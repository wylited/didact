import type { Kernel } from './types';
import { LispSession } from './session';

/** The Lisp teaching kernel: a pure-TypeScript reader/evaluator over an
 *  explicit continuation stack, with a stable-address cons-cell heap as
 *  the centerpiece panel. */
export const lispKernel: Kernel = {
  id: 'lisp',
  label: 'Lisp · interpreter',
  editorSyntax: 'scheme',
  features: { breakpoints: true, stepping: true },
  createSession: () => new LispSession(),
};
