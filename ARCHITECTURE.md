# Architecture

## Why PATHS has its own bus

PATHS is a graph-search request whose result is a stream of whole paths. A normal Comunica
query operation produces bindings, quads, a boolean, or a void result. Adding a path operation
and path result there would require coordinated releases of the parser, algebra, shared types,
query-operation bus, serializers, and every exhaustive consumer of those unions.

This package instead introduces a small, parallel actor contract:

```text
QueryEngine.queryPaths
        |
        v
MediatorQueryPath  --->  ActorQueryPathBfs
                              |
               +--------------+--------------+
               |                             |
               v                             v
     sequential query processor        query-operation bus
     (parse / optimize / evaluate)   -> RDF-join mediator
                                        (bind / hash / bind-source / ...)
```

The outer PATHS envelope and whole-path results stay on the path-query bus. Everything inside
START, END, and VIA remains standard SPARQL and standard Comunica algebra.

## Execution

`ActorQueryPathBfs` initializes one request context through the context-preprocess mediator, so
query-scoped values — `NOW()`, source identifiers, the RDF data factory, the logger — are
stable for the whole traversal.

Each embedded pattern is parsed into algebra and planned **once**:

1. The pattern text is parsed as `SELECT * WHERE { … }`. The wrapper exists so the pattern
   reaches the query parser, and so that the optimizers see a query operation at the root —
   source assignment silently does nothing to a bare graph pattern.
2. The optimizer plans that query, assigning and grouping sources. It is handed the context
   parsing produced, the way Comunica's own query processors chain the two steps, so the plan
   carries the query string the pattern was read from and any base IRI its prologue declared.
3. The projection is removed again. It projects exactly the variables its input already
   produces, and leaving it in would wrap every pushed-down request in a redundant sub-select.
   If source assignment scoped the whole query to one source, that scope moves to the graph
   input.

A pattern that reads no dataset — a bare `VALUES` block, for instance — is not planned at all.
It has no source to be assigned, and planning it would only scope a constant endpoint to a
source and turn it into a remote request.

The first depth is planned as START joined with VIA, as one query, whenever START projects
nothing but its node. Materializing START first would settle the join order here, where no
cardinality is known; planning the two together leaves that to Comunica, and lets a single
source answer both in one request. The join has to be *planned*, not assembled from the two
already-planned patterns: source grouping is an optimizer step, so a join built afterwards
reaches the join mediator as two separately scoped entries and can never become one request.

START is joined only when it projects its node alone. A SPARQL join joins on every shared
variable, so a START pattern binding anything else could share a name with VIA and be joined to
it — which the PATHS semantics forbid, since a path solution exposes only the endpoint variables
and VIA's own variables belong to a single step. It also keeps one START solution per node, so
the join is not multiplied by solutions the traversal would collapse again.

At each subsequent depth the actor builds a `VALUES` relation over the frontier and joins it with
the planned pattern. `VALUES` reports an exact cardinality, so the RDF-join mediator sees the true
frontier size and selects the physical join: a bind join, a hash join, or a bind join that
pushes the frontier into the source request. Nothing here batches the frontier — the whole
frontier is offered as one relation, and the join actors chunk it using their own block sizes.

That join is flattened under the rule Comunica's own `materializeOperation` applies: an input
carrying algebra metadata — a source annotation above all — stays a single join entry, and only
an unannotated input is merged. A pattern the optimizer scoped to one source therefore reaches
its bind-join actor whole, while a pattern left to local evaluation is weighed pattern by
pattern against the frontier.

Each depth's evaluation is wrapped in `DISTINCT`, after planning rather than before it.
Deduplication has to hold across the whole federation, so it must not be pushed into an
individual source; and planning it in would put the pattern behind a sub-select the frontier
relation can no longer filter, which would make a source recompute its whole distinct edge set
on every depth.

Planning happens once rather than once per depth, which is what Comunica's own bind-join actors
do: they materialize bindings into an operation and mediate the query-operation bus directly,
without re-running the optimizer. Re-planning per depth is also unsafe here, because
`ActorOptimizeQueryOperationQuerySourceSkolemize` wraps every query source in a fresh
skolemization layer on each call; feeding a planned context back into the optimizer would wrap
the sources again and change blank-node identity between depths.

Only traversal state and the breadth-first depth barrier are owned here. The barrier is needed
to collect all predecessors at the same distance before emitting every shortest path. Source
selection, graph-pattern evaluation, join ordering inside the pattern, and the physical join
between the frontier and the pattern remain Comunica responsibilities.

When END is a finite, `VALUES`-only target set, shortest traversal stops after every relevant
start/target pair has been settled. The winning depth is still consumed completely so all
equal-length shortest paths are retained, but no deeper frontier is evaluated.

## Results and metadata

The bus returns a Comunica-shaped result: an `AsyncIterator` of paths, a `metadata()` accessor,
and the initialized context. The metadata carries a `MetadataValidationState` and a cardinality
that is an estimate while traversing and exact once the stream ends; it is refreshed once per
completed depth rather than once per path. `queryPaths` publishes that accessor's value as the
stream's `metadata` property — the convention `IQuerySource.queryBindings` follows — which is
what makes it reachable through the public API, for any actor on the bus rather than only the
one that happens to build its own iterator.

The estimate is the sum of the paths already emitted, the traversal states still waiting to be
expanded, and the cardinality the join actors reported for the expansion in flight. In `all`
mode the pending states are the partial paths, not the distinct nodes they currently sit on,
because each partial path is expanded on its own.

Cancellation is ordinary stream teardown. Destroying the path stream destroys every bindings
stream still in flight and then unwinds the traversal, and the request's abort signal is wired
to that same teardown — so cancelling stops the traversal between depths as well as aborting
the HTTP requests underneath it.

`asynciterator` emits `end` only for a stream that closes normally: `destroy()` moves straight
to the destroyed state, skipping the event and then dropping its listeners. Cleanup that has to
run however a request finishes — flushing the logger, releasing the listener on the caller's
abort signal — therefore hangs off the iterator's own teardown hook rather than off `end`.

The traversal registers itself in the physical query plan and sets `physicalQueryPlanNode`, and
every clause evaluation adds a further node beneath it, labelled with its clause and traversal
depth. A physical explanation therefore reads as one node per depth, each showing the join the
RDF-join mediator picked, rather than as a flat run of indistinguishable siblings.

`queryPaths` has no explain mode of its own, because the path bus is not the query-process bus
that Comunica's explain actors sit on. `explainPaths` fills that role instead: it installs a
`MemoryPhysicalQueryPlanLogger`, runs the traversal to completion, and returns the same
`IQueryExplained` shape, in `parsed`, `physical`, or `physical-json` mode.

## Blank nodes and quoted triples

The traversal does not branch on RDF term type; named nodes, literals, quoted triples, and
blank nodes all travel in the same RDF/JS bindings stream and are stored in term-aware maps and
sets.

The split happens only at the point of submitting a frontier, and only because of what SPARQL's
`VALUES` grammar can hold. Named nodes and literals go into the `VALUES` relation. Blank nodes
and quoted triples are bound into the graph pattern with `materializeOperation`, which preserves
source assignment, so the planned pattern is reused rather than re-planned. Comunica's
skolemization layer then maps a source-scoped blank node back to its source identity, and yields
nothing for a source the blank node did not come from — which is the correct federated answer.

One case has no sound continuation: a blank node returned by a source that answers whole
queries, such as a SPARQL endpoint. Its label would be serialized back into a request, where
SPARQL reads a blank node as a variable and silently matches everything. That frontier node is
dropped with a warning rather than expanded.

## Components

The generated component metadata exposes:

- `ActorQueryPath`, the abstract bus contract;
- `ActorQueryPathBfs`, the current traversal implementation;
- `ActorInitQueryPaths`, the standard query init actor plus `mediatorQueryPath`.

The default configuration imports Comunica's stock SPARQL configuration, adds a race mediator
for the path bus, registers the BFS actor, and registers the path-enabled init actor at
`urn:comunica:paths:init`. The BFS actor receives the existing sequential query processor, the
context-preprocess mediator, and the merge-bindings-context mediator by reference — the same
collaborators `ActorQueryProcessSequential` itself takes. No replacement parser, algebra
factory, RDF model, source layer, or join implementation is included.

Alternative path algorithms subclass `ActorQueryPath`. Callers select one through the
`algorithm` execution option, which the engine places in the context under
`KeysQueryPath.algorithm`; each actor must reject every value it does not implement in `test()`,
so the race mediator never chooses between competing implementations by completion timing.
Comunica's own query-process bus is arranged the same way. Alternative Comunica source and join
actors can be installed through a downstream configuration without changing the traversal code.
