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
2. The optimizer plans that query, assigning and grouping sources.
3. The projection is removed again. It projects exactly the variables its input already
   produces, and leaving it in would wrap every pushed-down request in a redundant sub-select.
   If source assignment scoped the whole query to one source, that scope moves to the graph
   input.

A pattern that reads no dataset — a bare `VALUES` block, for instance — is not planned at all.
It has no source to be assigned, and planning it would only scope a constant endpoint to a
source and turn it into a remote request.

At each depth the actor builds a `VALUES` relation over the frontier and joins it with the
planned pattern. `VALUES` reports an exact cardinality, so the RDF-join mediator sees the true
frontier size and selects the physical join: a bind join, a hash join, or a bind join that
pushes the frontier into the source request. Nothing here batches the frontier — the whole
frontier is offered as one relation, and the join actors chunk it using their own block sizes.

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
completed depth rather than once per path. The public `queryPaths` also exposes the current
metadata as the stream's `metadata` property, the same convention `IQuerySource.queryBindings`
follows.

Cancellation is ordinary stream teardown. Destroying the path stream destroys every bindings
stream still in flight and then unwinds the traversal, and the request's abort signal is wired
to that same teardown — so cancelling stops the traversal between depths as well as aborting
the HTTP requests underneath it.

The traversal registers itself in the physical query plan and sets `physicalQueryPlanNode`, so
each depth's join plan is reported as a child of the path query rather than as a disconnected
root.

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
