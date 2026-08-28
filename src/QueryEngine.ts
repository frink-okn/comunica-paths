import { QueryEngineBase } from '@comunica/actor-init-query';
import { ActionContext } from '@comunica/core';
import type { QueryStringContext } from '@comunica/types';
import type { ActorInitQueryPaths } from './ActorInitQueryPaths.js';
import { parsePathServiceQuery } from './service.js';
import { parsePathQuery } from './syntax.js';
import type { PathQueryExecutionOptions, PathQuerySpec, PathResult } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const engineDefault = require('../engine-default.cjs') as () => ActorInitQueryPaths;

/** A configured Comunica engine with a dedicated structured path-query API. */
export class QueryEngine<QueryContext extends QueryStringContext = QueryStringContext>
  extends QueryEngineBase<QueryContext> {
  public constructor(private readonly actorInitQueryPaths: ActorInitQueryPaths = engineDefault()) {
    super(actorInitQueryPaths);
  }

  public queryPaths(
    spec: PathQuerySpec,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): AsyncIterable<PathResult> {
    return this.mediatePath(spec, context, options);
  }

  public queryPathString(
    query: string,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): AsyncIterable<PathResult> {
    return this.queryPaths(parsePathQuery(query), context, options);
  }

  public queryPathService(
    query: string,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): AsyncIterable<PathResult> {
    return this.queryPaths(parsePathServiceQuery(query), context, options);
  }

  private async *mediatePath(
    spec: PathQuerySpec,
    context: QueryContext | undefined,
    options: PathQueryExecutionOptions | undefined,
  ): AsyncIterable<PathResult> {
    const output = await this.actorInitQueryPaths.mediatorQueryPath.mediate({
      spec,
      context: ActionContext.ensureActionContext(context),
      ...(options ? { options } : {}),
    });
    yield* output.pathStream;
  }
}
