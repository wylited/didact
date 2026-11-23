import type { Kernel } from './types';
import { ElispSession } from './session';

/** Emacs Lisp teaching kernel: Lisp-2 symbols, dynamic vs lexical binding,
 *  macros, and a simulated buffer/hook/keymap runtime — pure TypeScript. */
export const elispKernel: Kernel = {
  id: 'elisp',
  label: 'Emacs Lisp · interpreter',
  // core has no Emacs Lisp editor id yet; the Scheme legacy mode reads
  // Lisp forms (including quote/backquote) correctly.
  editorSyntax: 'scheme',
  features: { breakpoints: true, stepping: true },
  createSession: () => new ElispSession(),
};
