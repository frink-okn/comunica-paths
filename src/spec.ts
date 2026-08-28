import { InvalidPathQueryError } from './errors.js';
import { validateSparqlVariable } from './sparql.js';
import type { PathQuerySpec } from './types.js';

/** Reject a specification that could not be executed as standard SPARQL. */
export function validateSpec(spec: PathQuerySpec): void {
  validateSparqlVariable(spec.start.node, 'START');
  validateSparqlVariable(spec.end.node, 'END');
  validateSparqlVariable(spec.via.from, 'VIA from');
  validateSparqlVariable(spec.via.to, 'VIA to');
  if (spec.via.from.slice(1) === spec.via.to.slice(1)) {
    throw new InvalidPathQueryError('VIA from and to variables must be different');
  }
  if (!spec.via.pattern.trim()) {
    throw new InvalidPathQueryError('VIA pattern must not be empty');
  }
  if (spec.mode !== undefined && ![ 'shortest', 'all' ].includes(spec.mode)) {
    throw new InvalidPathQueryError(`Unknown path query mode: ${String(spec.mode)}`);
  }
  for (const [ name, value ] of [
    [ 'maxDepth', spec.maxDepth ],
    [ 'maxPaths', spec.maxPaths ],
    [ 'offset', spec.offset ],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new InvalidPathQueryError(`${name} must be a non-negative safe integer`);
    }
  }
}
