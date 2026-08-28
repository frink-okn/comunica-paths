import TermMap from '@rdfjs/term-map';
import TermSet from '@rdfjs/term-set';
import type { Bindings, Term } from '@rdfjs/types';
import type { SelectQuery } from 'sparqljs';
import { compatibleBindings, getBinding } from './bindings.js';
import { InvalidPathQueryError, PathQueryCancelledError } from './errors.js';
import { compilePattern, compileQuery, compileValuesQuery, validateSparqlVariable } from './sparql.js';
import { parsePathServiceQuery } from './service.js';
import { parsePathQuery } from './syntax.js';
import type {
  BindingsQueryEngine,
  IPathQueryEngine,
  PathQueryEngineOptions,
  PathQueryExecutionOptions,
  PathQuerySpec,
  PathResult,
  PathStep,
  SparqlVariable,
} from './types.js';

interface RootInfo {
  bindings?: Bindings[];
}

interface Predecessor {
  from: Term;
  step: PathStep;
}

interface CorePath {
  nodes: Term[];
  steps: PathStep[];
}

interface EndpointMatches {
  /** Missing means the unconstrained endpoint, which has one empty match. */
  bindings?: Bindings[];
}

interface QueryTemplates {
  start: SelectQuery | undefined;
  end: SelectQuery | undefined;
  via: SelectQuery;
}

interface PathState {
  root: Term;
  node: Term;
}

interface CycleState {
  root: Term;
  predecessor: Predecessor;
}

interface AllPathState extends CorePath {
  root: Term;
  current: Term;
}

const DEFAULT_BATCH_SIZE = 128;

/**
 * Executes paths as a sequence of ordinary SPARQL bindings queries. The
 * injected engine remains responsible for source selection, joins,
 * federation, reasoning, and physical query planning.
 */
export class PathQueryEngine<QueryContext = unknown> implements IPathQueryEngine<QueryContext> {
  private readonly batchSize: number;

  public constructor(
    private readonly engine: BindingsQueryEngine<QueryContext>,
    options: PathQueryEngineOptions = {},
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize <= 0) {
      throw new InvalidPathQueryError('batchSize must be a positive safe integer');
    }
  }

  public async *queryPaths(
    spec: PathQuerySpec,
    context?: QueryContext,
    options: PathQueryExecutionOptions = {},
  ): AsyncIterable<PathResult> {
    validateSpec(spec);
    const templates = this.compileTemplates(spec);
    if (spec.maxPaths === 0) {
      return;
    }

    const traversal = spec.mode === 'all' ?
      this.queryAll(spec, templates, context, options.signal) :
      this.queryShortest(spec, templates, context, options.signal);
    const offset = spec.offset ?? 0;
    const limit = spec.maxPaths ?? Number.POSITIVE_INFINITY;
    let skipped = 0;
    let emitted = 0;

    for await (const result of traversal) {
      throwIfCancelled(options.signal);
      if (skipped < offset) {
        skipped++;
        continue;
      }
      yield result;
      emitted++;
      if (emitted >= limit) {
        return;
      }
    }
  }

  public queryPathString(
    query: string,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): AsyncIterable<PathResult> {
    return this.queryPaths(parsePathQuery(query), context, options);
  }

  public queryPathService(
    query: string,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): AsyncIterable<PathResult> {
    return this.queryPaths(parsePathServiceQuery(query), context, options);
  }

  private async *queryShortest(
    spec: PathQuerySpec,
    templates: QueryTemplates,
    context: QueryContext | undefined,
    signal: AbortSignal | undefined,
  ): AsyncIterable<PathResult> {
    const roots = templates.start ?
      await this.loadRoots(templates.start, spec.start.node, context, signal) :
      new TermMap<Term, RootInfo>();
    const distances = new TermMap<Term, TermMap<Term, number>>();
    const predecessors = new TermMap<Term, TermMap<Term, Predecessor[]>>();
    const cycleDistances = new TermMap<Term, number>();
    const endpointCache = new TermMap<Term, EndpointMatches | null>();
    let frontier = new TermMap<Term, TermSet<Term>>();
    let depth = 0;

    if (templates.start) {
      for (const root of roots.keys()) {
        getOrCreateTermMap(distances, root).set(root, 0);
        addFrontierState(frontier, root, root);
      }
    } else {
      const firstLayer = await this.expandShortestUnconstrained(
        templates.via,
        spec,
        roots,
        distances,
        predecessors,
        cycleDistances,
        context,
        signal,
      );
      frontier = firstLayer.frontier;
      depth = 1;
      yield* this.emitShortestLayer(
        firstLayer,
        templates.end,
        spec,
        roots,
        predecessors,
        endpointCache,
        context,
        signal,
      );
    }

    const maxDepth = spec.maxDepth ?? Number.POSITIVE_INFINITY;
    while (frontier.size > 0 && depth < maxDepth) {
      throwIfCancelled(signal);
      const nextDepth = depth + 1;
      const layer = await this.expandShortestFrontier(
        frontier,
        nextDepth,
        templates.via,
        spec,
        roots,
        distances,
        predecessors,
        cycleDistances,
        context,
        signal,
      );
      yield* this.emitShortestLayer(
        layer,
        templates.end,
        spec,
        roots,
        predecessors,
        endpointCache,
        context,
        signal,
      );
      frontier = layer.frontier;
      depth = nextDepth;
    }
  }

  private async *queryAll(
    spec: PathQuerySpec,
    templates: QueryTemplates,
    context: QueryContext | undefined,
    signal: AbortSignal | undefined,
  ): AsyncIterable<PathResult> {
    const roots = templates.start ?
      await this.loadRoots(templates.start, spec.start.node, context, signal) :
      new TermMap<Term, RootInfo>();
    const endpointCache = new TermMap<Term, EndpointMatches | null>();
    let frontier = new TermMap<Term, AllPathState[]>();
    let depth = 0;

    if (templates.start) {
      for (const root of roots.keys()) {
        frontier.set(root, [{ root, current: root, nodes: [ root ], steps: [] }]);
      }
    } else {
      const firstLayer = await this.expandAllUnconstrained(templates.via, spec, roots, context, signal);
      frontier = firstLayer.frontier;
      depth = 1;
      yield* this.emitAllLayer(firstLayer, templates.end, spec, roots, endpointCache, context, signal);
    }

    const maxDepth = spec.maxDepth ?? Number.POSITIVE_INFINITY;
    while (frontier.size > 0 && depth < maxDepth) {
      throwIfCancelled(signal);
      const layer = await this.expandAllFrontier(frontier, templates.via, spec, context, signal);
      yield* this.emitAllLayer(layer, templates.end, spec, roots, endpointCache, context, signal);
      frontier = layer.frontier;
      depth++;
    }
  }

  private compileTemplates(spec: PathQuerySpec): QueryTemplates {
    return {
      start: spec.start.pattern?.trim() ? compilePattern(spec.prologue, spec.start.pattern, spec.dataset) : undefined,
      end: spec.end.pattern?.trim() ? compilePattern(spec.prologue, spec.end.pattern, spec.dataset) : undefined,
      via: compilePattern(spec.prologue, spec.via.pattern, spec.dataset),
    };
  }

  private async loadRoots(
    template: SelectQuery,
    variable: SparqlVariable,
    context: QueryContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<TermMap<Term, RootInfo>> {
    const roots = new TermMap<Term, RootInfo>();
    for await (const bindings of this.queryBindings(compileQuery(template), context, signal)) {
      const term = requireBinding(bindings, variable, 'START');
      const existing = roots.get(term);
      if (existing) {
        existing.bindings!.push(bindings);
      } else {
        roots.set(term, { bindings: [ bindings ] });
      }
    }
    return roots;
  }

  private async expandShortestUnconstrained(
    via: SelectQuery,
    spec: PathQuerySpec,
    roots: TermMap<Term, RootInfo>,
    distances: TermMap<Term, TermMap<Term, number>>,
    predecessors: TermMap<Term, TermMap<Term, Predecessor[]>>,
    cycleDistances: TermMap<Term, number>,
    context: QueryContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ShortestLayer> {
    const layer = new ShortestLayer();
    if ((spec.maxDepth ?? Number.POSITIVE_INFINITY) < 1) {
      return layer;
    }

    for await (const bindings of this.queryBindings(compileQuery(via), context, signal)) {
      const from = requireBinding(bindings, spec.via.from, 'VIA');
      const to = requireBinding(bindings, spec.via.to, 'VIA');
      if (!roots.has(from)) {
        roots.set(from, {});
        getOrCreateTermMap(distances, from).set(from, 0);
      }
      this.discoverShortestEdge(
        from,
        from,
        to,
        bindings,
        1,
        layer,
        distances,
        predecessors,
        cycleDistances,
      );
    }
    return layer;
  }

  private async expandShortestFrontier(
    frontier: TermMap<Term, TermSet<Term>>,
    depth: number,
    via: SelectQuery,
    spec: PathQuerySpec,
    roots: TermMap<Term, RootInfo>,
    distances: TermMap<Term, TermMap<Term, number>>,
    predecessors: TermMap<Term, TermMap<Term, Predecessor[]>>,
    cycleDistances: TermMap<Term, number>,
    context: QueryContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ShortestLayer> {
    const layer = new ShortestLayer();
    for (const terms of batches([ ...frontier.keys() ], this.batchSize)) {
      const query = compileValuesQuery(via, spec.via.from, terms);
      for await (const bindings of this.queryBindings(query, context, signal)) {
        const from = requireBinding(bindings, spec.via.from, 'VIA');
        const to = requireBinding(bindings, spec.via.to, 'VIA');
        const matchingRoots = frontier.get(from);
        if (!matchingRoots) {
          throw new InvalidPathQueryError('VIA produced a start node outside the supplied frontier');
        }
        for (const root of matchingRoots) {
          if (!roots.has(root)) {
            throw new InvalidPathQueryError('Internal path state lost its START binding');
          }
          this.discoverShortestEdge(
            root,
            from,
            to,
            bindings,
            depth,
            layer,
            distances,
            predecessors,
            cycleDistances,
          );
        }
      }
    }
    return layer;
  }

  private discoverShortestEdge(
    root: Term,
    from: Term,
    to: Term,
    bindings: Bindings,
    depth: number,
    layer: ShortestLayer,
    distances: TermMap<Term, TermMap<Term, number>>,
    predecessors: TermMap<Term, TermMap<Term, Predecessor[]>>,
    cycleDistances: TermMap<Term, number>,
  ): void {
    const predecessor: Predecessor = { from, step: { from, to, bindings } };
    if (to.equals(root)) {
      const knownCycleDistance = cycleDistances.get(root);
      if (knownCycleDistance === undefined) {
        cycleDistances.set(root, depth);
        layer.addCycle(root, predecessor);
      } else if (knownCycleDistance === depth) {
        layer.addCycle(root, predecessor);
      }
      return;
    }

    const rootDistances = getOrCreateTermMap(distances, root);
    const knownDistance = rootDistances.get(to);
    if (knownDistance !== undefined && knownDistance < depth) {
      return;
    }
    if (knownDistance === undefined) {
      rootDistances.set(to, depth);
      getOrCreateTermMap(predecessors, root).set(to, [ predecessor ]);
      layer.addState(root, to);
    } else if (knownDistance === depth) {
      getOrCreateTermMap(predecessors, root).get(to)!.push(predecessor);
    }
  }

  private async *emitShortestLayer(
    layer: ShortestLayer,
    end: SelectQuery | undefined,
    spec: PathQuerySpec,
    roots: TermMap<Term, RootInfo>,
    predecessors: TermMap<Term, TermMap<Term, Predecessor[]>>,
    endpointCache: TermMap<Term, EndpointMatches | null>,
    context: QueryContext | undefined,
    signal: AbortSignal | undefined,
  ): AsyncIterable<PathResult> {
    const matches = await this.matchEndpoints(
      layer.endpointNodes,
      end,
      spec.end.node,
      endpointCache,
      context,
      signal,
    );

    if (!spec.cyclic) {
      for (const state of layer.states) {
        const endpoint = matches.get(state.node);
        if (!endpoint || !endpointVariablesCompatible(spec, state.root, state.node)) {
          continue;
        }
        for (const path of reconstructShortestPaths(state.root, state.node, predecessors)) {
          yield* combineEndpointBindings(path, roots.get(state.root), endpoint);
        }
      }
    }
    for (const cycle of layer.cycles) {
      const endpoint = matches.get(cycle.root);
      if (!endpoint) {
        continue;
      }
      for (const path of reconstructShortestCycle(cycle.root, cycle.predecessor, predecessors)) {
        yield* combineEndpointBindings(path, roots.get(cycle.root), endpoint);
      }
    }
  }

  private async expandAllUnconstrained(
    via: SelectQuery,
    spec: PathQuerySpec,
    roots: TermMap<Term, RootInfo>,
    context: QueryContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AllLayer> {
    const layer = new AllLayer();
    if ((spec.maxDepth ?? Number.POSITIVE_INFINITY) < 1) {
      return layer;
    }

    for await (const bindings of this.queryBindings(compileQuery(via), context, signal)) {
      const from = requireBinding(bindings, spec.via.from, 'VIA');
      const to = requireBinding(bindings, spec.via.to, 'VIA');
      if (!roots.has(from)) {
        roots.set(from, {});
      }
      const state: AllPathState = {
        root: from,
        current: to,
        nodes: [ from, to ],
        steps: [ { from, to, bindings } ],
      };
      if (to.equals(from)) {
        layer.addCycle(state);
      } else {
        layer.addPath(state);
      }
    }
    return layer;
  }

  private async expandAllFrontier(
    frontier: TermMap<Term, AllPathState[]>,
    via: SelectQuery,
    spec: PathQuerySpec,
    context: QueryContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AllLayer> {
    const layer = new AllLayer();
    for (const terms of batches([ ...frontier.keys() ], this.batchSize)) {
      const query = compileValuesQuery(via, spec.via.from, terms);
      for await (const bindings of this.queryBindings(query, context, signal)) {
        const from = requireBinding(bindings, spec.via.from, 'VIA');
        const to = requireBinding(bindings, spec.via.to, 'VIA');
        const prefixes = frontier.get(from);
        if (!prefixes) {
          throw new InvalidPathQueryError('VIA produced a start node outside the supplied frontier');
        }
        for (const prefix of prefixes) {
          const repeated = prefix.nodes.some(node => node.equals(to));
          if (repeated && !to.equals(prefix.root)) {
            continue;
          }
          const state: AllPathState = {
            root: prefix.root,
            current: to,
            nodes: [ ...prefix.nodes, to ],
            steps: [ ...prefix.steps, { from, to, bindings } ],
          };
          if (repeated) {
            layer.addCycle(state);
          } else {
            layer.addPath(state);
          }
        }
      }
    }
    return layer;
  }

  private async *emitAllLayer(
    layer: AllLayer,
    end: SelectQuery | undefined,
    spec: PathQuerySpec,
    roots: TermMap<Term, RootInfo>,
    endpointCache: TermMap<Term, EndpointMatches | null>,
    context: QueryContext | undefined,
    signal: AbortSignal | undefined,
  ): AsyncIterable<PathResult> {
    const matches = await this.matchEndpoints(
      layer.endpointNodes,
      end,
      spec.end.node,
      endpointCache,
      context,
      signal,
    );

    if (!spec.cyclic) {
      for (const state of layer.paths) {
        const endpoint = matches.get(state.current);
        if (!endpoint || !endpointVariablesCompatible(spec, state.root, state.current)) {
          continue;
        }
        yield* combineEndpointBindings(state, roots.get(state.root), endpoint);
      }
    }
    for (const state of layer.cycles) {
      const endpoint = matches.get(state.root);
      if (endpoint) {
        yield* combineEndpointBindings(state, roots.get(state.root), endpoint);
      }
    }
  }

  private async matchEndpoints(
    candidates: TermSet<Term>,
    end: SelectQuery | undefined,
    variable: SparqlVariable,
    cache: TermMap<Term, EndpointMatches | null>,
    context: QueryContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<TermMap<Term, EndpointMatches | null>> {
    if (!end) {
      const matches = new TermMap<Term, EndpointMatches | null>();
      for (const candidate of candidates) {
        matches.set(candidate, {});
      }
      return matches;
    }

    const unknown = [ ...candidates ].filter(candidate => !cache.has(candidate));
    for (const terms of batches(unknown, this.batchSize)) {
      for (const term of terms) {
        cache.set(term, null);
      }
      const query = compileValuesQuery(end, variable, terms);
      for await (const bindings of this.queryBindings(query, context, signal)) {
        const term = requireBinding(bindings, variable, 'END');
        const existing = cache.get(term);
        if (existing) {
          existing.bindings!.push(bindings);
        } else {
          cache.set(term, { bindings: [ bindings ] });
        }
      }
    }
    return cache;
  }

  private async *queryBindings(
    query: string,
    context: QueryContext | undefined,
    signal: AbortSignal | undefined,
  ): AsyncIterable<Bindings> {
    throwIfCancelled(signal);
    const stream = await abortable(this.engine.queryBindings(query, context), signal);
    const iterator = stream[Symbol.asyncIterator]();
    let done = false;

    try {
      while (!done) {
        const next = await abortable(iterator.next(), signal, () => stream.destroy?.(new PathQueryCancelledError()));
        done = Boolean(next.done);
        if (!next.done) {
          yield next.value;
        }
      }
    } finally {
      if (!done) {
        if (stream.destroy) {
          stream.destroy();
        } else {
          void iterator.return?.();
        }
      }
    }
  }
}

class ShortestLayer {
  public readonly frontier = new TermMap<Term, TermSet<Term>>();
  public readonly endpointNodes = new TermSet<Term>();
  public readonly states: PathState[] = [];
  public readonly cycles: CycleState[] = [];

  public addState(root: Term, node: Term): void {
    addFrontierState(this.frontier, node, root);
    this.endpointNodes.add(node);
    this.states.push({ root, node });
  }

  public addCycle(root: Term, predecessor: Predecessor): void {
    this.endpointNodes.add(root);
    this.cycles.push({ root, predecessor });
  }
}

class AllLayer {
  public readonly frontier = new TermMap<Term, AllPathState[]>();
  public readonly endpointNodes = new TermSet<Term>();
  public readonly paths: AllPathState[] = [];
  public readonly cycles: AllPathState[] = [];

  public addPath(state: AllPathState): void {
    const paths = this.frontier.get(state.current);
    if (paths) {
      paths.push(state);
    } else {
      this.frontier.set(state.current, [ state ]);
    }
    this.endpointNodes.add(state.current);
    this.paths.push(state);
  }

  public addCycle(state: AllPathState): void {
    this.endpointNodes.add(state.root);
    this.cycles.push(state);
  }
}

function validateSpec(spec: PathQuerySpec): void {
  validateVariable(spec.start.node, 'START');
  validateVariable(spec.end.node, 'END');
  validateVariable(spec.via.from, 'VIA from');
  validateVariable(spec.via.to, 'VIA to');
  if (spec.via.from.slice(1) === spec.via.to.slice(1)) {
    throw new InvalidPathQueryError('VIA from and to variables must be different');
  }
  if (!spec.via.pattern.trim()) {
    throw new InvalidPathQueryError('VIA pattern must not be empty');
  }
  if (spec.mode !== undefined && ![ 'shortest', 'all' ].includes(spec.mode)) {
    throw new InvalidPathQueryError(`Unknown path query mode: ${String(spec.mode)}`);
  }
  for (const [ name, value ] of [
    [ 'maxDepth', spec.maxDepth ],
    [ 'maxPaths', spec.maxPaths ],
    [ 'offset', spec.offset ],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new InvalidPathQueryError(`${name} must be a non-negative safe integer`);
    }
  }
}

function validateVariable(variable: string, label: string): void {
  validateSparqlVariable(variable, label);
}

function requireBinding(bindings: Bindings, variable: SparqlVariable, clause: string): Term {
  const term = getBinding(bindings, variable);
  if (!term) {
    throw new InvalidPathQueryError(`${clause} pattern did not bind ${variable}`);
  }
  return term;
}

function getOrCreateTermMap<V>(map: TermMap<Term, TermMap<Term, V>>, key: Term): TermMap<Term, V> {
  let nested = map.get(key);
  if (!nested) {
    nested = new TermMap<Term, V>();
    map.set(key, nested);
  }
  return nested;
}

function addFrontierState(frontier: TermMap<Term, TermSet<Term>>, node: Term, root: Term): void {
  let roots = frontier.get(node);
  if (!roots) {
    roots = new TermSet<Term>();
    frontier.set(node, roots);
  }
  roots.add(root);
}

function* batches<T>(values: readonly T[], size: number): Iterable<readonly T[]> {
  for (let offset = 0; offset < values.length; offset += size) {
    yield values.slice(offset, offset + size);
  }
}

function endpointVariablesCompatible(spec: PathQuerySpec, root: Term, endpoint: Term): boolean {
  return spec.start.node.slice(1) !== spec.end.node.slice(1) || root.equals(endpoint);
}

function* combineEndpointBindings(
  path: CorePath,
  root: RootInfo | undefined,
  endpoint: EndpointMatches,
): Iterable<PathResult> {
  const starts: Array<Bindings | undefined> = root?.bindings ?? [ undefined ];
  const ends: Array<Bindings | undefined> = endpoint.bindings ?? [ undefined ];
  for (const startBindings of starts) {
    for (const endBindings of ends) {
      if (!compatibleBindings(startBindings, endBindings)) {
        continue;
      }
      yield {
        nodes: path.nodes,
        steps: path.steps,
        ...(startBindings ? { startBindings } : {}),
        ...(endBindings ? { endBindings } : {}),
      };
    }
  }
}

function* reconstructShortestPaths(
  root: Term,
  node: Term,
  predecessors: TermMap<Term, TermMap<Term, Predecessor[]>>,
): Iterable<CorePath> {
  const pending: Array<{ current: Term; reversedNodes: Term[]; reversedSteps: PathStep[] }> = [
    { current: node, reversedNodes: [ node ], reversedSteps: [] },
  ];
  while (pending.length > 0) {
    const state = pending.pop()!;
    if (state.current.equals(root)) {
      yield {
        nodes: [ ...state.reversedNodes ].reverse(),
        steps: [ ...state.reversedSteps ].reverse(),
      };
      continue;
    }
    const options = predecessors.get(root)?.get(state.current) ?? [];
    for (let index = options.length - 1; index >= 0; index--) {
      const predecessor = options[index]!;
      pending.push({
        current: predecessor.from,
        reversedNodes: [ ...state.reversedNodes, predecessor.from ],
        reversedSteps: [ ...state.reversedSteps, predecessor.step ],
      });
    }
  }
}

function* reconstructShortestCycle(
  root: Term,
  predecessor: Predecessor,
  predecessors: TermMap<Term, TermMap<Term, Predecessor[]>>,
): Iterable<CorePath> {
  for (const prefix of reconstructShortestPaths(root, predecessor.from, predecessors)) {
    yield {
      nodes: [ ...prefix.nodes, root ],
      steps: [ ...prefix.steps, predecessor.step ],
    };
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new PathQueryCancelledError();
  }
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  throwIfCancelled(signal);

  return new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => {
      onAbort?.();
      reject(new PathQueryCancelledError());
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      },
    );
  });
}
