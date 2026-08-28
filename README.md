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

The core API accepts `PathQuerySpec`. `parsePathQuery` and `queryPathString` accept PATHS
syntax while parsing only its small outer envelope. START, END, and VIA graph patterns are
parsed by stock SPARQL.js and executed by Comunica:

```sparql
PREFIX ex: <https://example.org/>
PATHS ALL
START ?from = ex:a
END ?to { ?to a ex:Destination }
VIA { ?from ex:edge ?to }
MAX LENGTH 8
LIMIT 20
```

The same request can be tunneled through syntax accepted by an unmodified SPARQL 1.1 parser.
Reserved named graphs separate the three patterns, and one `VALUES` row carries the variable
names and traversal options:

```sparql
PREFIX ex: <https://example.org/>
PREFIX path: <urn:comunica:paths:>
SELECT * WHERE {
  SERVICE <urn:comunica:paths> {
    GRAPH path:start { VALUES ?from { ex:a } }
    GRAPH path:end { ?to a ex:Destination }
    GRAPH path:via { ?from ex:edge ?to }
    VALUES (?__path_start ?__path_end ?__path_mode ?__path_maxLength) {
      ("from" "to" "all" 8)
    }
  }
}
LIMIT 20
```

`parsePathServiceQuery` decodes this form, while `queryPathService` decodes and executes it.
This is an application-level tunnel: the reserved SERVICE is intercepted before the query
is handed to Comunica. The underlying engine sees only the generated standard START, END,
and VIA bindings queries.

## Status

The programmatic API supports batched, streaming `shortest`, `all`, and cyclic execution,
including maximum length, limit, offset, and cancellation. Both the textual PATHS adapter
and the optional standard-SPARQL SERVICE envelope are implemented.
