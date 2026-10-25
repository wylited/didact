import type { Kernel } from './types';
import { PrologSession } from './session';

/** The Prolog teaching kernel: a pure-TypeScript tokenizer, clause parser,
 *  and an SLD resolution machine with occurs-check unification, explicit
 *  goal stack and choice points, cut, and a step budget. */
export const prologKernel: Kernel = {
  id: 'prolog',
  label: 'Prolog · interpreter',
  editorSyntax: 'plain',
  features: { breakpoints: true, stepping: true },
  createSession: () => new PrologSession(),
};
