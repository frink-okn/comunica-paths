# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build      # tsc -> componentsjs-generator -> comunica-compile-config
npm test           # build, typecheck test/public-types.ts, then node --test test/*.test.mjs
npm run test:live  # bounded two-hop query against a public LDF endpoint (needs network)
npm run clean      # rm -rf components dist engine-default.cjs *.tsbuildinfo
npm run query -- route.paths --file graph.ttl   # run the CLI from this checkout
```

There is no lint script. `npx tsc -p tsconfig.json --noEmit` is the fast typecheck while iterating.

Run one test file or one test:

```bash
node --test test/shortest.test.mjs
node --test --test-name-pattern "frontier" test/actor-engine.test.mjs
```

**Tests import from `dist/`, not `src/`.** `npm test` builds first, but `node --test` alone runs
whatever was last compiled — run `npx tsc -p tsconfig.json` (or the full `npm run build`) before a
bare `node --test`, or you will be testing stale code.

## Build pipeline

Three stages, each feeding the next:

1. `tsc` compiles `src/` to `dist/`.
2. `componentsjs-generator` reads `dist/` and writes `components/*.jsonld`.
3. `comunica-compile-config` compiles `config/config-default.json` into `engine-default.cjs`,
   which `src/QueryEngine.ts` `require`s at runtime as the default actor graph.

Consequences worth knowing before editing:

- `dist/` and `engine-default.cjs` are gitignored; **`components/*.jsonld` is generated but tracked**.
  Changing an actor's constructor parameters regenerates those files, and they must be committed.
- Every new export from `src/index.ts` that is not a Components.js component (types, helper classes,
  functions) must be added to `ignoreComponents` in `.componentsjs-generator-config.json`, or the
  generator will try to emit a component for it and the build will produce noise.
- Only `ActorQueryPath`, `ActorQueryPathBfs`, and `ActorInitQueryPaths` are real components.

## Architecture

`ARCHITECTURE.md` is the authoritative design document — read it before changing execution.
The short version of who owns what:

```
QueryEngine (extends Comunica QueryEngineBase)
  -> mediatorQueryPath (MediatorRace, the dedicated path bus)
    -> ActorQueryPathBfs      request context, lifecycle, physical plan root
      -> PathOperations       algebra compilation + evaluation: the Comunica boundary
        -> IQueryProcessSequential (parse / optimize / evaluate) -> query-operation bus -> RDF-join mediator
      -> BfsPathTraversal     traversal state only; knows nothing about Comunica
      -> PathResultIterator   the output stream, plus PathMetadata
```

PATHS has its own action/actor/bus/mediator rather than extending Comunica's closed
query-operation result union. Everything inside START, END, and VIA is ordinary SPARQL, executed
by unmodified Comunica. `syntax.ts` (PATHS surface syntax) and `service.ts` (a SPARQL 1.1 SERVICE
tunnel) are pure front-ends that produce a `PathQuerySpec` and never touch Comunica.

The layer boundary matters: source selection, join ordering, physical join choice, and frontier
chunking are all Comunica's. This package owns only traversal state and the breadth-first depth
barrier. Keep it that way — if a change starts batching the frontier or picking a join strategy,
it is in the wrong layer.

### Invariants that are easy to break

- **Plan each pattern once, never re-plan.** `ActorOptimizeQueryOperationQuerySourceSkolemize`
  wraps every source in a fresh skolemization layer per call, so re-planning changes blank-node
  identity between depths. `PathOperations.context` is the only context handed to the optimizer.
- **One initialized context per request**, so `NOW()`, source identifiers, and the data factory
  stay stable across depths.
- **The whole frontier goes in as one `VALUES` relation.** `VALUES` reports an exact cardinality,
  which is what lets the RDF-join mediator see the true frontier size and pick bind / hash /
  bind-source. Do not pre-chunk it; the join actors chunk it with their own `blockSize`.
- **`DISTINCT` is wrapped after planning, deliberately.** Planning it in pushes the pattern behind
  a sub-select that the frontier relation can no longer filter, making a source recompute its
  whole distinct edge set every depth.
- **`asynciterator` does not emit `end` on `destroy()`.** Cleanup that must run however a stream
  finishes goes through `PathResultIterator.onDone()`, never an `end` listener.

## Verifying Comunica integration

Claims about pushdown and join selection are checkable, not a matter of reading. `explainPaths`
with `'physical'` runs the traversal and prints the plan the actors actually built, one node per
clause and depth:

```ts
const { data } = await new QueryEngine().explainPaths(spec, { sources }, 'physical');
```

Use it to confirm which physical join a change produces (`bind-source` means the frontier reached
the source as `VALUES`). For endpoint behaviour, stub `fetch` in the query context and assert on
the SPARQL text — `test/actor-engine.test.mjs` has several examples, including the assertions that
the pushed-down query contains `VALUES ?from` and no wrapping sub-`SELECT`.

## Tests

`.mjs` files under `test/`, run by `node --test`, importing the built `dist/`. `test/public-types.ts`
is not executed — it is typechecked by `tsconfig.types.json` to guard the public API surface.
Fixtures in `test/fixtures/` back the deterministic two-source federation used by most suites.
