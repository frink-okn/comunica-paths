import TermMap from '@rdfjs/term-map';
import TermSet from '@rdfjs/term-set';
import type * as RDF from '@rdfjs/types';
import { compatibleBindings } from './bindings.js';
import { InvalidPathQueryError } from './errors.js';
import type { PathOperations } from './PathOperations.js';
import type { PathMetadata } from './PathResultIterator.js';
import type { PathQuerySpec, PathResult, PathStep } from './types.js';

interface RootInfo {
  /** Missing means a root discovered by VIA rather than by a START solution. */
  bindings?: RDF.Bindings[];
}

interface Predecessor {
  from: RDF.Term;
  step: PathStep;
}

interface CorePath {
  nodes: RDF.Term[];
  steps: PathStep[];
}

interface EndpointMatches {
  /** Missing means the unconstrained endpoint, which has one empty match. */
  bindings?: RDF.Bindings[];
}

interface PathState {
  root: RDF.Term;
  node: RDF.Term;
}

interface CycleState {
  root: RDF.Term;
  predecessor: Predecessor;
}

interface AllPathState extends CorePath {
  root: RDF.Term;
  current: RDF.Term;
}

/**
 * Breadth-first path traversal.
 *
 * Only traversal state and the depth barrier are owned here. The barrier is
 * needed to collect all predecessors at the same distance before emitting every
 * shortest path. Source selection, graph-pattern evaluation, join ordering, and
 * the physical join between the frontier and the pattern all happen in
 * {@link PathOperations}, and therefore in Comunica.
 */
export class BfsPathTraversal {
  private readonly maxDepth: number;
  private readonly cyclic: boolean;
  private readonly sameEndpointVariable: boolean;

  private readonly roots = new TermMap<RDF.Term, RootInfo>();
  private readonly endpointCache = new TermMap<RDF.Term, EndpointMatches | null>();
  private readonly distances = new TermMap<RDF.Term, TermMap<RDF.Term, number>>();
  private readonly predecessors = new TermMap<RDF.Term, TermMap<RDF.Term, Predecessor[]>>();
  private readonly cycleDistances = new TermMap<RDF.Term, number>();

  public constructor(
    private readonly spec: PathQuerySpec,
    private readonly operations: PathOperations,
    private readonly metadata: PathMetadata,
  ) {
    this.maxDepth = spec.maxDepth ?? Number.POSITIVE_INFINITY;
    this.cyclic = spec.cyclic ?? false;
    this.sameEndpointVariable = operations.startVariable.equals(operations.endVariable);
  }

  /** Emit matching paths, honouring OFFSET and LIMIT. */
  public async *run(): AsyncGenerator<PathResult, void, undefined> {
    if (this.spec.maxPaths === 0) {
      return;
    }
    const offset = this.spec.offset ?? 0;
    const limit = this.spec.maxPaths ?? Number.POSITIVE_INFINITY;
    let skipped = 0;
    let emitted = 0;

    for await (const result of this.traverse()) {
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

  private traverse(): AsyncGenerator<PathResult, void, undefined> {
    return this.spec.mode === 'all' ? this.traverseAll() : this.traverseShortest();
  }

  private async *traverseShortest(): AsyncGenerator<PathResult, void, undefined> {
    let frontier = new TermMap<RDF.Term, TermSet<RDF.Term>>();
    let depth = 0;

    if (this.operations.hasStart) {
      await this.loadRoots();
      for (const root of this.roots.keys()) {
        getOrCreateTermMap(this.distances, root).set(root, 0);
        addFrontierState(frontier, root, root);
      }
    } else {
      const firstLayer = await this.expandShortestUnconstrained();
      frontier = firstLayer.frontier;
      depth = 1;
      yield* this.emitShortestLayer(firstLayer);
    }
    this.metadata.recordDepth(depth, frontier.size);

    while (frontier.size > 0 && depth < this.maxDepth) {
      const nextDepth = depth + 1;
      const layer = await this.expandShortestFrontier(frontier, nextDepth);
      yield* this.emitShortestLayer(layer);
      frontier = layer.frontier;
      depth = nextDepth;
      this.metadata.recordDepth(depth, frontier.size);
      if (this.fixedEndpointsSettled()) {
        return;
      }
    }
  }

  private async *traverseAll(): AsyncGenerator<PathResult, void, undefined> {
    let frontier = new TermMap<RDF.Term, AllPathState[]>();
    let depth = 0;

    if (this.operations.hasStart) {
      await this.loadRoots();
      for (const root of this.roots.keys()) {
        frontier.set(root, [{ root, current: root, nodes: [ root ], steps: []}]);
      }
    } else {
      const firstLayer = await this.expandAllUnconstrained();
      frontier = firstLayer.frontier;
      depth = 1;
      yield* this.emitAllLayer(firstLayer);
    }
    this.metadata.recordDepth(depth, frontier.size);

    while (frontier.size > 0 && depth < this.maxDepth) {
      const layer = await this.expandAllFrontier(frontier);
      yield* this.emitAllLayer(layer);
      frontier = layer.frontier;
      depth++;
      this.metadata.recordDepth(depth, frontier.size);
    }
  }

  private async loadRoots(): Promise<void> {
    for await (const bindings of this.operations.queryStart()) {
      const term = this.require(bindings, this.operations.startVariable, 'START');
      const existing = this.roots.get(term);
      if (existing) {
        existing.bindings!.push(bindings);
      } else {
        this.roots.set(term, { bindings: [ bindings ]});
      }
    }
  }

  private async expandShortestUnconstrained(): Promise<ShortestLayer> {
    const layer = new ShortestLayer();
    if (this.maxDepth < 1) {
      return layer;
    }
    for await (const bindings of this.operations.queryVia()) {
      const { from, to } = this.requireStep(bindings);
      if (!this.roots.has(from)) {
        this.roots.set(from, {});
        getOrCreateTermMap(this.distances, from).set(from, 0);
      }
      this.discoverShortestEdge(from, from, to, bindings, 1, layer);
    }
    return layer;
  }

  private async expandShortestFrontier(
    frontier: TermMap<RDF.Term, TermSet<RDF.Term>>,
    depth: number,
  ): Promise<ShortestLayer> {
    const layer = new ShortestLayer();
    for await (const bindings of this.operations.queryViaFrom([ ...frontier.keys() ])) {
      const { from, to } = this.requireStep(bindings);
      const matchingRoots = frontier.get(from);
      if (!matchingRoots) {
        throw new InvalidPathQueryError('VIA produced a start node outside the supplied frontier');
      }
      for (const root of matchingRoots) {
        if (!this.roots.has(root)) {
          throw new InvalidPathQueryError('Internal path state lost its START binding');
        }
        this.discoverShortestEdge(root, from, to, bindings, depth, layer);
      }
    }
    return layer;
  }

  private discoverShortestEdge(
    root: RDF.Term,
    from: RDF.Term,
    to: RDF.Term,
    bindings: RDF.Bindings,
    depth: number,
    layer: ShortestLayer,
  ): void {
    const predecessor: Predecessor = { from, step: { from, to, bindings }};
    if (to.equals(root)) {
      const knownCycleDistance = this.cycleDistances.get(root);
      if (knownCycleDistance === undefined) {
        this.cycleDistances.set(root, depth);
        layer.addCycle(root, predecessor);
      } else if (knownCycleDistance === depth) {
        layer.addCycle(root, predecessor);
      }
      return;
    }

    const rootDistances = getOrCreateTermMap(this.distances, root);
    const knownDistance = rootDistances.get(to);
    if (knownDistance !== undefined && knownDistance < depth) {
      return;
    }
    if (knownDistance === undefined) {
      rootDistances.set(to, depth);
      getOrCreateTermMap(this.predecessors, root).set(to, [ predecessor ]);
      layer.addState(root, to);
    } else if (knownDistance === depth) {
      getOrCreateTermMap(this.predecessors, root).get(to)!.push(predecessor);
    }
  }

  private async *emitShortestLayer(layer: ShortestLayer): AsyncGenerator<PathResult, void, undefined> {
    const matches = await this.matchEndpoints(layer.endpointNodes);

    if (!this.cyclic) {
      for (const state of layer.states) {
        const endpoint = matches.get(state.node);
        if (!endpoint || !this.endpointVariablesCompatible(state.root, state.node)) {
          continue;
        }
        for (const path of this.reconstructShortestPaths(state.root, state.node)) {
          yield* this.combineEndpointBindings(path, this.roots.get(state.root), endpoint);
        }
      }
    }
    for (const cycle of layer.cycles) {
      const endpoint = matches.get(cycle.root);
      if (!endpoint) {
        continue;
      }
      for (const path of this.reconstructShortestCycle(cycle.root, cycle.predecessor)) {
        yield* this.combineEndpointBindings(path, this.roots.get(cycle.root), endpoint);
      }
    }
  }

  private async expandAllUnconstrained(): Promise<AllLayer> {
    const layer = new AllLayer();
    if (this.maxDepth < 1) {
      return layer;
    }
    for await (const bindings of this.operations.queryVia()) {
      const { from, to } = this.requireStep(bindings);
      if (!this.roots.has(from)) {
        this.roots.set(from, {});
      }
      const state: AllPathState = {
        root: from,
        current: to,
        nodes: [ from, to ],
        steps: [{ from, to, bindings }],
      };
      if (to.equals(from)) {
        layer.addCycle(state);
      } else {
        layer.addPath(state);
      }
    }
    return layer;
  }

  private async expandAllFrontier(frontier: TermMap<RDF.Term, AllPathState[]>): Promise<AllLayer> {
    const layer = new AllLayer();
    for await (const bindings of this.operations.queryViaFrom([ ...frontier.keys() ])) {
      const { from, to } = this.requireStep(bindings);
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
          steps: [ ...prefix.steps, { from, to, bindings }],
        };
        if (repeated) {
          layer.addCycle(state);
        } else {
          layer.addPath(state);
        }
      }
    }
    return layer;
  }

  private async *emitAllLayer(layer: AllLayer): AsyncGenerator<PathResult, void, undefined> {
    const matches = await this.matchEndpoints(layer.endpointNodes);

    if (!this.cyclic) {
      for (const state of layer.paths) {
        const endpoint = matches.get(state.current);
        if (!endpoint || !this.endpointVariablesCompatible(state.root, state.current)) {
          continue;
        }
        yield* this.combineEndpointBindings(state, this.roots.get(state.root), endpoint);
      }
    }
    for (const state of layer.cycles) {
      const endpoint = matches.get(state.root);
      if (endpoint) {
        yield* this.combineEndpointBindings(state, this.roots.get(state.root), endpoint);
      }
    }
  }

  private async matchEndpoints(
    candidates: TermSet<RDF.Term>,
  ): Promise<TermMap<RDF.Term, EndpointMatches | null>> {
    if (!this.operations.hasEnd) {
      const matches = new TermMap<RDF.Term, EndpointMatches | null>();
      for (const candidate of candidates) {
        matches.set(candidate, {});
      }
      return matches;
    }

    const unknown = [ ...candidates ].filter(candidate => !this.endpointCache.has(candidate));
    for (const term of unknown) {
      this.endpointCache.set(term, null);
    }
    for await (const bindings of this.operations.queryEndFor(unknown)) {
      const term = this.require(bindings, this.operations.endVariable, 'END');
      const existing = this.endpointCache.get(term);
      if (existing) {
        existing.bindings!.push(bindings);
      } else {
        this.endpointCache.set(term, { bindings: [ bindings ]});
      }
    }
    return this.endpointCache;
  }

  /**
   * A `VALUES`-only END describes a finite target set. Once every relevant
   * start/target pair has a shortest distance, deeper layers cannot add a valid
   * shortest result and must not be expanded.
   */
  private fixedEndpointsSettled(): boolean {
    const endpoints = this.operations.hasStart ? this.operations.fixedEndNodes : undefined;
    if (!endpoints) {
      return false;
    }
    for (const root of this.roots.keys()) {
      for (const endpoint of endpoints) {
        if ((this.cyclic || this.sameEndpointVariable) && !root.equals(endpoint)) {
          continue;
        }
        const settled = root.equals(endpoint) ?
          this.cycleDistances.has(root) :
          this.distances.get(root)?.has(endpoint) ?? false;
        if (!settled) {
          return false;
        }
      }
    }
    return true;
  }

  private endpointVariablesCompatible(root: RDF.Term, endpoint: RDF.Term): boolean {
    return !this.sameEndpointVariable || root.equals(endpoint);
  }

  private *combineEndpointBindings(
    path: CorePath,
    root: RootInfo | undefined,
    endpoint: EndpointMatches,
  ): Iterable<PathResult> {
    const starts: (RDF.Bindings | undefined)[] = root?.bindings ?? [ undefined ];
    const ends: (RDF.Bindings | undefined)[] = endpoint.bindings ?? [ undefined ];
    for (const startBindings of starts) {
      for (const endBindings of ends) {
        if (!compatibleBindings(startBindings, endBindings)) {
          continue;
        }
        yield {
          nodes: path.nodes,
          steps: path.steps,
          ...startBindings ? { startBindings } : {},
          ...endBindings ? { endBindings } : {},
        };
      }
    }
  }

  private *reconstructShortestPaths(root: RDF.Term, node: RDF.Term): Iterable<CorePath> {
    const pending: { current: RDF.Term; reversedNodes: RDF.Term[]; reversedSteps: PathStep[] }[] = [
      { current: node, reversedNodes: [ node ], reversedSteps: []},
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
      const options = this.predecessors.get(root)?.get(state.current) ?? [];
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

  private *reconstructShortestCycle(root: RDF.Term, predecessor: Predecessor): Iterable<CorePath> {
    for (const prefix of this.reconstructShortestPaths(root, predecessor.from)) {
      yield {
        nodes: [ ...prefix.nodes, root ],
        steps: [ ...prefix.steps, predecessor.step ],
      };
    }
  }

  private requireStep(bindings: RDF.Bindings): { from: RDF.Term; to: RDF.Term } {
    return {
      from: this.require(bindings, this.operations.viaFromVariable, 'VIA'),
      to: this.require(bindings, this.operations.viaToVariable, 'VIA'),
    };
  }

  private require(bindings: RDF.Bindings, variable: RDF.Variable, clause: string): RDF.Term {
    const term = bindings.get(variable);
    if (!term) {
      throw new InvalidPathQueryError(`${clause} pattern did not bind ?${variable.value}`);
    }
    return term;
  }
}

class ShortestLayer {
  public readonly frontier = new TermMap<RDF.Term, TermSet<RDF.Term>>();
  public readonly endpointNodes = new TermSet<RDF.Term>();
  public readonly states: PathState[] = [];
  public readonly cycles: CycleState[] = [];

  public addState(root: RDF.Term, node: RDF.Term): void {
    addFrontierState(this.frontier, node, root);
    this.endpointNodes.add(node);
    this.states.push({ root, node });
  }

  public addCycle(root: RDF.Term, predecessor: Predecessor): void {
    this.endpointNodes.add(root);
    this.cycles.push({ root, predecessor });
  }
}

class AllLayer {
  public readonly frontier = new TermMap<RDF.Term, AllPathState[]>();
  public readonly endpointNodes = new TermSet<RDF.Term>();
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

function getOrCreateTermMap<V>(
  map: TermMap<RDF.Term, TermMap<RDF.Term, V>>,
  key: RDF.Term,
): TermMap<RDF.Term, V> {
  let nested = map.get(key);
  if (!nested) {
    nested = new TermMap<RDF.Term, V>();
    map.set(key, nested);
  }
  return nested;
}

function addFrontierState(
  frontier: TermMap<RDF.Term, TermSet<RDF.Term>>,
  node: RDF.Term,
  root: RDF.Term,
): void {
  let roots = frontier.get(node);
  if (!roots) {
    roots = new TermSet<RDF.Term>();
    frontier.set(node, roots);
  }
  roots.add(root);
}
