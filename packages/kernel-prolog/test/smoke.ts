// smoke.ts — bun smoke test for @didact/kernel-prolog.
// Run: `bun packages/kernel-prolog/test/smoke.ts`.
// Covers: unification and occurs check, backtracking order, append's three
// modes, cut (parent-goal semantics), arithmetic (=:= vs =), anonymous
// variables, budget and line-mapped errors, the Session contract (panels,
// breakpoints, reset, run-continues-for-more-solutions), and a round-trip
// of every lesson block against its #+RESULTS.

import { prologKernel } from '../src/index';
import type { Panel } from '../src/index';

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; } else { failures.push(detail !== '' ? `${name}: ${detail}` : name); }
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${String(got)} want ${String(want)}`);
}

/** Session-level helper: load + run, return [console text, panels, result]. */
async function runSession(src: string): Promise<{ text: string; panels: Panel[]; result: { finished: boolean; error?: string; pausedAt?: number; exit?: string } }> {
  const s = prologKernel.createSession();
  const load = await s.load(src);
  check('session loads', load.ok, load.ok ? '' : `line ${load.line}: ${load.message}`);
  const result = await s.run();
  return { text: consoleOf(s.state()), panels: s.state(), result };
}

function consoleOf(panels: Panel[]): string {
  const c = panels.find((p) => p.kind === 'console');
  return c !== undefined && c.kind === 'console' ? c.text : '';
}

const MEMBER = `member(X, [X|_]).
member(X, [_|T]) :- member(X, T).
`;
const APPEND = `append([], Ys, Ys).
append([X|Xs], Ys, [X|Zs]) :- append(Xs, Ys, Zs).
`;

// ─── semantics ──────────────────────────────────────────────────────────────
console.log('semantics · unification, backtracking, findall');
{
  const r = await runSession(`${MEMBER}?- findall(X, member(X, [a, b, c]), Xs).`);
  eq('member order via findall', r.text, 'Yes.\nX = X\nXs = [a, b, c]\n');
}
{
  const r = await runSession(`${APPEND}?- append([1, 2], [3, 4], Zs).`);
  eq('append constructs', r.text, 'Yes.\nZs = [1, 2, 3, 4]\n');
}
{
  const r = await runSession(`${APPEND}?- append([b], [c], [a, b, c]).`);
  eq('append checks', r.text, 'No.\n');
}
{
  const r = await runSession('?- X is 3 + 4 * 2, Y is 17 // 5, Z is 17 mod 5.');
  eq('is with // and mod', r.text, 'Yes.\nX = 11\nY = 3\nZ = 2\n');
}
{
  const r = await runSession('?- X = 2 + 2.');
  eq('= does not evaluate', r.text, 'Yes.\nX = 2 + 2\n');
}
{
  const r = await runSession('?- 4 =:= 2 + 2.');
  eq('=:= evaluates', r.text, 'Yes.\n');
}
{
  const r = await runSession('?- 4 = 2 + 2.');
  eq('= on 4 and 2+2 fails', r.text, 'No.\n');
}
{
  const r = await runSession('?- _ = 1, _ = 2.');
  eq('_ is fresh at each occurrence', r.text, 'Yes.\n');
}
console.log('semantics: unification, order, arithmetic, _ all exact');

// ─── cut ────────────────────────────────────────────────────────────────────
console.log('cut · parent-goal pruning');
{
  const cut = await runSession(`max3(X, Y, X) :- X >= Y, !.
max3(_, Y, Y).
?- findall(M, max3(5, 3, M), WithCut).`);
  eq('with cut: one solution', cut.text, 'Yes.\nM = M\nWithCut = [5]\n');
  const nocut = await runSession(`maxu(X, Y, X) :- X >= Y.
maxu(_, Y, Y).
?- findall(M, maxu(5, 3, M), WithoutCut).`);
  eq('without cut: two solutions', nocut.text, 'Yes.\nM = M\nWithoutCut = [5, 3]\n');
}
console.log('cut: solution count changes exactly as taught');

console.log('errors · occurs check, undefined predicate, budget');
{
  const s = prologKernel.createSession();
  await s.load('goal(fine).\n?- X = f(X).');
  const r = await s.run();
  check('occurs check is a line-mapped error', !r.finished && r.error !== undefined && r.error.includes('occurs check') && r.error.includes('line 2'), r.error ?? '');
  const s2 = prologKernel.createSession();
  await s2.load('goal(X) :- nope(X).\n?- goal(1).');
  const r2 = await s2.run();
  check('undefined predicate is line-mapped', !r2.finished && r2.error !== undefined && r2.error.includes('undefined predicate nope/1') && r2.error.includes('line 1'), r2.error ?? '');
  const s3 = prologKernel.createSession();
  await s3.load('p :- p.\n?- p.');
  const t0 = Date.now();
  const r3 = await s3.run();
  check('left recursion dies on budget', !r3.finished && r3.error !== undefined && r3.error.includes('budget exceeded') && Date.now() - t0 < 10_000, r3.error ?? '');
}
console.log('errors: occurs check, undefined predicate, budget all clean');

// ─── session contract ───────────────────────────────────────────────────────
console.log('contract · panels, stepping, breakpoints, reset, continue');
{
  const s = prologKernel.createSession();
  await s.load(`${MEMBER}?- member(X, [a, b]).`);
  const r1 = await s.run();
  eq('run 1: first solution, exit yes', `${r1.finished}/${r1.exit}`, 'true/yes');
  eq('run 1 console', consoleOf(s.state()), 'Yes.\nX = a\n');
  const r2 = await s.run();
  eq('run 2: more solutions, exit yes', `${r2.finished}/${r2.exit}`, 'true/yes');
  eq('run 2 console', consoleOf(s.state()), 'Yes.\nX = a\nYes.\nX = b\n');
  const r3 = await s.run();
  eq('run 3: exhausted, exit no', `${r3.finished}/${r3.exit}`, 'true/no');
  eq('run 3 console', consoleOf(s.state()), 'Yes.\nX = a\nYes.\nX = b\nNo.\n');
  s.reset();
  eq('reset clears the console', consoleOf(s.state()), '');
  const r4 = await s.run();
  eq('after reset, fresh first solution', `${r4.exit}/${consoleOf(s.state())}`, 'yes/Yes.\nX = a\n');
  s.dispose();
}
{
  // every step moves a panel
  const s = prologKernel.createSession();
  await s.load('p(X) :- q(X), X > 1.\nq(2).\nq(3).\n?- p(V).');
  let prev = '';
  let steps = 0;
  let transitions = 0;
  for (let i = 0; i < 20; i++) {
    const st = await s.step();
    if (!st.ran) break;
    steps++;
    const cur = JSON.stringify(s.state().slice(0, 3));
    if (cur !== prev) transitions++;
    prev = cur;
    if (st.result?.exit === 'yes' || st.result?.error !== undefined) break;
  }
  eq('one panel transition per step', transitions, steps);
  check('the example takes several steps', steps >= 5, `steps=${steps}`);
  s.dispose();
}
{
  const s = prologKernel.createSession();
  await s.load('p(X) :- q(X), X > 1.\n\nq(2).\nq(3).\n?- p(V).');
  const r = await s.run([1]);
  eq('breakpoint pauses on the rule line', r.pausedAt, 1);
  const goals = s.state().find((p) => p.id === 'goals');
  check('goal stack intact at pause', goals !== undefined && goals.kind === 'listing' && goals.rows[0]!.text.includes('p(V)'), '');
  const r2 = await s.run();
  eq('resume reaches the first solution', `${r2.finished}/${r2.exit}`, 'true/yes');
  s.dispose();
}
{
  const r = await runSession(`a(1).\nb(2).\n?- a(X).\n?- b(Y).`);
  eq('multiple queries answered in one run', r.text, 'Yes.\nX = 1\nYes.\nY = 2\n');
}
console.log('contract: run/continue, steps, breakpoints, reset all exact');

// ─── lesson/lesson.org: every block runs and matches its #+RESULTS ────────
console.log('session · lesson round-trip');
{
  const blocks: string[] = [];
  const expected: string[] = [];
  const org = await Bun.file(`${import.meta.dir}/../lesson/lesson.org`).text();
  const lines = org.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('#+BEGIN_SRC prolog')) {
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
    const s = prologKernel.createSession();
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
