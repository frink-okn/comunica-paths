import { QueryEngineBase } from '@comunica/actor-init-query';
import { MemoryPhysicalQueryPlanLogger } from '@comunica/actor-query-process-explain-physical';
import { KeysHttp, KeysInitQuery } from '@comunica/context-entries';
import { ActionContext } from '@comunica/core';
import type {
  IActionContext,
  IQueryExplained,
  QueryExplainMode,
  QueryStringContext,
} from '@comunica/types';
import type { ActorInitQueryPaths } from './ActorInitQueryPaths.js';
import type { IActorQueryPathOutput } from './ActorQueryPath.js';
import { KeysQueryPath } from './context-entries.js';
import { InvalidPathQueryError } from './errors.js';
import { parsePathServiceQuery } from './service.js';
import { parsePathQuery } from './syntax.js';
import type {
  IPathQueryEngine,
  PathQueryExecutionOptions,
  PathQuerySpec,
  PathStream,
} from './types.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const engineDefault = require('../engine-default.cjs') as () => ActorInitQueryPaths;

/** The explain modes a path query can be reported in. */
const EXPLAIN_MODES = new Set<QueryExplainMode>([ 'parsed', 'physical', 'physical-json' ]);

/**
 * A configured Comunica engine with a dedicated structured path-query API.
 *
 * The returned stream exposes its current cardinality under the `metadata`
 * iterator property, following the same invalidation rules as a bindings stream.
 */
export class QueryEngine<QueryContext extends QueryStringContext = QueryStringContext>
  extends QueryEngineBase<QueryContext>
  implements IPathQueryEngine<QueryContext> {
  public constructor(private readonly actorInitQueryPaths: ActorInitQueryPaths = engineDefault()) {
    super(actorInitQueryPaths);
  }

  public async queryPaths(
    spec: PathQuerySpec,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): Promise<PathStream> {
    const output = await this.executePaths(spec, await this.pathContext(context, options));
    return output.pathStream;
  }

  public async queryPathString(
    query: string,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): Promise<PathStream> {
    return this.queryPaths(parsePathQuery(query), context, options);
  }

  public async queryPathService(
    query: string,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): Promise<PathStream> {
    return this.queryPaths(parsePathServiceQuery(query), context, options);
  }

  /**
   * Explain a path query, in the same shape `QueryEngineBase.explain` reports an
   * ordinary one.
   *
   * `parsed` returns the specification the query compiled to. `physical` and
   * `physical-json` install a plan logger, run the traversal to completion, and
   * report the plan the actors actually built — every traversal depth nested
   * under the path query, with the physical join each depth chose.
   */
  public async explainPaths(
    spec: PathQuerySpec,
    context: QueryContext | undefined,
    explainMode: QueryExplainMode,
    options?: PathQueryExecutionOptions,
  ): Promise<IQueryExplained> {
    if (!EXPLAIN_MODES.has(explainMode)) {
      throw new InvalidPathQueryError(
        `A path query cannot be explained in '${explainMode}' mode, only in ${
          [ ...EXPLAIN_MODES ].map(mode => `'${mode}'`).join(', ')}`,
      );
    }
    if (explainMode === 'parsed') {
      return { explain: true, type: explainMode, data: spec };
    }

    const physicalQueryPlanLogger = new MemoryPhysicalQueryPlanLogger();
    const planContext = (await this.pathContext(context, options))
      .set(KeysInitQuery.physicalQueryPlanLogger, physicalQueryPlanLogger);
    const { pathStream } = await this.executePaths(spec, planContext);
    // A plan is only complete once every depth has been evaluated, so the whole
    // result is produced first, exactly as the physical-explain actor does.
    await pathStream.toArray();
    return {
      explain: true,
      type: explainMode,
      data: explainMode === 'physical' ?
        physicalQueryPlanLogger.toCompactString() :
        physicalQueryPlanLogger.toJson(),
    };
  }

  public async explainPathString(
    query: string,
    context: QueryContext | undefined,
    explainMode: QueryExplainMode,
    options?: PathQueryExecutionOptions,
  ): Promise<IQueryExplained> {
    return this.explainPaths(parsePathQuery(query), context, explainMode, options);
  }

  public async explainPathService(
    query: string,
    context: QueryContext | undefined,
    explainMode: QueryExplainMode,
    options?: PathQueryExecutionOptions,
  ): Promise<IQueryExplained> {
    return this.explainPaths(parsePathServiceQuery(query), context, explainMode, options);
  }

  /** Build the request context, applying the execution options and cache flag. */
  private async pathContext(
    context: QueryContext | undefined,
    options: PathQueryExecutionOptions | undefined,
  ): Promise<IActionContext> {
    let actionContext = ActionContext.ensureActionContext(context);
    if (options?.signal) {
      actionContext = actionContext.set(KeysHttp.httpAbortSignal, options.signal);
    }
    if (options?.algorithm !== undefined) {
      actionContext = actionContext.set(KeysQueryPath.algorithm, options.algorithm);
    }
    if (actionContext.get(KeysInitQuery.invalidateCache) ?? context?.invalidateCache) {
      await this.invalidateHttpCache(undefined, actionContext);
    }
    return actionContext;
  }

  private async executePaths(
    spec: PathQuerySpec,
    context: IActionContext,
  ): Promise<IActorQueryPathOutput> {
    const output = await this.actorInitQueryPaths.mediatorQueryPath.mediate({ spec, context });
    // Publish the metadata the bus contract carries onto the stream, which is
    // where the public API exposes it. Doing it here rather than trusting the
    // actor to have done it makes the property hold for any path actor.
    output.pathStream.setProperty('metadata', await output.metadata());
    return output;
  }
}
