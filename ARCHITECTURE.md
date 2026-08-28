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
     sequential query processor       RDF-join mediator
     (parse/optimize/evaluate)      (bind/hash/nested-loop/...)
```

The outer PATHS envelope and whole-path results stay on the path-query bus. Everything inside
START, END, and VIA remains standard SPARQL and standard Comunica algebra.

## Execution

`ActorQueryPathBfs` uses the standard sequential query processor to parse and optimize the
three embedded graph patterns. At each depth it supplies a bounded frontier as a bindings
query-operation result with exact cardinality and variable metadata. The VIA or END algebra
operation is the other join entry. The configured RDF-join mediator selects and runs the
physical join actor.

The actor initializes one base Comunica context for the whole PATHS request and derives every
START, VIA, and END operation context from it. Query-scoped values such as `NOW()`, source IDs,
the RDF data factory, and the logger consequently remain stable across the traversal.

Only traversal state and the breadth-first depth barrier are owned here. The barrier is needed
to collect all predecessors at the same distance before emitting every shortest path. Source
selection, graph-pattern evaluation, join ordering inside the pattern, and the physical join
between the frontier and pattern remain Comunica responsibilities.

The result is streaming at the natural boundary for shortest paths: input bindings are consumed
asynchronously, active and late-resolving streams are destroyed on early return or cancellation,
and the abort signal is also forwarded to Comunica's HTTP actors. Completed depths emit without
waiting for the entire reachable graph. `all` mode similarly processes one bounded depth at a
time while retaining the path prefixes needed to reject non-simple cycles.

## Blank nodes

The native actor does not branch on RDF term type. Named nodes, literals, quoted triples, and
blank nodes all travel in the same RDF/JS bindings stream. Comunica scopes source blank nodes in
its query-source layer and carries that internal identity through the selected join actor. The
path layer stores the resulting RDF/JS terms in term-aware maps and sets.

The portable `PathQueryEngine` adapter has less integration surface: it can only call an
engine's public `queryBindings` method. It serializes ordinary frontier terms into `VALUES`.
Since SPARQL syntax cannot name a previously returned blank node, that adapter uses Comunica's
public `initialBindings` option for blank frontiers. This is a transport workaround in the
adapter, not an alternative blank-node identity model.

## Components

The generated component metadata exposes:

- `ActorQueryPath`, the abstract bus contract;
- `ActorQueryPathBfs`, the current traversal implementation;
- `ActorInitQueryPaths`, the standard query init actor plus `mediatorQueryPath`.

The default configuration imports Comunica's stock SPARQL configuration, adds a race mediator
for the path bus, registers the BFS actor, and registers the path-enabled init actor at
`urn:comunica:paths:init`. The BFS actor receives the existing sequential query processor and
the existing RDF-join mediator by reference. No replacement parser, algebra factory, RDF model,
source layer, or join implementation is included.

Alternative path algorithms can subclass `ActorQueryPath`. Callers select one with the
`algorithm` execution option; each actor must accept only its own discriminator in `test()`, so
the race mediator never chooses between competing implementations by completion timing. The
public engine maps an omitted option to `bfs` before mediation.
Alternative Comunica source and join actors can be installed through a downstream configuration
without changing the traversal code.

## Portable adapter

`PathQueryEngine` remains useful when an application already owns a stock or custom engine and
cannot change its Components.js graph. It exposes the same `queryPaths`, `queryPathString`, and
`queryPathService` calls. If its injected engine implements the optional
`queryBindingsWithBindings` hook, the adapter uses that native route; otherwise it falls back to
standard SPARQL requests. This keeps integration incremental while making the configured actor
engine the most idiomatic and capable route.
