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
import { Algebra, AlgebraFactory } from '@comunica/utils-algebra';
import { MetadataValidationState } from '@comunica/utils-metadata';
import { getSafeBindings } from '@comunica/utils-query-operation';
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
  private readonly operations = new Map<string, { operation: Algebra.Operation; context: IActionContext }>();

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
    const { operation, context } = await this.prepare(query);
    const operationOutput = getSafeBindings(await this.queryProcessor.evaluate(operation, context));
    const variableTerm = context.getSafe(KeysInitQuery.dataFactory).variable(variable.slice(1));
    const frontierOutput = createFrontierOutput(bindings, variableTerm);
    const algebraFactory = new AlgebraFactory(context.getSafe(KeysInitQuery.dataFactory));
    const frontierOperation = algebraFactory.createNop();
    const joined = await this.mediatorRdfJoin.mediate({
      type: 'inner',
      entries: [
        { operation: frontierOperation, output: frontierOutput, operationModified: true },
        { operation, output: operationOutput },
      ],
      context,
    });
    return joined.bindingsStream;
  }

  private async prepare(query: string): Promise<{ operation: Algebra.Operation; context: IActionContext }> {
    const cached = this.operations.get(query);
    if (cached) {
      return cached;
    }
    const parsed = await this.queryProcessor.parse(query, this.context);
    const optimized = await this.queryProcessor.optimize(parsed.operation, parsed.context);
    this.operations.set(query, optimized);
    return optimized;
  }
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
