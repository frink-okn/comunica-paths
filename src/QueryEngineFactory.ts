import { QueryEngineFactoryBase, type IDynamicQueryEngineOptions } from '@comunica/actor-init-query';
import type { ActorInitQueryPaths } from './ActorInitQueryPaths.js';
import { QueryEngine } from './QueryEngine.js';

/** Creates path-enabled query engines from Components.js configurations. */
export class QueryEngineFactory extends QueryEngineFactoryBase<QueryEngine> {
  public constructor() {
    super(
      `${__dirname}/../`,
      `${__dirname}/../config/config-default.json`,
      actor => new QueryEngine(actor as ActorInitQueryPaths),
    );
  }

  public override create(options: IDynamicQueryEngineOptions = {}): Promise<QueryEngine> {
    return super.create({ instanceUri: 'urn:comunica:paths:init', ...options });
  }
}
