import type { IAction, IActorArgs, IActorOutput, IActorTest, Mediate } from '@comunica/core';
import { Actor } from '@comunica/core';
import type { IActionContext } from '@comunica/types';
import type { IPathMetadata, PathQuerySpec, PathStream } from './types.js';

/**
 * Input to the dedicated path-query bus.
 *
 * The algorithm discriminator travels in the context under
 * {@link KeysQueryPath.algorithm}, like every other query option.
 */
export interface IActionQueryPath extends IAction {
  spec: PathQuerySpec;
}

/** Output from the dedicated path-query bus. */
export interface IActorQueryPathOutput extends IActorOutput {
  pathStream: PathStream;
  /** Resolves the current path-stream metadata, following Comunica's invalidation rules. */
  metadata: () => Promise<IPathMetadata>;
  /** The initialized request context shared by every internal query operation. */
  context: IActionContext;
}

export type MediatorQueryPath = Mediate<IActionQueryPath, IActorQueryPathOutput>;

/** Base class for path-query implementations. */
export abstract class ActorQueryPath<TS = undefined>
  extends Actor<IActionQueryPath, IActorTest, IActorQueryPathOutput, TS> {
  /**
   * @param args -
   *   \ @defaultNested {<default_bus> a <cc:components/Bus.jsonld#Bus>} bus
   *   \ @defaultNested {Path querying failed: none of the configured actors accepted the request} busFailMessage
   */
  public constructor(args: IActorQueryPathArgs<TS>) {
    super(args);
  }
}

export interface IActorQueryPathArgs<TS = undefined>
  extends IActorArgs<IActionQueryPath, IActorTest, IActorQueryPathOutput, TS> {}
