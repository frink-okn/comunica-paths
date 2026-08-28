import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { QueryEngine } from '@comunica/query-sparql';
import { InvalidPathQueryError, parsePathQuery, PathQueryEngine } from '../dist/index.js';

const EX = 'https://example.org/';
const sources = [
  {
    type: 'serialized',
    value: await readFile(new URL('./fixtures/source-a.ttl', import.meta.url), 'utf8'),
    mediaType: 'text/turtle',
    baseIRI: `${EX}source-a`,
  },
  {
    type: 'serialized',
    value: await readFile(new URL('./fixtures/source-b.ttl', import.meta.url), 'utf8'),
    mediaType: 'text/turtle',
    baseIRI: `${EX}source-b`,
  },
];

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

describe('PATHS syntax', () => {
  it('parses modes, endpoint forms, datasets, and solution modifiers', () => {
    const parsed = parsePathQuery(`
      PREFIX ex: <${EX}>
      PATHS ALL CYCLIC FROM <https://example.org/graph>
      START ?origin = ex:a
      END ?destination {
        ?destination ex:target true .
        FILTER("LIMIT inside a string" != "")
      }
      VIA { ?origin ex:edge ?destination }
      MAX LENGTH 7 OFFSET 2 LIMIT 3
    `);

    assert.equal(parsed.mode, 'all');
    assert.equal(parsed.cyclic, true);
    assert.equal(parsed.dataset, 'FROM <https://example.org/graph>');
    assert.equal(parsed.start.node, '?origin');
    assert.match(parsed.start.pattern, /^VALUES \?origin/u);
    assert.match(parsed.end.pattern, /FILTER/u);
    assert.equal(parsed.via.from, '?origin');
    assert.equal(parsed.via.to, '?destination');
    assert.equal(parsed.maxDepth, 7);
    assert.equal(parsed.offset, 2);
    assert.equal(parsed.maxPaths, 3);
  });

  it('expands predicate variables and property paths into standard graph patterns', () => {
    const variable = parsePathQuery(`
      PREFIX ex: <${EX}>
      PATHS START ?from END ?to VIA ?predicate LIMIT 1
    `);
    const propertyPath = parsePathQuery(`
      PREFIX ex: <${EX}>
      PATHS SHORTEST START $from = ex:a END $to = ex:d
      VIA (^ex:edge|ex:edge)/ex:edge?
      MAX LENGTH 4
    `);

    assert.match(variable.via.pattern, /^\?from \?predicate\s+\?to \.$/u);
    assert.match(propertyPath.via.pattern, /^\$from \(\^ex:edge\|ex:edge\)\/ex:edge\?\s+\$to \.$/u);
  });

  it('executes textual queries through an unchanged Comunica engine', async () => {
    const engine = new PathQueryEngine(new QueryEngine());
    const paths = await collect(engine.queryPathString(`
      PREFIX ex: <${EX}>
      PATHS ALL
      START ?from = ex:a
      END ?to = ex:d
      VIA ex:edge
      MAX LENGTH 3
    `, { sources }));

    assert.deepEqual(
      paths.map(path => path.nodes.map(term => term.value.replace(EX, '')).join('-')),
      [ 'a-b-d', 'a-c-d', 'a-b-x-d' ],
    );
  });

  it('rejects malformed envelopes and invalid embedded SPARQL', () => {
    assert.throws(() => parsePathQuery('SELECT * WHERE { ?s ?p ?o }'), InvalidPathQueryError);
    assert.throws(
      () => parsePathQuery('PATHS ALL SHORTEST START ?s END ?e VIA ?p'),
      /Only one/u,
    );
    assert.throws(
      () => parsePathQuery('PATHS START ?s END ?e VIA { ?s <urn:edge> ?other }'),
      /both endpoint variables/u,
    );
    assert.throws(
      () => parsePathQuery('PATHS START ?s { ?s ?p } END ?e VIA ?p'),
      /Invalid SPARQL graph pattern/u,
    );
  });
});
