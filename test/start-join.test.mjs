import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { QueryEngine } from '../dist/index.js';

const EX = 'https://example.org/';

const federated = [
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

function inline(value, name) {
  return { type: 'serialized', value, mediaType: 'text/turtle', baseIRI: `${EX}${name}` };
}

function planNodes(node, collected = []) {
  if (!node || typeof node !== 'object') {
    return collected;
  }
  if (node.logical) {
    collected.push(node);
  }
  for (const child of [ ...node.children ?? [], ...node.childrenCompact ?? [] ]) {
    planNodes(child.firstOccurrence ?? child, collected);
  }
  return collected;
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

/** Whether START reached Comunica joined with VIA rather than on its own. */
async function joinedStart(spec, context) {
  const { data } = await new QueryEngine().explainPaths(spec, context, 'physical-json');
  return planNodes(data).every(node => node.logical !== 'paths-start');
}

describe('joining START into the first depth', () => {
  it('plans the joined first depth across a federation', async () => {
    const spec = {
      prologue: `PREFIX ex: <${EX}>`,
      // Matches in both sources, so the joined pattern has to survive source
      // assignment over more than one source.
      start: { pattern: '?start ex:edge ex:d', node: '?start' },
      end: { pattern: '?end ex:target true', node: '?end' },
      via: { pattern: '?start ex:edge ?end' },
    };

    assert.equal(await joinedStart(spec, { sources: federated }), true);
    const paths = await collect(await new QueryEngine().queryPaths(spec, { sources: federated }));
    assert.deepEqual([ ...new Set(paths.map(nodePath)) ].sort(), [ 'b-d', 'c-d', 'x-d' ]);
  });

  it('composes a START that is a sub-select or carries a filter', async () => {
    const base = {
      prologue: `PREFIX ex: <${EX}>`,
      end: { pattern: '?end ex:target true', node: '?end' },
      via: { pattern: '?start ex:edge ?end' },
    };
    // All three describe the same single start node, so all three must agree.
    const forms = {
      values: 'VALUES ?start { ex:a }',
      filtered: '?start ex:edge ex:b . FILTER(?start != ex:z)',
      subSelect: '{ SELECT ?start WHERE { ?start ex:edge ex:b } }',
    };

    const results = {};
    for (const [ name, pattern ] of Object.entries(forms)) {
      const spec = { ...base, start: { pattern, node: '?start' }};
      assert.equal(await joinedStart(spec, { sources: federated }), true, name);
      results[name] = (await collect(await new QueryEngine().queryPaths(spec, { sources: federated })))
        .map(nodePath).sort();
    }
    assert.deepEqual(results.filtered, results.values);
    assert.deepEqual(results.subSelect, results.values);
    assert.ok(results.values.length > 0);
  });

  it('carries a blank-node start through the joined first depth', async () => {
    const sources = [ inline(`
      @prefix ex: <${EX}> .
      [] a ex:Person ; ex:edge ex:d .
      ex:d ex:target true .
    `, 'blank-start') ];
    const spec = {
      prologue: `PREFIX ex: <${EX}>`,
      start: { pattern: '?start a ex:Person', node: '?start' },
      end: { pattern: '?end ex:target true', node: '?end' },
      via: { pattern: '?start ex:edge ?end' },
    };

    assert.equal(await joinedStart(spec, { sources }), true);
    const paths = await collect(await new QueryEngine().queryPaths(spec, { sources }));
    assert.equal(paths.length, 1);
    assert.equal(paths[0].nodes[0].termType, 'BlankNode');
    assert.equal(paths[0].nodes[1].value, `${EX}d`);
    assert.equal(paths[0].startBindings.get('start').termType, 'BlankNode');
  });

  it('admits no path and asks nothing of a source when no edge may be taken', async () => {
    const requests = [];
    const fetch = async(input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      let query = url.searchParams.get('query');
      if (!query && init.body !== undefined) {
        query = new URLSearchParams(String(init.body)).get('query');
      }
      query ??= '';
      const json = body => new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/sparql-results+json' },
      });
      if (/^\s*ASK/imu.test(query)) {
        return json({ head: {}, boolean: true });
      }
      requests.push(query);
      return json({ head: { vars: []}, results: { bindings: []}});
    };

    // A joined START and a materialized one must agree: neither may emit a path
    // of no edges, and neither should evaluate a clause to discover that.
    for (const start of [ '?start a ex:Person', '?start a ex:Person . ?start ex:name ?n' ]) {
      requests.length = 0;
      const stream = await new QueryEngine().queryPaths({
        prologue: `PREFIX ex: <${EX}>`,
        start: { pattern: start, node: '?start' },
        end: { node: '?end' },
        via: { pattern: '?start ex:edge ?end' },
        maxDepth: 0,
      }, { sources: [{ type: 'sparql', value: `${EX}sparql` }], fetch });

      assert.deepEqual(await collect(stream), [], start);
      assert.equal(stream.getProperty('metadata').depth, 0, start);
      assert.deepEqual(requests, [], start);
    }
  });
});
