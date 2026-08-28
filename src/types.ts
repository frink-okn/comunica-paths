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
 * Every embedded pattern remains standard SPARQL. A Stardog-compatible parser
 * can translate its surface syntax into this type without changing SPARQL.js,
 * sparqlalgebrajs, RDF/JS, or Comunica's algebra.
 */
export interface PathQuerySpec {
  /** PREFIX and BASE declarations shared by all generated standard queries. */
  prologue?: string;
  start: PathEndpointPattern;
  end: PathEndpointPattern;
  via: PathViaPattern;
  mode?: PathQueryMode;
  /** A safety bound for otherwise unbounded traversals. Zero permits no edges. */
  maxDepth?: number;
  /** Stop after emitting this many paths. Zero emits none. */
  maxPaths?: number;
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
export interface BindingsQueryEngine<QueryContext = unknown> {
  queryBindings(query: string, context?: QueryContext): Promise<AsyncIterable<Bindings>>;
}

export interface PathQueryEngineOptions {
  /** Maximum number of RDF terms placed in a generated VALUES clause. */
  batchSize?: number;
}

/** Public execution contract; its implementation remains outside Comunica's algebra. */
export interface IPathQueryEngine<QueryContext = unknown> {
  queryPaths(spec: PathQuerySpec, context?: QueryContext): AsyncIterable<PathResult>;
}
