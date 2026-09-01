import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { QueryEngine } from '../dist/index.js';

const EX = 'https://example.org/';

const sources = [{
  type: 'serialized',
  mediaType: 'application/n-triples',
  baseIRI: `${EX}instrumented`,
  value: `
    <${EX}a> <${EX}edge> <${EX}b> .
    <${EX}a> <${EX}edge> <${EX}c> .
    <${EX}b> <${EX}edge> <${EX}d> .
    <${EX}c> <${EX}edge> <${EX}d> .
  `,
}];

const spec = {
  prologue: `PREFIX ex: <${EX}>`,
  start: { pattern: 'VALUES ?from { ex:a }', node: '?from' },
  end: { pattern: 'VALUES ?to { ex:d }', node: '?to' },
  via: { pattern: '?from ex:edge ?to' },
  mode: 'all',
  maxDepth: 2,
};

describe('traversal instrumentation', () => {
  it('reports per-depth counters and timings on the physical plan', async () => {
    const { data } = await new QueryEngine().explainPaths(spec, { sources }, 'physical-json');
    const { traversal } = data;

    assert.ok(traversal, JSON.stringify(data));
    assert.equal(typeof traversal.totalMs, 'number');
    assert.equal(typeof traversal.firstPathMs, 'number');
    assert.deepEqual(traversal.depths.map(depth => depth.depth), [ 1, 2 ]);

    const [ first, second ] = traversal.depths;
    // Two edges leave ex:a, and neither of them ends at ex:d.
    assert.equal(first.edges, 2);
    assert.equal(first.statesOut, 2);
    assert.equal(first.endpointMatches, 0);
    assert.equal(first.joinedEnd, false);
    // Both of them reach ex:d, which is where the depth bound puts END. The two
    // partial paths meet on that one node, and endpoints are counted by node.
    assert.equal(second.frontierNodes, 2);
    assert.equal(second.statesIn, 2);
    assert.equal(second.statesOut, 2);
    assert.equal(second.endpointCandidates, 1);
    assert.equal(second.endpointMatches, 1);
    assert.equal(second.joinedEnd, true);
    assert.equal(second.emitted, 2);

    for (const depth of traversal.depths) {
      for (const field of [ 'sourceMs', 'endpointMs', 'downstreamMs', 'workMs', 'depthMs' ]) {
        assert.equal(typeof depth[field], 'number', field);
        assert.ok(depth[field] >= 0, `${field} of depth ${depth.depth}`);
      }
      assert.ok(depth.sourceMs + depth.workMs <= depth.depthMs + 1);
    }
  });

  it('reports what a cancelled traversal managed to do', async () => {
    const stream = await new QueryEngine().queryPaths(spec, { sources });
    // No plan was asked for, so nothing is measured and nothing is published.
    assert.equal(stream.getProperty('metadata').traversal, undefined);
    stream.destroy();
  });
});

describe('browser entry point', () => {
  it('omits only the export a browser cannot load', async () => {
    const full = await import('../dist/index.js');
    const browser = await import('../dist/index-browser.js');

    assert.ok(full.QueryEngineFactory);
    assert.equal(browser.QueryEngineFactory, undefined);
    assert.deepEqual(
      Object.keys(full).filter(name => name !== 'QueryEngineFactory').sort(),
      Object.keys(browser).sort(),
    );
    assert.ok(new browser.QueryEngine());
  });

  it('never pulls the Components.js factory into the browser module graph', async () => {
    // In a fresh process, so that nothing another test loaded is mistaken for
    // part of this module graph.
    const entry = fileURLToPath(new URL('../dist/index-browser.js', import.meta.url));
    const loaded = execFileSync(process.execPath, [
      '-e',
      `require(${JSON.stringify(entry)}); console.log(Object.keys(require.cache).join('\\n'))`,
    ], { encoding: 'utf8' }).split('\n');

    assert.ok(loaded.some(path => path.endsWith('index-browser.js')));
    assert.ok(
      !loaded.some(path => path.endsWith('QueryEngineFactory.js')),
      'the browser entry must not reach the Components.js factory',
    );

    // In Node, `@comunica/actor-init-query` resolves to its full entry point, so
    // its own factory is always in the graph; a bundler substitutes the browser
    // entry that omits it. What has to hold on this side of that substitution is
    // that nothing this package loads in a browser names the factory it drops.
    const own = loaded.filter(path => path.startsWith(fileURLToPath(new URL('../dist/', import.meta.url))));
    assert.ok(own.length > 1);
    for (const path of own) {
      assert.doesNotMatch(
        await readFile(path, 'utf8'),
        /QueryEngineFactoryBase/u,
        `${path} would break a browser build`,
      );
    }
  });

  it('routes bundlers to that entry point', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    assert.deepEqual(manifest.exports['.'].browser, {
      types: './dist/index-browser.d.ts',
      default: './dist/index-browser.js',
    });
    // The condition has to be offered before the general-purpose ones, since the
    // first matching condition wins.
    assert.equal(Object.keys(manifest.exports['.'])[0], 'browser');
    assert.deepEqual(manifest.browser, { './dist/index.js': './dist/index-browser.js' });
  });
});

/**
 * Eight partial paths converge on one node, so one outgoing edge from it
 * multiplies into eight, and one endpoint recurs across every batch of a depth.
 */
const convergent = [{
  type: 'serialized',
  mediaType: 'application/n-triples',
  baseIRI: `${EX}convergent`,
  value: [
    ...Array.from({ length: 8 }, (_, index) => `<${EX}a> <${EX}edge> <${EX}b${index}> .`),
    ...Array.from({ length: 8 }, (_, index) => `<${EX}b${index}> <${EX}edge> <${EX}x> .`),
    `<${EX}x> <${EX}edge> <${EX}y> .`,
  ].join('\n'),
}];

function convergentSpec(overrides) {
  return {
    prologue: `PREFIX ex: <${EX}>`,
    start: { pattern: 'VALUES ?from { ex:a }', node: '?from' },
    end: { pattern: 'VALUES ?to { ex:y }', node: '?to' },
    via: { pattern: '?from ex:edge ?to' },
    mode: 'all',
    maxDepth: 3,
    ...overrides,
  };
}

describe('bounded work under a small limit', () => {
  it('stops multiplying prefixes as soon as a batch is full', async () => {
    const { data } = await new QueryEngine()
      .explainPaths(convergentSpec({ maxPaths: 1 }), { sources: convergent }, 'physical-json');
    const last = data.traversal.depths.at(-1);

    assert.equal(last.depth, 3);
    // The single edge leaving ex:x extends all eight partial paths sitting on
    // it. One path was asked for, so only one of those extensions may be built.
    assert.equal(last.statesOut, 1, JSON.stringify(data.traversal.depths));
  });

  it('counts an endpoint node once a depth, not once a batch', async () => {
    const { data } = await new QueryEngine()
      .explainPaths(convergentSpec({ maxPaths: 1 }), { sources: convergent }, 'physical-json');
    const second = data.traversal.depths.find(depth => depth.depth === 2);

    // Every one of the eight edges of this depth ends on ex:x, and a limit of one
    // makes the batches small enough that several of them contain it. None of
    // that changes how many endpoint nodes the depth had, which is one.
    assert.equal(second.statesOut, 8);
    assert.equal(second.endpointCandidates, 1, JSON.stringify(second));
    assert.equal(second.endpointMatches, 0);
  });

  it('reports the partial paths a shortest depth carried and produced', async () => {
    const { data } = await new QueryEngine().explainPaths(
      convergentSpec({ mode: 'shortest', end: { node: '?to' }}),
      { sources: convergent },
      'physical-json',
    );
    const [ first, second ] = data.traversal.depths;

    assert.equal(first.statesOut, 8, JSON.stringify(data.traversal.depths));
    // Eight partial paths sit on eight distinct nodes, all of which reach ex:x.
    assert.equal(second.frontierNodes, 8);
    assert.equal(second.statesIn, 8);
    assert.equal(second.statesOut, 1);
  });

  it('reports states a shortest frontier holds, not the nodes they sit on', async () => {
    // Two roots reach ex:x, so one frontier node carries two partial paths.
    const twoRoots = [{
      type: 'serialized',
      mediaType: 'application/n-triples',
      baseIRI: `${EX}two-roots`,
      value: `
        <${EX}a> <${EX}edge> <${EX}x> .
        <${EX}b> <${EX}edge> <${EX}x> .
        <${EX}x> <${EX}edge> <${EX}y> .
      `,
    }];
    const { data } = await new QueryEngine().explainPaths({
      prologue: `PREFIX ex: <${EX}>`,
      start: { pattern: 'VALUES ?from { ex:a ex:b }', node: '?from' },
      end: { node: '?to' },
      via: { pattern: '?from ex:edge ?to' },
      mode: 'shortest',
      maxDepth: 2,
    }, { sources: twoRoots }, 'physical-json');
    const second = data.traversal.depths.find(depth => depth.depth === 2);

    assert.equal(second.frontierNodes, 1);
    assert.equal(second.statesIn, 2, JSON.stringify(second));
  });
});

describe('planning only what a traversal can use', () => {
  it('does not plan the END join for a traversal that has no final depth', async () => {
    const { PathOperations } = await import('../dist/PathOperations.js');
    const create = PathOperations.create;
    let planned = 0;

    // Every planned pattern is parsed exactly once, so counting parses counts
    // the plans a request built.
    PathOperations.create = async function(args) {
      const processor = new Proxy(args.queryProcessor, {
        get: (target, property, receiver) => (property === 'parse' ?
          (...parseArgs) => {
            planned++;
            return target.parse(...parseArgs);
          } :
          Reflect.get(target, property, receiver)),
      });
      return create.call(this, { ...args, queryProcessor: processor });
    };

    const spec = {
      prologue: `PREFIX ex: <${EX}>`,
      start: { pattern: 'VALUES ?from { ex:a }', node: '?from' },
      end: { pattern: '?to ex:target ?flag', node: '?to' },
      via: { pattern: '?from ex:edge ?to' },
      mode: 'all',
    };
    const count = async(overrides) => {
      planned = 0;
      await (await new QueryEngine().queryPaths({ ...spec, ...overrides }, { sources })).toArray();
      return planned;
    };

    try {
      const unbounded = await count({});
      const bounded = await count({ maxDepth: 3 });

      // START, VIA, END, and START joined with VIA, for both. Only the bounded
      // one has a last depth for VIA joined with END to be evaluated at.
      assert.equal(unbounded, 4);
      assert.equal(bounded, 5);
      // A bound of zero admits no path at all, so it has no final depth either.
      assert.equal(await count({ maxDepth: 0 }), 4);
    } finally {
      PathOperations.create = create;
    }
  });
});
