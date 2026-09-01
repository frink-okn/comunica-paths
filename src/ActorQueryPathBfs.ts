import type { MediatorContextPreprocess } from '@comunica/bus-context-preprocess';
import type { MediatorMergeBindingsContext } from '@comunica/bus-merge-bindings-context';
import type { IQueryProcessSequential } from '@comunica/bus-query-process';
import { KeysCore, KeysHttp, KeysInitQuery } from '@comunica/context-entries';
import { failTest, passTestVoid, type IActorTest, type TestResult } from '@comunica/core';
import type { IActionContext, IPhysicalQueryPlanLogger } from '@comunica/types';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import {
  ActorQueryPath,
  type IActionQueryPath,
  type IActorQueryPathArgs,
  type IActorQueryPathOutput,
} from './ActorQueryPath.js';
import { BfsPathTraversal } from './BfsPathTraversal.js';
import { KeysQueryPath } from './context-entries.js';
import { PathQueryCancelledError } from './errors.js';
import { PathOperations } from './PathOperations.js';
import { PathMetadata, PathResultIterator } from './PathResultIterator.js';
import { PathTraversalStats } from './PathStats.js';
import { validateSpec } from './spec.js';

const ALGORITHM = 'bfs';

/**
 * Executes breadth-first path traversal, submitting every bounded frontier to
 * Comunica as standard query algebra.
 */
export class ActorQueryPathBfs extends ActorQueryPath {
  private readonly queryProcessor: IQueryProcessSequential;
  private readonly mediatorContextPreprocess: MediatorContextPreprocess;
  private readonly mediatorMergeBindingsContext: MediatorMergeBindingsContext;

  public constructor(args: IActorQueryPathBfsArgs) {
    super(args);
    this.queryProcessor = args.queryProcessor;
    this.mediatorContextPreprocess = args.mediatorContextPreprocess;
    this.mediatorMergeBindingsContext = args.mediatorMergeBindingsContext;
  }

  public async test(action: IActionQueryPath): Promise<TestResult<IActorTest>> {
    const algorithm = action.context.get(KeysQueryPath.algorithm);
    if (algorithm !== undefined && algorithm !== ALGORITHM) {
      return failTest(`Actor ${this.name} only supports the '${ALGORITHM}' path algorithm`);
    }
    return passTestVoid();
  }

  public async run(action: IActionQueryPath): Promise<IActorQueryPathOutput> {
    validateSpec(action.spec);

    // One initialized context for the whole request, so that query-scoped values
    // such as NOW(), source identifiers, the RDF data factory, and the logger
    // stay stable across every traversal depth.
    const { context } = await this.mediatorContextPreprocess.mediate({
      context: action.context,
      initialize: true,
    });
    const bindingsFactory = await BindingsFactory.create(
      this.mediatorMergeBindingsContext,
      context,
      context.getSafe(KeysInitQuery.dataFactory),
    );
    const metadata = new PathMetadata(action.spec.maxPaths);
    const plan = this.logPlan(context, action);
    // Measuring costs something on every solution, so it is only done when a plan
    // was asked for, which is the only place the measurements are reported.
    const stats = plan ? new PathTraversalStats() : undefined;
    const operations = await PathOperations.create({
      queryProcessor: this.queryProcessor,
      bindingsFactory,
      context: plan?.context ?? context,
      spec: action.spec,
      actorName: this.name,
      logWarn: (message, data) => this.logWarn(context, message, data),
      onExpansionCardinality: cardinality => metadata.recordExpansion(cardinality),
    });

    const traversal = new BfsPathTraversal(action.spec, operations, metadata, stats);
    const pathStream = new PathResultIterator(
      traversal.run(),
      metadata,
      cause => operations.destroy(cause),
    );
    // The logger belongs to the context this actor initialized, so flushing it is
    // this actor's responsibility — and on every way the stream can finish, not
    // only on one that runs to its end.
    pathStream.onDone(() => {
      if (plan && stats) {
        stats.closeDepth();
        plan.logger.appendMetadata(plan.node, { traversal: stats.read() });
      }
      context.get(KeysCore.log)?.flush();
    });
    linkAbortSignal(pathStream, context.get(KeysHttp.httpAbortSignal));

    return {
      pathStream,
      metadata: async() => metadata.read(),
      context: operations.context,
    };
  }

  /**
   * Register the traversal in the physical query plan, so that the plan for each
   * depth is reported as a child of this path query rather than as a root.
   *
   * Returns nothing when no plan was asked for, which is also the signal that
   * this traversal has nowhere to report measurements to.
   */
  private logPlan(context: IActionContext, action: IActionQueryPath): IPathPlan | undefined {
    const logger: IPhysicalQueryPlanLogger | undefined = context.get(KeysInitQuery.physicalQueryPlanLogger);
    if (!logger) {
      return undefined;
    }
    const node = { type: 'paths' };
    logger.logOperation(
      'paths',
      ALGORITHM,
      node,
      context.get(KeysInitQuery.physicalQueryPlanNode),
      this.name,
      {
        mode: action.spec.mode ?? 'shortest',
        cyclic: action.spec.cyclic ?? false,
        ...action.spec.maxDepth === undefined ? {} : { maxDepth: action.spec.maxDepth },
      },
    );
    return { logger, node, context: context.set(KeysInitQuery.physicalQueryPlanNode, node) };
  }
}

/** The physical query plan node a traversal reports itself under. */
interface IPathPlan {
  logger: IPhysicalQueryPlanLogger;
  node: unknown;
  context: IActionContext;
}

export interface IActorQueryPathBfsArgs extends IActorQueryPathArgs {
  /** The standard sequential query processor used to parse, optimize, and evaluate graph patterns. */
  queryProcessor: IQueryProcessSequential;
  /** Initializes the one request context that every path operation is derived from. */
  mediatorContextPreprocess: MediatorContextPreprocess;
  /** Creates the bindings used to bind a frontier node into a graph pattern. */
  mediatorMergeBindingsContext: MediatorMergeBindingsContext;
}

/**
 * Cancel a traversal when the request's abort signal fires.
 *
 * The signal already reaches Comunica's HTTP actors through the context. This
 * additionally tears down the traversal itself, so that a cancelled request
 * stops between depths rather than after the current one completes.
 */
function linkAbortSignal(pathStream: PathResultIterator, signal: AbortSignal | undefined): void {
  if (!signal) {
    return;
  }
  const abort = (): void => pathStream.destroy(new PathQueryCancelledError());
  if (signal.aborted) {
    abort();
    return;
  }
  signal.addEventListener('abort', abort, { once: true });
  // Drop the listener however the stream finishes. A signal that outlives this
  // request must not keep a finished traversal reachable, and a destroyed stream
  // never emits `end`.
  pathStream.onDone(() => signal.removeEventListener('abort', abort));
}
