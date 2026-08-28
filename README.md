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
const paths = await engine.queryPathString(`
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

## Command line

From this checkout, build once and run a PATHS query against one or more local RDF files:

```bash
npm run build
npm run query -- route.paths \
  --file data-a.ttl \
  --file data-b.ttl
```

After installing the package, the equivalent command is:

```bash
comunica-paths route.paths --file data-a.ttl --file data-b.ttl
```

Remote RDF documents, SPARQL endpoints, and LDF endpoints can be supplied with repeatable
`--url` options. Sources can also use Comunica's `type@value` syntax, either as positional
arguments after the query file or through repeatable `--source` options. This is useful when
automatic source identification is unavailable or ambiguous:

```bash
comunica-paths route.paths sparql@https://qlever.dev/api/wikidata
comunica-paths route.paths --source brtpf@https://example.org/fragments
```

A JSON query context can supply typed sources and other standard Comunica context options:

```json
{
  "sources": [
    { "type": "sparql", "value": "https://qlever.dev/api/wikidata" }
  ]
}
```

```bash
comunica-paths route.paths --context sources.json
```

CLI sources are appended to sources from the context. Query text may also be piped over standard
input (use `-` as its positional query-file marker when positional sources follow):

```bash
cat route.paths | comunica-paths --url https://apps.okn.us/ldf/wikidata
cat route.paths | comunica-paths - sparql@https://qlever.dev/api/wikidata
```

The command writes JSON Lines: each line is one complete path containing its ordered RDF/JS
nodes, the complete VIA bindings for each step, and START/END bindings. Step `i` connects node
`i` to node `i + 1`. This keeps results streamable and easy to pipe to tools such as `jq`.
Local source formats are inferred from common RDF filename extensions. Use `comunica-paths
--help` for the full option list; Ctrl-C cancels active Comunica streams and HTTP requests.

## Design boundary

PATHS has its own Comunica action, actor, bus, and mediator, rather than adding a value to
Comunica's closed query-operation result union or maintaining forks of the SPARQL and algebra
packages. Its parser-independent input is `PathQuerySpec`:

```ts
const query = {
  prologue: 'PREFIX ex: <https://example.org/>',
  start: { pattern: '?start a ex:Person', node: '?start' },
  end: { pattern: '?end a ex:Place', node: '?end' },
  via: { pattern: '?start ex:knows|ex:locatedIn ?end' },
  mode: 'shortest',
} satisfies PathQuerySpec;
```

A VIA pattern names one traversal step using the query's own endpoint variables: START's node
is the source of a step and END's node is its target, so VIA must bind both. There are no
separate step variables to declare, and START and END must therefore use different variables.

`ActorQueryPathBfs` parses each embedded START, END, and VIA graph pattern into standard
Comunica algebra once, and plans it once through the standard optimizer. For each traversal
frontier it builds a `VALUES` relation over the frontier terms and joins that with the planned
graph pattern. `VALUES` reports an exact cardinality, so the RDF-join mediator sees the true
frontier size and chooses the physical join itself — bind, hash, nested-loop, or a bind join
that pushes the frontier into the source request.

```ts
import { QueryEngine } from 'comunica-paths';

const paths = await new QueryEngine().queryPaths(query, {
  sources: [ 'https://example.org/data.ttl' ],
});

for await (const path of paths) {
  console.log(path.nodes, path.steps);
}

// The stream carries its own cardinality, refreshed once per completed depth.
console.log(paths.getProperty('metadata').cardinality);
```

`queryPaths` resolves to an `AsyncIterator` of whole paths, following the same conventions as
Comunica's bindings streams: it exposes a `metadata` property whose validation state is
invalidated whenever the estimate changes, and destroying it tears the traversal down. The
abort signal on the query context cancels the traversal and every request behind it.

The estimate is the paths already emitted, plus the traversal states still to be expanded, plus
the cardinality Comunica itself reports for the expansion in flight. It becomes exact when the
stream ends.

### Explaining a path query

`explainPaths`, `explainPathString`, and `explainPathService` report a path query the way
`QueryEngineBase.explain` reports an ordinary one, in `parsed`, `physical`, or `physical-json`
mode:

```ts
const { data } = await new QueryEngine()
  .explainPaths(query, { sources: [ 'https://example.org/sparql' ]}, 'physical');
console.log(data);
```

```text
paths(bfs)
  paths-start
    distinct
      values
  paths-via
    distinct
      join
        join-inner(bind-source) cardReal:1 timeSelf:0.174ms timeLife:8.01ms
          values cardEst:1
          pattern (?from https://example.org/edge ?to) cardEst:~∞ src:0
  paths-end
    distinct
      join
        join-inner(bind-source) timeSelf:0.022ms timeLife:2.33ms
          values cardEst:1
          pattern (?end https://example.org/type https://example.org/Dest) cardEst:~∞ src:0
  paths-via
    distinct
      join
        join-inner(bind-source) cardReal:1 timeSelf:0.05ms timeLife:1.792ms
          values cardEst:1
          pattern (?from https://example.org/edge ?to) cardEst:~∞ src:0
  ...

sources:
  0: QuerySourceHypermedia(https://example.org/sparql)(SkolemID:0)
```

Every clause and every traversal depth is its own node beneath the path query, so the plan shows
which physical join each depth chose and against which source. `bind-source` above means the
frontier reached the endpoint as a `VALUES` block inside the request; a local source would show
`bind` or `nested-loop` instead, chosen by the same mediator from the same cardinalities.
`physical-json` reports the same tree with each clause node labelled by its `depth`, which the
compact rendering above leaves out. A physical explanation runs the traversal to completion,
exactly as Comunica's own physical-explain actor does.

## Execution model

1. Parse and plan START, END, and VIA once, against one initialized request context.
2. Evaluate START and stream its distinct nodes into the initial frontier.
3. Expand the whole frontier for a depth as one `VALUES` relation joined with the planned VIA
   pattern, letting the RDF-join mediator choose and chunk the physical join.
4. Consume VIA solutions incrementally as they arrive, building the next frontier as they stream
   in rather than buffering a depth's response.
5. Test candidate nodes against END in one mediated join per depth, and cache the result.
6. For `shortest`, retain per-start distances and predecessor DAGs so every start/end pair gets
   all of its shortest paths. For `all`, enumerate simple paths: a node cannot repeat except to
   close a cycle back to its own start, which bounds traversal on a cyclic graph on its own, with
   `MAX LENGTH` and `LIMIT` as further explicit bounds.
7. Propagate cancellation and downstream backpressure to every active Comunica stream.

Breadth-first depth is the only orchestration barrier: it is needed to know that a discovered
route is shortest. Within a depth, frontier expansion and endpoint matching are ordinary SPARQL
joins planned and executed by Comunica. Nothing here batches the frontier or picks a join
strategy; the join actors do both, using their own block sizes.

RDF terms are keyed with RDF/JS term-aware collections — not by `.value` — so named nodes, blank
nodes, language strings, datatypes, and RDF-star terms cannot collide in traversal state. Named
nodes and literals travel in the `VALUES` relation. Blank nodes and quoted triples, which
SPARQL's `VALUES` grammar cannot hold, are bound into the graph pattern instead; Comunica's
query-source skolemization layer then owns blank-node source scope exactly as it does for
ordinary joins.

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
is handed to Comunica. The engine sees only the standard START, END, and VIA graph patterns.

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
usual Components.js way.

An alternative path algorithm subclasses `ActorQueryPath`. Callers select one through the
`algorithm` execution option, which the engine places in the query context under
`KeysQueryPath.algorithm`; each actor must reject every value it does not implement in
`test()`, so the bus never resolves competing implementations by completion timing. This is the
same arrangement Comunica uses on its own query-process bus.

## Status

The programmatic API supports streaming `shortest`, `all`, and cyclic execution, including
maximum length, limit, offset, cancellation, and `parsed`, `physical`, and `physical-json`
explanations. Both the textual PATHS adapter and the optional standard-SPARQL SERVICE envelope
are implemented. There is one execution route: the configured Components.js actor graph.

## Development

```bash
npm install
npm test
```

The default suite is deterministic and uses two local RDF sources through an unchanged
Comunica engine. `npm run test:live` additionally checks a bounded two-hop query against a
public LDF endpoint; it is intentionally separate because it requires network access.
