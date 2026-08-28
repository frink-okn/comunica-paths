import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PathMetadata, QueryEngine as PathsQueryEngine } from '../dist/index.js';

const EX = 'https://example.org/';

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

describe('path stream metadata', () => {
  it('projects emitted paths, pending states, and the expansion in flight', () => {
    const metadata = new PathMetadata(undefined);

    assert.deepEqual(metadata.read().cardinality, {
      type: 'estimate',
      value: Number.POSITIVE_INFINITY,
    });

    metadata.recordDepth(1, 4);
    assert.deepEqual(metadata.read().cardinality, { type: 'estimate', value: 4 });

    // Comunica's own estimate for the depth being evaluated stands in until that
    // depth lands and replaces it with a real count.
    metadata.recordExpansion({ type: 'estimate', value: 10 });
    assert.equal(metadata.read().cardinality.value, 14);

    // A source that cannot count reports no usable value; the previous estimate
    // must not be read as zero paths remaining.
    metadata.recordExpansion({ type: 'estimate', value: null });
    assert.equal(metadata.read().cardinality.value, 4);

    metadata.recordEmitted();
    metadata.recordExpansion({ type: 'estimate', value: 3 });
    assert.equal(metadata.read().cardinality.value, 8);

    metadata.recordDepth(2, 7);
    assert.deepEqual(metadata.read().cardinality, { type: 'estimate', value: 8 });
    assert.equal(metadata.read().depth, 2);

    metadata.recordCompletion();
    assert.deepEqual(metadata.read().cardinality, { type: 'exact', value: 1 });
  });

  it('never projects beyond a requested result limit', () => {
    const metadata = new PathMetadata(3);
    metadata.recordDepth(1, 100);
    metadata.recordExpansion({ type: 'estimate', value: 900 });

    assert.deepEqual(metadata.read().cardinality, { type: 'estimate', value: 3 });
  });

  it('invalidates the previous state on every refresh', () => {
    const metadata = new PathMetadata(undefined);
    const first = metadata.read().state;
    let invalidated = false;
    first.addInvalidateListener(() => {
      invalidated = true;
    });

    metadata.recordDepth(1, 2);

    assert.ok(invalidated);
    assert.notEqual(metadata.read().state, first);
    assert.ok(metadata.read().state.valid);
  });

  it('counts the partial paths left to expand, not the nodes they sit on', async () => {
    // Two partial paths meet on ex:d, so at the final depth the frontier holds
    // two states across a single node.
    const sources = [{
      type: 'serialized',
      value: `
        <${EX}a> <${EX}edge> <${EX}b> .
        <${EX}a> <${EX}edge> <${EX}c> .
        <${EX}b> <${EX}edge> <${EX}d> .
        <${EX}c> <${EX}edge> <${EX}d> .
      `,
      mediaType: 'application/n-triples',
      baseIRI: `${EX}diamond`,
    }];
    const stream = await new PathsQueryEngine().queryPaths({
      prologue: `PREFIX ex: <${EX}>`,
      start: { pattern: 'VALUES ?start { ex:a }', node: '?start' },
      end: { node: '?end' },
      via: { pattern: '?start ex:edge ?end' },
      mode: 'all',
      maxDepth: 2,
    }, { sources });

    // Record every republished metadata object, by chaining onto each new state.
    const published = [];
    const record = () => {
      const metadata = stream.getProperty('metadata');
      published.push({ depth: metadata.depth, ...metadata.cardinality });
      metadata.state.addInvalidateListener(record);
    };
    record();

    const paths = await collect(stream);
    assert.deepEqual(
      paths.map(path => path.nodes.map(term => term.value.replace(EX, '')).join('-')),
      [ 'a-b', 'a-c', 'a-b-d', 'a-c-d' ],
    );

    assert.deepEqual(published.at(-1), { depth: 2, type: 'exact', value: 4 });
    // Four paths emitted plus the two partial paths still sitting on ex:d.
    // Counting frontier nodes instead of states would report five.
    assert.deepEqual(published.at(-2), { depth: 2, type: 'estimate', value: 6 });

    // The estimate rises within a depth as Comunica reports the cardinality of
    // the expansion it is running, then falls back to the real count.
    assert.ok(
      published.some((entry, index) =>
        index > 0 &&
        entry.depth === published[index - 1].depth &&
        entry.type === 'estimate' &&
        published[index - 1].type === 'estimate' &&
        entry.value > published[index - 1].value),
      JSON.stringify(published),
    );
  });
});
