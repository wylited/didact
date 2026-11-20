// toolkit.ts — the Python helper's source, embedded from toolkit.py.
//
// The helper lives in a real .py file so it is syntax-highlighted, testable
// by a host CPython and reviewable as Python. Vite inlines it verbatim via
// `?raw` (the app build); under vitest/node there is no asset pipeline, so
// the same file is read through node:fs with an import guarded to that path.
// `test/toolkit-source.test.ts` pins both to the one file.

import toolkitRaw from './toolkit.py?raw';

/** The Python source installed once per engine as `_lw_*` helpers. */
export const TOOLKIT_SOURCE: string = toolkitRaw;

/** The file name the block is compiled under — tracebacks and the trace
 *  hook both key on it, so the traceback shows real source lines. */
export const FILENAME = 'lesson.py';
