// smoke.ts — bun smoke test for @didact/kernel-wasm.
// Run: `bun packages/kernel-wasm/test/smoke.ts`.
// Covers: i32 semantics (wrapping, division, little-endian memory),
// structured control flow, line-mapped errors at compile time and trap
// time, the Session contract (panels, breakpoints, step, reset), and a
// round-trip of every lesson block against its #+RESULTS.

import { wasmKernel } from '../src/index';
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

/** Session-level helper: load + run, return [console text, result]. */
async function runSession(src: string, breakpoints?: number[]): Promise<{ text: string; result: { finished: boolean; steps: number; error?: string; pausedAt?: number } }> {
  const s = wasmKernel.createSession();
  const load = await s.load(src);
  if (!load.ok) throw new Error(`load failed: line ${load.line}: ${load.message}`);
  const result = await s.run(breakpoints);
  return { text: consoleOf(s.state()), result };
}
function consoleOf(panels: Panel[]): string {
  const p = panels.find((q): q is Extract<Panel, { kind: 'console' }> => q.kind === 'console');
  return p?.text ?? '';
}
const shell = (body: string): string => `(module
  (import "didact" "print" (func $print (param i32)))
  (func (export "main")
    ${body}))`;

// ─── semantics ──────────────────────────────────────────────────────────────
console.log('semantics · i32 core');
{
  const wrap = await runSession(shell('(call $print (i32.mul (i32.const 65536) (i32.const 65536)))'));
  eq('32-bit multiply wraps to 0', wrap.text, '0\n');

  const div = await runSession(shell(`(call $print (i32.div_s (i32.const -7) (i32.const 2)))
    (call $print (i32.div_u (i32.const -1) (i32.const 2)))`));
  eq('div_s truncates toward zero, div_u reads unsigned', div.text, '-3\n2147483647\n');

  const loop = await runSession(`(module
  (import "didact" "print" (func $print (param i32)))
  (func (export "main") (local $i i32) (local $sum i32)
    (block $done
      (loop $again
        (br_if $done (i32.gt_s (local.get $i) (i32.const 5)))
        (local.set $sum (i32.add (local.get $sum) (local.get $i)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $again)))
    (call $print (local.get $sum))))`);
  check('br to a loop repeats, br to a block exits: sum 1..5', loop.result.finished && loop.text === '15\n', loop.result.error ?? loop.text);

  const mem = await runSession(`(module
  (import "didact" "print" (func $print (param i32)))
  (import "didact" "print_char" (func $print_char (param i32)))
  (memory 1)
  (func (export "main")
    (i32.store8 (i32.const 0) (i32.const 0x2A))
    (call $print_char (i32.load8_u (i32.const 0)))
    (call $print (i32.load8_u (i32.const 0)))))`);
  eq('store8/load8_u round-trips one byte', mem.text, '*42\n');
  console.log('semantics: wrapping, division, labels, byte memory all exact');
}

// ─── line-mapped errors ────────────────────────────────────────────────────
console.log('errors · line mapping');
{
  const s = wasmKernel.createSession();
  const unclosed = await s.load('(module\n(func (export "main") (drop (i32.const 1))');
  check('unclosed ( reports its opening line', !unclosed.ok && unclosed.line === 2, JSON.stringify(unclosed));

  const compile = await s.load(shell('(call $print (i32.add (i32.const 1)))'));
  check('compile-time arity error names the operator line', !compile.ok && compile.line === 4 && compile.message === 'i32.add takes exactly 2 folded operands, got 1', JSON.stringify(compile));

  const trap = await runSession(shell('(call $print (i32.div_s (i32.const 1) (i32.const 0)))'));
  eq('divide-by-zero trap carries the line', trap.result.error, 'integer divide by zero (line 4)');

  const oob = await runSession(`(module (memory 1)
  (func (export "main") (i32.store8 (i32.const 65536) (i32.const 1))))`);
  eq('out-of-bounds store carries the line', oob.result.error, 'out of bounds memory access: address 65536 + 1 bytes is past the end (65536 bytes) (line 2)');
  console.log('errors: reader, compiler and traps all line-mapped');
}

// ─── session contract ──────────────────────────────────────────────────────
console.log('contract · session, panels, breakpoints');
{
  const s = wasmKernel.createSession();
  const load = await s.load(shell('(call $print (i32.add (i32.const 20) (i32.const 22)))'));
  check('load summary counts instructions', load.ok && load.summary === 'loaded · 5 instructions', JSON.stringify(load));

  const first = await s.step();
  check('step runs exactly one instruction', first.ran && first.result!.steps === 1, JSON.stringify(first));
  const stack = s.state().find((p): p is Extract<Panel, { kind: 'listing' }> => p.kind === 'listing' && p.id === 'stack')!;
  eq('operand stack shows the pushed value', stack.rows.map((r) => r.text).join(','), '20');

  const done = await s.run();
  check('run finishes after stepping', done.finished && done.exit === 'main returned', done.error ?? '');
  eq('console has the print output', consoleOf(s.state()), '42\n');

  const panels = s.state();
  check('panel order: instructions, stack, locals, globals, callstack, memory, console',
    panels.length === 7
    && panels[0]!.kind === 'listing' && panels[1]!.kind === 'listing'
    && panels[2]!.kind === 'fields' && panels[3]!.kind === 'fields'
    && panels[4]!.kind === 'listing' && panels[5]!.kind === 'hexdump'
    && panels[6]!.kind === 'console',
    panels.map((p) => `${p.kind}:${p.id ?? ''}`).join(','));
  const listing = panels[0] as Extract<Panel, { kind: 'listing' }>;
  check('listing rows carry real binary opcodes', listing.rows.every((r) => /^0x[0-9a-f]{2}$/.test(r.bytes)), listing.rows.map((r) => r.bytes).join(','));

  s.reset();
  const rerun = await s.run();
  eq('reset replays the same run', rerun.steps, done.steps);

  const sb = wasmKernel.createSession();
  await sb.load(`(module
  (import "didact" "print" (func $print (param i32)))
  (func (export "main")
    (call $print (i32.const 1))
    (call $print (i32.const 2))))`);
  const stop = await sb.run([5]);
  check('breakpoint pauses before the line runs', !stop.finished && stop.pausedAt === 5, JSON.stringify(stop));
  eq('paused before the print executes', consoleOf(sb.state()), '1\n');
  check('resume completes', (await sb.run()).finished);
  s.dispose();
  console.log('contract: load/step/run/reset/state + breakpoints honored');
}

// ─── lesson/lesson.org: every block runs and matches its #+RESULTS ────────
console.log('session · lesson round-trip');
{
  const blocks: string[] = [];
  const expected: string[] = [];
  const org = await Bun.file(`${import.meta.dir}/../lesson/lesson.org`).text();
  const lines = org.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('#+BEGIN_SRC wasm')) {
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
  eq('lesson has 4 executable blocks', blocks.length, 4);
  eq('lesson has 4 results slots', expected.length, 4);
  for (let k = 0; k < blocks.length; k++) {
    const s = wasmKernel.createSession();
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
