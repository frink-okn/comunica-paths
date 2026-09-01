import type { IQueryProcessSequential } from '@comunica/bus-query-process';
import { KeysInitQuery } from '@comunica/context-entries';
import type { BindingsStream, ComunicaDataFactory, IActionContext } from '@comunica/types';
import { Algebra, AlgebraFactory, algebraUtils } from '@comunica/utils-algebra';
import type { BindingsFactory } from '@comunica/utils-bindings-factory';
import {
  assignOperationSource,
  getOperationSource,
  getSafeBindings,
  materializeOperation,
} from '@comunica/utils-query-operation';
import TermSet from '@rdfjs/term-set';
import type * as RDF from '@rdfjs/types';
import { InvalidPathQueryError } from './errors.js';
import type { PathQuerySpec } from './types.js';

/** Reports a condition that silently reduces the result set. */
export type PathWarningLogger = (message: string, data?: () => Record<string, unknown>) => void;

/**
 * The clause an evaluation belongs to, used as the logical operator name of its
 * physical query plan node.
 */
export type PathClause = 'paths-start' | 'paths-via' | 'paths-end';

/** Receives the cardinality Comunica reports for a frontier expansion. */
export type PathExpansionListener = (cardinality: RDF.QueryResultCardinality) => void;

/** One embedded graph pattern, planned once and reused at every depth. */
interface IPathPattern {
  /** The planned graph pattern, carrying whatever source assignment decided. */
  operation: Algebra.Operation;
  /** The context the plan was produced against. */
  context: IActionContext;
  /** Whether one source received the complete query, as a SPARQL endpoint does. */
  wholeQuerySource: boolean;
  /** The variables the pattern projects. */
  variables: readonly RDF.Variable[];
}

export interface IPathOperationsArgs {
  /** The standard sequential query processor used to parse, optimize, and evaluate graph patterns. */
  queryProcessor: IQueryProcessSequential;
  /** Creates the bindings used to bind a frontier node into a graph pattern. */
  bindingsFactory: BindingsFactory;
  /** The initialized request context. See {@link PathOperations#context}. */
  context: IActionContext;
  /** A specification that has already passed `validateSpec`. */
  spec: PathQuerySpec;
  /** Reports a condition that silently reduces the result set. */
  logWarn: PathWarningLogger;
  /** Recorded as the responsible actor on the physical query plan node of every evaluation. */
  actorName: string;
  /** Receives the cardinality Comunica reports for each frontier expansion. */
  onExpansionCardinality?: PathExpansionListener;
}

/**
 * Compiles a path specification into standard Comunica algebra, and evaluates its
 * START, VIA, and END patterns against bounded frontiers.
 *
 * Each pattern is planned once by the standard optimizer, which keeps source
 * assignment, source grouping, and pushdown in Comunica's hands. Every depth
 * then joins the planned pattern with a `VALUES` relation holding the frontier.
 * Because `VALUES` reports an exact cardinality, the RDF-join mediator sees the
 * true frontier size and picks the physical join itself: a bind join, a hash
 * join, or a bind join that pushes the frontier into the source request.
 *
 * Planning once, rather than once per depth, is what Comunica's own bind-join
 * actors do — they materialize bindings into an operation and mediate the
 * query-operation bus directly. It is also the only safe option here, for the
 * reason given on the request context below.
 */
export class PathOperations {
  /**
   * The initialized request context, and the only context handed to the
   * optimizer. Planning must always start from it, and must not be repeated with
   * a planned context: the optimizer wraps every query source in a fresh
   * skolemization layer, so re-planning would wrap the sources again and change
   * blank-node identity between depths.
   */
  public readonly context: IActionContext;

  private readonly activeStreams = new Set<BindingsStream>();
  private readonly algebraFactory: AlgebraFactory;
  private readonly queryProcessor: IQueryProcessSequential;
  private readonly bindingsFactory: BindingsFactory;
  private readonly logWarn: PathWarningLogger;
  private readonly actorName: string;
  private readonly onExpansionCardinality: PathExpansionListener | undefined;

  private constructor(
    args: IPathOperationsArgs,
    dataFactory: ComunicaDataFactory,
    private readonly startPattern: IPathPattern | undefined,
    private readonly viaPattern: IPathPattern,
    private readonly endPattern: IPathPattern | undefined,
    /** START joined with VIA, planned as one query, when START may be joined. */
    private readonly startViaPattern: IPathPattern | undefined,
    /** VIA joined with END, planned as one query, for the final permitted depth. */
    private readonly viaEndPattern: IPathPattern | undefined,
    /** START, VIA, and END as one query, when the first depth is also the last. */
    private readonly startViaEndPattern: IPathPattern | undefined,
    /**
     * Whether END binds nothing besides its node, so that a depth which joined
     * END already holds every solution END produces.
     */
    public readonly joinedEndIsComplete: boolean,
    /** The source of a traversal step, and the node a START solution binds. */
    public readonly startVariable: RDF.Variable,
    /** The target of a traversal step, and the node an END solution binds. */
    public readonly endVariable: RDF.Variable,
    /** The finite END target set when END is a bare `VALUES` block, otherwise undefined. */
    public readonly fixedEndNodes: TermSet<RDF.Term> | undefined,
  ) {
    this.queryProcessor = args.queryProcessor;
    this.bindingsFactory = args.bindingsFactory;
    this.logWarn = args.logWarn;
    this.actorName = args.actorName;
    this.onExpansionCardinality = args.onExpansionCardinality;
    this.context = args.context;
    this.algebraFactory = new AlgebraFactory(dataFactory);
  }

  public static async create(args: IPathOperationsArgs): Promise<PathOperations> {
    const { context, spec } = args;
    const dataFactory = context.getSafe(KeysInitQuery.dataFactory);
    const algebraFactory = new AlgebraFactory(dataFactory);
    const prepare = async(pattern: string | undefined): Promise<IPathPattern | undefined> =>
      pattern?.trim() ?
        await preparePattern(args.queryProcessor, algebraFactory, context, spec, pattern) :
        undefined;

    // `validateSpec` is the single validator of a specification, and the actor
    // applies it before reaching here; a VIA pattern is guaranteed to be present.
    const via = await preparePattern(
      args.queryProcessor,
      algebraFactory,
      context,
      spec,
      spec.via.pattern,
    );
    const start = await prepare(spec.start.pattern);
    const end = await prepare(spec.end.pattern);
    const endVariable = dataFactory.variable(spec.end.node.slice(1));
    const startVariable = dataFactory.variable(spec.start.node.slice(1));

    /** Plan several clauses as one query, so that the optimizer groups them itself. */
    const planJoined = async(...patterns: string[]): Promise<IPathPattern> => preparePattern(
      args.queryProcessor,
      algebraFactory,
      context,
      spec,
      patterns.map(pattern => `{\n${pattern}\n}`).join('\n'),
    );

    // Plan the first depth as one query when START projects nothing but its
    // node. A SPARQL join joins on every shared variable, so a START pattern
    // binding anything else could share a name with VIA and be joined to it,
    // which the PATHS semantics forbid: a path solution exposes only the
    // endpoint variables, and VIA's own variables belong to a single step.
    // Projecting nothing else also keeps one START solution per node, so the
    // join is not multiplied by solutions the traversal would collapse again.
    const startVia = start &&
      start.variables.length === 1 &&
      start.variables[0]!.equals(startVariable) ?
      await planJoined(spec.start.pattern!, spec.via.pattern) :
      undefined;

    // END as it is joined into the final depth's VIA evaluation.
    //
    // The same shared-variable problem applies to END, but END has a remedy
    // START does not: its non-node variables are never joined to anything, so a
    // sub-select projecting the endpoint node alone scopes them away. A
    // projection is SPARQL's own scoping boundary, so this needs no renaming and
    // no disjointness analysis, and applies to every END pattern. It also leaves
    // the joined solutions with exactly VIA's variables, which is what keeps the
    // traversal — and the `DISTINCT` every evaluation is wrapped in — unchanged:
    // an END with several solutions for one node cannot multiply a traversal
    // step, the way it would if its variables reached the join.
    const endBindsOnlyNode = Boolean(end) &&
      end!.variables.length === 1 &&
      end!.variables[0]!.equals(endVariable);
    const endFragment = end && spec.end.pattern?.trim() ?
      (endBindsOnlyNode ?
        spec.end.pattern :
        `{ SELECT ${spec.end.node} WHERE {\n${spec.end.pattern}\n} }`) :
      undefined;

    return new PathOperations(
      args,
      dataFactory,
      start,
      via,
      end,
      startVia,
      endFragment ? await planJoined(spec.via.pattern, endFragment) : undefined,
      // Only the first depth can also be the last, so this plan is worth making
      // only then.
      startVia && endFragment && spec.maxDepth === 1 ?
        await planJoined(spec.start.pattern!, spec.via.pattern, endFragment) :
        undefined,
      endBindsOnlyNode,
      startVariable,
      endVariable,
      end ? readFixedNodes(end.operation, endVariable) : undefined,
    );
  }

  public get hasStart(): boolean {
    return this.startPattern !== undefined;
  }

  public get hasEnd(): boolean {
    return this.endPattern !== undefined;
  }

  /** Evaluate the START pattern without any frontier constraint. */
  public queryStart(): AsyncIterable<RDF.Bindings> {
    return this.consume(this.startPattern!, this.startPattern!.operation, 'paths-start');
  }

  /** Evaluate the VIA pattern without any frontier constraint, as the first depth. */
  public queryVia(depth: number, withEnd = false): AsyncIterable<RDF.Bindings> {
    const pattern = this.viaPatternFor(withEnd);
    return this.consume(pattern, pattern.operation, 'paths-via', depth);
  }

  /**
   * Whether the final permitted depth may carry the END constraint into its VIA
   * evaluation.
   *
   * At that depth a candidate END does not match cannot contribute to a later
   * frontier, because there is no later frontier, so constraining the evaluation
   * drops nothing that could still be emitted. Every other depth must expand the
   * whole frontier, since a node that is not an endpoint is still a route to one.
   */
  public get canJoinEnd(): boolean {
    return this.viaEndPattern !== undefined;
  }

  /** Whether the joined first depth may also carry the END constraint. */
  public get canJoinStartEnd(): boolean {
    return this.startViaEndPattern !== undefined;
  }

  /**
   * Whether the first depth can be evaluated as START joined with VIA.
   *
   * Only when START projects nothing but its node. A SPARQL join joins on every
   * shared variable, so a START pattern binding anything else could share a name
   * with VIA and be joined to it — which the PATHS semantics forbid, since a
   * path solution exposes only the endpoint variables and VIA's own variables
   * belong to a single step. Projecting nothing else also keeps one START
   * solution per node, so the join is not multiplied by solutions the traversal
   * would immediately collapse.
   */
  public get canJoinStart(): boolean {
    return this.startViaPattern !== undefined;
  }

  /**
   * Evaluate the first depth as START joined with VIA, in one operation.
   *
   * Handing both patterns to Comunica together is what lets it order the join
   * itself: a selective VIA can drive a broad START, and a single source can
   * answer the whole thing in one request. Materializing START first would
   * decide that ordering here, where the cardinalities are not known.
   *
   * The join is planned rather than assembled from the two planned patterns.
   * Source grouping is an optimizer step, so a join built afterwards reaches the
   * join mediator as two separately scoped entries and can never become one
   * source request — the very thing the join is for.
   */
  public queryViaFromStart(withEnd = false): AsyncIterable<RDF.Bindings> {
    const pattern = withEnd ? this.startViaEndPattern! : this.startViaPattern!;
    return this.consume(pattern, pattern.operation, 'paths-via', 1);
  }

  /** Evaluate the VIA pattern for every frontier node in one mediated join. */
  public queryViaFrom(
    terms: readonly RDF.Term[],
    depth: number,
    withEnd = false,
  ): AsyncIterable<RDF.Bindings> {
    return this.queryConstrained(
      this.viaPatternFor(withEnd),
      this.startVariable,
      terms,
      'paths-via',
      depth,
    );
  }

  /** Evaluate the END pattern for every candidate endpoint in one mediated join. */
  public queryEndFor(terms: readonly RDF.Term[], depth: number): AsyncIterable<RDF.Bindings> {
    return this.queryConstrained(this.endPattern!, this.endVariable, terms, 'paths-end', depth);
  }

  /** Destroy every bindings stream that is still in flight. */
  public destroy(cause?: Error): void {
    for (const stream of [ ...this.activeStreams ]) {
      stream.destroy(cause);
    }
    this.activeStreams.clear();
  }

  /** The VIA plan to evaluate, with or without the END constraint joined into it. */
  private viaPatternFor(withEnd: boolean): IPathPattern {
    return withEnd ? this.viaEndPattern! : this.viaPattern;
  }

  /**
   * Join a graph pattern with a bounded set of terms for one of its variables.
   *
   * Named nodes and literals are submitted as a single `VALUES` relation, so the
   * join actors see the true frontier cardinality and chunk any pushdown
   * themselves. Terms that SPARQL's `VALUES` grammar cannot hold — blank nodes
   * and quoted triples — are substituted into the pattern instead.
   */
  private async *queryConstrained(
    pattern: IPathPattern,
    variable: RDF.Variable,
    terms: readonly RDF.Term[],
    clause: PathClause,
    depth: number,
  ): AsyncIterable<RDF.Bindings> {
    const inlineable: (RDF.NamedNode | RDF.Literal)[] = [];
    const substitutable: RDF.Term[] = [];
    for (const term of terms) {
      if (term.termType === 'NamedNode' || term.termType === 'Literal') {
        inlineable.push(term);
      } else {
        substitutable.push(term);
      }
    }

    if (inlineable.length > 0) {
      const values = this.algebraFactory.createValues(
        [ variable ],
        inlineable.map(term => ({ [variable.value]: term })),
      );
      // Flattening lets the n-way join actors weigh the frontier against every
      // graph-pattern input at once. An input carrying metadata — a source
      // annotation above all — has to stay a single entry, so that its bind-join
      // actor can push the frontier into that source's request instead. This is
      // the rule Comunica's own `materializeOperation` applies to a join.
      const inputs: Algebra.Operation[] = [ values, pattern.operation ];
      yield* this.consume(
        pattern,
        this.algebraFactory.createJoin(inputs, inputs.every(input => !input.metadata)),
        clause,
        depth,
      );
    }

    for (const term of substitutable) {
      yield* this.querySubstituted(pattern, variable, term, clause, depth);
    }
  }

  /**
   * Evaluate a graph pattern with one term substituted for a variable.
   *
   * Comunica's skolemization layer maps a source-scoped blank node back to its
   * source identity when the term appears inside an operation, which is why the
   * term is bound into the pattern rather than pushed as a join relation.
   * Materializing preserves source assignment, so the planned pattern is reused
   * here as well.
   */
  private async *querySubstituted(
    pattern: IPathPattern,
    variable: RDF.Variable,
    term: RDF.Term,
    clause: PathClause,
    depth: number,
  ): AsyncIterable<RDF.Bindings> {
    if (term.termType === 'BlankNode' && pattern.wholeQuerySource) {
      // A blank node returned by a whole-query source has result-set scope. Its
      // label would be serialized back into the request, where SPARQL reads a
      // blank node as a variable and silently matches everything, so this
      // frontier node has no sound continuation.
      this.logWarn(
        'Dropping a blank-node path frontier that a whole-query source cannot resolve',
        () => ({ term: term.value }),
      );
      return;
    }
    const substituted = materializeOperation(
      pattern.operation,
      this.bindingsFactory.bindings([[ variable, term ]]),
      this.algebraFactory,
      this.bindingsFactory,
      { bindFilter: true },
    );
    // Substitution removes the variable from the pattern, so it is absent from
    // the solutions. Restore it, so that every route through this class produces
    // the same variables for the same graph pattern.
    for await (const bindings of this.consume(pattern, substituted, clause, depth)) {
      yield bindings.set(variable, term);
    }
  }

  private async *consume(
    pattern: IPathPattern,
    operation: Algebra.Operation,
    clause: PathClause,
    depth?: number,
  ): AsyncIterable<RDF.Bindings> {
    // Deduplicate after planning, deliberately. Distinct solutions are required
    // across the whole federation, so this must not be pushed into an individual
    // source — and planning it in would put the pattern behind a sub-select that
    // the frontier relation can no longer filter, making a source compute its
    // distinct edge set in full on every depth.
    const distinct = this.algebraFactory.createDistinct(operation);
    const output = getSafeBindings(
      await this.queryProcessor.evaluate(distinct, this.planEvaluation(pattern.context, clause, depth)),
    );
    if (this.onExpansionCardinality && clause === 'paths-via') {
      // Read the metadata the join actors already computed, without waiting on
      // it: a source that resolves its cardinality late must not stall traversal.
      output.metadata().then(
        metadata => this.onExpansionCardinality!(metadata.cardinality),
        () => {
          // No estimate available; the previous one stands.
        },
      );
    }
    const stream = output.bindingsStream;
    this.activeStreams.add(stream);
    try {
      yield* stream;
    } finally {
      this.activeStreams.delete(stream);
      if (!stream.done) {
        stream.destroy();
      }
    }
  }

  /**
   * Give one evaluation its own physical query plan node, so that each clause and
   * each traversal depth is reported separately rather than as one flat run of
   * indistinguishable siblings under the path query.
   */
  private planEvaluation(
    context: IActionContext,
    clause: PathClause,
    depth: number | undefined,
  ): IActionContext {
    const logger = context.get(KeysInitQuery.physicalQueryPlanLogger);
    if (!logger) {
      return context;
    }
    const node = { clause, depth };
    logger.logOperation(
      clause,
      undefined,
      node,
      context.get(KeysInitQuery.physicalQueryPlanNode),
      this.actorName,
      depth === undefined ? {} : { depth },
    );
    return context.set(KeysInitQuery.physicalQueryPlanNode, node);
  }
}

/** Whether an operation reads from an RDF dataset, and therefore needs a source. */
function readsDataset(operation: Algebra.Operation): boolean {
  let found = false;
  algebraUtils.visitOperation(operation, {
    [Algebra.Types.BGP]: { visitor: (bgp) => {
      found ||= bgp.patterns.length > 0;
    } },
    [Algebra.Types.PATH]: { visitor: () => {
      found = true;
    } },
    [Algebra.Types.PATTERN]: { visitor: () => {
      found = true;
    } },
    [Algebra.Types.SERVICE]: { visitor: () => {
      found = true;
    } },
  });
  return found;
}

/**
 * Parse one embedded graph pattern and plan it once.
 *
 * The `SELECT *` wrapper exists so the pattern reaches the query parser, and so
 * that the optimizers see a query operation at the root: source assignment
 * silently does nothing to a bare graph pattern. The projection is removed again
 * afterwards, because it projects exactly the variables its input already
 * produces, and because leaving it in place would wrap every pushed-down request
 * in a redundant sub-select.
 */
async function preparePattern(
  queryProcessor: IQueryProcessSequential,
  algebraFactory: AlgebraFactory,
  context: IActionContext,
  spec: PathQuerySpec,
  pattern: string,
): Promise<IPathPattern> {
  const query = `${spec.prologue ?? ''}\nSELECT * ${spec.dataset ?? ''} WHERE {\n${pattern}\n}`;
  let parsed;
  try {
    parsed = await queryProcessor.parse(query, context);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidPathQueryError(`Invalid SPARQL graph pattern: ${message}`);
  }
  if (parsed.operation.type !== Algebra.Types.PROJECT) {
    throw new InvalidPathQueryError('A path graph pattern did not compile to a projection');
  }
  const projection = <Algebra.Project> parsed.operation;

  if (!readsDataset(projection.input)) {
    // Nothing to assign a source to. Planning a source-independent form such as
    // a bare VALUES block would only scope it to a source, turning a constant
    // endpoint into a remote request.
    return {
      operation: projection.input,
      context: parsed.context,
      wholeQuerySource: false,
      variables: [ ...projection.variables ],
    };
  }

  // Plan against the context parsing produced, the way Comunica's own query
  // processors chain the two steps: it carries the query string this pattern was
  // read from, and any base IRI its prologue declared.
  const planned = await queryProcessor.optimize(
    algebraFactory.createProject(projection.input, [ ...projection.variables ]),
    parsed.context,
  );
  // A source annotated on the projection itself received the complete query,
  // which only a source that answers whole queries — a SPARQL endpoint — does.
  const wholeQuerySource = Boolean(getOperationSource(planned.operation));
  return {
    operation: unwrapPlannedProjection(planned.operation),
    context: planned.context,
    wholeQuerySource,
    variables: [ ...projection.variables ],
  };
}

/**
 * Remove the projection that only existed so the optimizers could plan a query.
 *
 * When source assignment scoped the whole query to one source, the scope moves
 * to the graph input, so that the source receives the graph pattern and the
 * frontier relation directly rather than wrapped in a sub-select.
 */
function unwrapPlannedProjection(operation: Algebra.Operation): Algebra.Operation {
  if (operation.type !== Algebra.Types.PROJECT) {
    return operation;
  }
  const { input } = <Algebra.Project> operation;
  const source = getOperationSource(operation);
  return source && !getOperationSource(input) ? assignOperationSource(input, source) : input;
}

/**
 * Read the finite target set from an END pattern that is a bare `VALUES` block.
 *
 * A shortest traversal can stop once every relevant start/target pair is settled,
 * which is only sound when the reachable targets are known up front.
 */
function readFixedNodes(operation: Algebra.Operation, variable: RDF.Variable): TermSet<RDF.Term> | undefined {
  if (operation.type !== Algebra.Types.VALUES) {
    return undefined;
  }
  const nodes = new TermSet<RDF.Term>();
  for (const row of (<Algebra.Values> operation).bindings) {
    const term = row[variable.value];
    if (!term) {
      return undefined;
    }
    nodes.add(term);
  }
  return nodes;
}
