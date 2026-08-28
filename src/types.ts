import type { Bindings, Term } from '@rdfjs/types';

/** A SPARQL variable written in its query-string form. */
export type SparqlVariable = `?${string}` | `$${string}`;

/** A START or END graph pattern and the variable denoting its path node. */
export interface PathEndpointPattern {
  /**
   * The contents of a standard SPARQL WHERE clause, without the outer braces.
   * Omit it to leave this endpoint unconstrained.
   */
  pattern?: string;
  node: SparqlVariable;
}

/** A VIA graph pattern and the variables denoting one directed traversal step. */
export interface PathViaPattern {
  /** The contents of a standard SPARQL WHERE clause, without the outer braces. */
  pattern: string;
  from: SparqlVariable;
  to: SparqlVariable;
}

export type PathQueryMode = 'shortest' | 'all';

/**
 * Parser-independent representation of a path query.
 *
 * Every embedded pattern remains standard SPARQL. A textual PATHS parser can
 * translate its surface syntax into this type without changing SPARQL.js,
 * sparqlalgebrajs, RDF/JS, or Comunica's algebra.
 */
export interface PathQuerySpec {
  /** PREFIX and BASE declarations shared by all generated standard queries. */
  prologue?: string;
  /** Standard FROM and FROM NAMED clauses shared by all generated queries. */
  dataset?: string;
  start: PathEndpointPattern;
  end: PathEndpointPattern;
  via: PathViaPattern;
  mode?: PathQueryMode;
  /** Restrict results to simple cycles. */
  cyclic?: boolean;
  /** A safety bound for otherwise unbounded traversals. Zero permits no edges. */
  maxDepth?: number;
  /** Stop after emitting this many paths. Zero emits none. */
  maxPaths?: number;
  /** Skip this many matching paths before emitting results. */
  offset?: number;
}

/** One VIA solution used as an edge in an emitted path. */
export interface PathStep {
  from: Term;
  to: Term;
  /** All bindings produced by the VIA pattern for this step. */
  bindings: Bindings;
}

/** A streamed path result. */
export interface PathResult {
  nodes: readonly Term[];
  steps: readonly PathStep[];
  /** The matching START solution, including variables other than the path node. */
  startBindings?: Bindings;
  /** The matching END solution, including variables other than the path node. */
  endBindings?: Bindings;
}

/**
 * The small structural subset of Comunica needed by the path executor.
 * Stock and custom-configured Comunica engines satisfy it.
 */
export interface BindingsStream extends AsyncIterable<Bindings> {
  /** Comunica streams expose destroy; other compatible engines may omit it. */
  destroy?(error?: Error): void;
}

export interface BindingsQueryEngine<QueryContext = unknown> {
  queryBindings(query: string, context?: QueryContext): Promise<BindingsStream>;
}

export interface PathQueryEngineOptions {
  /** Maximum number of RDF terms placed in a generated VALUES clause. */
  batchSize?: number;
}

export interface PathQueryExecutionOptions {
  /** Cancels traversal and the currently active bindings stream. */
  signal?: AbortSignal;
}

/** Public execution contract; its implementation remains outside Comunica's algebra. */
export interface IPathQueryEngine<QueryContext = unknown> {
  queryPaths(
    spec: PathQuerySpec,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): AsyncIterable<PathResult>;
  queryPathString(
    query: string,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): AsyncIterable<PathResult>;
  queryPathService(
    query: string,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): AsyncIterable<PathResult>;
}
