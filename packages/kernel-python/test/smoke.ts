// Smoke: drive PythonSession against the real Pyodide build in node — the
// same interpreter the browser lazy-loads from public/vendor-python/. The
// itself (script tag + indexURL against vendor-python/) needs a DOM; here
// the engine is injected through the session's loader seam instead.
//
//   bun packages/kernel-python/test/smoke.ts
//
// Excluded from vitest (include is **/*.test.ts) on purpose: booting
// Pyodide takes seconds, not milliseconds.

import { Window } from 'happy-dom';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import { pythonKernel } from '../src/kernel';
import { PythonSession } from '../src/session';
import type { Field, Panel } from '../src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`smoke FAIL: ${msg}`);
  console.log('ok   ' + msg);
}

function consoleText(s: PythonSession): string {
  // by id: the panels also carry non-program sections, and only this one is
  // the block's own stdout/stderr
  const con = s.state().find(
    (p): p is Extract<Panel, { kind: 'console' }> => p.id === 'py-console');
  return con?.text ?? '';
}

function fieldsOf(s: PythonSession, id = 'py-vars'): Field[] {
  const panel = s.state().find(
    (p): p is Extract<Panel, { kind: 'fields' }> => p.kind === 'fields' && p.id === id);
  return panel?.fields ?? [];
}

/** The trace panel's rows, flattened from the html section the panel
 *  host receives (the session never exposes the raw hook payload). */
function traceTable(s: PythonSession): HTMLElement {
  // a throwaway DOM parses the trusted html section (bun has no document)
  const win = new Window();
  const panel = s.state().find((p) => p.kind === 'html' && /trace/i.test(p.title)) as
    | Extract<Panel, { kind: 'html' }>
    | undefined;
  if (panel === undefined) throw new Error('smoke FAIL: no Trace section in state()');
  const host = win.document.createElement('div');
  host.innerHTML = panel.html;
  return host as unknown as HTMLElement;
}

/** [line, hits] for every row of the trace table. */
function traceRows(s: PythonSession): { line: number; hits: number }[] {
  const host = traceTable(s);
  return [...host.querySelectorAll('tr[data-line]')].map((tr) => ({
    line: Number(tr.getAttribute('data-line')),
    hits: Number(tr.getAttribute('data-hits') ?? '0'),
  }));
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
  // the under-the-hood trace: both print statements ran, once each
  assert(traceRows(s1).map((r) => r.line).join(',') === '1,2',
    'trace lists the two executed lines');

  // 2. loop + list: variables panel shows n and squares with types.
  const s2 = makeSession();
  await s2.load('squares = []\nfor n in range(1, 6):\n    squares.append(n * n)\nprint("squares:", squares)\n');
  const r2 = await s2.run();
  assert(r2.finished, 'loop block finished');
  assert(consoleText(s2) === 'squares: [1, 4, 9, 16, 25]\n', 'loop stdout');
  const v2 = fieldMap(s2);
  assert(v2.get('n')?.value === '5' && v2.get('n')?.changed === true,
    'field n = 5 (changed)');
  assert(v2.get('n')?.sub?.includes('int') === true, `n is an int (${v2.get('n')?.sub})`);
  assert(v2.get('squares')?.value.startsWith('[1, 4, 9, 16, 25]') === true,
    `field squares = [1, 4, 9, 16, 25] (got ${v2.get('squares')?.value})`);
  assert(v2.get('squares')?.sub?.includes('list') === true && v2.get('squares')?.sub?.includes('len 5') === true,
    `squares is a list of 5 (${v2.get('squares')?.sub})`);
  // the loop at line 2 ran 5 times — the trace shows the header re-read
  const header = traceRows(s2).find((r) => r.line === 2);
  assert(header?.hits === 6, `loop header hit 6 times (${header?.hits})`);

  // 3. fib: function global, deterministic output.
  const s3 = makeSession();
  await s3.load('def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\nprint("fib(10) =", fib(10))\n');
  const r3 = await s3.run();
  assert(r3.finished && consoleText(s3) === 'fib(10) = 55\n', 'fib(10) = 55');
  const v3 = fieldMap(s3);
  assert(v3.get('fib')?.sub?.includes('function') === true
    && (v3.get('fib')?.value ?? '').startsWith('<function fib at'),
    `field fib is a function (${JSON.stringify(v3.get('fib'))})`);
  // the grouped panel carries section headers; no loop-local or dunder
  // name may appear as a variable row
  assert(!['a', 'b', '_', 'n'].some((k) => v3.has(k)), 'loop locals are not module variables');

  // 4. long strings keep their info: a preview, not a bare ellipsis.
  const s4 = makeSession();
  // 234 characters: past the helper's 200-char repr cap, so the row must
  // carry a truncated preview (one '…') and the real length beside it
  await s4.load('words = "abcdefghijklmnopqrstuvwxyz" * 9\n');
  await s4.run();
  const w = fieldMap(s4).get('words');
  assert(w !== undefined && w.value.startsWith("'abcdefghij") && w.value.endsWith('…')
    && w.value.length <= 200 && w.sub?.includes('str') === true && w.sub.includes('len 234'),
    `long str keeps a preview and its length (${JSON.stringify(w)})`);

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
  // the failure story: the traceback listing marks the failing frame,
  // and the trace table marks the failing line
  const tb = s6.state().find((p) => p.kind === 'listing' && /traceback/i.test(p.title)) as
    | Extract<Panel, { kind: 'listing' }>
    | undefined;
  assert(tb?.rows.some((r) => r.current === true && r.line === 2) === true,
    'traceback marks the failing frame (line 2)');
  assert(traceTable(s6).querySelector('tr.py-failed') !== null,
    'trace marks the failing line');

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
