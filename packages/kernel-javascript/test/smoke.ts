// smoke.ts — bun smoke test for @didact/kernel-javascript.
// Run from the package root: `bun test/smoke.ts`.
// Covers: parser subset rejection, coercion/closure/hoisting semantics,
// the Session contract (step, breakpoints/pausedAt, panels, reset,
// changed flags, budget), and a round-trip of every lesson block against
// its #+RESULTS.

import { jsKernel } from '../src/kernel';
import type { Panel, RunResult, Session } from '../src/types';

type FieldsPanel = Extract<Panel, { kind: 'fields' }>;
type ListingPanel = Extract<Panel, { kind: 'listing' }>;
type ConsolePanel = Extract<Panel, { kind: 'console' }>;

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${String(got)} want ${String(want)}`);
}
function fieldsOf(panels: Panel[]): FieldsPanel['fields'] {
  const p = panels.find((q): q is FieldsPanel => q.kind === 'fields' && q.id === 'scopes');
  if (p === undefined) throw new Error('missing scopes panel');
  return p.fields;
}
function rowsOf(panels: Panel[], id: string): ListingPanel['rows'] {
  const p = panels.find((q): q is ListingPanel => q.kind === 'listing' && q.id === id);
  if (p === undefined) throw new Error(`missing ${id} panel`);
  return p.rows;
}
function consoleOf(panels: Panel[]): string {
  const p = panels.find((q): q is ConsolePanel => q.kind === 'console');
  if (p === undefined) throw new Error('missing console panel');
  return p.text;
}
async function load(src: string): Promise<Session> {
  const s = jsKernel.createSession();
  const r = await s.load(src);
  if (!r.ok) throw new Error(`fixture failed to load: line ${r.line}: ${r.message}`);
  return s;
}
async function run(src: string, bps?: number[]): Promise<{ r: RunResult; s: Session }> {
  const s = await load(src);
  const r = await s.run(bps);
  return { r, s };
}

// ─── coercion table, closures, hoisting, event loop ────────────────────────
console.log('interpreter · the four lessons');
{
  const { r, s } = await run(`console.log([] == false, '' == 0, '1' == 1, null == undefined, NaN == NaN, [] === false);`);
  eq('coercion table', consoleOf(s.state()), 'true true true true false false\n');
  eq('coercion run finishes', r.finished, true);
  s.dispose();

  const c = await load(`var fns = [];
for (var i = 0; i < 3; i = i + 1) { fns.push(function () { return i; }); }
var gns = [];
for (let j = 0; j < 3; j = j + 1) { gns.push(function () { return j; }); }
console.log(fns[0](), fns[2](), gns[0](), gns[2]());`);
  await c.run();
  eq('var vs let capture', consoleOf(c.state()), '3 3 0 2\n');
  c.dispose();

  const h = await load(`console.log(a, typeof b);
var a = 1;
function b() { return 2; }`);
  await h.run();
  eq('hoisting', consoleOf(h.state()), 'undefined function\n');
  h.dispose();

  const e = await run(`console.log('sync');
setTimeout(function () { console.log('macro'); }, 0);
Promise.resolve().then(function () { console.log('micro'); });
console.log('still');`);
  eq('event loop ordering', consoleOf(e.s.state()), 'sync\nstill\nmicro\nmacro\n');
  e.s.dispose();
}

// ─── session: step, breakpoints, panels, reset, budget ─────────────────────
console.log('session · step, breakpoints, panels');
{
  const s = await load(`var x = 1;
x = x + 2;
console.log(x);`);
  const st1 = await s.step();
  check('step 1 ran', st1.ran === true);
  eq('step 1 pausedAt (next line)', st1.result?.pausedAt, 2);
  const st2 = await s.step();
  eq('step 2 pausedAt', st2.result?.pausedAt, 3);
  let fields = fieldsOf(s.state());
  eq('x after two steps', fields.find((f) => f.key === 'global.x')?.value, '3');
  check('x flagged changed by step 2', fields.find((f) => f.key === 'global.x')?.changed === true);
  await s.step();
  eq('step 3 logs', consoleOf(s.state()), '3\n');
  const st4 = await s.step();
  check('step 4 reports done', st4.ran === false && st4.result?.finished === true && st4.result?.exit === 'exit(0)');
  s.reset();
  eq('reset clears console', consoleOf(s.state()), '');
  const rr = await s.run();
  check('run after reset finishes', rr.finished === true && rr.exit === 'exit(0)');
  eq('output again 3', consoleOf(s.state()), '3\n');
  s.dispose();

  // breakpoint: pause before the line, execute with step, re-trip later
  const b = await load(`var total = 0;
var k = 0;
while (k < 3) {
  total = total + k;
  k = k + 1;
}
console.log(total);`);
  const bp = await b.run([4]);
  eq('paused before line 4', bp.pausedAt, 4);
  eq('total untouched at pause', fieldsOf(b.state()).find((f) => f.key === 'global.total')?.value, '0');
  await b.step();
  eq('step executes the paused line', fieldsOf(b.state()).find((f) => f.key === 'global.total')?.value, '0'); // 0 + 0
  const bp2 = await b.run([4]);
  eq('breakpoint re-trips next iteration', bp2.pausedAt, 4);
  const fin = await b.run();
  check('finishes after clearing breakpoints', fin.finished === true);
  eq('loop total', consoleOf(b.state()), '3\n');
  b.dispose();

  // event-loop panel: queues visible, micro head is the current phase
  const q = await load(`setTimeout(function onTimeout() { console.log('macro'); }, 0);
Promise.resolve().then(function micro1() { console.log('micro'); });
console.log('queued');`);
  const qp = await q.run([3]);
  eq('queued program paused at log line', qp.pausedAt, 3);
  const rows = rowsOf(q.state(), 'loop');
  eq('two queued tasks', rows.length, 2);
  eq('microtask first', rows[0]!.text, 'microtask · micro1');
  eq('macrotask second', rows[1]!.text, 'macrotask · onTimeout');
  check('micro head marked current', rows[0]!.current === true && rows[1]!.current !== true);
  await q.run();
  eq('queues drain in order', consoleOf(q.state()), 'queued\nmicro\nmacro\n');
  q.dispose();

  // budget + load errors
  const inf = await load('while (true) { }');
  const ir = await inf.run();
  check('budget stops the infinite loop', ir.finished === false && (ir.error ?? '').includes('budget'), ir.error ?? '');
  inf.dispose();

  const bad = await jsKernel.createSession().load('var x = 1;\nclass Foo {}');
  check(
    'class rejected at load, line-mapped',
    !bad.ok && bad.line === 2 && bad.message.includes("'class'") && bad.message.includes('is not in the teaching subset'),
    bad.ok ? 'unexpectedly ok' : `line ${bad.line}: ${bad.message}`,
  );
}

// ─── lesson/lesson.org: every block runs and matches its #+RESULTS: ────────
console.log('session · lesson round-trip');
{
  const blocks: string[] = [];
  const expected: string[] = [];
  const org = await Bun.file(`${import.meta.dir}/../lesson/lesson.org`).text();
  const lines = org.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('#+BEGIN_SRC javascript')) {
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
  // Block 3 (hoisting) deliberately ends in a TDZ error; its #+RESULTS are
  // everything printed before the throw.
  const expectError = [false, false, true, false, false];
  for (let k = 0; k < blocks.length; k++) {
    const s = jsKernel.createSession();
    const loadR = await s.load(blocks[k]!);
    check(`lesson block ${k + 1} loads`, loadR.ok, loadR.ok ? '' : `line ${loadR.line}: ${loadR.message}`);
    const r = await s.run();
    if (expectError[k]) {
      check(`lesson block ${k + 1} stops with the TDZ error`, (r.error ?? '').includes('before initialization'), r.error ?? '');
    } else {
      check(`lesson block ${k + 1} finishes`, r.finished && r.error === undefined, r.error ?? '');
    }
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
