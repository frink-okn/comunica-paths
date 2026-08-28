import type { Bindings, Term } from '@rdfjs/types';

/** A SPARQL variable written in its query-string form. */
export type SparqlVariable = `?${string}` | `$${string}`;

/** A START or END graph pattern and the variable denoting its path node. */
export interface PathEndpointPattern {
  /** The contents of a standard SPARQL WHERE clause, without the outer braces. */
  pattern: string;
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
  /** A safety bound for otherwise unbounded traversals. Zero permits only start nodes. */
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

/** A streamed path result. A zero-length path has one node and no steps. */
export interface PathResult {
  nodes: readonly Term[];
  steps: readonly PathStep[];
}

/**
 * The small structural subset of Comunica needed by the path executor.
 * Stock Comunica and specialised engines such as kgf-sparql both satisfy it.
 */
export interface BindingsQueryEngine<QueryContext = unknown> {
  queryBindings(query: string, context?: QueryContext): Promise<AsyncIterable<Bindings>>;
}

/** Public execution contract; its implementation will remain outside Comunica's algebra. */
export interface PathQueryEngine<QueryContext = unknown> {
  queryPaths(spec: PathQuerySpec, context?: QueryContext): AsyncIterable<PathResult>;
}

