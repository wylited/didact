// kernel.ts — registration for the MATLAB-flavored teaching interpreter.

import type { Kernel } from './types';
import { MatlabSession } from './session';

/** The MATLAB kernel: a hand-written lexer/parser/interpreter for a
 *  MATLAB-flavored dialect — not The MathWorks' MATLAB. Matrices are the
 *  only data structure and they live column-major in one flat array,
 *  which the panels make visible element by element. No engine download,
 *  no eval, and nothing random: identical source runs identically. */
export const matlabKernel: Kernel = {
  id: 'matlab',
  label: 'MATLAB · interpreter',
  editorSyntax: 'octave',
  features: { breakpoints: true, stepping: true },
  createSession: () => new MatlabSession(),
};
