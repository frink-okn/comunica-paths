import type { QueryStringContext } from '@comunica/types';
import type { MetadataValidationState } from '@comunica/utils-metadata';
import type { Bindings, QueryResultCardinality, Term } from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';

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

/** A stream of whole paths, following Comunica's iterator conventions. */
export type PathStream = AsyncIterator<PathResult>;

/**
 * Metadata about a path stream, following the same shape and invalidation rules
 * as Comunica's bindings metadata so that consumers can plan against it.
 */
export interface IPathMetadata {
  /** Invalidated whenever a completed traversal depth changes the estimate. */
  state: MetadataValidationState;
  /** An estimate while traversing, and the exact count once the stream ends. */
  cardinality: QueryResultCardinality;
  /** The number of traversal depths completed so far. */
  depth: number;
}

export interface PathQueryExecutionOptions {
  /**
   * Cancels traversal and every active bindings stream. Equivalent to setting
   * `httpAbortSignal` on the query context.
   */
  signal?: AbortSignal;
  /** Selects an installed path-query actor. The bundled implementation is `bfs`. */
  algorithm?: string;
}

/** Public path-query contract implemented by the configured engine. */
export interface IPathQueryEngine<QueryContext extends QueryStringContext = QueryStringContext> {
  queryPaths(
    spec: PathQuerySpec,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): Promise<PathStream>;
  queryPathString(
    query: string,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): Promise<PathStream>;
  queryPathService(
    query: string,
    context?: QueryContext,
    options?: PathQueryExecutionOptions,
  ): Promise<PathStream>;
}
