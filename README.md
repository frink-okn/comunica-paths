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

The eventual executor will compile each traversal frontier into ordinary SPARQL and submit
it through the injected engine's `queryBindings` method. That makes stock Comunica and other
configured Comunica engines usable without coupling this package to their Components.js 
configuration.

## Intended execution model

1. Evaluate START once and stream its distinct nodes into the initial frontier.
2. Expand a bounded batch of frontier nodes with one standard SPARQL query containing
   `VALUES`, allowing Comunica to optimise the VIA pattern across all configured sources.
3. Stream VIA solutions immediately while building the next breadth-first frontier.
4. Test candidate nodes against END in batches and cache the result.
5. For `shortest`, retain distances and a predecessor DAG; finish the matching BFS level but
   never expand a deeper one. For `all`, enumerate simple paths with explicit resource
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

The repository currently defines and documents the clean public boundary. The first
implementation milestone is the batched streaming shortest-path executor, tested against
an in-memory dataset and a two-source federation before adding either textual syntax.
