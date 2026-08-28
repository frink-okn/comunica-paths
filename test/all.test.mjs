import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { QueryEngine } from '@comunica/query-sparql';
import { PathQueryCancelledError, PathQueryEngine } from '../dist/index.js';

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
    via: { pattern: '?from ex:edge ?to', from: '?from', to: '?to' },
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
    const engine = new PathQueryEngine(new QueryEngine());
    const paths = await collect(engine.queryPaths(spec(), { sources }));

    assert.deepEqual(paths.map(nodePath), [ 'a-b-d', 'a-c-d', 'a-b-x-d' ]);
  });

  it('allows only the closing repetition of a simple cycle', async () => {
    const engine = new PathQueryEngine(new QueryEngine());
    const paths = await collect(engine.queryPaths(spec({
      end: { pattern: 'VALUES ?end { ex:a }', node: '?end' },
      maxDepth: 6,
    }), { sources }));

    assert.deepEqual(paths.map(nodePath), [ 'a-b-d-e-a', 'a-c-d-e-a', 'a-b-x-d-e-a' ]);
    assert.ok(paths.every(path => new Set(path.nodes.slice(0, -1).map(term => term.value)).size === path.nodes.length - 1));
  });

  it('supports the CYCLIC mode independently of ordinary endpoints', async () => {
    const engine = new PathQueryEngine(new QueryEngine());
    const paths = await collect(engine.queryPaths(spec({
      end: { node: '?end' },
      cyclic: true,
      maxDepth: 4,
    }), { sources }));

    assert.deepEqual(paths.map(nodePath), [ 'a-b-d-e-a', 'a-c-d-e-a' ]);
  });

  it('combines CYCLIC with shortest-path selection', async () => {
    const engine = new PathQueryEngine(new QueryEngine());
    const paths = await collect(engine.queryPaths(spec({
      end: { node: '?end' },
      mode: 'shortest',
      cyclic: true,
      maxDepth: 6,
    }), { sources }));

    assert.deepEqual(paths.map(nodePath), [ 'a-b-d-e-a', 'a-c-d-e-a' ]);
  });

  it('applies OFFSET and LIMIT to the streamed path sequence', async () => {
    const engine = new PathQueryEngine(new QueryEngine());
    const allPaths = await collect(engine.queryPaths(spec(), { sources }));
    const window = await collect(engine.queryPaths(spec({ offset: 1, maxPaths: 1 }), { sources }));

    assert.equal(window.length, 1);
    assert.equal(nodePath(window[0]), nodePath(allPaths[1]));
  });

  it('cancels an active bindings stream through AbortSignal', async () => {
    const start = namedNode(`${EX}a`);
    let call = 0;
    let destroyed = false;
    const engine = new PathQueryEngine({
      async queryBindings() {
        if (call++ === 0) {
          return valuesStream([ bindings([ [ variable('start'), start ] ]) ]);
        }
        return {
          destroy() {
            destroyed = true;
          },
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise(() => {}),
              return: async () => ({ done: true }),
            };
          },
        };
      },
    });
    const controller = new AbortController();
    const iterator = engine.queryPaths(spec({ maxDepth: 1 }), {}, { signal: controller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();

    await assert.rejects(pending, PathQueryCancelledError);
    assert.equal(destroyed, true);
  });
});

function valuesStream(values) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}

function bindings(entries) {
  return new Map(entries);
}

function variable(value) {
  return {
    termType: 'Variable',
    value,
    equals(other) {
      return other?.termType === this.termType && other.value === this.value;
    },
  };
}

function namedNode(value) {
  return {
    termType: 'NamedNode',
    value,
    equals(other) {
      return other?.termType === this.termType && other.value === this.value;
    },
  };
}
