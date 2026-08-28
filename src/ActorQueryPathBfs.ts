import type { MediatorRdfJoin } from '@comunica/bus-rdf-join';
import type { IQueryProcessSequential } from '@comunica/bus-query-process';
import { KeysInitQuery } from '@comunica/context-entries';
import { passTestVoid, type IActorTest, type TestResult } from '@comunica/core';
import type {
  BindingsStream,
  IActionContext,
  IQueryOperationResultBindings,
  QueryStringContext,
} from '@comunica/types';
import { AlgebraFactory, type Algebra } from '@comunica/utils-algebra';
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

  public constructor(args: IActorQueryPathBfsArgs) {
    super(args);
    this.queryProcessor = args.queryProcessor;
    this.mediatorRdfJoin = args.mediatorRdfJoin;
  }

  public async test(_action: IActionQueryPath): Promise<TestResult<IActorTest>> {
    return passTestVoid();
  }

  public async run(action: IActionQueryPath): Promise<IActorQueryPathOutput> {
    const backend = new MediatedBindingsBackend(
      this.queryProcessor,
      this.mediatorRdfJoin,
      action.context,
    );
    const engine = new PathQueryEngine<QueryStringContext>(backend);
    return {
      pathStream: engine.queryPaths(action.spec, undefined, action.options),
    };
  }
}

export interface IActorQueryPathBfsArgs extends IActorQueryPathArgs {
  /** The standard sequential query processor used to parse, optimize, and evaluate graph patterns. */
  queryProcessor: IQueryProcessSequential;
  /** The configured RDF-join mediator used for frontier/VIA and candidate/END joins. */
  mediatorRdfJoin: MediatorRdfJoin;
}

class MediatedBindingsBackend {
  private readonly operations = new Map<string, { operation: Algebra.Operation; context: IActionContext }>();

  public constructor(
    private readonly queryProcessor: IQueryProcessSequential,
    private readonly mediatorRdfJoin: MediatorRdfJoin,
    private readonly context: IActionContext,
  ) {}

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
