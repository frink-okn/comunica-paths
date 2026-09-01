import TermMap from '@rdfjs/term-map';
import TermSet from '@rdfjs/term-set';
import type * as RDF from '@rdfjs/types';
import { compatibleBindings } from './bindings.js';
import { InvalidPathQueryError } from './errors.js';
import type { PathOperations } from './PathOperations.js';
import type { PathMetadata } from './PathResultIterator.js';
import { now, type PathTraversalStats } from './PathStats.js';
import type { PathQuerySpec, PathResult, PathStep } from './types.js';

/**
 * The largest number of partial paths an `ALL` depth accumulates before their
 * endpoints are tested and the completed paths among them are emitted.
 *
 * This is the granularity at which a depth becomes interruptible: a consumer
 * that has seen enough, or a satisfied LIMIT, stops the traversal within one
 * batch rather than after the whole depth. It is not a frontier chunk — the
 * frontier still reaches Comunica whole, so the join actors still see its true
 * cardinality and still chunk any pushdown themselves.
 */
const ENDPOINT_BATCH = 512;

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

/**
 * One partial path, held as a link to the partial path it extends.
 *
 * An `ALL` traversal discovers far more partial paths than it emits, so a state
 * costs one object and no copying: the nodes and steps of a path are collected
 * only when that path is actually emitted. Sharing the prefix is safe because a
 * state is never mutated after it is created.
 */
interface AllPathState {
  root: RDF.Term;
  current: RDF.Term;
  /** The partial path this one extends. Missing at a root. */
  prefix: AllPathState | undefined;
  /** The edge taken from the prefix's node to {@link current}. Missing at a root. */
  step: PathStep | undefined;
  /** Edges from the root, which is the length of the path this state describes. */
  length: number;
}

/** The frontier of an `ALL` traversal: every partial path, by the node it sits on. */
type AllFrontier = TermMap<RDF.Term, AllPathState[]>;

/**
 * Breadth-first path traversal.
 *
 * Only traversal state and the depth barrier are owned here. The barrier is
 * needed to collect all predecessors at the same distance before emitting every
 * shortest path. Source selection, graph-pattern evaluation, join ordering, and
 * the physical join between the frontier and the pattern all happen in
 * {@link PathOperations}, and therefore in Comunica.
 *
 * An `ALL` traversal keeps the depth ordering but not the barrier: it has no
 * reason to wait for a depth to finish, so it emits completed paths in batches
 * as the depth's solutions arrive. That is what lets a satisfied LIMIT, or a
 * consumer that stops reading, destroy the bindings stream mid-depth instead of
 * after it.
 */
export class BfsPathTraversal {
  private readonly maxDepth: number;
  private readonly cyclic: boolean;

  private readonly roots = new TermMap<RDF.Term, RootInfo>();
  private readonly endpointCache = new TermMap<RDF.Term, EndpointMatches | null>();
  private readonly distances = new TermMap<RDF.Term, TermMap<RDF.Term, number>>();
  private readonly predecessors = new TermMap<RDF.Term, TermMap<RDF.Term, Predecessor[]>>();
  private readonly cycleDistances = new TermMap<RDF.Term, number>();
  /** Endpoint nodes the depth in progress has already counted. Only while measuring. */
  private countedEndpoints: TermSet<RDF.Term> | undefined;

  public constructor(
    private readonly spec: PathQuerySpec,
    private readonly operations: PathOperations,
    private readonly metadata: PathMetadata,
    /** Collects counters and timings. Absent unless a plan logger asked for them. */
    private readonly stats?: PathTraversalStats,
  ) {
    this.maxDepth = spec.maxDepth ?? Number.POSITIVE_INFINITY;
    this.cyclic = spec.cyclic ?? false;
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
      this.stats?.recordEmitted();
      const suspended = now();
      yield result;
      this.stats?.time('downstreamMs', suspended);
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

    // A bound of zero edges admits no path, since a path of no edges is never
    // emitted. Returning here reports no depth as completed, and spares the
    // clause evaluations whose results could not be used anyway.
    if (this.maxDepth < 1) {
      this.metadata.recordDepth(depth, 0);
      return;
    }

    if (this.operations.hasStart && !this.operations.canJoinStart) {
      await this.loadRoots();
      for (const root of this.roots.keys()) {
        getOrCreateTermMap(this.distances, root).set(root, 0);
        addFrontierState(frontier, root, root);
      }
    } else {
      depth = 1;
      const joinedEnd = this.joinsEndAt(depth, true);
      this.openDepth(depth, 0, 0, joinedEnd);
      const firstLayer = await this.expandShortest(undefined, depth, joinedEnd);
      frontier = firstLayer.frontier;
      yield* this.emitShortestLayer(firstLayer, depth, joinedEnd);
    }
    this.metadata.recordDepth(depth, frontier.size);

    while (frontier.size > 0 && depth < this.maxDepth) {
      // Checked before expanding rather than after, so that a first depth which
      // already settled every pair — whether it came from START joined with VIA
      // or from a seeded frontier — stops here too.
      if (this.fixedEndpointsSettled()) {
        break;
      }
      const nextDepth = depth + 1;
      const joinedEnd = this.joinsEndAt(nextDepth, false);
      this.openDepth(nextDepth, frontier.size, countShortestStates(frontier), joinedEnd);
      const layer = await this.expandShortest(frontier, nextDepth, joinedEnd);
      yield* this.emitShortestLayer(layer, nextDepth, joinedEnd);
      frontier = layer.frontier;
      depth = nextDepth;
      this.metadata.recordDepth(depth, frontier.size);
    }
    this.stats?.closeDepth();
  }

  private async *traverseAll(): AsyncGenerator<PathResult, void, undefined> {
    let frontier: AllFrontier = new TermMap<RDF.Term, AllPathState[]>();
    let depth = 0;

    // A bound of zero edges admits no path, since a path of no edges is never
    // emitted. Returning here reports no depth as completed, and spares the
    // clause evaluations whose results could not be used anyway.
    if (this.maxDepth < 1) {
      this.metadata.recordDepth(depth, 0);
      return;
    }

    if (this.operations.hasStart && !this.operations.canJoinStart) {
      await this.loadRoots();
      for (const root of this.roots.keys()) {
        frontier.set(root, [ rootState(root) ]);
      }
    } else {
      depth = 1;
      frontier = yield* this.expandAll(undefined, depth);
    }
    this.metadata.recordDepth(depth, countAllStates(frontier));

    while (frontier.size > 0 && depth < this.maxDepth) {
      depth++;
      frontier = yield* this.expandAll(frontier, depth);
      // Every partial path is expanded on its own, so the states left to expand
      // are the partial paths, not the distinct nodes they currently sit on.
      this.metadata.recordDepth(depth, countAllStates(frontier));
    }
    this.stats?.closeDepth();
  }

  /**
   * How many partial paths the first batch of a depth collects.
   *
   * At most every path the query could still emit, so a small LIMIT is answered
   * from the first solutions of a depth rather than from all of them.
   */
  private firstBatchSize(): number {
    const wanted = (this.spec.offset ?? 0) + (this.spec.maxPaths ?? Number.POSITIVE_INFINITY);
    return Math.max(1, Math.min(ENDPOINT_BATCH, wanted));
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

  /**
   * Whether the END constraint travels with the VIA evaluation of one depth.
   *
   * Only the final permitted depth qualifies, and only when a plan joining END
   * exists for the shape that depth is evaluated in.
   */
  private joinsEndAt(depth: number, first: boolean): boolean {
    if (depth < this.maxDepth || !this.operations.canJoinEnd) {
      return false;
    }
    return first && this.operations.canJoinStart ? this.operations.canJoinStartEnd : true;
  }

  /** The VIA solutions of one depth, with or without the END constraint applied. */
  private expansionStream(
    nodes: readonly RDF.Term[] | undefined,
    depth: number,
    joinedEnd: boolean,
  ): AsyncIterable<RDF.Bindings> {
    if (nodes) {
      return this.operations.queryViaFrom(nodes, depth, joinedEnd);
    }
    return this.operations.canJoinStart ?
      this.operations.queryViaFromStart(joinedEnd) :
      this.operations.queryVia(depth, joinedEnd);
  }

  /**
   * Expand one `ALL` depth, emitting completed paths as they are discovered and
   * returning the frontier for the depth after it.
   */
  private async *expandAll(
    frontier: AllFrontier | undefined,
    depth: number,
  ): AsyncGenerator<PathResult, AllFrontier, undefined> {
    const next: AllFrontier = new TermMap<RDF.Term, AllPathState[]>();
    const joinedEnd = this.joinsEndAt(depth, frontier === undefined);
    this.openDepth(depth, frontier?.size ?? 0, frontier ? countAllStates(frontier) : 0, joinedEnd);
    let batch: AllPathState[] = [];
    // A query that only wants a few paths should not wait for a full batch to
    // find them, but a candidate need not match END, so a batch sized to the
    // remaining need can come back empty. Growing it after every flush keeps the
    // first paths early without turning a selective END into one query per path.
    let target = this.firstBatchSize();

    for await (const bindings of this.timed(this.expansionStream(
      frontier ? [ ...frontier.keys() ] : undefined,
      depth,
      joinedEnd,
    ))) {
      let started = now();
      const { from, to } = this.requireStep(bindings);
      if (joinedEnd && this.operations.joinedEndIsComplete) {
        this.recordJoinedEndpoint(to, bindings);
      }
      const step: PathStep = { from, to, bindings };
      for (const prefix of this.prefixesFor(frontier, from, bindings)) {
        const repeated = visits(prefix, to);
        if (repeated && !to.equals(prefix.root)) {
          continue;
        }
        const state = extendState(prefix, to, step);
        // A closing repetition ends a path rather than continuing one, so it is
        // emitted but never carried into the next frontier.
        if (!repeated) {
          addAllState(next, state);
        }
        batch.push(state);
        this.stats?.count('statesOut');
        // Checked here rather than once per solution: an edge into a node many
        // partial paths have converged on extends every one of them, so waiting
        // until the solution is finished would let a single edge build a batch
        // of any size — which is the unbounded span batching exists to prevent.
        if (batch.length >= target) {
          this.stats?.time('workMs', started);
          yield* this.emitAllBatch(batch, depth, joinedEnd);
          batch = [];
          target = Math.min(ENDPOINT_BATCH, target * 2);
          started = now();
        }
      }
      this.stats?.time('workMs', started);
    }
    yield* this.emitAllBatch(batch, depth, joinedEnd);
    return next;
  }

  /**
   * The partial paths an edge leaving `from` extends.
   *
   * Without a frontier this is the first depth, where every edge starts a path
   * at its own source, and where a root is recorded as its edges arrive rather
   * than up front. A start node with no outgoing edge never appears, which
   * changes no result: a path of no edges is never emitted, so such a node could
   * not contribute one.
   */
  private prefixesFor(
    frontier: AllFrontier | undefined,
    from: RDF.Term,
    bindings: RDF.Bindings,
  ): readonly AllPathState[] {
    if (!frontier) {
      this.registerRoot(from, bindings);
      return [ rootState(from) ];
    }
    const prefixes = frontier.get(from);
    if (!prefixes) {
      throw new InvalidPathQueryError('VIA produced a start node outside the supplied frontier');
    }
    return prefixes;
  }

  /**
   * Begin measuring a depth.
   *
   * The endpoint counters are per depth rather than per batch, and a streaming
   * depth can meet one endpoint in several batches, so the nodes it has already
   * counted are remembered for as long as it runs.
   */
  private openDepth(depth: number, frontierNodes: number, statesIn: number, joinedEnd: boolean): void {
    if (!this.stats) {
      return;
    }
    this.countedEndpoints = new TermSet<RDF.Term>();
    this.stats.openDepth(depth, frontierNodes, statesIn, joinedEnd);
  }

  /** Count the endpoint nodes of one batch that this depth has not counted yet. */
  private countEndpoints(candidates: TermSet<RDF.Term>, matched: (node: RDF.Term) => boolean): void {
    const counted = this.countedEndpoints;
    if (!counted) {
      return;
    }
    for (const candidate of candidates) {
      if (counted.has(candidate)) {
        continue;
      }
      counted.add(candidate);
      this.stats!.count('endpointCandidates');
      if (matched(candidate)) {
        this.stats!.count('endpointMatches');
      }
    }
  }

  /** Record a root the first depth discovered, however that depth was evaluated. */
  private registerRoot(root: RDF.Term, bindings: RDF.Bindings): void {
    if (this.roots.has(root)) {
      return;
    }
    if (this.operations.canJoinStart) {
      // The joined solution carries START's variables alongside VIA's, and START
      // is only joined when it projects nothing but its node, so restricting the
      // solution to that variable reproduces exactly what evaluating START on its
      // own would have bound. Every solution for one root is therefore identical,
      // and keeping the first avoids multiplying the emitted paths.
      const startVariable = this.operations.startVariable;
      this.roots.set(root, {
        bindings: [ bindings.filter((_value, key) => key.equals(startVariable)) ],
      });
    } else {
      this.roots.set(root, {});
    }
  }

  /** Test the endpoints of one batch of partial paths, and emit those that match. */
  private async *emitAllBatch(
    batch: readonly AllPathState[],
    depth: number,
    joinedEnd: boolean,
  ): AsyncGenerator<PathResult, void, undefined> {
    if (batch.length === 0) {
      return;
    }
    const candidates = new TermSet<RDF.Term>();
    for (const state of batch) {
      // In CYCLIC mode a path that did not return to its root is never emitted,
      // so its endpoint never has to be tested.
      if (!this.cyclic || isCycle(state)) {
        candidates.add(state.current);
      }
    }
    const started = now();
    const matches = await this.matchEndpoints(candidates, depth, joinedEnd);
    this.stats?.time('endpointMs', started);

    for (const state of batch) {
      if (this.cyclic && !isCycle(state)) {
        continue;
      }
      const endpoint = matches.get(state.current);
      if (!endpoint) {
        continue;
      }
      yield* this.combineEndpointBindings(
        materialize(state),
        this.roots.get(state.root),
        endpoint,
      );
    }
  }

  /**
   * Expand one shortest-path depth in full.
   *
   * Unlike an `ALL` depth this keeps the barrier: every predecessor at the same
   * distance has to be known before any path through them can be reconstructed.
   */
  private async expandShortest(
    frontier: TermMap<RDF.Term, TermSet<RDF.Term>> | undefined,
    depth: number,
    joinedEnd: boolean,
  ): Promise<ShortestLayer> {
    const layer = new ShortestLayer();
    for await (const bindings of this.timed(this.expansionStream(
      frontier ? [ ...frontier.keys() ] : undefined,
      depth,
      joinedEnd,
    ))) {
      const started = now();
      const { from, to } = this.requireStep(bindings);
      if (joinedEnd && this.operations.joinedEndIsComplete) {
        this.recordJoinedEndpoint(to, bindings);
      }
      if (frontier) {
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
      } else {
        if (!this.roots.has(from)) {
          this.registerRoot(from, bindings);
          getOrCreateTermMap(this.distances, from).set(from, 0);
        }
        this.discoverShortestEdge(from, from, to, bindings, depth, layer);
      }
      this.stats?.time('workMs', started);
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
        this.stats?.count('statesOut');
      } else if (knownCycleDistance === depth) {
        layer.addCycle(root, predecessor);
        this.stats?.count('statesOut');
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
      this.stats?.count('statesOut');
    } else if (knownDistance === depth) {
      getOrCreateTermMap(this.predecessors, root).get(to)!.push(predecessor);
    }
  }

  private async *emitShortestLayer(
    layer: ShortestLayer,
    depth: number,
    joinedEnd: boolean,
  ): AsyncGenerator<PathResult, void, undefined> {
    const started = now();
    const matches = await this.matchEndpoints(layer.endpointNodes, depth, joinedEnd);
    this.stats?.time('endpointMs', started);

    if (!this.cyclic) {
      for (const state of layer.states) {
        const endpoint = matches.get(state.node);
        if (!endpoint) {
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

  /**
   * Record the END solution a depth's own evaluation already produced.
   *
   * Only reached when END binds nothing besides its node, so every solution for
   * one node is identical and the first stands for all of them.
   */
  private recordJoinedEndpoint(node: RDF.Term, bindings: RDF.Bindings): void {
    if (this.endpointCache.get(node)) {
      return;
    }
    const endVariable = this.operations.endVariable;
    this.endpointCache.set(node, {
      bindings: [ bindings.filter((_value, key) => key.equals(endVariable)) ],
    });
  }

  private async matchEndpoints(
    candidates: TermSet<RDF.Term>,
    depth: number,
    joinedEnd: boolean,
  ): Promise<TermMap<RDF.Term, EndpointMatches | null>> {
    if (!this.operations.hasEnd) {
      const matches = new TermMap<RDF.Term, EndpointMatches | null>();
      for (const candidate of candidates) {
        matches.set(candidate, {});
      }
      this.countEndpoints(candidates, () => true);
      return matches;
    }

    if (joinedEnd && this.operations.joinedEndIsComplete) {
      // The evaluation that produced these candidates applied END and carried its
      // solutions, so every candidate is a match and nothing more has to be asked.
      this.countEndpoints(candidates, () => true);
      return this.endpointCache;
    }

    const unknown = [ ...candidates ].filter(candidate => !this.endpointCache.has(candidate));
    for (const term of unknown) {
      this.endpointCache.set(term, null);
    }
    for await (const bindings of this.operations.queryEndFor(unknown, depth)) {
      const term = this.require(bindings, this.operations.endVariable, 'END');
      const existing = this.endpointCache.get(term);
      if (existing) {
        existing.bindings!.push(bindings);
      } else {
        this.endpointCache.set(term, { bindings: [ bindings ]});
      }
    }
    this.countEndpoints(candidates, candidate => Boolean(this.endpointCache.get(candidate)));
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
        if (this.cyclic && !root.equals(endpoint)) {
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

  /**
   * Consume a bindings stream, measuring how long it spends waiting on it.
   *
   * Driving the iterator by hand is only worth it while measuring, so the plain
   * delegation stays the path an uninstrumented traversal takes.
   */
  private async *timed(stream: AsyncIterable<RDF.Bindings>): AsyncGenerator<RDF.Bindings, void, undefined> {
    const stats = this.stats;
    if (!stats) {
      yield* stream;
      return;
    }
    const iterator = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        const started = now();
        const next = await iterator.next();
        stats.time('sourceMs', started);
        if (next.done === true) {
          return;
        }
        stats.count('edges');
        yield next.value;
      }
    } finally {
      // Manual iteration does not forward an early return the way `yield*` does,
      // and that return is what destroys the bindings stream behind it.
      await iterator.return?.(undefined);
    }
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
      from: this.require(bindings, this.operations.startVariable, 'VIA'),
      to: this.require(bindings, this.operations.endVariable, 'VIA'),
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

/** A partial path of no edges, sitting on the root it starts from. */
function rootState(root: RDF.Term): AllPathState {
  return { root, current: root, prefix: undefined, step: undefined, length: 0 };
}

function extendState(prefix: AllPathState, to: RDF.Term, step: PathStep): AllPathState {
  return { root: prefix.root, current: to, prefix, step, length: prefix.length + 1 };
}

/** Whether a partial path already visits a node. */
function visits(state: AllPathState, node: RDF.Term): boolean {
  for (let current: AllPathState | undefined = state; current; current = current.prefix) {
    if (current.current.equals(node)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a partial path closed back onto its root.
 *
 * Every repeated node other than the root is rejected as it is discovered, so
 * returning to the root is the only repetition a state can hold.
 */
function isCycle(state: AllPathState): boolean {
  return state.length > 0 && state.current.equals(state.root);
}

/** Collect the nodes and steps of one path, walking its prefix chain once. */
function materialize(state: AllPathState): CorePath {
  const nodes = Array.from<RDF.Term>({ length: state.length + 1 });
  const steps = Array.from<PathStep>({ length: state.length });
  let current: AllPathState | undefined = state;
  for (let index = state.length; index >= 0 && current; index--) {
    nodes[index] = current.current;
    if (current.step) {
      steps[index - 1] = current.step;
    }
    current = current.prefix;
  }
  return { nodes, steps };
}

function addAllState(frontier: AllFrontier, state: AllPathState): void {
  const states = frontier.get(state.current);
  if (states) {
    states.push(state);
  } else {
    frontier.set(state.current, [ state ]);
  }
}

/**
 * The number of partial paths a shortest frontier holds.
 *
 * One node can be on the way from several roots, and each of those is its own
 * partial path, so this is not the number of nodes in the frontier.
 */
function countShortestStates(frontier: TermMap<RDF.Term, TermSet<RDF.Term>>): number {
  let total = 0;
  for (const roots of frontier.values()) {
    total += roots.size;
  }
  return total;
}

/** The number of partial paths a frontier holds, across every node in it. */
function countAllStates(frontier: AllFrontier): number {
  let total = 0;
  for (const states of frontier.values()) {
    total += states.length;
  }
  return total;
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
