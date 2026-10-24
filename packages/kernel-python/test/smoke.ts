// Smoke: drive PythonSession against the real Pyodide build in node — the
// same interpreter the browser lazy-loads from vendor/. The browser loader
// itself (script tag + indexURL against vendor-python/) needs a DOM; here
// the engine is injected through the session's loader seam instead.
//
//   bun packages/kernel-python/test/smoke.ts
//
// Excluded from vitest (include is **/*.test.ts) on purpose: booting
// Pyodide takes seconds, not milliseconds.

import { loadPyodide, type PyodideInterface } from 'pyodide';
import { pythonKernel } from '../src/kernel';
import { PythonSession } from '../src/session';
import type { Field, Panel } from '../src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`smoke FAIL: ${msg}`);
  console.log('ok   ' + msg);
}

function consoleText(s: PythonSession): string {
  const con = s.state().find(
    (p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
  return con?.text ?? '';
}

function fieldsOf(s: PythonSession): Field[] {
  const panel = s.state().find(
    (p): p is Extract<Panel, { kind: 'fields' }> => p.kind === 'fields');
  return panel?.fields ?? [];
}

function fieldMap(s: PythonSession): Map<string, Field> {
  return new Map(fieldsOf(s).map((f) => [f.key, f] as const));
}

async function main(): Promise<void> {
  assert(pythonKernel.id === 'python', 'kernel id is python');
  assert(pythonKernel.label === 'Python · Pyodide', 'kernel label');
  assert(pythonKernel.features?.stepping === false && pythonKernel.features.breakpoints === false,
    'stepping and breakpoints disabled');

  const py: PyodideInterface = await loadPyodide();
  const makeSession = (): PythonSession => new PythonSession(() => Promise.resolve(py));

  // 1. hello + arithmetic: stdout captured verbatim, no globals defined.
  const s1 = makeSession();
  const l1 = await s1.load('print("Hello, Python!")\nprint("2 + 3 * 4 =", 2 + 3 * 4)\n');
  assert(l1.ok, 'load ok');
  const r1 = await s1.run();
  assert(r1.finished && r1.steps === 0 && r1.exit === undefined && r1.error === undefined,
    'run finished, steps 0, no exit/error');
  assert(consoleText(s1) === 'Hello, Python!\n2 + 3 * 4 = 14\n',
    `stdout captured exactly (got ${JSON.stringify(consoleText(s1))})`);
  assert(fieldsOf(s1).length === 0, 'no globals defined by hello block');

  // 2. loop + list: variables panel shows n and squares with types.
  const s2 = makeSession();
  await s2.load('squares = []\nfor n in range(1, 6):\n    squares.append(n * n)\nprint("squares:", squares)\n');
  const r2 = await s2.run();
  assert(r2.finished, 'loop block finished');
  assert(consoleText(s2) === 'squares: [1, 4, 9, 16, 25]\n', 'loop stdout');
  const v2 = fieldMap(s2);
  assert(v2.get('n')?.value === '5' && v2.get('n')?.sub === 'int' && v2.get('n')?.changed === true,
    'field n = 5 (int, changed)');
  assert(v2.get('squares')?.value === '[1, 4, 9, 16, 25]' && v2.get('squares')?.sub === 'list',
    'field squares = [1, 4, 9, 16, 25] (list)');

  // 3. fib: function global, deterministic output.
  const s3 = makeSession();
  await s3.load('def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\nprint("fib(10) =", fib(10))\n');
  const r3 = await s3.run();
  assert(r3.finished && consoleText(s3) === 'fib(10) = 55\n', 'fib(10) = 55');
  const v3 = fieldMap(s3);
  assert(v3.size === 1 && v3.get('fib')?.sub === 'function'
    && (v3.get('fib')?.value ?? '').startsWith('<function fib at'),
    'field fib (function); underscore loop var filtered');

  // 4. long repr truncated to ~40 chars.
  const s4 = makeSession();
  await s4.load('words = "abcdefghijklmnopqrstuvwxyz" * 4\n');
  await s4.run();
  const w = fieldMap(s4).get('words');
  assert(w !== undefined && w.value.length === 40 && w.value.endsWith('…') && w.sub === 'str',
    `long repr truncated to 40 chars with ellipsis (got ${JSON.stringify(w?.value)})`);

  // 5. syntax error: CPython's exact line.
  const s5 = makeSession();
  const l5 = await s5.load('x = 1\ny =\n');
  assert(!l5.ok && l5.line === 2 && /SyntaxError/.test(l5.message),
    `syntax error on line 2 (${JSON.stringify(l5)})`);

  // 6. runtime error: error = type + message, traceback in console.
  const s6 = makeSession();
  await s6.load('total = 0\n1 / 0\n');
  const r6 = await s6.run();
  assert(!r6.finished && r6.error === 'ZeroDivisionError: division by zero',
    `runtime error is type + message (${JSON.stringify(r6.error)})`);
  const out6 = consoleText(s6);
  assert(out6.includes('Traceback (most recent call last)') && out6.includes('lesson.py') && out6.includes('1 / 0'),
    'console gets the traceback with source lines');
  assert(out6.split('ZeroDivisionError').length === 2, 'traceback appears exactly once');

  // 7. fresh namespace: another block cannot see s2's globals.
  const l7 = await s1.load('print(squares)\n');
  assert(l7.ok, 'cross-block name compiles');
  const r7 = await s1.run();
  assert(!r7.finished && r7.error !== undefined && r7.error.startsWith('NameError'),
    `fresh namespace → NameError (${JSON.stringify(r7.error)})`);

  // 8. step is a no-op; reset clears output and snapshots.
  const st = await s1.step();
  assert(st.ran === false && st.result === undefined, 'step() never runs');
  s2.reset();
  assert(consoleText(s2) === '' && fieldsOf(s2).length === 0, 'reset clears console and variables');

  // 9. unflushed stdout tail: captured by its own session, never dropped
  //    and never leaked into the next session's console.
  const s9 = makeSession();
  await s9.load("print('no-newline tail', end='')\n");
  const r9 = await s9.run();
  assert(r9.finished, 'tail block finished');
  assert(consoleText(s9) === 'no-newline tail',
    `unflushed tail captured verbatim (got ${JSON.stringify(consoleText(s9))})`);
  const s10 = makeSession();
  await s10.load('print("second")\n');
  await s10.run();
  assert(consoleText(s10) === 'second\n',
    `next session sees only its own output (got ${JSON.stringify(consoleText(s10))})`);

  console.log('\nALL PYTHON KERNEL SMOKE CHECKS PASSED');
}

main().catch((e: unknown) => {
  console.error(e);
  throw e; // top-level: the process exits non-zero on failure
});
