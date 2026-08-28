import { QueryEngineBase } from '@comunica/actor-init-query';
import { KeysCore, KeysHttp, KeysInitQuery } from '@comunica/context-entries';
import { ActionContext } from '@comunica/core';
import type { QueryStringContext } from '@comunica/types';
import type { ActorInitQueryPaths } from './ActorInitQueryPaths.js';
import { KeysQueryPath } from './context-entries.js';
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

    const output = await this.actorInitQueryPaths.mediatorQueryPath.mediate({
      spec,
      context: actionContext,
    });
    const flush = (): void => output.context.get(KeysCore.log)?.flush();
    output.pathStream.on('end', flush);
    output.pathStream.on('error', flush);
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
}
