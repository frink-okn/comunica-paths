import type { IQueryProcessSequential } from '@comunica/bus-query-process';
import { KeysHttp, KeysInitQuery } from '@comunica/context-entries';
import { failTest, passTestVoid, type IActorTest, type TestResult } from '@comunica/core';
import type {
  BindingsStream,
  IActionContext,
  QueryStringContext,
} from '@comunica/types';
import { Algebra, AlgebraFactory, algebraUtils } from '@comunica/utils-algebra';
import { assignOperationSource, getOperationSource, getSafeBindings } from '@comunica/utils-query-operation';
import type * as RDF from '@rdfjs/types';
import { ArrayIterator } from 'asynciterator';
import { ActorQueryPath, type IActionQueryPath, type IActorQueryPathArgs, type IActorQueryPathOutput } from './ActorQueryPath.js';
import { PathQueryEngine } from './PathQueryEngine.js';

/**
 * Executes breadth-first path traversal while submitting each bounded frontier
 * to Comunica as standard query algebra.
 */
export class ActorQueryPathBfs extends ActorQueryPath {
  private readonly queryProcessor: IQueryProcessSequential;
  private readonly batchSize: number | undefined;

  public constructor(args: IActorQueryPathBfsArgs) {
    super(args);
    this.queryProcessor = args.queryProcessor;
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
    const backend = await ComunicaBindingsBackend.create(this.queryProcessor, context);
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
  /** Maximum number of frontier bindings submitted in one mediated join. */
  batchSize?: number;
}

class ComunicaBindingsBackend {
  private readonly operations = new Map<string, PreparedOperation>();

  private constructor(
    private readonly queryProcessor: IQueryProcessSequential,
    public readonly context: IActionContext,
  ) {}

  public static async create(
    queryProcessor: IQueryProcessSequential,
    context: IActionContext,
  ): Promise<ComunicaBindingsBackend> {
    // Parsing an algebra operation runs Comunica's context preprocessing without
    // invoking a query parser. All real operations are derived from this common
    // initialized context, so request-scoped values such as NOW() and source IDs
    // remain stable for the entire traversal.
    const initialized = await queryProcessor.parse({ type: Algebra.Types.NOP }, context);
    return new ComunicaBindingsBackend(queryProcessor, initialized.context);
  }

  public async queryBindings(query: string, queryContext?: QueryStringContext): Promise<BindingsStream> {
    const context = this.applyQueryContext(queryContext);
    if (queryContext?.initialBindings) {
      const parsed = await this.queryProcessor.parse(query, context);
      const optimized = await this.prepareParsed(parsed);
      // A blank node returned by a remote whole-query source has result-set
      // scope and can not be named in a later SPARQL request. Pattern-oriented
      // sources retain their normal Comunica source-scoped handling here.
      if (hasBlankNode(queryContext.initialBindings) && getOperationSource(optimized.operation)) {
        return new ArrayIterator([], { autoStart: false }) as unknown as BindingsStream;
      }
      return getSafeBindings(
        await this.queryProcessor.evaluate(optimized.operation, optimized.context),
      ).bindingsStream;
    }
    const prepared = await this.prepare(query);
    return getSafeBindings(
      await this.queryProcessor.evaluate(prepared.operation, prepared.context),
    ).bindingsStream;
  }

  public async queryBindingsWithBindings(
    query: string,
    variable: `?${string}` | `$${string}`,
    bindings: readonly RDF.Bindings[],
  ): Promise<BindingsStream> {
    const { operation, context } = await this.prepare(query);
    const variableTerm = context.getSafe(KeysInitQuery.dataFactory).variable(variable.slice(1));
    const algebraFactory = new AlgebraFactory(context.getSafe(KeysInitQuery.dataFactory));
    const values = algebraFactory.createValues([ variableTerm ], bindings.map((binding) => {
      const value = binding.get(variableTerm);
      if (!value || (value.termType !== 'NamedNode' && value.termType !== 'Literal')) {
        throw new Error(`Frontier binding for ${variable} can not be represented in SPARQL VALUES`);
      }
      return { [variableTerm.value]: value };
    }));
    const select = extractSelect(operation);
    const outerSource = getOperationSource(operation);
    // Source identification is allowed to scope a complete SELECT to one source.
    // Since SELECT is only a parser wrapper here, retain that decision on its
    // graph input when inserting VALUES. For pattern-oriented sources, Comunica
    // has already annotated the inner operations and no transfer is necessary.
    const graphInput = outerSource && !getOperationSource(select.input) ?
      assignOperationSource(select.input, outerSource) :
      select.input;
    // Flattening lets the normal n-way join actors consider VALUES alongside
    // every graph-pattern input when the prepared plan is not source-scoped.
    // A source-scoped graph remains one input and its bind-join actor can push
    // the VALUES relation into the source request.
    const joined = algebraFactory.createJoin([ values, graphInput ], !getOperationSource(graphInput));
    const selected = algebraFactory.createDistinct(
      algebraFactory.createProject(joined, select.variables),
    );
    return getSafeBindings(
      await this.queryProcessor.evaluate(selected, context.delete(KeysInitQuery.queryString)),
    ).bindingsStream;
  }

  private async prepare(query: string): Promise<PreparedOperation> {
    const cached = this.operations.get(query);
    if (cached) {
      return cached;
    }
    const parsed = await this.queryProcessor.parse(query, this.context);
    const prepared = await this.prepareParsed(parsed);
    this.operations.set(query, prepared);
    return prepared;
  }

  private async prepareParsed(parsed: PreparedOperation): Promise<PreparedOperation> {
    // VALUES, expressions, and other source-independent algebra should execute
    // locally. Source planning is only needed when an operation reads an RDF
    // dataset; this also avoids pointless requests for constant START/END forms.
    return operationReadsDataset(parsed.operation) ?
      this.queryProcessor.optimize(parsed.operation, parsed.context) :
      parsed;
  }

  private applyQueryContext(queryContext?: QueryStringContext): IActionContext {
    let context = this.context;
    if (queryContext?.initialBindings) {
      const initialBindings = context.get(KeysInitQuery.initialBindings)?.merge(queryContext.initialBindings) ??
        queryContext.initialBindings;
      context = context.set(KeysInitQuery.initialBindings, initialBindings);
    }
    if (queryContext?.httpAbortSignal) {
      context = context.set(KeysHttp.httpAbortSignal, queryContext.httpAbortSignal);
    }
    return context;
  }
}

interface PreparedOperation {
  operation: Algebra.Operation;
  context: IActionContext;
}

function hasBlankNode(bindings: RDF.Bindings): boolean {
  return [ ...bindings.values() ].some(term => term.termType === 'BlankNode');
}

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

/** Extract the graph pattern and projection from the synthetic SELECT DISTINCT wrapper. */
function extractSelect(operation: Algebra.Operation): Algebra.Project {
  if (operation.type === Algebra.Types.DISTINCT) {
    operation = (operation as Algebra.Distinct).input;
  }
  if (operation.type === Algebra.Types.PROJECT) {
    return operation as Algebra.Project;
  }
  throw new Error(`Expected an embedded graph pattern to compile to a projection, received ${operation.type}`);
}
