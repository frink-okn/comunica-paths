import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { InvalidPathQueryError, PathQueryCancelledError, QueryEngine as PathsQueryEngine } from '../dist/index.js';

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
    end: { pattern: 'VALUES ?end { ex:d }', node: '?end' },
    via: { pattern: '?start ex:edge ?end' },
    mode: 'all',
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

describe('all and cyclic path execution', () => {
  it('enumerates every simple path to the endpoint in breadth-first order', async () => {
    const engine = new PathsQueryEngine();
    const paths = await collect(await engine.queryPaths(spec(), { sources }));

    assert.deepEqual(paths.map(nodePath), [ 'a-b-d', 'a-c-d', 'a-b-x-d' ]);
  });

  it('allows only the closing repetition of a simple cycle', async () => {
    const engine = new PathsQueryEngine();
    const paths = await collect(await engine.queryPaths(spec({
      end: { pattern: 'VALUES ?end { ex:a }', node: '?end' },
      maxDepth: 6,
    }), { sources }));

    assert.deepEqual(paths.map(nodePath), [ 'a-b-d-e-a', 'a-c-d-e-a', 'a-b-x-d-e-a' ]);
    assert.ok(paths.every(path => new Set(path.nodes.slice(0, -1).map(term => term.value)).size === path.nodes.length - 1));
  });

  it('supports the CYCLIC mode independently of ordinary endpoints', async () => {
    const engine = new PathsQueryEngine();
    const paths = await collect(await engine.queryPaths(spec({
      end: { node: '?end' },
      cyclic: true,
      maxDepth: 4,
    }), { sources }));

    assert.deepEqual(paths.map(nodePath), [ 'a-b-d-e-a', 'a-c-d-e-a' ]);
  });

  it('combines CYCLIC with shortest-path selection', async () => {
    const engine = new PathsQueryEngine();
    const paths = await collect(await engine.queryPaths(spec({
      end: { node: '?end' },
      mode: 'shortest',
      cyclic: true,
      maxDepth: 6,
    }), { sources }));

    assert.deepEqual(paths.map(nodePath), [ 'a-b-d-e-a', 'a-c-d-e-a' ]);
  });

  it('applies OFFSET and LIMIT to the streamed path sequence', async () => {
    const engine = new PathsQueryEngine();
    const allPaths = await collect(await engine.queryPaths(spec(), { sources }));
    const window = await collect(await engine.queryPaths(spec({ offset: 1, maxPaths: 1 }), { sources }));

    assert.equal(window.length, 1);
    assert.equal(nodePath(window[0]), nodePath(allPaths[1]));
  });

  it('cancels an in-flight traversal and aborts the request behind it', async () => {
    let sawViaRequest;
    const viaRequested = new Promise((resolve) => {
      sawViaRequest = resolve;
    });
    const fetch = async(input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const query = url.searchParams.get('query') ?? new URLSearchParams(init.body ?? '').get('query');
      // Answer planning and endpoint traversal alike, but never complete the
      // traversal request, so that the abort lands on an in-flight stream.
      if (query?.includes(`<${EX}edge>`)) {
        sawViaRequest(init.signal);
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return new Response(JSON.stringify({ head: { vars: []}, results: { bindings: []}}), {
        headers: { 'content-type': 'application/sparql-results+json' },
      });
    };

    const controller = new AbortController();
    const stream = await new PathsQueryEngine().queryPaths({
      prologue: `PREFIX ex: <${EX}>`,
      start: { pattern: 'VALUES ?from { ex:a }', node: '?from' },
      end: { node: '?to' },
      via: { pattern: '?from ex:edge ?to' },
    }, {
      sources: [{ type: 'sparql', value: `${EX}sparql` }],
      fetch,
    }, { signal: controller.signal });
    const pending = collect(stream);

    const signal = await viaRequested;
    assert.ok(signal, 'Comunica should hand an abort signal to the HTTP layer');
    controller.abort();

    await assert.rejects(pending, PathQueryCancelledError);
    assert.equal(signal.aborted, true, 'cancelling must reach the pending request');
  });

  it('stops the traversal when the consumer destroys the stream', async () => {
    const stream = await new PathsQueryEngine().queryPaths(spec(), { sources });
    const iterator = stream[Symbol.asyncIterator]();

    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.ok(first.value.nodes.length > 0);

    stream.destroy();
    assert.equal(stream.done, true);
    assert.equal((await iterator.next()).done, true);
  });

  it('does not silently ignore an unsupported algorithm discriminator', async () => {
    const engine = new PathsQueryEngine();
    await assert.rejects(
      engine.queryPaths(spec(), { sources }, { algorithm: 'not-installed' }),
      /only supports the 'bfs' path algorithm/u,
    );
  });
});
