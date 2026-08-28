import type { Bindings, Term } from '@rdfjs/types';

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

