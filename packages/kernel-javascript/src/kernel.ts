// kernel.ts — registration for the JavaScript teaching interpreter.

import type { Kernel } from './types';
import { JsSession } from './session';

/** The JavaScript kernel: hand-written lexer/parser/interpreter, no engine
 *  download, no eval — the language subset is small enough to hold in your
 *  head, which is the point of the lesson. */
export const jsKernel: Kernel = {
  id: 'javascript',
  label: 'JavaScript · interpreter',
  editorSyntax: 'javascript',
  features: { breakpoints: true, stepping: true },
  createSession: () => new JsSession(),
};
