import {
  QueryEngine as PathEnabledQueryEngine,
  QueryEngineFactory,
  type PathQuerySpec,
  type PathStream,
} from '../src/index.js';

const spec = {
  start: { pattern: 'VALUES ?from { <urn:a> }', node: '?from' },
  end: { node: '?to' },
  via: { pattern: '?from <urn:edge> ?to', from: '?from', to: '?to' },
} satisfies PathQuerySpec;

const engine = new PathEnabledQueryEngine();
const results: Promise<PathStream> = engine.queryPaths(spec, { sources: []});
const textualResults: Promise<PathStream> = engine.queryPathString(
  'PATHS START ?from = <urn:a> END ?to VIA <urn:edge> LIMIT 1',
  { sources: []},
);
const serviceResults: Promise<PathStream> = engine.queryPathService(
  'SELECT * WHERE { SERVICE <urn:comunica:paths> { GRAPH <urn:comunica:paths:via> { ?from <urn:edge> ?to } } }',
  { sources: []},
);
const dynamicEngine = new QueryEngineFactory().create();

void results;
void textualResults;
void serviceResults;
void dynamicEngine;
