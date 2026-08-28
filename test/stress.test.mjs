import assert from 'node:assert/strict';
import { it } from 'node:test';
import { QueryEngine } from '@comunica/query-sparql';
import { PathQueryEngine } from '../dist/index.js';

const EX = 'https://example.org/stress/';

it('bounds path explosion while traversing a cyclic graph', async () => {
  const triples = [];
  for (let from = 0; from < 8; from++) {
    for (let to = 0; to < 8; to++) {
      if (from !== to) {
        triples.push(`<${EX}${from}> <${EX}edge> <${EX}${to}> .`);
      }
    }
  }
  const source = {
    type: 'serialized',
    value: triples.join('\n'),
    mediaType: 'application/n-triples',
    baseIRI: EX,
  };
  const engine = new PathQueryEngine(new QueryEngine(), { batchSize: 3 });
  const paths = [];
  for await (const path of engine.queryPaths({
    start: { pattern: `VALUES ?from { <${EX}0> }`, node: '?from' },
    end: { node: '?to' },
    via: { pattern: `?from <${EX}edge> ?to`, from: '?from', to: '?to' },
    mode: 'all',
    maxDepth: 7,
    maxPaths: 100,
  }, { sources: [ source ] })) {
    paths.push(path);
  }

  assert.equal(paths.length, 100);
  assert.ok(paths.every((path) => {
    const values = path.nodes.map(term => term.value);
    const simpleValues = values[0] === values.at(-1) ? values.slice(0, -1) : values;
    return new Set(simpleValues).size === simpleValues.length;
  }));
});
