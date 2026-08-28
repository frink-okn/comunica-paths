import type { Term } from '@rdfjs/types';
import {
  Generator,
  Parser,
  Wildcard,
  type Pattern,
  type SelectQuery,
  type ValuePatternRow,
} from 'sparqljs';
import { InvalidPathQueryError, UnsupportedPathTermError } from './errors.js';
import type { SparqlVariable } from './types.js';

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

export function compileValuesQuery(
  template: SelectQuery,
  variable: SparqlVariable,
  terms: readonly Term[],
): string {
  const values: ValuePatternRow[] = terms.map((term) => {
    assertValuesTerm(term);
    return { [variable]: term } as ValuePatternRow;
  });
  return generator.stringify({
    ...template,
    where: [ { type: 'values', values }, ...(template.where ?? []) ],
  });
}

export function compileQuery(template: SelectQuery): string {
  return generator.stringify(template);
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

function assertValuesTerm(term: Term): void {
  if (term.termType === 'BlankNode') {
    throw new UnsupportedPathTermError(
      'A blank node cannot be carried between independent SPARQL queries with VALUES. ' +
      'Use named nodes for traversable resources.',
    );
  }
  if (term.termType === 'Variable' || term.termType === 'DefaultGraph') {
    throw new UnsupportedPathTermError(`A ${term.termType} cannot be used as a path node`);
  }
}
