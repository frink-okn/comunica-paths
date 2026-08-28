import { QueryEngine } from '@comunica/query-sparql';
import { PathQueryEngine, type PathQuerySpec } from '../src/index.js';

const spec = {
  start: { pattern: 'VALUES ?from { <urn:a> }', node: '?from' },
  end: { node: '?to' },
  via: { pattern: '?from <urn:edge> ?to', from: '?from', to: '?to' },
} satisfies PathQuerySpec;

const engine = new PathQueryEngine(new QueryEngine());
const results = engine.queryPaths(spec, { sources: [] });
const textualResults = engine.queryPathString(
  'PATHS START ?from = <urn:a> END ?to VIA <urn:edge> LIMIT 1',
  { sources: [] },
);

void results;
void textualResults;

