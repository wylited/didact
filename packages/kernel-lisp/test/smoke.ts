// smoke.ts — bun smoke test for @didact/kernel-lisp.
// Run: `bun packages/kernel-lisp/test/smoke.ts`.
// Covers: reader/evaluator semantics (arithmetic, quasiquote, closures,
// tail calls, macros, eq?/equal?), line-mapped errors, budget and heap
// bounds, the Session contract (panels, breakpoints, reset), and a
// round-trip of every lesson block against its #+RESULTS.


import { lispKernel, Machine, makeBuiltins, readProgram, renderWrite, withHeap } from '../src/index';
import type { Panel } from '../src/index';

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${String(got)} want ${String(want)}`);
}

/** Machine-level helper: run src, return the machine (for lastValue). */
function machineOf(src: string): Machine {
  let m!: Machine;
  const b = makeBuiltins((fv, env) => m.macroExpandOnce(fv, env));
  m = new Machine(readProgram(src), b);
  while (!m.finished && m.error === null) m.step();
  return m;
}
function val(src: string): string {
  const m = machineOf(src);
  if (m.error !== null) return `ERROR: ${m.error}`;
  return withHeap(m.heap, () => renderWrite(m.lastValue));
}

/** Session-level helper: load + run, return [console text, panels, result]. */
async function runSession(src: string): Promise<{ text: string; panels: Panel[]; result: { finished: boolean; error?: string; pausedAt?: number } }> {
  const s = lispKernel.createSession();
  const load = await s.load(src);
  if (!load.ok) throw new Error(`load failed: line ${load.line}: ${load.message}`);
  const result = await s.run();
  return { text: consoleOf(s.state()), panels: s.state(), result };
}
function consoleOf(panels: Panel[]): string {
  const p = panels.find((q): q is Extract<Panel, { kind: 'console' }> => q.kind === 'console');
  return p?.text ?? '';
}

// ─── semantics ──────────────────────────────────────────────────────────────
console.log('semantics · reader + evaluator');
eq('nested arithmetic', val('(+ 1 (* 2 3) (- 10 4))'), '13');
eq('quote keeps structure', val(`'(1 2 (3 . 4))`), '(1 2 (3 . 4))');
eq('quasiquote with splicing', val('`(1 ,(+ 1 1) ,@(list 3 4) 5)'), '(1 2 3 4 5)');
eq('closure counter', val(`(define (mk) (let ((n 0)) (lambda () (set! n (+ n 1)) n)))
(define c (mk)) (c) (c) (c)`), '3');
eq('eq? is address identity', val('(define xs (list 1 2)) (list (eq? xs xs) (eq? (list 1 2) (list 1 2)))'), '(#t #f)');
eq('equal? walks the heap', val('(equal? (list 1 (list 2)) (list 1 (list 2)))'), '#t');
eq('dotted pair renders honestly', val('(cons 1 2)'), '(1 . 2)');
eq('cond with else', val(`(cond ((= 1 2) 'a) (else 'fallback))`), 'fallback');
eq('macroexpand-1 shows the expansion', val(`(define-macro (my-if c t e) \`(cond (,c ,t) (else ,e)))
(macroexpand-1 '(my-if #t 1 2))`), '(cond (#t 1) (else 2))');
eq('macro applies', val(`(define-macro (my-if c t e) \`(cond (,c ,t) (else ,e)))
(my-if #f 42 99)`), '99');
console.log('semantics: arithmetic, quoting, closures, eq?/equal?, macros all exact');

// ─── tail calls and bounds ─────────────────────────────────────────────────
console.log('bounds · tail calls, budget, heap');
{
  const tco = await runSession(`(define (loop n) (if (= n 0) 'done (loop (- n 1))))\n(loop 100000)`);
  check('100 000-deep tail loop completes', tco.result.finished, tco.result.error ?? '');

  const spin = await runSession('(define (spin n) (spin (+ n 1)))\n(spin 0)');
  check('runaway loop hits the budget', !spin.result.finished && !!spin.result.error?.includes('run budget exceeded'), spin.result.error ?? '');

  const grow = await runSession('(define (grow l)\n  (grow (cons 0 l)))\n(grow (list))');
  check('heap overflow names line 2', !grow.result.finished && !!grow.result.error?.includes('heap overflow: 4096 cells (line 2)'), grow.result.error ?? '');

  const fib = machineOf('(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))\n(fib 15)');
  eq('non-tail fib(15) works within budget', withHeap(fib.heap, () => renderWrite(fib.lastValue)), '610');
  console.log('bounds: TCO 1e5, budget 1e6, heap 4096 all enforced with lines');
}

// ─── line-mapped errors ────────────────────────────────────────────────────
console.log('errors · line mapping');
{
  const s = lispKernel.createSession();
  const unclosed = await s.load('(define x 1)\n(display (+ 1 2)');
  check('unclosed ( reports its opening line', !unclosed.ok && unclosed.line === 2, JSON.stringify(unclosed));
  const unbound = await runSession('(define a 1)\n(+ a nope)');
  eq('unbound variable line', unbound.result.error, 'unbound variable: nope (line 2)');
  const setbad = await runSession('(set! nope 1)');
  eq('set! unbound line', setbad.result.error, 'set!: unbound variable: nope (line 1)');
  console.log('errors: reader, unbound, set! all line-mapped');
}

// ─── session contract ──────────────────────────────────────────────────────
console.log('contract · session, panels, breakpoints');
{
  const s = lispKernel.createSession();
  const load = await s.load('(define (twice x) (* 2 x))\n(display (twice 21))');
  check('load summary', load.ok && load.summary === 'loaded · 2 forms', JSON.stringify(load));

  const paused = await s.run([2]);
  check('breakpoint pauses before line 2', !paused.finished && paused.pausedAt === 2, JSON.stringify(paused));
  const stepped = await s.step();
  check('step runs one reduction', stepped.ran);
  const done = await s.run();
  check('resume finishes', done.finished, done.error ?? '');
  eq('console has the result', consoleOf(s.state()), '42');

  const panels = s.state();
  check('panel kinds: heap, env, control, console',
    panels[0]!.kind === 'listing'
    && panels.some((p) => p.kind === 'fields' && p.title === 'global')
    && panels.some((p) => p.kind === 'listing' && p.id === 'control')
    && panels[panels.length - 1]!.kind === 'console',
    panels.map((p) => `${p.kind}:${p.id ?? ''}`).join(','));
  const global = panels.find((p): p is Extract<Panel, { kind: 'fields' }> => p.kind === 'fields' && p.title === 'global');
  check('global frame shows the user binding twice',
    global !== undefined && global.fields.some((f) => f.key === 'twice' && f.value === '#<procedure twice>'));

  const stepsFirst = done.steps;
  s.reset();
  const rerun = await s.run();
  eq('reset replays the same program', rerun.steps, stepsFirst);
  s.dispose();
  console.log('contract: load/run/step/reset/state + breakpoints honored');
}

// ─── lesson/lesson.org: every block runs and matches its #+RESULTS ────────
console.log('session · lesson round-trip');
{
  const blocks: string[] = [];
  const expected: string[] = [];
  const org = await Bun.file(`${import.meta.dir}/../lesson/lesson.org`).text();
  const lines = org.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('#+BEGIN_SRC lisp')) {
      const body: string[] = [];
      for (let j = i + 1; !lines[j]!.startsWith('#+END_SRC'); j++) body.push(lines[j]!);
      blocks.push(body.join('\n'));
    }
    if (lines[i]!.startsWith('#+RESULTS:')) {
      const body: string[] = [];
      for (let j = i + 1; lines[j] !== undefined && lines[j]!.startsWith(': '); j++) {
        body.push(lines[j]!.slice(2));
      }
      expected.push(body.join('\n'));
    }
  }
  eq('lesson has 5 executable blocks', blocks.length, 5);
  eq('lesson has 5 results slots', expected.length, 5);
  for (let k = 0; k < blocks.length; k++) {
    const s = lispKernel.createSession();
    const load = await s.load(blocks[k]!);
    check(`lesson block ${k + 1} loads`, load.ok, load.ok ? '' : `line ${load.line}: ${load.message}`);
    const r = await s.run();
    check(`lesson block ${k + 1} finishes`, r.finished && r.error === undefined, r.error ?? '');
    eq(`lesson block ${k + 1} output = ${JSON.stringify(expected[k])}`, consoleOf(s.state()).trim(), expected[k]!);
    s.dispose();
  }
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} FAILED / ${pass} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`all ${pass} checks passed`);
