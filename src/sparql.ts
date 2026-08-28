import {
  Generator,
  Parser,
  Wildcard,
  type Pattern,
  type SelectQuery,
} from 'sparqljs';
import { InvalidPathQueryError } from './errors.js';

const parser = new Parser({ sparqlStar: true });
const generator = new Generator({ sparqlStar: true });

export function compilePattern(
  prologue: string | undefined,
  pattern: string,
  dataset?: string,
): SelectQuery {
  let parsed;
  try {
    parsed = parser.parse(`${prologue ?? ''}\nSELECT DISTINCT * ${dataset ?? ''} WHERE {\n${pattern}\n}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidPathQueryError(`Invalid SPARQL graph pattern: ${message}`);
  }

  if (parsed.type !== 'query' || parsed.queryType !== 'SELECT') {
    throw new InvalidPathQueryError('A path graph pattern did not compile to a SELECT query');
  }
  return parsed;
}

export function serializePatterns(patterns: Pattern[]): string {
  const query = generator.stringify({
    type: 'query',
    queryType: 'SELECT',
    variables: [ new Wildcard() ],
    prefixes: {},
    where: patterns,
  });
  const open = query.indexOf('{');
  const close = query.lastIndexOf('}');
  if (open < 0 || close < open) {
    throw new InvalidPathQueryError('Could not serialize a standard SPARQL graph pattern');
  }
  return query.slice(open + 1, close).trim();
}

export function serializeDataset(dataset: SelectQuery['from']): string | undefined {
  if (!dataset) {
    return undefined;
  }
  const query = generator.stringify({
    type: 'query',
    queryType: 'SELECT',
    variables: [ new Wildcard() ],
    prefixes: {},
    from: dataset,
    where: [],
  });
  const select = query.indexOf('SELECT *') + 'SELECT *'.length;
  const where = query.indexOf('WHERE', select);
  const serialized = query.slice(select, where).trim();
  return serialized || undefined;
}

/** Whether a parsed SPARQL structure mentions the named variable anywhere. */
export function containsVariable(value: unknown, name: string, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if ('termType' in value && value.termType === 'Variable' && 'value' in value && value.value === name) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(entry => containsVariable(entry, name, seen));
  }
  return Object.entries(value).some(([ key, entry ]) =>
    key === `?${name}` || key === `$${name}` || containsVariable(entry, name, seen));
}

export function validateSparqlVariable(variable: string, label: string): void {
  try {
    const parsed = parser.parse(`SELECT ${variable} WHERE { }`);
    const selected = parsed.type === 'query' && parsed.queryType === 'SELECT' ? parsed.variables[0] : undefined;
    if (!selected || !('termType' in selected) || selected.termType !== 'Variable') {
      throw new Error('not a variable');
    }
  } catch {
    throw new InvalidPathQueryError(`${label} must be a valid SPARQL variable`);
  }
}
