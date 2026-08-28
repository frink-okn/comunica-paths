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

  it('delegates frontier joins to the configured RDF-join mediator', async () => {
    const joins = [];
    const physicalQueryPlanLogger = {
      logOperation(logicalOperator, physicalOperator, node, _parentNode, actor) {
        if (logicalOperator === 'join-inner' && node.entries?.some(entry => entry.operationModified)) {
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
