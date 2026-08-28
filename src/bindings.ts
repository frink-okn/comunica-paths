import type { Bindings, Term } from '@rdfjs/types';
import type { SparqlVariable } from './types.js';

export function getBinding(bindings: Bindings, variable: SparqlVariable): Term | undefined {
  const name = variable.slice(1);
  for (const [ key, value ] of bindings) {
    if (key.value === name) {
      return value;
    }
  }
  return undefined;
}

export function compatibleBindings(left: Bindings | undefined, right: Bindings | undefined): boolean {
  if (!left || !right) {
    return true;
  }

  const leftTerms = new Map<string, Term>();
  for (const [ variable, term ] of left) {
    leftTerms.set(variable.value, term);
  }
  for (const [ variable, term ] of right) {
    const leftTerm = leftTerms.get(variable.value);
    if (leftTerm && !leftTerm.equals(term)) {
      return false;
    }
  }
  return true;
}

