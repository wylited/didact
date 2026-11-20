import type { Kernel } from './types';
import { PythonSession } from './session';

/** The Python kernel: real CPython 3.14 on WebAssembly (Pyodide).
 *
 *  `stepping: false` — Run executes the whole block under a line hook, and
 *  the x-ray it leaves behind (executed lines with counts, flow summary,
 *  call stack, traceback, grouped variables, declared-vs-observed types) is
 *  the under-the-hood view. True single-stepping is not offered: CPython
 *  cannot pause a running block from outside, and Pyodide is single-threaded
 *  (docs/languages.md §5). Breakpoints are not offered. */
export const pythonKernel: Kernel = {
  id: 'python',
  label: 'Python · Pyodide',
  editorSyntax: 'python',
  features: { stepping: false, breakpoints: false },
  createSession: () => new PythonSession(),
};
