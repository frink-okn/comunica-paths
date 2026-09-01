import {
  QueryEngine as PathEnabledQueryEngine,
  QueryEngineFactory,
  type PathQuerySpec,
  type PathStream,
} from '../src/index.js';
// The browser entry carries the same surface bar the Components.js factory, so
// a public export added to the Node barrel alone fails to compile here.
import * as browserSurface from '../src/index-browser.js';

const spec = {
  start: { pattern: 'VALUES ?from { <urn:a> }', node: '?from' },
  end: { node: '?to' },
  via: { pattern: '?start <urn:edge> ?end' },
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

// Every export but the factory has to be reachable from the browser entry too.
const browserEngine: PathEnabledQueryEngine = new browserSurface.QueryEngine();
const browserPaths: Promise<PathStream> = browserEngine.queryPaths(spec, { sources: []});

void browserPaths;
void results;
void textualResults;
void serviceResults;
void dynamicEngine;
