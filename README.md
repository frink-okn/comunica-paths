# comunica-paths

Streaming path queries over one or more RDF sources through
[Comunica](https://comunica.dev/), without maintaining forks of SPARQL.js,
sparqlalgebrajs, RDF/JS, or Comunica.

This is a standalone package; it does not live inside or fork the Comunica monorepo.

## Design boundary

PATHS is treated as a query orchestration layer over a normal bindings query engine, not as
a new Comunica algebra operation. Its parser-independent input is `PathQuerySpec`:

```ts
const query = {
  prologue: 'PREFIX ex: <https://example.org/>',
  start: { pattern: '?start a ex:Person', node: '?start' },
  end: { pattern: '?end a ex:Place', node: '?end' },
  via: {
    pattern: '?from ex:knows|ex:locatedIn ?to',
    from: '?from',
    to: '?to',
  },
  mode: 'shortest',
} satisfies PathQuerySpec;
```

The executor compiles each traversal frontier into ordinary SPARQL and submits
it through the injected engine's `queryBindings` method. That makes stock Comunica and other
configured Comunica engines usable without coupling this package to their Components.js 
configuration.

```ts
import { QueryEngine } from '@comunica/query-sparql';
import { PathQueryEngine } from 'comunica-paths';

const paths = new PathQueryEngine(new QueryEngine()).queryPaths(query, {
  sources: [ 'https://example.org/data.ttl' ],
});

for await (const path of paths) {
  console.log(path.nodes, path.steps);
}
```

## Intended execution model

1. Evaluate START once and stream its distinct nodes into the initial frontier.
2. Expand a bounded batch of frontier nodes with one standard SPARQL query containing
   `VALUES`, allowing Comunica to optimise the VIA pattern across all configured sources.
3. Stream VIA solutions immediately while building the next breadth-first frontier.
4. Test candidate nodes against END in batches and cache the result.
5. For `shortest`, retain per-start distances and predecessor DAGs so every start/end pair
   gets all of its shortest paths. For `all`, enumerate simple paths with explicit resource
   limits so cycles cannot run forever.
6. Propagate cancellation and downstream backpressure to every active Comunica stream.

RDF terms will be keyed and serialised as complete RDF terms—not by `.value`—so named nodes,
blank nodes, language strings, datatypes, and RDF-star terms cannot collide.

## Syntax

The core API accepts `PathQuerySpec`. A Stardog-compatible PATHS parser will be an adapter
that parses only the PATHS envelope and delegates START, END, and VIA graph patterns to
stock SPARQL tooling. A standard-SPARQL `SERVICE` envelope may be added as a second adapter;
neither representation changes the executor.

## Status

The programmatic API supports batched, streaming `shortest`, `all`, and `cyclic` execution,
including `maxDepth`, `maxPaths`, `offset`, and cancellation. Textual PATHS syntax and the
optional standard-SPARQL envelope are the next implementation stages.
