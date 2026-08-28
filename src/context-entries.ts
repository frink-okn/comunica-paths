import { ActionContextKey } from '@comunica/core';

/** Context entries understood by the path-query bus. */
export const KeysQueryPath = {
  /**
   * Selects the installed path algorithm actor. Actors must reject any value
   * they do not implement, so that the bus never resolves competing
   * implementations by completion timing. Defaults to `bfs`.
   */
  algorithm: new ActionContextKey<string>('comunica-paths:algorithm'),
};
