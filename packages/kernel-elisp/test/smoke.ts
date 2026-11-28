// smoke.ts — headless smoke test for @didact/kernel-elisp.
// Run from the repo root: `bun packages/kernel-elisp/test/smoke.ts`.
// Covers registration, Lisp-2 symbol cells, dynamic vs lexical binding,
// macros, buffer editing, stepping, breakpoints, :session resume/reset,
// and line-mapped error handling.

import { elispKernel } from '../src/kernel';
import type { Panel, RunResult, Session } from '../src/types';

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

function consoleOf(panels: Panel[]): string {
  const p = panels.find((x) => x.kind === 'console');
  return p !== undefined && p.kind === 'console' ? p.text : '';
}

function rowsOf(panels: Panel[], id: string): { addr: number; text: string }[] {
  const p = panels.find((x) => x.id === id);
  return p !== undefined && p.kind === 'listing' ? p.rows : [];
}

async function load(src: string): Promise<Session> {
  const s = elispKernel.createSession();
  const r = await s.load(src);
  if (!r.ok) throw new Error(`load failed: line ${r.line}: ${r.message}`);
  return s;
}

async function run(src: string, bps?: number[]): Promise<{ r: RunResult; s: Session }> {
  const s = await load(src);
  return { r: await s.run(bps), s };
}

console.log('registration');
{
  eq('id', elispKernel.id, 'elisp');
  eq('label', elispKernel.label, 'Emacs Lisp · interpreter');
  eq('syntax', elispKernel.editorSyntax, 'scheme');
  check('stepping + breakpoints', elispKernel.features?.stepping === true
    && elispKernel.features.breakpoints === true);
}

console.log('Lisp-2 · value cell and function cell');
{
  const { r, s } = await run(`(defun double (x) (* 2 x))
(setq double 99)
(list double (double 4))`);
  eq('run finishes', r.error ?? 'ok', 'ok');
  eq('value and function cells stay distinct', r.exit, '=> (99 8)');
  const symbols = rowsOf(s.state(), 'symbols');
  check('Symbols panel shows both cells', symbols.some((row) =>
    row.text.includes('double · value 99 · fn #<function double>')));
  s.dispose();
}

console.log('dynamic vs lexical binding');
{
  const dyn = await run(`(setq x 1)
(defun get-x () x)
(let ((x 2)) (get-x))`);
  eq('dynamic binding sees caller let', dyn.r.exit, '=> 2');
  dyn.s.dispose();

  const lex = await run(`;; -*- lexical-binding: t; -*-
(setq x 1)
(defun get-x () x)
(let ((x 2)) (get-x))`);
  eq('lexical binding ignores caller let', lex.r.exit, '=> 1');
  lex.s.dispose();

  const closure = await run(`;; -*- lexical-binding: t; -*-
(defun make-adder (n) (lambda (x) (+ x n)))
(funcall (make-adder 5) 3)`);
  eq('lexical closure captures n', closure.r.exit, '=> 8');
  closure.s.dispose();
}

console.log('macros');
{
  const { r, s } = await run(`(defmacro our-unless (c &rest body)
  \`(if ,c nil (progn ,@body)))
(setq n 0)
(our-unless nil (setq n 5) (setq n (+ n 1)))
n`);
  eq('defmacro expands and evaluates', r.exit, '=> 6');
  s.dispose();

  const exp = await run(`(defmacro twice (x) \`(progn ,x ,x))
(macroexpand-1 '(twice (setq z 1)))`);
  eq('macroexpand-1 returns expansion', exp.r.exit, '=> (progn (setq z 1) (setq z 1))');
  exp.s.dispose();
}

console.log('buffer editing');
{
  const { r, s } = await run(`(insert "hello")
(goto-char 1)
(insert ">")
(delete-region 3 5)
(buffer-string)`);
  eq('buffer edits produce expected string', r.exit, '=> ">hlo"');
  const bufRows = rowsOf(s.state(), 'buffer-text');
  check('buffer-text panel shows edited text', bufRows.some((row) => row.text.includes('>hlo')));
  s.dispose();
}

console.log('stepping · breakpoints · :session resume · reset');
{
  const s = await load(`(setq a 1)
(setq b 2)
(+ a b)`);
  const paused = await s.run([2]);
  eq('breakpoint pauses before line 2', paused.pausedAt, 2);
  eq('not finished at pause', paused.finished, false);
  const st = await s.step();
  eq('step advances from pause', st.ran, true);
  const done = await s.run([2]);
  eq('continue past breakpoint finishes', done.finished, true);
  eq('result after continue', done.exit, '=> 3');
  s.dispose();

  const sess = await load(`(defun inc (x) (+ x 1))
(defvar counter 10)
(insert "hi")`);
  await sess.run();
  const resumed = await sess.resume!(`(setq counter (inc counter))
(insert "!")
(list counter (buffer-string))`);
  check('resume accepted', resumed.ok);
  const r2 = await sess.run();
  eq('resume finishes', r2.finished, true);
  eq('resume keeps functions, vars, and buffer', r2.exit, '=> (11 "hi!")');
  eq('resumed block output', consoleOf(sess.state()), '(11 "hi!")');

  sess.reset();
  const afterReset = await sess.run();
  check('reset clears shared session state',
    !afterReset.finished && (afterReset.error ?? '').includes('void-function inc'),
    afterReset.error ?? '');
  sess.dispose();
}

console.log('errors');
{
  const s = elispKernel.createSession();
  const bad = await s.load('(defun f (');
  check('reader error reports line 1', !bad.ok && bad.line === 1, JSON.stringify(bad));
  s.dispose();

  const rt = await run(`(defun f (x)
  (car x))
(f 1)`);
  check('runtime error maps to line 2',
    !rt.r.finished && (rt.r.error ?? '').includes('(line 2)'),
    rt.r.error ?? '');
  rt.s.dispose();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failure${failures.length === 1 ? '' : 's'}: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nall ${pass} checks passed`);
