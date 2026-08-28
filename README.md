# comunica-paths

Streaming path queries over one or more RDF sources through
[Comunica](https://comunica.dev/), without maintaining forks of SPARQL.js,
sparqlalgebrajs, RDF/JS, or Comunica.

This is a standalone package; it does not live inside or fork the Comunica monorepo.

## Usage

The default export surface includes a normal Comunica query engine with PATHS support added:

```ts
import { QueryEngine } from 'comunica-paths';

const engine = new QueryEngine();
const paths = engine.queryPathString(`
  PREFIX ex: <https://example.org/>
  PATHS ALL
  START ?from = ex:a
  END ?to { ?to a ex:Destination }
  VIA { ?from ex:edge ?to }
  MAX LENGTH 8
  LIMIT 20
`, {
  sources: [ 'https://example.org/data.ttl' ],
});

for await (const path of paths) {
  console.log(path.nodes, path.steps);
}
```

The same engine retains the complete `QueryEngineBase` API, so `queryBindings`,
`queryQuads`, updates, result serialization, and other ordinary Comunica operations remain
available.

## Design boundary

PATHS has its own Comunica action, actor, bus, and mediator, rather than adding a value to
Comunica's closed query-operation result union or maintaining forks of the SPARQL and algebra
packages. Its parser-independent input is `PathQuerySpec`:

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

`ActorQueryPathBfs` parses, optimizes, and evaluates the embedded START, END, and VIA graph
patterns through Comunica's standard sequential query processor. For each traversal frontier,
it creates an RDF/JS bindings stream with cardinality and variable metadata, then asks the
configured RDF-join mediator to join that stream with the VIA or END operation. The normal
join actors therefore choose bind, hash, nested-loop, or another installed strategy.

```ts
import { QueryEngine as ComunicaQueryEngine } from '@comunica/query-sparql';
import { PathQueryEngine } from 'comunica-paths';

const paths = new PathQueryEngine(new ComunicaQueryEngine()).queryPaths(query, {
  sources: [ 'https://example.org/data.ttl' ],
});

for await (const path of paths) {
  console.log(path.nodes, path.steps);
}
```

`PathQueryEngine` in that example is the portable adapter. It only requires an object with
Comunica's `queryBindings` method and consequently works with an existing or custom engine.
It uses bounded `VALUES` joins for ordinary terms and `initialBindings` for blank nodes. The
configured `QueryEngine` is preferred when Components.js integration is possible: it puts all
frontier terms—including source-scoped blank nodes—through the same mediated bindings join.

## Intended execution model

1. Evaluate START once and stream its distinct nodes into the initial frontier.
2. Expand a bounded batch of frontier nodes by joining its RDF/JS bindings stream to the VIA
   operation through Comunica's configured RDF-join mediator.
3. Stream VIA solutions immediately while building the next breadth-first frontier.
4. Test candidate nodes against END in batches and cache the result.
5. For `shortest`, retain per-start distances and predecessor DAGs so every start/end pair
   gets all of its shortest paths. For `all`, enumerate simple paths with explicit resource
   limits so cycles cannot run forever.
6. Propagate cancellation and downstream backpressure to every active Comunica stream.

Breadth-first depth is the only orchestration barrier: it is needed to know that a discovered
route is shortest. Within a depth, frontier expansion and endpoint matching remain ordinary
SPARQL joins planned and executed by Comunica.

RDF terms are keyed with RDF/JS term-aware collections—not by `.value`—so named nodes,
blank nodes, language strings, datatypes, and RDF-star terms cannot collide in traversal state.
In the actor-backed engine all terms use the same frontier-binding mechanism. Comunica's normal
query-source skolemization layer owns blank-node source scope, exactly as it does for ordinary
joins. The portable adapter has a blank-node-only `initialBindings` fallback because blank nodes
cannot be represented as constants in a SPARQL `VALUES` clause.

The breadth-first depth barrier remains in this package because shortest-path semantics require
all predecessor edges at a depth before a shortest path can be finalized. It does not dictate
the physical join inside a depth. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the actor graph,
extension points, and streaming tradeoffs.

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

## Components.js configuration

`new QueryEngine()` uses the compiled default actor graph. For dynamic or extended
configurations, use `QueryEngineFactory`:

```ts
import { QueryEngineFactory } from 'comunica-paths';

const engine = await new QueryEngineFactory().create({
  configPath: '/absolute/path/to/config.json',
  instanceUri: 'urn:comunica:paths:init',
});
```

The shipped [`config/config-default.json`](./config/config-default.json) imports Comunica's
standard SPARQL configuration and adds only the path actor, its mediator, and a path-enabled
init actor. A downstream engine configuration can replace or tune these components in the
usual Components.js way; `ActorQueryPathBfs` exposes `batchSize` as a configuration parameter.

## Status

The programmatic API supports batched, streaming `shortest`, `all`, and cyclic execution,
including maximum length, limit, offset, and cancellation. Both the textual PATHS adapter
and the optional standard-SPARQL SERVICE envelope are implemented. The actor-backed and
portable execution routes share the same traversal implementation and conformance tests.

## Development

```bash
npm install
npm test
```

The default suite is deterministic and uses two local RDF sources through an unchanged
Comunica engine. `npm run test:live` additionally checks a bounded two-hop query against a
public LDF endpoint; it is intentionally separate because it requires network access.
