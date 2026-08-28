import type { Literal, Term } from '@rdfjs/types';
import {
  Parser,
  type GraphPattern,
  type Pattern,
  type SelectQuery,
  type ServicePattern,
  type ValuesPattern,
  type ValuePatternRow,
} from 'sparqljs';
import { InvalidPathQueryError } from './errors.js';
import { compilePattern, serializeDataset, serializePatterns, validateSparqlVariable } from './sparql.js';
import type { PathQueryMode, PathQuerySpec, SparqlVariable } from './types.js';

export const PATHS_SERVICE_IRI = 'urn:comunica:paths';
export const PATHS_START_GRAPH_IRI = 'urn:comunica:paths:start';
export const PATHS_END_GRAPH_IRI = 'urn:comunica:paths:end';
export const PATHS_VIA_GRAPH_IRI = 'urn:comunica:paths:via';

const CONFIG = {
  start: '?__path_start',
  end: '?__path_end',
  mode: '?__path_mode',
  cyclic: '?__path_cyclic',
  maxLength: '?__path_maxLength',
} as const;

const parser = new Parser({ sparqlStar: true });

/**
 * Decode a path request carried entirely in valid SPARQL 1.1 syntax.
 * The outer query must be SELECT * with one reserved SERVICE block.
 */
export function parsePathServiceQuery(input: string): PathQuerySpec {
  const query = parseSelect(input);
  const service = extractService(query);
  const { startPatterns, endPatterns, viaPatterns, config } = extractServiceBody(service);
  const start = readVariable(config, CONFIG.start, 'start');
  const end = readVariable(config, CONFIG.end, 'end');
  const mode = readMode(config);
  const cyclic = readBoolean(config, CONFIG.cyclic, false);
  const maxDepth = readOptionalInteger(config, CONFIG.maxLength);
  const dataset = serializeDataset(query.from);

  const spec: PathQuerySpec = {
    ...(dataset ? { dataset } : {}),
    start: {
      node: start,
      ...(startPatterns ? { pattern: serializePatterns(startPatterns) } : {}),
    },
    end: {
      node: end,
      ...(endPatterns ? { pattern: serializePatterns(endPatterns) } : {}),
    },
    via: {
      from: start,
      to: end,
      pattern: serializePatterns(viaPatterns),
    },
    mode,
    cyclic,
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(query.limit === undefined ? {} : { maxPaths: query.limit }),
    ...(query.offset === undefined ? {} : { offset: query.offset }),
  };

  validateSparqlVariable(start, 'SERVICE path start');
  validateSparqlVariable(end, 'SERVICE path end');
  if (spec.start.pattern) {
    compilePattern(undefined, spec.start.pattern, dataset);
  }
  if (spec.end.pattern) {
    compilePattern(undefined, spec.end.pattern, dataset);
  }
  compilePattern(undefined, spec.via.pattern, dataset);
  return spec;
}

function parseSelect(input: string): SelectQuery {
  let parsed;
  try {
    parsed = parser.parse(input);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidPathQueryError(`Invalid SPARQL SERVICE path query: ${message}`);
  }
  if (parsed.type !== 'query' || parsed.queryType !== 'SELECT') {
    throw new InvalidPathQueryError('A SERVICE path query must use SELECT');
  }
  const selected = parsed.variables[0];
  if (
    parsed.variables.length !== 1 ||
    !selected ||
    !('termType' in selected) ||
    selected.termType !== 'Wildcard'
  ) {
    throw new InvalidPathQueryError('A SERVICE path query must use SELECT *');
  }
  if (parsed.group || parsed.having || parsed.order || parsed.values) {
    throw new InvalidPathQueryError('The SERVICE path envelope does not accept outer query modifiers');
  }
  return parsed;
}

function extractService(query: SelectQuery): ServicePattern {
  const patterns = query.where ?? [];
  if (patterns.length !== 1 || patterns[0]?.type !== 'service') {
    throw new InvalidPathQueryError('Expected exactly one SERVICE <urn:comunica:paths> block');
  }
  const service = patterns[0];
  if (service.silent || service.name.termType !== 'NamedNode' || service.name.value !== PATHS_SERVICE_IRI) {
    throw new InvalidPathQueryError('Expected a non-SILENT SERVICE <urn:comunica:paths> block');
  }
  return service;
}

function extractServiceBody(service: ServicePattern): {
  startPatterns: Pattern[] | undefined;
  endPatterns: Pattern[] | undefined;
  viaPatterns: Pattern[];
  config: ValuePatternRow;
} {
  let startPatterns: Pattern[] | undefined;
  let endPatterns: Pattern[] | undefined;
  let viaPatterns: Pattern[] | undefined;
  let config: ValuePatternRow | undefined;

  for (const pattern of service.patterns) {
    if (pattern.type === 'values') {
      if (config || pattern.values.length !== 1) {
        throw new InvalidPathQueryError('The path SERVICE requires exactly one single-row VALUES configuration');
      }
      config = pattern.values[0];
      continue;
    }
    if (pattern.type !== 'graph' || pattern.name.termType !== 'NamedNode') {
      throw new InvalidPathQueryError('The path SERVICE body accepts only reserved GRAPH blocks and configuration VALUES');
    }
    if (pattern.name.value === PATHS_START_GRAPH_IRI) {
      startPatterns = setOnce(startPatterns, pattern, 'START');
    } else if (pattern.name.value === PATHS_END_GRAPH_IRI) {
      endPatterns = setOnce(endPatterns, pattern, 'END');
    } else if (pattern.name.value === PATHS_VIA_GRAPH_IRI) {
      viaPatterns = setOnce(viaPatterns, pattern, 'VIA');
    } else {
      throw new InvalidPathQueryError(`Unknown path SERVICE graph: ${pattern.name.value}`);
    }
  }

  if (!config) {
    throw new InvalidPathQueryError('The path SERVICE is missing its VALUES configuration');
  }
  if (!viaPatterns) {
    throw new InvalidPathQueryError('The path SERVICE is missing its VIA graph');
  }
  return { startPatterns, endPatterns, viaPatterns, config };
}

function setOnce(current: Pattern[] | undefined, graph: GraphPattern, label: string): Pattern[] {
  if (current) {
    throw new InvalidPathQueryError(`The path SERVICE contains more than one ${label} graph`);
  }
  return graph.patterns;
}

function readVariable(row: ValuePatternRow, key: string, label: string): SparqlVariable {
  const value = readLiteral(row, key, true)!;
  const variable = value.startsWith('?') || value.startsWith('$') ? value : `?${value}`;
  validateSparqlVariable(variable, `SERVICE path ${label}`);
  return variable as SparqlVariable;
}

function readMode(row: ValuePatternRow): PathQueryMode {
  const value = readLiteral(row, CONFIG.mode, false)?.toLowerCase() ?? 'shortest';
  if (value !== 'shortest' && value !== 'all') {
    throw new InvalidPathQueryError('SERVICE path mode must be "shortest" or "all"');
  }
  return value;
}

function readBoolean(row: ValuePatternRow, key: string, fallback: boolean): boolean {
  const term = row[key];
  if (!term) {
    return fallback;
  }
  if (term.termType !== 'Literal' || ![ 'true', 'false', '1', '0' ].includes(term.value)) {
    throw new InvalidPathQueryError(`${key} must be a boolean literal`);
  }
  return term.value === 'true' || term.value === '1';
}

function readOptionalInteger(row: ValuePatternRow, key: string): number | undefined {
  const term = row[key];
  if (!term) {
    return undefined;
  }
  if (term.termType !== 'Literal' || !/^\d+$/u.test(term.value)) {
    throw new InvalidPathQueryError(`${key} must be a non-negative integer literal`);
  }
  const value = Number(term.value);
  if (!Number.isSafeInteger(value)) {
    throw new InvalidPathQueryError(`${key} is too large`);
  }
  return value;
}

function readLiteral(row: ValuePatternRow, key: string, required: boolean): string | undefined {
  const term: Term | undefined = row[key];
  if (!term) {
    if (required) {
      throw new InvalidPathQueryError(`The path SERVICE configuration is missing ${key}`);
    }
    return undefined;
  }
  if (term.termType !== 'Literal') {
    throw new InvalidPathQueryError(`${key} must be an RDF literal`);
  }
  return (term as Literal).value;
}
