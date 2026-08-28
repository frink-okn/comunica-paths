import type { IActorInitQueryBaseArgs } from '@comunica/actor-init-query';
import { ActorInitQueryBase } from '@comunica/actor-init-query';
import type { MediatorQueryPath } from './ActorQueryPath.js';

/** Standard Comunica init actor augmented with the path-query mediator. */
export class ActorInitQueryPaths extends ActorInitQueryBase {
  public readonly mediatorQueryPath: MediatorQueryPath;

  public constructor(args: IActorInitQueryPathsArgs) {
    super(args);
    this.mediatorQueryPath = args.mediatorQueryPath;
  }
}

export interface IActorInitQueryPathsArgs extends IActorInitQueryBaseArgs {
  mediatorQueryPath: MediatorQueryPath;
}
