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

describe('Components.js path engine', () => {
  it('supports ordinary SPARQL and path queries on the same configured engine', async () => {
    const sources = [
      source(`<${EX}a> <${EX}edge> <${EX}b> .`, 'left'),
      source(`<${EX}b> <${EX}edge> <${EX}d> .`, 'right'),
    ];
    const engine = new QueryEngine();

    const paths = await collect(engine.queryPaths(spec(), { sources }));
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

    const paths = await collect(new QueryEngine().queryPaths(spec(), context));

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

    const paths = await collect(new QueryEngine().queryPaths(spec({
      end: { pattern: 'VALUES ?end { ex:d ex:wrong }', node: '?end' },
    }), { sources }));

    assert.equal(paths.length, 1);
    assert.equal(paths[0].nodes[1].termType, 'BlankNode');
    assert.equal(paths[0].nodes[2].value, `${EX}d`);
  });

  it('uses one initialized context for request-scoped SPARQL values', async () => {
    const paths = await collect(new QueryEngine().queryPaths(spec({
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

    const paths = await collect(new QueryEngine().queryPaths(spec({ mode: 'all', maxDepth: 2 }), {
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

    const paths = await collect(new QueryEngine().queryPaths(spec({
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
      (await collect(engine.queryPaths(spec(), { sources }, { algorithm: 'bfs' }))).map(nodePath),
      [ 'a-d' ],
    );
    await assert.rejects(
      collect(engine.queryPaths(spec(), { sources }, { algorithm: 'not-installed' })),
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

    await collect(engine.queryPaths(spec(), {
      sources: [ source(`<${EX}a> <${EX}edge> <${EX}d> .`, 'lifecycle') ],
      invalidateCache: true,
      log: logger,
    }));

    assert.equal(invalidations, 1);
    assert.equal(flushes, 1);
  });

  it('can instantiate the path-enabled actor graph dynamically', async () => {
    const engine = await new QueryEngineFactory().create();
    const paths = await collect(engine.queryPathString(`
      PREFIX ex: <${EX}>
      PATHS START ?from = ex:a END ?to = ex:d VIA ex:edge
    `, {
      sources: [ source(`<${EX}a> <${EX}edge> <${EX}d> .`, 'factory') ],
    }));

    assert.deepEqual(paths.map(nodePath), [ 'a-d' ]);
  });

  it('propagates cancellation through the actor-backed result stream', async () => {
    const controller = new AbortController();
    const paths = new QueryEngine().queryPaths(spec({
      end: { node: '?end' },
      maxDepth: 2,
    }), {
      sources: [ source(`
        <${EX}a> <${EX}edge> <${EX}b> .
        <${EX}a> <${EX}edge> <${EX}c> .
        <${EX}b> <${EX}edge> <${EX}d> .
      `, 'cancel') ],
    }, { signal: controller.signal })[Symbol.asyncIterator]();

    assert.equal((await paths.next()).done, false);
    controller.abort();
    await assert.rejects(paths.next(), PathQueryCancelledError);
  });
});
