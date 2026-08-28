import TermMap from '@rdfjs/term-map';
import TermSet from '@rdfjs/term-set';
import type { Bindings, Term } from '@rdfjs/types';
import type { SelectQuery } from 'sparqljs';
import { compatibleBindings, getBinding } from './bindings.js';
import { InvalidPathQueryError } from './errors.js';
import { compilePattern, compileQuery, compileValuesQuery } from './sparql.js';
import type {
  BindingsQueryEngine,
  IPathQueryEngine,
  PathQueryEngineOptions,
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

  public async *queryPaths(spec: PathQuerySpec, context?: QueryContext): AsyncIterable<PathResult> {
    validateSpec(spec);
    if (spec.mode === 'all') {
      throw new InvalidPathQueryError('ALL path execution is not implemented yet');
    }
    if (spec.maxPaths === 0) {
      return;
    }

    const templates = this.compileTemplates(spec);
    const roots = templates.start ?
      await this.loadRoots(templates.start, spec.start.node, context) :
      new TermMap<Term, RootInfo>();
    const distances = new TermMap<Term, TermMap<Term, number>>();
    const predecessors = new TermMap<Term, TermMap<Term, Predecessor[]>>();
    const cycleDistances = new TermMap<Term, number>();
    const endpointCache = new TermMap<Term, EndpointMatches | null>();
    let frontier = new TermMap<Term, TermSet<Term>>();
    let depth = 0;
    let emitted = 0;

    if (templates.start) {
      for (const root of roots.keys()) {
        getOrCreateTermMap(distances, root).set(root, 0);
        addFrontierState(frontier, root, root);
      }
    } else {
      const firstLayer = await this.expandUnconstrained(
        templates.via,
        spec,
        roots,
        distances,
        predecessors,
        cycleDistances,
        context,
      );
      frontier = firstLayer.frontier;
      depth = 1;
      for await (const result of this.emitLayer(
        firstLayer,
        templates.end,
        spec,
        roots,
        predecessors,
        endpointCache,
        context,
      )) {
        yield result;
        emitted++;
        if (emitted === spec.maxPaths) {
          return;
        }
      }
    }

    const maxDepth = spec.maxDepth ?? Number.POSITIVE_INFINITY;
    while (frontier.size > 0 && depth < maxDepth) {
      const nextDepth = depth + 1;
      const layer = await this.expandFrontier(
        frontier,
        nextDepth,
        templates.via,
        spec,
        roots,
        distances,
        predecessors,
        cycleDistances,
        context,
      );

      for await (const result of this.emitLayer(
        layer,
        templates.end,
        spec,
        roots,
        predecessors,
        endpointCache,
        context,
      )) {
        yield result;
        emitted++;
        if (emitted === spec.maxPaths) {
          return;
        }
      }

      frontier = layer.frontier;
      depth = nextDepth;
    }
  }

  private compileTemplates(spec: PathQuerySpec): QueryTemplates {
    return {
      start: spec.start.pattern?.trim() ? compilePattern(spec.prologue, spec.start.pattern) : undefined,
      end: spec.end.pattern?.trim() ? compilePattern(spec.prologue, spec.end.pattern) : undefined,
      via: compilePattern(spec.prologue, spec.via.pattern),
    };
  }

  private async loadRoots(
    template: SelectQuery,
    variable: SparqlVariable,
    context: QueryContext | undefined,
  ): Promise<TermMap<Term, RootInfo>> {
    const roots = new TermMap<Term, RootInfo>();
    const stream = await this.engine.queryBindings(compileQuery(template), context);
    for await (const bindings of stream) {
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

  private async expandUnconstrained(
    via: SelectQuery,
    spec: PathQuerySpec,
    roots: TermMap<Term, RootInfo>,
    distances: TermMap<Term, TermMap<Term, number>>,
    predecessors: TermMap<Term, TermMap<Term, Predecessor[]>>,
    cycleDistances: TermMap<Term, number>,
    context: QueryContext | undefined,
  ): Promise<Layer> {
    const layer = new Layer();
    if ((spec.maxDepth ?? Number.POSITIVE_INFINITY) < 1) {
      return layer;
    }

    const stream = await this.engine.queryBindings(compileQuery(via), context);
    for await (const bindings of stream) {
      const from = requireBinding(bindings, spec.via.from, 'VIA');
      const to = requireBinding(bindings, spec.via.to, 'VIA');
      if (!roots.has(from)) {
        roots.set(from, {});
        getOrCreateTermMap(distances, from).set(from, 0);
      }
      this.discoverEdge(from, from, to, bindings, 1, layer, distances, predecessors, cycleDistances);
    }
    return layer;
  }

  private async expandFrontier(
    frontier: TermMap<Term, TermSet<Term>>,
    depth: number,
    via: SelectQuery,
    spec: PathQuerySpec,
    roots: TermMap<Term, RootInfo>,
    distances: TermMap<Term, TermMap<Term, number>>,
    predecessors: TermMap<Term, TermMap<Term, Predecessor[]>>,
    cycleDistances: TermMap<Term, number>,
    context: QueryContext | undefined,
  ): Promise<Layer> {
    const layer = new Layer();
    const nodes = [ ...frontier.keys() ];
    for (const terms of batches(nodes, this.batchSize)) {
      const stream = await this.engine.queryBindings(compileValuesQuery(via, spec.via.from, terms), context);
      for await (const bindings of stream) {
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
          this.discoverEdge(root, from, to, bindings, depth, layer, distances, predecessors, cycleDistances);
        }
      }
    }
    return layer;
  }

  private discoverEdge(
    root: Term,
    from: Term,
    to: Term,
    bindings: Bindings,
    depth: number,
    layer: Layer,
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

  private async *emitLayer(
    layer: Layer,
    end: SelectQuery | undefined,
    spec: PathQuerySpec,
    roots: TermMap<Term, RootInfo>,
    predecessors: TermMap<Term, TermMap<Term, Predecessor[]>>,
    endpointCache: TermMap<Term, EndpointMatches | null>,
    context: QueryContext | undefined,
  ): AsyncIterable<PathResult> {
    const matches = await this.matchEndpoints(
      layer.endpointNodes,
      end,
      spec.end.node,
      endpointCache,
      context,
    );

    for (const state of layer.states) {
      const endpoint = matches.get(state.node);
      if (!endpoint || !endpointVariablesCompatible(spec, state.root, state.node)) {
        continue;
      }
      for (const path of this.reconstructPaths(state.root, state.node, predecessors)) {
        yield* combineEndpointBindings(path, roots.get(state.root), endpoint);
      }
    }
    for (const cycle of layer.cycles) {
      const endpoint = matches.get(cycle.root);
      if (!endpoint) {
        continue;
      }
      for (const path of this.reconstructCycle(cycle.root, cycle.predecessor, predecessors)) {
        yield* combineEndpointBindings(path, roots.get(cycle.root), endpoint);
      }
    }
  }

  private async matchEndpoints(
    candidates: TermSet<Term>,
    end: SelectQuery | undefined,
    variable: SparqlVariable,
    cache: TermMap<Term, EndpointMatches | null>,
    context: QueryContext | undefined,
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
      const stream = await this.engine.queryBindings(compileValuesQuery(end, variable, terms), context);
      for await (const bindings of stream) {
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

  private *reconstructPaths(
    root: Term,
    node: Term,
    predecessors: TermMap<Term, TermMap<Term, Predecessor[]>>,
  ): Iterable<CorePath> {
    if (node.equals(root)) {
      yield { nodes: [ root ], steps: [] };
      return;
    }
    for (const predecessor of predecessors.get(root)?.get(node) ?? []) {
      for (const prefix of this.reconstructPaths(root, predecessor.from, predecessors)) {
        yield {
          nodes: [ ...prefix.nodes, node ],
          steps: [ ...prefix.steps, predecessor.step ],
        };
      }
    }
  }

  private *reconstructCycle(
    root: Term,
    predecessor: Predecessor,
    predecessors: TermMap<Term, TermMap<Term, Predecessor[]>>,
  ): Iterable<CorePath> {
    for (const prefix of this.reconstructPaths(root, predecessor.from, predecessors)) {
      yield {
        nodes: [ ...prefix.nodes, root ],
        steps: [ ...prefix.steps, predecessor.step ],
      };
    }
  }
}

class Layer {
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
  for (const [ name, value ] of [ [ 'maxDepth', spec.maxDepth ], [ 'maxPaths', spec.maxPaths ] ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new InvalidPathQueryError(`${name} must be a non-negative safe integer`);
    }
  }
}

function validateVariable(variable: string, label: string): void {
  if (!/^[?$][A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) {
    throw new InvalidPathQueryError(`${label} must be a SPARQL variable such as ?node`);
  }
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
