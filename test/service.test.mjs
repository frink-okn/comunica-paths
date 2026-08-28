import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { QueryEngine } from '@comunica/query-sparql';
import { InvalidPathQueryError, parsePathServiceQuery, PathQueryEngine } from '../dist/index.js';

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

function serviceQuery(extra = '') {
  return `
    PREFIX ex: <${EX}>
    PREFIX path: <urn:comunica:paths:>
    SELECT * WHERE {
      SERVICE <urn:comunica:paths> {
        GRAPH path:start { VALUES ?from { ex:a } }
        GRAPH path:end { VALUES ?to { ex:d } }
        GRAPH path:via { ?from ex:edge ?to }
        VALUES (?__path_start ?__path_end ?__path_mode ?__path_cyclic ?__path_maxLength) {
          ("from" "to" "all" false 3)
        }
      }
    }
    ${extra}
  `;
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function nodePath(path) {
  return path.nodes.map(term => term.value.replace(EX, '')).join('-');
}

describe('standard SPARQL SERVICE tunnel', () => {
  it('decodes reserved graphs and configuration into a path query', () => {
    const parsed = parsePathServiceQuery(serviceQuery('LIMIT 2 OFFSET 1'));

    assert.equal(parsed.start.node, '?from');
    assert.match(parsed.start.pattern, /VALUES \?from/u);
    assert.match(parsed.end.pattern, /VALUES \?to/u);
    assert.match(parsed.via.pattern, /<https:\/\/example\.org\/edge>/u);
    assert.equal(parsed.mode, 'all');
    assert.equal(parsed.cyclic, false);
    assert.equal(parsed.maxDepth, 3);
    assert.equal(parsed.maxPaths, 2);
    assert.equal(parsed.offset, 1);
  });

  it('executes a tunneled request without modifying Comunica', async () => {
    const engine = new PathQueryEngine(new QueryEngine());
    const paths = await collect(engine.queryPathService(serviceQuery(), { sources }));

    assert.deepEqual(paths.map(nodePath), [ 'a-b-d', 'a-c-d', 'a-b-x-d' ]);
  });

  it('rejects envelopes that could otherwise be silently misinterpreted', () => {
    assert.throws(
      () => parsePathServiceQuery('SELECT * WHERE { ?s ?p ?o }'),
      /exactly one SERVICE/u,
    );
    assert.throws(
      () => parsePathServiceQuery('SELECT ?x WHERE { SERVICE <urn:comunica:paths> { ?s ?p ?o } }'),
      /SELECT \*/u,
    );
    assert.throws(
      () => parsePathServiceQuery(`
        SELECT * WHERE {
          SERVICE <urn:comunica:paths> {
            GRAPH <urn:comunica:paths:via> { ?from ?p ?to }
          }
        }
      `),
      InvalidPathQueryError,
    );
  });
});

