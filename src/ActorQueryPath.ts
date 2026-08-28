import type { IAction, IActorArgs, IActorOutput, IActorTest, Mediate } from '@comunica/core';
import { Actor } from '@comunica/core';
import type { IActionContext } from '@comunica/types';
import type { PathQueryExecutionOptions, PathQuerySpec, PathResult } from './types.js';

/** Input to the dedicated path-query bus. */
export interface IActionQueryPath extends IAction {
  spec: PathQuerySpec;
  context: IActionContext;
  /** Selects exactly one path algorithm actor. */
  algorithm: string;
  options?: PathQueryExecutionOptions;
}

/** Output from the dedicated path-query bus. */
export interface IActorQueryPathOutput extends IActorOutput {
  pathStream: AsyncIterable<PathResult>;
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
