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

    return new PathOperations(
      args,
      dataFactory,
      start,
      via,
      end,
      dataFactory.variable(spec.start.node.slice(1)),
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
  public queryVia(depth: number): AsyncIterable<RDF.Bindings> {
    return this.consume(this.viaPattern, this.viaPattern.operation, 'paths-via', depth);
  }

  /** Evaluate the VIA pattern for every frontier node in one mediated join. */
  public queryViaFrom(terms: readonly RDF.Term[], depth: number): AsyncIterable<RDF.Bindings> {
    return this.queryConstrained(this.viaPattern, this.startVariable, terms, 'paths-via', depth);
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
    return { operation: projection.input, context: parsed.context, wholeQuerySource: false };
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
