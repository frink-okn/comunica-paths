import type { MediatorRdfJoin } from '@comunica/bus-rdf-join';
import type { IQueryProcessSequential } from '@comunica/bus-query-process';
import { KeysHttp, KeysInitQuery } from '@comunica/context-entries';
import { failTest, passTestVoid, type IActorTest, type TestResult } from '@comunica/core';
import type {
  BindingsStream,
  IActionContext,
  IQueryOperationResultBindings,
  QueryStringContext,
} from '@comunica/types';
import { Algebra, AlgebraFactory, algebraUtils } from '@comunica/utils-algebra';
import { MetadataValidationState } from '@comunica/utils-metadata';
import {
  assignOperationSource,
  getOperationSource,
  getSafeBindings,
  removeOperationSource,
} from '@comunica/utils-query-operation';
import type * as RDF from '@rdfjs/types';
import { ArrayIterator } from 'asynciterator';
import { ActorQueryPath, type IActionQueryPath, type IActorQueryPathArgs, type IActorQueryPathOutput } from './ActorQueryPath.js';
import { PathQueryEngine } from './PathQueryEngine.js';

/**
 * Executes breadth-first path traversal while delegating every frontier join
 * to Comunica's RDF-join mediator.
 */
export class ActorQueryPathBfs extends ActorQueryPath {
  private readonly queryProcessor: IQueryProcessSequential;
  private readonly mediatorRdfJoin: MediatorRdfJoin;
  private readonly batchSize: number | undefined;

  public constructor(args: IActorQueryPathBfsArgs) {
    super(args);
    this.queryProcessor = args.queryProcessor;
    this.mediatorRdfJoin = args.mediatorRdfJoin;
    this.batchSize = args.batchSize;
  }

  public async test(action: IActionQueryPath): Promise<TestResult<IActorTest>> {
    if (action.algorithm !== 'bfs') {
      return failTest(`Actor ${this.name} only supports the 'bfs' path algorithm`);
    }
    return passTestVoid();
  }

  public async run(action: IActionQueryPath): Promise<IActorQueryPathOutput> {
    const context = action.options?.signal ?
      action.context.set(KeysHttp.httpAbortSignal, action.options.signal) :
      action.context;
    const backend = await MediatedBindingsBackend.create(
      this.queryProcessor,
      this.mediatorRdfJoin,
      context,
    );
    const engine = new PathQueryEngine<QueryStringContext>(
      backend,
      this.batchSize === undefined ? {} : { batchSize: this.batchSize },
    );
    return {
      pathStream: engine.queryPaths(
        action.spec,
        undefined,
        action.options?.signal ? { signal: action.options.signal } : undefined,
      ),
      context: backend.context,
    };
  }
}

export interface IActorQueryPathBfsArgs extends IActorQueryPathArgs {
  /** The standard sequential query processor used to parse, optimize, and evaluate graph patterns. */
  queryProcessor: IQueryProcessSequential;
  /** The configured RDF-join mediator used for frontier/VIA and candidate/END joins. */
  mediatorRdfJoin: MediatorRdfJoin;
  /** Maximum number of frontier bindings submitted in one mediated join. */
  batchSize?: number;
}

class MediatedBindingsBackend {
  private readonly operations = new Map<string, PreparedOperation>();

  private constructor(
    private readonly queryProcessor: IQueryProcessSequential,
    private readonly mediatorRdfJoin: MediatorRdfJoin,
    public readonly context: IActionContext,
  ) {}

  public static async create(
    queryProcessor: IQueryProcessSequential,
    mediatorRdfJoin: MediatorRdfJoin,
    context: IActionContext,
  ): Promise<MediatedBindingsBackend> {
    // Parsing an algebra operation runs Comunica's context preprocessing without
    // invoking a query parser. All real operations are derived from this common
    // initialized context, so request-scoped values such as NOW() and source IDs
    // remain stable for the entire traversal.
    const initialized = await queryProcessor.parse({ type: Algebra.Types.NOP }, context);
    return new MediatedBindingsBackend(queryProcessor, mediatorRdfJoin, initialized.context);
  }

  public async queryBindings(query: string): Promise<BindingsStream> {
    const { operation, context } = await this.prepare(query);
    return getSafeBindings(await this.queryProcessor.evaluate(operation, context)).bindingsStream;
  }

  public async queryBindingsWithBindings(
    query: string,
    variable: `?${string}` | `$${string}`,
    bindings: readonly RDF.Bindings[],
  ): Promise<BindingsStream> {
    const { graphPattern, context, rejectsBlankNodeBindings } = await this.prepare(query);
    const variableTerm = context.getSafe(KeysInitQuery.dataFactory).variable(variable.slice(1));
    // SPARQL VALUES does not permit blank nodes, and blank-node labels returned
    // by a remote result set cannot identify that node in a later request.
    // Pattern-oriented sources (including TPF and local RDF sources) do not use
    // this whole-operation pushdown and retain Comunica's scoped-blank handling.
    const effectiveBindings = rejectsBlankNodeBindings ?
      bindings.filter(binding => binding.get(variableTerm)?.termType !== 'BlankNode') :
      bindings;
    const frontierOutput = createFrontierOutput(effectiveBindings, variableTerm);
    if (effectiveBindings.length === 0) {
      return frontierOutput.bindingsStream;
    }
    const operationOutput = getSafeBindings(await this.queryProcessor.evaluate(graphPattern, context));
    const algebraFactory = new AlgebraFactory(context.getSafe(KeysInitQuery.dataFactory));
    const frontierOperation = algebraFactory.createNop();
    const joined = await this.mediatorRdfJoin.mediate({
      type: 'inner',
      entries: [
        { operation: frontierOperation, output: frontierOutput, operationModified: true },
        { operation: graphPattern, output: operationOutput },
      ],
      context,
    });
    return joined.bindingsStream.uniq(bindingsKey) as BindingsStream;
  }

  private async prepare(query: string): Promise<PreparedOperation> {
    const cached = this.operations.get(query);
    if (cached) {
      return cached;
    }
    const parsed = await this.queryProcessor.parse(query, this.context);
    const optimized = await this.queryProcessor.optimize(parsed.operation, parsed.context);
    let operation = optimized.operation;
    let graphPattern = extractGraphPattern(operation);
    // A source such as a SPARQL endpoint may accept the complete synthetic
    // SELECT DISTINCT operation, in which case Comunica scopes the source to
    // that outer operation. Transfer the annotation when removing the wrapper
    // so the endpoint receives the selective graph pattern with frontier
    // bindings inside it. TPF and federated plans instead annotate operations
    // inside the graph pattern; extracting it preserves those annotations.
    const source = getOperationSource(operation);
    const sourceAcceptsWholeOperation = Boolean(source && operationReadsDataset(graphPattern));
    if (source && sourceAcceptsWholeOperation && !getOperationSource(graphPattern)) {
      graphPattern = assignOperationSource(graphPattern, source);
    } else if (source && !sourceAcceptsWholeOperation) {
      // Source identification may assign even a VALUES-only SELECT to the sole
      // configured endpoint. Such source-independent algebra is both cheaper
      // and safer locally (notably, it avoids serializing blank nodes in VALUES).
      operation = operation.metadata ?
        { ...operation, metadata: { ...operation.metadata } } :
        { ...operation };
      removeOperationSource(operation);
    }
    const prepared = {
      ...optimized,
      operation,
      graphPattern,
      rejectsBlankNodeBindings: sourceAcceptsWholeOperation,
    };
    this.operations.set(query, prepared);
    return prepared;
  }
}

interface PreparedOperation {
  operation: Algebra.Operation;
  graphPattern: Algebra.Operation;
  context: IActionContext;
  rejectsBlankNodeBindings: boolean;
}

/** Remove the synthetic SELECT DISTINCT * wrapper used only to parse an embedded graph pattern. */
function extractGraphPattern(operation: Algebra.Operation): Algebra.Operation {
  const project = operation.type === Algebra.Types.DISTINCT ?
    (operation as Algebra.Distinct).input :
    operation;
  if (project.type !== Algebra.Types.PROJECT) {
    throw new Error(`Expected an embedded graph pattern to compile to a projection, received ${operation.type}`);
  }
  return (project as Algebra.Project).input;
}

/** Whether an operation contains a graph access that needs a configured query source. */
function operationReadsDataset(operation: Algebra.Operation): boolean {
  let readsDataset = false;
  algebraUtils.visitOperation(operation, {
    [Algebra.Types.BGP]: {
      visitor: bgp => {
        readsDataset ||= bgp.patterns.length > 0;
      },
    },
    [Algebra.Types.PATH]: {
      visitor: () => {
        readsDataset = true;
      },
    },
    [Algebra.Types.PATTERN]: {
      visitor: () => {
        readsDataset = true;
      },
    },
    [Algebra.Types.SERVICE]: {
      visitor: () => {
        readsDataset = true;
      },
    },
  });
  return readsDataset;
}

/** Stable key for restoring the synthetic SELECT DISTINCT semantics after a mediated frontier join. */
function bindingsKey(bindings: RDF.Bindings): string {
  return JSON.stringify([ ...bindings ]
    .sort(([ left ], [ right ]) => left.value.localeCompare(right.value))
    .map(([ variable, term ]) => [ variable.value, termKey(term) ]));
}

function termKey(term: RDF.Term): unknown {
  if (term.termType === 'Literal') {
    return [ term.termType, term.value, term.language, term.direction, termKey(term.datatype) ];
  }
  if (term.termType === 'Quad') {
    return [
      term.termType,
      termKey(term.subject),
      termKey(term.predicate),
      termKey(term.object),
      termKey(term.graph),
    ];
  }
  return [ term.termType, term.value ];
}

function createFrontierOutput(
  bindings: readonly RDF.Bindings[],
  variable: RDF.Variable,
): IQueryOperationResultBindings {
  return {
    type: 'bindings',
    bindingsStream: new ArrayIterator([ ...bindings ], { autoStart: false }) as unknown as BindingsStream,
    metadata: async() => ({
      state: new MetadataValidationState(),
      cardinality: { type: 'exact', value: bindings.length },
      variables: [{ variable, canBeUndef: false }],
    }),
  };
}
