// kernel.ts — registration for the Fortran teaching interpreter.

import type { Kernel } from './types';
import { FortranSession } from './session';

/** The Fortran kernel: a hand-written lexer/parser/interpreter for a
 *  free-form F90/95/2003 teaching subset — modules, internal procedures,
 *  allocatable and assumed-shape arrays, array sections, derived types,
 *  WHERE and the numeric intrinsics HPC code actually uses. Arrays are
 *  column-major in one flat buffer, which the panels make visible element
 *  by element. No compiler download, no eval, no network. */
export const fortranKernel: Kernel = {
  id: 'fortran',
  label: 'Fortran · interpreter',
  editorSyntax: 'fortran',
  features: { breakpoints: true, stepping: true },
  createSession: () => new FortranSession(),
};
