import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KeysInitQuery } from '@comunica/context-entries';
import { ActionContext } from '@comunica/core';
import { PathQueryCancelledError, QueryEngine, QueryEngineFactory } from '../dist/index.js';

const EX = 'https://example.org/';

function source(value, name) {
  return {
    type: 'serialized',
    value,
    mediaType: 'application/n-triples',
    baseIRI: `${EX}${name}`,
  };
}

function spec(overrides = {}) {
  return {
    prologue: `PREFIX ex: <${EX}>`,
    start: { pattern: 'VALUES ?start { ex:a }', node: '?start' },
    end: { pattern: 'VALUES ?end { ex:d }', node: '?end' },
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

/** Flatten a physical query plan, following both plain and compacted children. */
function planNodes(node, collected = []) {
  if (!node || typeof node !== 'object') {
    return collected;
  }
  if (node.logical) {
    collected.push(node);
  }
  for (const child of node.children ?? []) {
    planNodes(child, collected);
  }
  for (const child of node.childrenCompact ?? []) {
    planNodes(child.firstOccurrence, collected);
  }
  return collected;
}

describe('Components.js path engine', () => {
  it('supports ordinary SPARQL and path queries on the same configured engine', async () => {
    const sources = [
      source(`<${EX}a> <${EX}edge> <${EX}b> .`, 'left'),
      source(`<${EX}b> <${EX}edge> <${EX}d> .`, 'right'),
    ];
    const engine = new QueryEngine();

    const paths = await collect(await engine.queryPaths(spec(), { sources }));
    const rows = await collect(await engine.queryBindings(
      `SELECT * WHERE { ?s <${EX}edge> ?o }`,
      { sources },
    ));

    assert.deepEqual(paths.map(nodePath), [ 'a-b-d' ]);
    assert.equal(rows.length, 2);
  });

  it('delegates frontier joins to Comunica query planning', async () => {
    const joins = [];
    const physicalQueryPlanLogger = {
      logOperation(logicalOperator, physicalOperator, node, _parentNode, actor) {
        if (logicalOperator === 'join-inner') {
          joins.push({ actor, physicalOperator });
        }
      },
      stashChildren() {},
      unstashChild() {},
      appendMetadata() {},
      toJson() {
        return {};
      },
    };
    let context = new ActionContext({
      sources: [ source(`<${EX}a> <${EX}edge> <${EX}d> .`, 'join') ],
    });
    context = context.set(KeysInitQuery.physicalQueryPlanLogger, physicalQueryPlanLogger);

    const paths = await collect(await new QueryEngine().queryPaths(spec(), context));

    assert.equal(paths.length, 1);
    assert.ok(joins.length > 0);
    assert.ok(joins.every(join => join.actor.startsWith('urn:comunica:default:rdf-join/actors#')));
    assert.ok(joins.every(join => typeof join.physicalOperator === 'string'));
  });

  it('preserves source-scoped blank nodes between mediated joins', async () => {
    const sources = [
      source(`
        <${EX}a> <${EX}edge> _:shared .
        _:shared <${EX}edge> <${EX}d> .
      `, 'blank-left'),
      source(`_:shared <${EX}edge> <${EX}wrong> .`, 'blank-right'),
    ];

    const paths = await collect(await new QueryEngine().queryPaths(spec({
      end: { pattern: 'VALUES ?end { ex:d ex:wrong }', node: '?end' },
    }), { sources }));

    assert.equal(paths.length, 1);
    assert.equal(paths[0].nodes[1].termType, 'BlankNode');
    assert.equal(paths[0].nodes[2].value, `${EX}d`);
  });

  it('uses one initialized context for request-scoped SPARQL values', async () => {
    const paths = await collect(await new QueryEngine().queryPaths(spec({
      start: {
        pattern: 'VALUES ?start { ex:a } BIND(NOW() AS ?stamp)',
        node: '?start',
      },
      end: {
        pattern: 'VALUES ?end { ex:d } BIND(NOW() AS ?stamp)',
        node: '?end',
      },
    }), {
      sources: [ source(`<${EX}a> <${EX}edge> <${EX}d> .`, 'timestamp') ],
    }));

    assert.equal(paths.length, 1);
    assert.ok(paths[0].startBindings.get('stamp').equals(paths[0].endBindings.get('stamp')));
  });

  it('pushes frontier bindings into SPARQL endpoint graph patterns', async () => {
    const endpointQueries = [];
    const fetch = async(input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      let query = url.searchParams.get('query');
      if (!query && typeof init.body === 'string') {
        query = new URLSearchParams(init.body).get('query');
      }
      assert.ok(query, 'expected a SPARQL query in the endpoint request');
      endpointQueries.push(query);

      let vars;
      let bindings;
      if (query.includes(`<${EX}edge>`)) {
        vars = [ 'from', 'to' ];
        bindings = query.includes(`<${EX}d>`) ? [] : [
          {
            from: { type: 'uri', value: `${EX}a` },
            to: { type: 'uri', value: `${EX}d` },
          },
          {
            from: { type: 'uri', value: `${EX}a` },
            to: { type: 'bnode', value: 'remote-result' },
          },
          {
            from: { type: 'uri', value: `${EX}a` },
            to: { type: 'uri', value: `${EX}d` },
          },
        ];
      } else if (query.includes('?start')) {
        vars = [ 'start' ];
        bindings = [{ start: { type: 'uri', value: `${EX}a` } }];
      } else {
        vars = [ 'end' ];
        bindings = [{ end: { type: 'uri', value: `${EX}d` } }];
      }
      return new Response(JSON.stringify({
        head: { vars },
        results: { bindings },
      }), {
        headers: { 'content-type': 'application/sparql-results+json' },
      });
    };

    const paths = await collect(await new QueryEngine().queryPaths(spec({ mode: 'all', maxDepth: 2 }), {
      sources: [{ type: 'sparql', value: `${EX}sparql` }],
      fetch,
    }));

    assert.deepEqual(paths.map(nodePath), [ 'a-d' ], endpointQueries.join('\n---\n'));
    const viaQueries = endpointQueries.filter(query => query.includes(`<${EX}edge>`));
    assert.equal(viaQueries.length, 2, endpointQueries.join('\n---\n'));
    assert.equal(endpointQueries.length, viaQueries.length,
      'source-independent START and END forms should execute locally');
    for (const viaQuery of viaQueries) {
      assert.match(viaQuery, /VALUES\s+\?from/iu);
      assert.doesNotMatch(viaQuery, /\{\s*SELECT\b/iu);
      assert.doesNotMatch(viaQuery, /\bDISTINCT\b/iu);
    }
    assert.ok(endpointQueries.every(query => !query.includes('_:')),
      'remote blank nodes must not be sent back in a later query');
  });

  it('preserves source scope around multi-pattern endpoint joins', async () => {
    const endpointQueries = [];
    const fetch = async(input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      let query = url.searchParams.get('query');
      if (!query && typeof init.body === 'string') {
        query = new URLSearchParams(init.body).get('query');
      }
      assert.ok(query, 'expected a SPARQL query in the endpoint request');
      endpointQueries.push(query);

      let vars;
      let bindings;
      if (query.includes(`<${EX}cast>`)) {
        vars = [ 'from', 'work', 'to' ];
        bindings = [{
          from: { type: 'uri', value: `${EX}a` },
          work: { type: 'uri', value: `${EX}film` },
          to: { type: 'uri', value: `${EX}d` },
        }];
      } else if (query.includes('?start')) {
        vars = [ 'start' ];
        bindings = [{ start: { type: 'uri', value: `${EX}a` } }];
      } else {
        vars = [ 'end' ];
        bindings = [{ end: { type: 'uri', value: `${EX}d` } }];
      }
      return new Response(JSON.stringify({ head: { vars }, results: { bindings } }), {
        headers: { 'content-type': 'application/sparql-results+json' },
      });
    };

    const paths = await collect(await new QueryEngine().queryPaths(spec({
      via: {
        pattern: '?work ex:cast ?from . ?work ex:cast ?to',
        from: '?from',
        to: '?to',
      },
    }), {
      sources: [{ type: 'sparql', value: `${EX}sparql` }],
      fetch,
    }));

    assert.deepEqual(paths.map(nodePath), [ 'a-d' ], endpointQueries.join('\n---\n'));
    const viaQuery = endpointQueries.find(query => query.includes(`<${EX}cast>`));
    assert.ok(viaQuery);
    assert.match(viaQuery, /VALUES\s+\?from/iu);
    assert.doesNotMatch(viaQuery, /\{\s*SELECT\b/iu);
  });

  it('rejects algorithms not handled by the bundled BFS actor', async () => {
    const engine = new QueryEngine();
    const sources = [ source(`<${EX}a> <${EX}edge> <${EX}d> .`, 'algorithm') ];

    assert.deepEqual(
      (await collect(await engine.queryPaths(spec(), { sources }, { algorithm: 'bfs' }))).map(nodePath),
      [ 'a-d' ],
    );
    await assert.rejects(
      engine.queryPaths(spec(), { sources }, { algorithm: 'not-installed' }),
      /only supports the 'bfs' path algorithm/u,
    );
  });

  it('invalidates caches and flushes the initialized logger once per path request', async () => {
    let invalidations = 0;
    let flushes = 0;
    class InstrumentedEngine extends QueryEngine {
      async invalidateHttpCache() {
        invalidations++;
      }
    }
    const logger = {
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
      logGrouped(_key, emit) {
        emit(1);
      },
      flush() {
        flushes++;
      },
    };
    const engine = new InstrumentedEngine();

    await collect(await engine.queryPaths(spec(), {
      sources: [ source(`<${EX}a> <${EX}edge> <${EX}d> .`, 'lifecycle') ],
      invalidateCache: true,
      log: logger,
    }));

    assert.equal(invalidations, 1);
    assert.equal(flushes, 1);
  });

  it('explains a path query as a physical plan with a node per clause and depth', async () => {
    const engine = new QueryEngine();
    const sources = [
      source(`<${EX}a> <${EX}edge> <${EX}b> .\n<${EX}b> <${EX}edge> <${EX}d> .`, 'explain'),
    ];

    const explained = await engine.explainPaths(spec(), { sources }, 'physical-json');

    assert.equal(explained.explain, true);
    assert.equal(explained.type, 'physical-json');
    const nodes = planNodes(explained.data);
    assert.equal(nodes.filter(node => node.logical === 'paths').length, 1);
    // Each depth is reported separately, and nested under the path query rather
    // than as a disconnected root.
    assert.deepEqual(nodes.filter(node => node.logical === 'paths-via').map(node => node.depth), [ 1, 2 ]);
    assert.equal(nodes.filter(node => node.logical === 'paths-start').length, 1);
    assert.ok(nodes.some(node => node.logical === 'join-inner' && node.physical));

    const compact = await engine.explainPaths(spec(), { sources }, 'physical');
    assert.equal(compact.type, 'physical');
    assert.match(compact.data, /^paths\(bfs\)/u);
    assert.match(compact.data, /paths-via/u);
  });

  it('reports the parsed specification and refuses modes it cannot explain', async () => {
    const engine = new QueryEngine();

    const parsed = await engine.explainPathString(
      `PREFIX ex: <${EX}>\nPATHS START ?from = ex:a END ?to = ex:d VIA ex:edge`,
      undefined,
      'parsed',
    );
    assert.equal(parsed.explain, true);
    assert.equal(parsed.type, 'parsed');
    assert.equal(parsed.data.via.from, '?from');

    await assert.rejects(
      engine.explainPaths(spec(), { sources: []}, 'logical'),
      /cannot be explained in 'logical' mode/u,
    );
  });

  it('releases the logger and the abort listener when the stream is destroyed', async () => {
    let flushes = 0;
    const logger = {
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
      flush() {
        flushes++;
      },
    };
    const listeners = [];
    const signal = {
      aborted: false,
      addEventListener(type, listener) {
        listeners.push({ type, listener });
      },
      removeEventListener(type, listener) {
        const index = listeners.findIndex(entry => entry.type === type && entry.listener === listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      },
    };

    const stream = await new QueryEngine().queryPaths(spec(), {
      sources: [ source(`<${EX}a> <${EX}edge> <${EX}d> .`, 'teardown') ],
      log: logger,
    }, { signal });
    assert.equal(listeners.length, 1);

    // A destroyed iterator never emits 'end', so neither the flush nor the
    // listener removal may be hung off that event.
    stream.destroy();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(flushes, 1);
    assert.deepEqual(listeners, []);
  });

  it('submits a multi-pattern local VIA as one join holding the frontier', async () => {
    const explained = await new QueryEngine().explainPaths(spec({
      via: {
        pattern: '?work ex:cast ?from . ?work ex:cast ?to . ?work ex:year ?y',
        from: '?from',
        to: '?to',
      },
    }), {
      sources: [ source(`
        <${EX}w> <${EX}cast> <${EX}a> .
        <${EX}w> <${EX}cast> <${EX}d> .
        <${EX}w> <${EX}year> "2020" .
      `, 'nway') ],
    }, 'physical-json');

    const via = planNodes(explained.data).filter(node => node.logical === 'paths-via');
    assert.equal(via.length, 1);
    // The planned pattern's own join is flattened into the frontier join, so the
    // RDF-join bus weighs the frontier against each pattern rather than against
    // one opaque sub-join. A sub-join would evaluate as a second 'join' node.
    assert.equal(planNodes(via[0]).filter(node => node.logical === 'join').length, 1);
  });

  it('can instantiate the path-enabled actor graph dynamically', async () => {
    const engine = await new QueryEngineFactory().create();
    const paths = await collect(await engine.queryPathString(`
      PREFIX ex: <${EX}>
      PATHS START ?from = ex:a END ?to = ex:d VIA ex:edge
    `, {
      sources: [ source(`<${EX}a> <${EX}edge> <${EX}d> .`, 'factory') ],
    }));

    assert.deepEqual(paths.map(nodePath), [ 'a-d' ]);
  });

  it('propagates cancellation through the actor-backed result stream', async () => {
    // A complete graph keeps the traversal running well past the first result,
    // so the abort lands on a stream that is still producing.
    const triples = [];
    for (let from = 0; from < 8; from++) {
      for (let to = 0; to < 8; to++) {
        if (from !== to) {
          triples.push(`<${EX}${from}> <${EX}edge> <${EX}${to}> .`);
        }
      }
    }

    const controller = new AbortController();
    const stream = await new QueryEngine().queryPaths({
      prologue: `PREFIX ex: <${EX}>`,
      start: { pattern: 'VALUES ?start { ex:0 }', node: '?start' },
      end: { node: '?end' },
      via: { pattern: '?from ex:edge ?to', from: '?from', to: '?to' },
      mode: 'all',
      maxDepth: 6,
    }, {
      sources: [ source(triples.join('\n'), 'cancel') ],
    }, { signal: controller.signal });
    const paths = stream[Symbol.asyncIterator]();

    assert.equal((await paths.next()).done, false);
    controller.abort();
    await assert.rejects(paths.next(), PathQueryCancelledError);
  });
});
