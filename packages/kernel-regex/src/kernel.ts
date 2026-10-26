// kernel.ts — registration for the regex NFA engine.

import type { Kernel } from './types';
import { RegexSession } from './session';

/** The regex teaching kernel: a pure-TypeScript pattern parser,
 *  Thompson NFA compiler, and parallel state-set simulator with
 *  POSIX-flavored leftmost-longest matching. No backtracking, ever. */
export const regexKernel: Kernel = {
  id: 'regex',
  label: 'Regex · NFA engine',
  editorSyntax: 'plain',
  features: { breakpoints: true, stepping: true },
  createSession: () => new RegexSession(),
};
