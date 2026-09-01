import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryEngine } from '../dist/index.js';

const EX = 'https://example.org/';

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

/**
 * A diamond with a duplicated edge, a cycle, and a decorated endpoint.
 *
 * `a` reaches `d` at depth two through both `b` and `c`; `b` reaches `d` over
 * two differently typed edges, so one node pair carries more than one VIA
 * solution; and `d` has two labels, so END has more than one solution for one
 * node.
 */
const graph = {
  type: 'serialized',
  mediaType: 'application/n-triples',
  baseIRI: `${EX}final-depth`,
  value: `
    <${EX}a> <${EX}edge> <${EX}b> .
    <${EX}a> <${EX}edge> <${EX}c> .
    <${EX}b> <${EX}edge> <${EX}d> .
    <${EX}b> <${EX}also> <${EX}d> .
    <${EX}c> <${EX}edge> <${EX}d> .
    <${EX}d> <${EX}edge> <${EX}z> .
    <${EX}z> <${EX}edge> <${EX}a> .
    <${EX}d> <${EX}label> "one" .
    <${EX}d> <${EX}label> "two" .
  `,
};

function spec(overrides = {}) {
  return {
    prologue: `PREFIX ex: <${EX}>`,
    start: { pattern: 'VALUES ?from { ex:a }', node: '?from' },
    end: { pattern: 'VALUES ?to { ex:d }', node: '?to' },
    // ?kind belongs to the step, not to the path, and is what tells two edges
    // between the same pair of nodes apart.
    via: { pattern: 'VALUES ?kind { ex:edge ex:also } ?from ?kind ?to' },
    mode: 'all',
    maxDepth: 2,
    ...overrides,
  };
}

/**
 * Run a query at its bound, and again past it.
 *
 * A traversal that cannot reach its bound never joins END into a VIA
 * evaluation, so the second run is the same result set produced the unoptimized
 * way, and the two must agree over the lengths they share.
 */
async function bothWays(overrides = {}, sources = [ graph ]) {
  const engine = new QueryEngine();
  const maxDepth = overrides.maxDepth ?? 2;
  const joined = await collect(await engine.queryPaths(spec({ ...overrides, maxDepth }), { sources }));
  const unjoined = (await collect(await engine.queryPaths(
    spec({ ...overrides, maxDepth: maxDepth + 3 }),
    { sources },
  ))).filter(path => path.nodes.length <= maxDepth + 1);
  return { joined, unjoined };
}

const sorted = paths => paths.map(nodePath).sort();

describe('joining END into the final depth', () => {
  it('agrees with an unjoined traversal for a fixed END', async () => {
    const { joined, unjoined } = await bothWays();

    assert.deepEqual(sorted(joined), [ 'a-b-d', 'a-b-d', 'a-c-d' ]);
    assert.deepEqual(sorted(joined), sorted(unjoined));
  });

  it('keeps multiple VIA solutions between one pair as separate paths', async () => {
    const { joined } = await bothWays();
    const repeated = joined.filter(path => nodePath(path) === 'a-b-d');

    assert.equal(repeated.length, 2);
    assert.deepEqual(
      repeated.map(path => path.steps.at(-1).bindings.get('kind').value.replace(EX, '')).sort(),
      [ 'also', 'edge' ],
    );
  });

  it('keeps every END solution when END binds more than its node', async () => {
    const { joined, unjoined } = await bothWays({
      end: { pattern: '?to ex:label ?label', node: '?to' },
    });

    const labelled = paths => paths
      .map(path => `${nodePath(path)}/${path.endBindings.get('label').value}`)
      .sort();
    assert.deepEqual(labelled(joined), [
      'a-b-d/one', 'a-b-d/one', 'a-b-d/two', 'a-b-d/two', 'a-c-d/one', 'a-c-d/two',
    ]);
    assert.deepEqual(labelled(joined), labelled(unjoined));
  });

  it('scopes an END variable that VIA also binds', async () => {
    // ?kind is VIA's own step variable. END's ?kind is a different thing, and
    // joining END into the final depth must not let a SPARQL join merge the two
    // — which would leave no solution at all, since no label is a predicate.
    const { joined, unjoined } = await bothWays({
      end: { pattern: '?to ex:label ?kind', node: '?to' },
    });

    assert.deepEqual(sorted(joined), [ 'a-b-d', 'a-b-d', 'a-b-d', 'a-b-d', 'a-c-d', 'a-c-d' ]);
    assert.deepEqual(
      joined.map(path => path.endBindings.get('kind').value).sort(),
      [ 'one', 'one', 'one', 'two', 'two', 'two' ],
      "END's own binding must survive, unmerged with the step variable of the same name",
    );
    assert.deepEqual(sorted(joined), sorted(unjoined));
  });

  it('holds at a maximum length of one, where the first depth is also the last', async () => {
    const { joined, unjoined } = await bothWays({
      end: { pattern: 'VALUES ?to { ex:b }', node: '?to' },
      maxDepth: 1,
    });

    assert.deepEqual(sorted(joined), [ 'a-b' ]);
    assert.deepEqual(sorted(joined), sorted(unjoined));
  });

  it('admits a closing cycle at the final depth and rejects other repeats', async () => {
    const { joined } = await bothWays({
      end: { pattern: 'VALUES ?to { ex:a }', node: '?to' },
      maxDepth: 4,
    });

    assert.deepEqual(sorted(joined), [ 'a-b-d-z-a', 'a-b-d-z-a', 'a-c-d-z-a' ]);
    assert.ok(joined.every((path) => {
      const values = path.nodes.slice(0, -1).map(term => term.value);
      return new Set(values).size === values.length;
    }));
  });

  it('holds under the shortest-path mode as well', async () => {
    const { joined, unjoined } = await bothWays({ mode: 'shortest', maxDepth: 2 });

    assert.deepEqual(sorted(joined), [ 'a-b-d', 'a-b-d', 'a-c-d' ]);
    assert.deepEqual(sorted(joined), sorted(unjoined));
  });

  it('applies OFFSET and LIMIT over the order the unwindowed query produces', async () => {
    const engine = new QueryEngine();
    const all = await collect(await engine.queryPaths(spec(), { sources: [ graph ]}));
    assert.ok(all.length > 1);

    for (let offset = 0; offset < all.length; offset++) {
      const window = await collect(await engine.queryPaths(
        spec({ offset, maxPaths: 2 }),
        { sources: [ graph ]},
      ));
      assert.deepEqual(
        window.map(nodePath),
        all.slice(offset, offset + 2).map(nodePath),
        `offset ${offset}`,
      );
    }
  });
});

/** Read the SPARQL query out of a stubbed endpoint request, however it was sent. */
function requestedQuery(input, init) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  let query = url.searchParams.get('query');
  if (!query && init.body !== undefined && init.body !== null) {
    const body = typeof init.body === 'string' ? init.body : String(init.body);
    query = new URLSearchParams(body).get('query') ?? body;
  }
  return query ?? '';
}

function sparqlJson(body) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/sparql-results+json' },
  });
}

describe('what the final depth asks a SPARQL endpoint', () => {
  it('carries the END constraint into the last depth only, alongside the frontier', async () => {
    const successors = { a: 'n1', n1: 'n2', n2: 'target' };
    const requests = [];
    const fetch = async(input, init = {}) => {
      const query = requestedQuery(input, init);
      if (/^\s*ASK/imu.test(query)) {
        return sparqlJson({ head: {}, boolean: true });
      }
      requests.push(query);
      // A node reaches the endpoint either as a full IRI or in the prologue's
      // prefixed form, depending on how the request was assembled.
      const bindings = Object.entries(successors)
        .filter(([ from ]) => new RegExp(`(?:<${EX}|ex:)${from}\\b`, 'u').test(query))
        .map(([ from, to ]) => ({
          from: { type: 'uri', value: `${EX}${from}` },
          to: { type: 'uri', value: `${EX}${to}` },
        }));
      return sparqlJson({ head: { vars: [ 'from', 'to' ]}, results: { bindings }});
    };

    const paths = await collect(await new QueryEngine().queryPaths({
      prologue: `PREFIX ex: <${EX}>`,
      start: { pattern: 'VALUES ?from { ex:a }', node: '?from' },
      end: { pattern: `VALUES ?to { <${EX}target> }`, node: '?to' },
      via: { pattern: '?from ex:edge ?to' },
      mode: 'all',
      maxDepth: 3,
    }, { sources: [{ type: 'sparql', value: `${EX}sparql` }], fetch }));

    assert.deepEqual(paths.map(nodePath), [ 'a-n1-n2-target' ]);
    const via = requests.filter(query => /edge/u.test(query));
    assert.equal(via.length, 3, via.join('\n---\n'));
    // A node that is not an endpoint is still a route to one, so the depths that
    // still have a successor must stay unconstrained.
    assert.doesNotMatch(via[0], /target/u);
    assert.doesNotMatch(via[1], /target/u);
    // The last depth carries END, and still pushes the frontier down beside it,
    // in one request and without a wrapping sub-select.
    assert.match(via[2], /VALUES\s+\?to/iu);
    assert.match(via[2], /VALUES\s+\?from/iu);
    assert.doesNotMatch(via[2], /\{\s*SELECT\b/iu);
  });

  it('stops asking a source once the requested number of paths is reached', async () => {
    let requests = 0;
    const fetch = async(input, init = {}) => {
      const query = requestedQuery(input, init);
      if (/^\s*ASK/imu.test(query)) {
        return sparqlJson({ head: {}, boolean: true });
      }
      requests++;
      return sparqlJson({
        head: { vars: [ 'from', 'to' ]},
        results: {
          bindings: Array.from({ length: 200 }, (_, index) => ({
            from: { type: 'uri', value: `${EX}a` },
            to: { type: 'uri', value: `${EX}n${index}` },
          })),
        },
      });
    };

    const paths = await collect(await new QueryEngine().queryPaths({
      prologue: `PREFIX ex: <${EX}>`,
      start: { pattern: 'VALUES ?from { ex:a }', node: '?from' },
      end: { node: '?to' },
      via: { pattern: '?from ex:edge ?to' },
      mode: 'all',
      maxDepth: 4,
      maxPaths: 3,
    }, { sources: [{ type: 'sparql', value: `${EX}sparql` }], fetch }));

    assert.equal(paths.length, 3);
    // The first depth alone offers two hundred paths, so a traversal that stops
    // when its limit is met never expands a second one.
    assert.equal(requests, 1);
  });
});
