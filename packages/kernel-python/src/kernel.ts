import type { Kernel } from './types';
import { PythonSession } from './session';

/** The Python kernel: real CPython 3.14 on WebAssembly (Pyodide), run to
 *  completion — no stepping, no breakpoints. */
export const pythonKernel: Kernel = {
  id: 'python',
  label: 'Python · Pyodide',
  editorSyntax: 'python',
  features: { stepping: false, breakpoints: false },
  createSession: () => new PythonSession(),
};
