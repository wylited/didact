// smoke.ts — bun smoke test for @didact/kernel-matlab.
// Run from the package root: `bun test/smoke.ts`.
// Covers: subset refusals, column-major semantics, the Session contract
// (step, breakpoints/pausedAt, panels, reset, changed flags, budget), and
// a round-trip of every lesson block against its #+RESULTS.

import { matlabKernel } from '../src/kernel';
import type { Panel, RunResult, Session } from '../src/types';

type FieldsPanel = Extract<Panel, { kind: 'fields' }>;
type ListingPanel = Extract<Panel, { kind: 'listing' }>;

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
  check(name, got === want, `got ${String(got)} want ${String(want)}`);
}

function fieldsOf(panels: Panel[]): FieldsPanel['fields'] {
  const p = panels.find((x) => x.id === 'workspace');
  return p !== undefined && p.kind === 'fields' ? p.fields : [];
}

function rowsOf(panels: Panel[], id: string): ListingPanel['rows'] {
  const p = panels.find((x) => x.id === id);
  return p !== undefined && p.kind === 'listing' ? p.rows : [];
}

function consoleOf(panels: Panel[]): string {
  const p = panels.find((x) => x.id === 'console');
  return p !== undefined && p.kind === 'console' ? p.text : '';
}

async function load(src: string): Promise<Session> {
  const s = matlabKernel.createSession();
  const r = await s.load(src);
  if (!r.ok) throw new Error(`load failed: line ${r.line}: ${r.message}`);
  return s;
}

async function run(src: string, bps?: number[]): Promise<{ r: RunResult; s: Session }> {
  const s = await load(src);
  return { r: await s.run(bps), s };
}

// ─── the interpreter: column-major, for-over-columns, workspaces ──────────
console.log('interpreter · the four lessons');
{
  const { r, s } = await run(`A = [1 2; 3 4];
disp(A(:)')
disp(A(2))
disp(A(3))
disp(A')`);
  eq('block finishes', r.error ?? 'ok', 'ok');
  eq('column-major order + transpose', consoleOf(s.state()).trimEnd(),
    '1  3  2  4\n3\n2\n1  3\n2  4');

  const v = await run(`disp(1:0.5:3)`);
  eq('0.5 prints as 0.5', consoleOf(v.s.state()).trimEnd(), '  1  1.5    2  2.5    3');

  const m = await run(`A = [1 2 3; 4 5 6];
for c = A
  fprintf('col: %d %d\\n', c(1), c(2))
end
disp(sum(A))
disp(sum(A, 2))`);
  eq('for walks columns; sums know their dim', consoleOf(m.s.state()).trimEnd(),
    'col: 1 4\ncol: 2 5\ncol: 3 6\n5  7  9\n 6\n15');

  const f = await run(`function [q, r] = divmod(a, b)
  q = floor(a / b);
  r = a - b * q;
end
[q, r] = divmod(17, 5);
fprintf('%d %d\\n', q, r);`);
  eq('two outputs', consoleOf(f.s.state()).trimEnd(), '3 2');
}

// ─── session: step, breakpoints, panels, reset, budget ─────────────────────
console.log('session · step, breakpoints, panels');
{
  const s = await load(`M = zeros(2, 3);
M(2, 2) = 42;
M(1, :) = [7 8 9];`);
  let st = await s.step();
  check('step 1 runs', st.ran === true);
  st = await s.step();
  const touched = rowsOf(s.state(), 'matrix').filter((r) => r.current).map((r) => r.text);
  eq('one element marked after the indexed write', touched.join('|'), 'M(2,2) = 42');
  const allRows = rowsOf(s.state(), 'matrix').map((r) => r.text);
  eq('element rows in column-major order', allRows.join('|'),
    'M(1,1) = 0|M(2,1) = 0|M(1,2) = 0|M(2,2) = 42|M(1,3) = 0|M(2,3) = 0');
  const hexRow = rowsOf(s.state(), 'matrix').find((r) => r.text === 'M(2,2) = 42');
  eq('42.0 as IEEE 754 hex', hexRow?.bytes ?? '', '4045000000000000');

  const bp = await load(`t = 0;
for k = 1:3
  t = t + k;
end
disp(t)`);
  let r = await bp.run([3]);
  eq('pauses before line 3', r.pausedAt ?? 0, 3);
  r = await bp.run([3]);
  eq('resumed run executes the paused statement first', r.pausedAt ?? 0, 3);
  r = await bp.run([3]);
  r = await bp.run([3]);
  eq('last resume finishes the loop', r.exit ?? '', 'exit(0)');
  eq('loop total after the pauses', consoleOf(bp.state()).trimEnd(), '6');

  const ws = await load(`function t = twice(x)
  local = x * 2;
  t = local;
end
y = [1 2];
w = twice(y);`);
  await ws.run([2]);
  eq('base workspace untouched by the function', fieldsOf(ws.state()).map((f) => f.key).join(','), 'y');
  eq('function frame names its own workspace',
    rowsOf(ws.state(), 'stack').map((r) => r.text).join('|'),
    'script · base workspace|twice · own workspace: x');
  await ws.run();
  eq('caller sees the returned matrix',
    fieldsOf(ws.state()).map((f) => f.key).join(','), 'y,w');

  const crash = await load(`x = [1 2] + [1 2 3];`);
  const c1 = await crash.run();
  eq('dimension error is line-mapped', c1.error ?? '', "line 1: matrix dimensions must agree for '+' (1x2 vs 1x3); a 1x1 broadcasts");
  const c2 = await crash.run();
  eq('crash is sticky until reset', c2.error ?? '', c1.error ?? '');

  const budget = await load(`n = 0;
while 1
  n = n + 1;
end`);
  const b = await budget.run();
  eq('budget error names its line', b.error ?? '',
    'line 2: run budget exceeded (1,000,000 evaluation units) — the program never finished');

  const reset = await load(`x = 2;
disp(x * 3)`);
  const first = await reset.run();
  reset.reset();
  const second = await reset.run();
  eq('reset replays the same program', JSON.stringify(second), JSON.stringify(first));
}

// ─── refusals are line-mapped and total ────────────────────────────────────
console.log('session · refusals');
{
  const cases: [string, string, number][] = [
    ['c = {1 2};', 'not in the teaching subset: cell arrays ({}) — matrices are the only data structure', 1],
    ['f = @(x) x;', 'not in the teaching subset: anonymous functions (@)', 1],
    ['A = [1 2];\nx = A.b;', 'not in the teaching subset: structs (a.b) — matrices are the only data structure', 2],
    ['global g;', "not in the teaching subset: 'global' — functions own their workspace; scripts share the base workspace", 1],
  ];
  for (const [src, message, line] of cases) {
    const loadR = await matlabKernel.createSession().load(src);
    check(`refuses: ${message.slice(34, 60)}…`,
      loadR.ok === false && loadR.line === line && loadR.message === message,
      JSON.stringify(loadR));
  }
  // rand and strings-as-data parse fine — the refusal fires at run time.
  const runCases: [string, string, number][] = [
    ['x = rand(2);', "line 1: not in the teaching subset: 'rand' — the interpreter is deterministic on purpose"],
    ["s = 'no';", "line 1: not in the teaching subset: strings are display text only — pass them to disp(), fprintf() or error()"],
  ];
  for (const [src, message] of runCases) {
    const { r } = await run(src);
    eq(`runtime refuses: ${message.slice(7, 40)}…`, r.error ?? '', message);
  }
}

// ─── lesson/lesson.org: every block runs and matches its #+RESULTS: ────────
console.log('session · lesson round-trip');
{
  const blocks: string[] = [];
  const expected: string[] = [];
  const org = await Bun.file(`${import.meta.dir}/../lesson/lesson.org`).text();
  const lines = org.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('#+BEGIN_SRC matlab')) {
      const body: string[] = [];
      for (let j = i + 1; !lines[j]!.startsWith('#+END_SRC'); j++) body.push(lines[j]!);
      blocks.push(body.join('\n'));
    }
    if (lines[i]!.startsWith('#+RESULTS:')) {
      // Same rule as the site's org parser: every line starting with
      // ':' is canned results text (': x' → 'x', bare ':' → '').
      const body: string[] = [];
      for (let j = i + 1; j < lines.length && /^\s*:/.test(lines[j]!); j++) {
        body.push(lines[j]!.replace(/^\s*:\s?/, ''));
      }
      expected.push(body.join('\n'));
    }
  }
  eq('lesson has 7 executable blocks', blocks.length, 7);
  eq('lesson has 7 results slots', expected.length, 7);
  for (let k = 0; k < blocks.length; k++) {
    const s = matlabKernel.createSession();
    const loadR = await s.load(blocks[k]!);
    check(`lesson block ${k + 1} loads`, loadR.ok,
      loadR.ok ? '' : `line ${loadR.line}: ${loadR.message}`);
    const r = await s.run();
    check(`lesson block ${k + 1} finishes`, r.finished && r.error === undefined, r.error ?? '');
    eq(`lesson block ${k + 1} output = ${JSON.stringify(expected[k])}`,
      consoleOf(s.state()).replace(/\n+$/, ''), expected[k]!);
    s.dispose();
  }
}

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`all ${pass} checks passed`);
