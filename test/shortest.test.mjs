import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { QueryEngine } from '@comunica/query-sparql';
import { Parser } from 'sparqljs';
import { InvalidPathQueryError, PathQueryEngine } from '../dist/index.js';

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
    via: { pattern: '?from ex:edge ?to', from: '?from', to: '?to' },
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
    const engine = new PathQueryEngine(new QueryEngine(), { batchSize: 1 });
    const paths = await collect(engine.queryPaths(spec(), { sources }));

    assert.deepEqual(paths.map(nodePath).sort(), [ 'a-b-d', 'a-c-d' ]);
    assert.equal(paths[0].steps.length, 2);
    assert.equal(bindingValue(paths[0].endBindings, 'rank'), '1');
  });

  it('uses shortest semantics independently for every start/end pair', async () => {
    const engine = new PathQueryEngine(new QueryEngine());
    const paths = await collect(engine.queryPaths(spec({
      start: { pattern: 'VALUES ?start { ex:a ex:b }', node: '?start' },
    }), { sources }));

    assert.deepEqual(paths.map(nodePath).sort(), [ 'a-b-d', 'a-c-d', 'b-d' ]);
  });

  it('returns every reachable endpoint when END is unconstrained', async () => {
    const engine = new PathQueryEngine(new QueryEngine());
    const paths = await collect(engine.queryPaths(spec({ end: { node: '?end' }, maxDepth: 2 }), { sources }));

    assert.deepEqual(paths.map(nodePath).sort(), [
      'a-b',
      'a-b-d',
      'a-b-x',
      'a-c',
      'a-c-d',
    ]);
  });

  it('discovers starts from the first VIA evaluation when START is unconstrained', async () => {
    const engine = new PathQueryEngine(new QueryEngine());
    const paths = await collect(engine.queryPaths(spec({
      start: { node: '?start' },
      maxDepth: 1,
    }), { sources }));

    assert.deepEqual(paths.map(nodePath).sort(), [ 'b-d', 'c-d', 'x-d' ]);
  });

  it('honours zero and finite result limits', async () => {
    const engine = new PathQueryEngine(new QueryEngine());
    assert.deepEqual(await collect(engine.queryPaths(spec({ maxPaths: 0 }), { sources })), []);
    assert.equal((await collect(engine.queryPaths(spec({ end: { node: '?end' }, maxPaths: 2 }), { sources }))).length, 2);
    assert.deepEqual(await collect(engine.queryPaths(spec({ maxDepth: 0 }), { sources })), []);
  });

  it('returns shortest simple cycles rather than zero-length paths', async () => {
    const engine = new PathQueryEngine(new QueryEngine());
    const paths = await collect(engine.queryPaths(spec({
      end: { pattern: 'VALUES ?end { ex:a }', node: '?end' },
      maxDepth: 6,
    }), { sources }));

    assert.deepEqual(paths.map(nodePath).sort(), [ 'a-b-d-e-a', 'a-c-d-e-a' ]);
  });

  it('applies SPARQL compatibility to START and END pattern bindings', async () => {
    const engine = new PathQueryEngine(new QueryEngine());
    const incompatible = await collect(engine.queryPaths(spec({
      start: { pattern: 'VALUES (?start ?kind) { (ex:a ex:keep) }', node: '?start' },
      end: { pattern: 'VALUES (?end ?kind) { (ex:d ex:drop) }', node: '?end' },
    }), { sources }));
    const compatible = await collect(engine.queryPaths(spec({
      start: { pattern: 'VALUES (?start ?kind) { (ex:a ex:keep) }', node: '?start' },
      end: { pattern: 'VALUES (?end ?kind) { (ex:d ex:keep) }', node: '?end' },
    }), { sources }));

    assert.deepEqual(incompatible, []);
    assert.deepEqual(compatible.map(nodePath).sort(), [ 'a-b-d', 'a-c-d' ]);
  });

  it('submits parseable standard SPARQL with bounded VALUES batches', async () => {
    const delegate = new QueryEngine();
    const queries = [];
    const recordingEngine = {
      async queryBindings(query, context) {
        const parsed = new Parser({ sparqlStar: true }).parse(query);
        queries.push({ query, parsed });
        return delegate.queryBindings(query, context);
      },
    };
    const engine = new PathQueryEngine(recordingEngine, { batchSize: 1 });
    await collect(engine.queryPaths(spec(), { sources }));

    const frontierQueries = queries.filter(({ query }) => /VALUES\s+\?from/iu.test(query));
    assert.ok(frontierQueries.length >= 2);
    assert.ok(frontierQueries.every(({ parsed }) => parsed.where[0].values.length === 1));
  });

  it('rejects malformed path specifications before querying', async () => {
    const engine = new PathQueryEngine(new QueryEngine());
    await assert.rejects(
      async () => collect(engine.queryPaths(spec({ via: { pattern: '', from: '?x', to: '?x' } }), { sources })),
      InvalidPathQueryError,
    );
  });
});
