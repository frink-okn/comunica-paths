export * from './index-browser.js';
/**
 * Creating an engine from a Components.js configuration reads that
 * configuration from disk, so this is the one export a browser build cannot
 * carry. It is absent from `index-browser.ts`, which the `browser` export
 * condition resolves to instead.
 */
export { QueryEngineFactory } from './QueryEngineFactory.js';
