import { InvalidPathQueryError } from './errors.js';
import { compilePattern, containsVariable, validateSparqlVariable } from './sparql.js';
import type { PathQuerySpec } from './types.js';

/**
 * Reject a specification that could not be executed as standard SPARQL.
 *
 * A VIA pattern names one traversal step with the same two variables the query
 * uses for the whole path: START's node is the source of a step and END's node
 * is its target. Every front-end produces that shape, so the rule is checked
 * here rather than in any one of them, and every surface reports it identically.
 */
export function validateSpec(spec: PathQuerySpec): void {
  validateSparqlVariable(spec.start.node, 'START');
  validateSparqlVariable(spec.end.node, 'END');
  if (spec.start.node.slice(1) === spec.end.node.slice(1)) {
    throw new InvalidPathQueryError(
      `START and END must use different variables, but both are ${spec.start.node}`,
    );
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

  const via = compilePattern(spec.prologue, spec.via.pattern, spec.dataset);
  if (!containsVariable(via, spec.start.node.slice(1)) ||
    !containsVariable(via, spec.end.node.slice(1))) {
    throw new InvalidPathQueryError(
      `VIA pattern must bind both ${spec.start.node} and ${spec.end.node}`,
    );
  }
  for (const [ clause, endpoint ] of [
    [ 'START', spec.start ],
    [ 'END', spec.end ],
  ] as const) {
    const pattern = endpoint.pattern?.trim();
    if (pattern && !containsVariable(
      compilePattern(spec.prologue, pattern, spec.dataset),
      endpoint.node.slice(1),
    )) {
      throw new InvalidPathQueryError(`${clause} pattern does not mention ${endpoint.node}`);
    }
  }
}
