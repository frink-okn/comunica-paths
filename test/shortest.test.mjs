import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { InvalidPathQueryError, QueryEngine as PathsQueryEngine } from '../dist/index.js';

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

function spec(overrides = {}) {
  return {
    prologue: `PREFIX ex: <${EX}>`,
    start: { pattern: 'VALUES ?start { ex:a }', node: '?start' },
    end: { pattern: '?end ex:target true; ex:rank ?rank', node: '?end' },
    via: { pattern: '?start ex:edge ?end' },
    ...overrides,
  };
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

function bindingValue(bindings, name) {
  for (const [ variable, term ] of bindings) {
    if (variable.value === name) {
      return term.value;
    }
  }
  return undefined;
}

describe('shortest path execution', () => {
  it('finds every shortest path across a two-source federation', async () => {
    const engine = new PathsQueryEngine();
    const paths = await collect(await engine.queryPaths(spec(), { sources }));

    assert.deepEqual(paths.map(nodePath).sort(), [ 'a-b-d', 'a-c-d' ]);
    assert.equal(paths[0].steps.length, 2);
    assert.equal(bindingValue(paths[0].endBindings, 'rank'), '1');
  });

  it('uses shortest semantics independently for every start/end pair', async () => {
    const engine = new PathsQueryEngine();
    const paths = await collect(await engine.queryPaths(spec({
      start: { pattern: 'VALUES ?start { ex:a ex:b }', node: '?start' },
    }), { sources }));

    assert.deepEqual(paths.map(nodePath).sort(), [ 'a-b-d', 'a-c-d', 'b-d' ]);
  });

  it('returns every reachable endpoint when END is unconstrained', async () => {
    const engine = new PathsQueryEngine();
    const paths = await collect(await engine.queryPaths(spec({ end: { node: '?end' }, maxDepth: 2 }), { sources }));

    assert.deepEqual(paths.map(nodePath).sort(), [
      'a-b',
      'a-b-d',
      'a-b-x',
      'a-c',
      'a-c-d',
    ]);
  });

  it('discovers starts from the first VIA evaluation when START is unconstrained', async () => {
    const engine = new PathsQueryEngine();
    const paths = await collect(await engine.queryPaths(spec({
      start: { node: '?start' },
      maxDepth: 1,
    }), { sources }));

    assert.deepEqual(paths.map(nodePath).sort(), [ 'b-d', 'c-d', 'x-d' ]);
  });

  it('honours zero and finite result limits', async () => {
    const engine = new PathsQueryEngine();
    assert.deepEqual(await collect(await engine.queryPaths(spec({ maxPaths: 0 }), { sources })), []);
    assert.equal((await collect(await engine.queryPaths(spec({ end: { node: '?end' }, maxPaths: 2 }), { sources }))).length, 2);
    assert.deepEqual(await collect(await engine.queryPaths(spec({ maxDepth: 0 }), { sources })), []);
  });

  it('returns shortest simple cycles rather than zero-length paths', async () => {
    const engine = new PathsQueryEngine();
    const paths = await collect(await engine.queryPaths(spec({
      end: { pattern: 'VALUES ?end { ex:a }', node: '?end' },
      maxDepth: 6,
    }), { sources }));

    assert.deepEqual(paths.map(nodePath).sort(), [ 'a-b-d-e-a', 'a-c-d-e-a' ]);
  });

  it('applies SPARQL compatibility to START and END pattern bindings', async () => {
    const engine = new PathsQueryEngine();
    const incompatible = await collect(await engine.queryPaths(spec({
      start: { pattern: 'VALUES (?start ?kind) { (ex:a ex:keep) }', node: '?start' },
      end: { pattern: 'VALUES (?end ?kind) { (ex:d ex:drop) }', node: '?end' },
    }), { sources }));
    const compatible = await collect(await engine.queryPaths(spec({
      start: { pattern: 'VALUES (?start ?kind) { (ex:a ex:keep) }', node: '?start' },
      end: { pattern: 'VALUES (?end ?kind) { (ex:d ex:keep) }', node: '?end' },
    }), { sources }));

    assert.deepEqual(incompatible, []);
    assert.deepEqual(compatible.map(nodePath).sort(), [ 'a-b-d', 'a-c-d' ]);
  });

  it('submits one whole frontier per depth as a single mediated join', async () => {
    const endpointQueries = [];
    const fetch = async(input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const query = url.searchParams.get('query') ?? new URLSearchParams(init.body).get('query');
      endpointQueries.push(query);

      if (query.includes(`<${EX}edge>`)) {
        // The first depth fans out to three nodes; the second closes on the target.
        const fanOut = /VALUES[^}]*\bstart\b/u.test(query) || query.includes(`<${EX}a>`);
        return sparqlJson([ 'from', 'to' ], fanOut && !query.includes(`<${EX}f1>`) ?
          [ 'f1', 'f2', 'f3' ].map(to => ({
            start: { type: 'uri', value: `${EX}a` },
            end: { type: 'uri', value: `${EX}${to}` },
          })) :
          [ 'f1', 'f2', 'f3' ].map(from => ({
            start: { type: 'uri', value: `${EX}${from}` },
            end: { type: 'uri', value: `${EX}d` },
          })));
      }
      return sparqlJson([ 'end' ], [{ end: { type: 'uri', value: `${EX}d` }}]);
    };

    const paths = await collect(await new PathsQueryEngine().queryPaths({
      prologue: `PREFIX ex: <${EX}>`,
      start: { pattern: 'VALUES ?start { ex:a }', node: '?start' },
      end: { pattern: 'VALUES ?end { ex:d }', node: '?end' },
      via: { pattern: '?start ex:edge ?end' },
    }, { sources: [{ type: 'sparql', value: `${EX}sparql` }], fetch }));

    assert.deepEqual(paths.map(nodePath).sort(), [ 'a-f1-d', 'a-f2-d', 'a-f3-d' ]);
    const viaQueries = endpointQueries.filter(query => query.includes(`<${EX}edge>`));
    assert.equal(viaQueries.length, 2, endpointQueries.join('\n---\n'));
    // The whole three-node frontier travels in one request, not one request per node.
    const secondDepth = viaQueries[1];
    for (const node of [ 'f1', 'f2', 'f3' ]) {
      assert.match(secondDepth, new RegExp(`${EX}${node}>`, 'u'), secondDepth);
    }
  });

  it('stops after completing the shortest layer for a fixed END', async () => {
    const engine = new PathsQueryEngine();
    const stream = await engine.queryPaths(spec({
      end: { pattern: 'VALUES ?end { ex:d }', node: '?end' },
      maxDepth: 4,
      maxPaths: 5,
    }), { sources });
    const paths = await collect(stream);

    assert.deepEqual(paths.map(nodePath).sort(), [ 'a-b-d', 'a-c-d' ]);
    // Both targets settle at depth two, so the depth-three frontier is never expanded.
    assert.equal(stream.getProperty('metadata').depth, 2);
  });

  it('does not expand a second layer after finding a direct fixed END', async () => {
    const engine = new PathsQueryEngine();
    const stream = await engine.queryPaths(spec({
      end: { pattern: 'VALUES ?end { ex:b }', node: '?end' },
      maxDepth: 4,
      maxPaths: 5,
    }), { sources });
    const paths = await collect(stream);

    assert.deepEqual(paths.map(nodePath), [ 'a-b' ]);
    assert.equal(stream.getProperty('metadata').depth, 1);
  });

  it('reports a cardinality estimate that becomes exact when the stream ends', async () => {
    const engine = new PathsQueryEngine();
    const stream = await engine.queryPaths(spec(), { sources });

    assert.equal(stream.getProperty('metadata').cardinality.type, 'estimate');
    const paths = await collect(stream);
    assert.deepEqual(stream.getProperty('metadata').cardinality, {
      type: 'exact',
      value: paths.length,
    });
  });

  it('carries blank-node frontiers through Comunica initial bindings', async () => {
    const left = {
      type: 'serialized',
      value: `
        <${EX}root> <${EX}edge> _:shared .
        _:shared <${EX}edge> <${EX}end> .
      `,
      mediaType: 'application/n-triples',
      baseIRI: `${EX}blank-left`,
    };
    const right = {
      type: 'serialized',
      value: `_:shared <${EX}edge> <${EX}wrong> .`,
      mediaType: 'application/n-triples',
      baseIRI: `${EX}blank-right`,
    };
    const engine = new PathsQueryEngine();
    const paths = await collect(await engine.queryPaths(spec({
      start: { pattern: 'VALUES ?start { ex:root }', node: '?start' },
      end: { pattern: 'VALUES ?end { ex:end ex:wrong }', node: '?end' },
      maxDepth: 2,
    }), { sources: [ left, right ] }));

    assert.equal(paths.length, 1);
    assert.equal(paths[0].nodes[1].termType, 'BlankNode');
    assert.equal(paths[0].nodes[2].value, `${EX}end`);
  });

  it('matches blank-node END candidates through Comunica initial bindings', async () => {
    const source = {
      type: 'serialized',
      value: `
        <${EX}root> <${EX}edge> _:target .
        _:target <${EX}target> true .
      `,
      mediaType: 'application/n-triples',
      baseIRI: `${EX}blank-end`,
    };
    const engine = new PathsQueryEngine();
    const paths = await collect(await engine.queryPaths(spec({
      start: { pattern: 'VALUES ?start { ex:root }', node: '?start' },
      end: { pattern: '?end ex:target true', node: '?end' },
      maxDepth: 1,
    }), { sources: [ source ] }));

    assert.equal(paths.length, 1);
    assert.equal(paths[0].nodes[1].termType, 'BlankNode');
  });

  it('rejects malformed path specifications before querying', async () => {
    const engine = new PathsQueryEngine();
    await assert.rejects(
      async () => collect(await engine.queryPaths(spec({ via: { pattern: '' } }), { sources })),
      InvalidPathQueryError,
    );
  });
});

function sparqlJson(vars, bindings) {
  return new Response(JSON.stringify({ head: { vars }, results: { bindings }}), {
    headers: { 'content-type': 'application/sparql-results+json' },
  });
}
