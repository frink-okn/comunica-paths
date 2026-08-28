import { InvalidPathQueryError } from './errors.js';
import { compilePattern } from './sparql.js';
import type { PathEndpointPattern, PathQueryMode, PathQuerySpec, SparqlVariable } from './types.js';

const MODIFIERS = [ 'MAX', 'OFFSET', 'LIMIT' ] as const;

/** Parse the PATHS query envelope while delegating every graph pattern to SPARQL.js. */
export function parsePathQuery(input: string): PathQuerySpec {
  const pathsAt = findTopLevelKeyword(input, 'PATHS', 0);
  if (pathsAt < 0) {
    throw syntaxError(input, 0, 'Expected PATHS query');
  }

  const prologueText = input.slice(0, pathsAt).trim();
  const cursor = new Cursor(input, pathsAt);
  cursor.expectKeyword('PATHS');

  let mode: PathQueryMode = 'shortest';
  let modeSeen = false;
  let cyclic = false;
  for (;;) {
    if (cursor.consumeKeyword('SHORTEST')) {
      if (modeSeen) {
        throw cursor.error('Only one of SHORTEST or ALL may be specified');
      }
      mode = 'shortest';
      modeSeen = true;
    } else if (cursor.consumeKeyword('ALL')) {
      if (modeSeen) {
        throw cursor.error('Only one of SHORTEST or ALL may be specified');
      }
      mode = 'all';
      modeSeen = true;
    } else if (cursor.consumeKeyword('CYCLIC')) {
      if (cyclic) {
        throw cursor.error('CYCLIC may be specified only once');
      }
      cyclic = true;
    } else {
      break;
    }
  }

  const startAt = findTopLevelKeyword(input, 'START', cursor.position);
  if (startAt < 0) {
    throw cursor.error('Expected START clause');
  }
  const datasetText = input.slice(cursor.position, startAt).trim();
  cursor.position = startAt;
  cursor.expectKeyword('START');
  const start = parseEndpoint(cursor, 'END');
  cursor.expectKeyword('END');
  const end = parseEndpoint(cursor, 'VIA');
  cursor.expectKeyword('VIA');

  const viaText = parseVia(cursor);
  const viaPattern = viaText.braced ?
    viaText.value :
    `${start.node} ${viaText.value}\n${end.node} .`;

  let maxDepth: number | undefined;
  let maxPaths: number | undefined;
  let offset: number | undefined;
  while (!cursor.atEnd()) {
    if (cursor.consumeKeyword('MAX')) {
      if (maxDepth !== undefined) {
        throw cursor.error('MAX LENGTH may be specified only once');
      }
      cursor.expectKeyword('LENGTH');
      maxDepth = cursor.readNonNegativeInteger('MAX LENGTH');
    } else if (cursor.consumeKeyword('OFFSET')) {
      if (offset !== undefined) {
        throw cursor.error('OFFSET may be specified only once');
      }
      offset = cursor.readNonNegativeInteger('OFFSET');
    } else if (cursor.consumeKeyword('LIMIT')) {
      if (maxPaths !== undefined) {
        throw cursor.error('LIMIT may be specified only once');
      }
      maxPaths = cursor.readNonNegativeInteger('LIMIT');
    } else {
      throw cursor.error('Expected MAX LENGTH, OFFSET, LIMIT, or end of query');
    }
  }

  const spec: PathQuerySpec = {
    ...(prologueText ? { prologue: prologueText } : {}),
    ...(datasetText ? { dataset: datasetText } : {}),
    start,
    end,
    via: { pattern: viaPattern, from: start.node, to: end.node },
    mode,
    ...(cyclic ? { cyclic: true } : {}),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxPaths === undefined ? {} : { maxPaths }),
    ...(offset === undefined ? {} : { offset }),
  };
  validateStandardSparql(spec);
  return spec;
}

function parseEndpoint(cursor: Cursor, nextKeyword: 'END' | 'VIA'): PathEndpointPattern {
  const node = cursor.readVariable();
  if (cursor.consumeCharacter('=')) {
    const term = cursor.readTerm();
    return { node, pattern: `VALUES ${node} { ${term} }` };
  }
  if (cursor.peekCharacter() === '{') {
    return { node, pattern: cursor.readBalancedBlock() };
  }
  if (!cursor.peekKeyword(nextKeyword)) {
    throw cursor.error(`Expected =, a graph pattern, or ${nextKeyword}`);
  }
  return { node };
}

function parseVia(cursor: Cursor): { value: string; braced: boolean } {
  if (cursor.peekCharacter() === '{') {
    return { value: cursor.readBalancedBlock(), braced: true };
  }

  const end = findFirstTopLevelKeyword(cursor.input, MODIFIERS, cursor.position);
  const value = cursor.input.slice(cursor.position, end < 0 ? cursor.input.length : end).trim();
  if (!value) {
    throw cursor.error('VIA must contain a graph pattern, variable, or property path');
  }
  cursor.position = end < 0 ? cursor.input.length : end;
  return { value, braced: false };
}

function validateStandardSparql(spec: PathQuerySpec): void {
  const start = spec.start.pattern?.trim();
  const end = spec.end.pattern?.trim();
  if (start) {
    const query = compilePattern(spec.prologue, start, spec.dataset);
    if (!containsVariable(query, spec.start.node.slice(1))) {
      throw new InvalidPathQueryError(`START pattern does not mention ${spec.start.node}`);
    }
  }
  if (end) {
    const query = compilePattern(spec.prologue, end, spec.dataset);
    if (!containsVariable(query, spec.end.node.slice(1))) {
      throw new InvalidPathQueryError(`END pattern does not mention ${spec.end.node}`);
    }
  }
  const via = compilePattern(spec.prologue, spec.via.pattern, spec.dataset);
  if (!containsVariable(via, spec.via.from.slice(1)) || !containsVariable(via, spec.via.to.slice(1))) {
    throw new InvalidPathQueryError('VIA pattern must mention both endpoint variables');
  }
}

function containsVariable(value: unknown, name: string, seen = new Set<object>()): boolean {
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

class Cursor {
  public constructor(public readonly input: string, public position = 0) {}

  public atEnd(): boolean {
    this.skipIgnored();
    return this.position >= this.input.length;
  }

  public consumeKeyword(keyword: string): boolean {
    this.skipIgnored();
    if (!matchesKeyword(this.input, this.position, keyword)) {
      return false;
    }
    this.position += keyword.length;
    return true;
  }

  public expectKeyword(keyword: string): void {
    if (!this.consumeKeyword(keyword)) {
      throw this.error(`Expected ${keyword}`);
    }
  }

  public peekKeyword(keyword: string): boolean {
    this.skipIgnored();
    return matchesKeyword(this.input, this.position, keyword);
  }

  public consumeCharacter(character: string): boolean {
    this.skipIgnored();
    if (this.input[this.position] !== character) {
      return false;
    }
    this.position++;
    return true;
  }

  public peekCharacter(): string | undefined {
    this.skipIgnored();
    return this.input[this.position];
  }

  public readVariable(): SparqlVariable {
    this.skipIgnored();
    const start = this.position;
    if (this.input[this.position] !== '?' && this.input[this.position] !== '$') {
      throw this.error('Expected a SPARQL variable');
    }
    this.position++;
    while (this.position < this.input.length && !/[\s={}/()[\];,.]/u.test(this.input[this.position]!)) {
      this.position++;
    }
    return this.input.slice(start, this.position) as SparqlVariable;
  }

  public readBalancedBlock(): string {
    this.skipIgnored();
    if (this.input[this.position] !== '{') {
      throw this.error('Expected a graph pattern');
    }
    const start = ++this.position;
    let depth = 1;
    let state: LexicalState = 'normal';
    let quote = '';

    while (this.position < this.input.length) {
      const character = this.input[this.position]!;
      const next = this.input[this.position + 1];
      if (state === 'comment') {
        if (character === '\n' || character === '\r') {
          state = 'normal';
        }
        this.position++;
        continue;
      }
      if (state === 'iri') {
        this.position++;
        if (character === '\\') {
          this.position++;
        } else if (character === '>') {
          state = 'normal';
        }
        continue;
      }
      if (state === 'string') {
        if (character === '\\') {
          this.position += 2;
          continue;
        }
        if (this.input.startsWith(quote, this.position)) {
          this.position += quote.length;
          state = 'normal';
        } else {
          this.position++;
        }
        continue;
      }

      if (character === '#') {
        state = 'comment';
        this.position++;
      } else if (character === '<') {
        state = 'iri';
        this.position++;
      } else if (character === '"' || character === "'") {
        quote = character.repeat(next === character && this.input[this.position + 2] === character ? 3 : 1);
        state = 'string';
        this.position += quote.length;
      } else if (character === '{') {
        depth++;
        this.position++;
      } else if (character === '}') {
        depth--;
        if (depth === 0) {
          const value = this.input.slice(start, this.position);
          this.position++;
          return value;
        }
        this.position++;
      } else {
        this.position++;
      }
    }
    throw this.error('Unclosed graph pattern');
  }

  public readTerm(): string {
    this.skipIgnored();
    const start = this.position;
    const first = this.input[this.position];
    if (first === '<') {
      this.readDelimited('<', '>');
    } else if (first === '"' || first === "'") {
      this.readQuoted(first);
      if (this.input[this.position] === '@') {
        this.position++;
        while (/[A-Za-z0-9-]/u.test(this.input[this.position] ?? '')) {
          this.position++;
        }
      } else if (this.input.startsWith('^^', this.position)) {
        this.position += 2;
        if (this.input[this.position] === '<') {
          this.readDelimited('<', '>');
        } else {
          this.readBareToken();
        }
      }
    } else {
      this.readBareToken();
    }
    if (this.position === start) {
      throw this.error('Expected an RDF term');
    }
    return this.input.slice(start, this.position);
  }

  public readNonNegativeInteger(label: string): number {
    this.skipIgnored();
    const match = /^\d+/u.exec(this.input.slice(this.position));
    if (!match) {
      throw this.error(`${label} requires a non-negative integer`);
    }
    this.position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isSafeInteger(value)) {
      throw this.error(`${label} is too large`);
    }
    return value;
  }

  public error(message: string): InvalidPathQueryError {
    return syntaxError(this.input, this.position, message);
  }

  private skipIgnored(): void {
    for (;;) {
      while (/\s/u.test(this.input[this.position] ?? '')) {
        this.position++;
      }
      if (this.input[this.position] !== '#') {
        return;
      }
      while (this.position < this.input.length && !/[\r\n]/u.test(this.input[this.position]!)) {
        this.position++;
      }
    }
  }

  private readDelimited(open: string, close: string): void {
    if (this.input[this.position] !== open) {
      throw this.error(`Expected ${open}`);
    }
    this.position++;
    while (this.position < this.input.length) {
      const character = this.input[this.position++]!;
      if (character === '\\') {
        this.position++;
      } else if (character === close) {
        return;
      }
    }
    throw this.error(`Unclosed ${open}`);
  }

  private readQuoted(character: string): void {
    const quote = character.repeat(
      this.input[this.position + 1] === character && this.input[this.position + 2] === character ? 3 : 1,
    );
    this.position += quote.length;
    while (this.position < this.input.length) {
      if (this.input[this.position] === '\\') {
        this.position += 2;
      } else if (this.input.startsWith(quote, this.position)) {
        this.position += quote.length;
        return;
      } else {
        this.position++;
      }
    }
    throw this.error('Unclosed RDF literal');
  }

  private readBareToken(): void {
    while (this.position < this.input.length && !/[\s{}]/u.test(this.input[this.position]!)) {
      this.position++;
    }
  }
}

type LexicalState = 'normal' | 'comment' | 'iri' | 'string';

function findFirstTopLevelKeyword(
  input: string,
  keywords: readonly string[],
  start: number,
): number {
  let best = -1;
  for (const keyword of keywords) {
    const found = findTopLevelKeyword(input, keyword, start);
    if (found >= 0 && (best < 0 || found < best)) {
      best = found;
    }
  }
  return best;
}

function findTopLevelKeyword(input: string, keyword: string, start: number): number {
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  let state: LexicalState = 'normal';
  let quote = '';

  for (let index = start; index < input.length; index++) {
    const character = input[index]!;
    const next = input[index + 1];
    if (state === 'comment') {
      if (character === '\n' || character === '\r') {
        state = 'normal';
      }
      continue;
    }
    if (state === 'iri') {
      if (character === '\\') {
        index++;
      } else if (character === '>') {
        state = 'normal';
      }
      continue;
    }
    if (state === 'string') {
      if (character === '\\') {
        index++;
      } else if (input.startsWith(quote, index)) {
        index += quote.length - 1;
        state = 'normal';
      }
      continue;
    }

    if (character === '#') {
      state = 'comment';
    } else if (character === '<') {
      state = 'iri';
    } else if (character === '"' || character === "'") {
      quote = character.repeat(next === character && input[index + 2] === character ? 3 : 1);
      state = 'string';
      index += quote.length - 1;
    } else if (character === '{') {
      braces++;
    } else if (character === '}') {
      braces--;
    } else if (character === '(') {
      parentheses++;
    } else if (character === ')') {
      parentheses--;
    } else if (character === '[') {
      brackets++;
    } else if (character === ']') {
      brackets--;
    } else if (braces === 0 && parentheses === 0 && brackets === 0 && matchesKeyword(input, index, keyword)) {
      return index;
    }
  }
  return -1;
}

function matchesKeyword(input: string, position: number, keyword: string): boolean {
  if (input.slice(position, position + keyword.length).toUpperCase() !== keyword) {
    return false;
  }
  const before = input[position - 1];
  const after = input[position + keyword.length];
  return !isNameCharacter(before) && !isNameCharacter(after);
}

function isNameCharacter(character: string | undefined): boolean {
  return Boolean(character && /[A-Za-z0-9_:-]/u.test(character));
}

function syntaxError(input: string, position: number, message: string): InvalidPathQueryError {
  const prefix = input.slice(0, position);
  const line = prefix.split(/\r\n|\r|\n/u).length;
  const lastBreak = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r'));
  const column = position - lastBreak;
  return new InvalidPathQueryError(`${message} at line ${line}, column ${column}`);
}
