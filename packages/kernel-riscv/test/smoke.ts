// smoke.ts — bun smoke test for @literate/kernel-riscv.
// Run from the package root: `bun test/smoke.ts`.
// Covers: assembler encodings + line-mapped errors, interpreter semantics
// (sign extension, M extension, ecall I/O), and the Session contract
// (panels, breakpoints/pausedAt, step-from-pause, reset, changed flags).

import { assemble, TEXT_BASE } from '../src/asm';
import { Cpu } from '../src/cpu';
import { riscvKernel } from '../src/kernel';
import { assemble, TEXT_BASE, type Assembled } from '../src/asm';

type FieldsPanel = Extract<Panel, { kind: 'fields' }>;
type ListingPanel = Extract<Panel, { kind: 'listing' }>;
type HexdumpPanel = Extract<Panel, { kind: 'hexdump' }>;
type ConsolePanel = Extract<Panel, { kind: 'console' }>;

let pass = 0;
const failures: string[] = [];

/** Assert `cond`; tally and log pass/fail with an optional detail. */
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

/** Recombine 4 little-endian bytes into the encoded 32-bit word. */
function word(bytes: number[]): number {
  return (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
}
/** assemble() or throw (fixture programs are known-good). */
function prog(src: string): Assembled {
  const r = assemble(src);
  if (!r.ok) throw new Error(`fixture failed to assemble: line ${r.error.line}: ${r.error.message}`);
  return r.program;
}

/** Drive a raw Cpu until it halts, faults, or burns `budget` steps. */
function runToHalt(cpu: Cpu, budget = 1_000_000): void {
  while (cpu.halted === null && cpu.error === null && cpu.steps < budget) cpu.step();
}
/** Typed panel accessors (Panel is a discriminated union). */
function fieldsOf(panels: Panel[]): FieldsPanel['fields'] {
  const p = panels.find((q): q is FieldsPanel => q.kind === 'fields');
  if (p === undefined) throw new Error('missing fields panel');
  return p.fields;
}
function listingOf(panels: Panel[]): ListingPanel['rows'] {
  const p = panels.find((q): q is ListingPanel => q.kind === 'listing');
  if (p === undefined) throw new Error('missing listing panel');
  return p.rows;
}
function consoleOf(panels: Panel[]): string {
  const p = panels.find((q): q is ConsolePanel => q.kind === 'console');
  if (p === undefined) throw new Error('missing console panel');
  return p.text;
}

// ─── assembler: encodings (bit-level derivations from the asm.ts header) ───
console.log('assembler · encodings');
{
  const p = prog(`
        .text
        addi x1, x2, 4
        lw   x1, 8(x2)
        sw   x1, 8(x2)
        beq  x1, x2, over
        jal  x1, far
        nop
        nop
over:   ret
far:    ret
        ecall
        add  t0, t1, t2
        mul  t0, t1, t2
`);
  const got = p.insns.map((i) => word(i.bytes));
  eq('addi x1,x2,4   = 0x00410093', got[0], 0x00410093);
  eq('lw x1,8(x2)    = 0x00812083', got[1], 0x00812083);
  eq('sw x1,8(x2)    = 0x00112423', got[2], 0x00112423);
  eq('beq x1,x2,+16  = 0x00208863', got[3], 0x00208863);
  eq('jal x1,+16     = 0x010000EF', got[4], 0x010000ef);
  eq('ret (over)      = 0x00008067', got[7], 0x00008067);
  eq('ecall          = 0x00000073', got[9], 0x00000073);
  eq('add t0,t1,t2   = 0x007302B3', got[10], 0x007302b3);
  eq('mul t0,t1,t2   = 0x027302B3', got[11], 0x027302b3);
  eq('entry is TEXT_BASE', p.entry, TEXT_BASE);
  eq('listing text uses ABI names', p.insns[10]!.text, 'add t0, t1, t2');
}

// ─── assembler: forward label + line map ───
console.log('assembler · forward label');
{
  const p = prog('        .text\n        j       done\n        nop\ndone:\n        ret');
  eq('j done (forward, +8) = 0x0080006F', word(p.insns[0]!.bytes), 0x0080006f);
  eq('j expands to `jal zero, done`', p.insns[0]!.text, 'jal zero, done');
  eq('source line of nop is 3', p.insns[1]!.sourceLine, 3);
  eq('source line of ret is 5', p.insns[2]!.sourceLine, 5);
  eq('label-only line carries no row labels', p.insns[2]!.labels.join(','), '');
}

// ─── assembler: line-mapped errors ───
console.log('assembler · errors');
{
  const cases: [string, number, string][] = [
    ['        .text\n        addd t0, t0, t1', 2, 'unknown mnemonic'],
    ['        .text\n        j     nowhere', 2, "undefined label 'nowhere'"],
    ['        .text\n        add t0, t1', 2, 'expects 3 operands'],
    ['        .text\n        li a0, 9999999999', 2, 'does not fit in 32 bits'],
    ['        .text\n        lw a0, msg\n        .data\nmsg:\n        .asciz "x"', 2, "unknown register 'msg'"],
  ];
  for (const [src, line, needle] of cases) {
    const r = assemble(src);
    check(
      `error line ${line} (${needle})`,
      !r.ok && r.error.line === line && r.error.message.includes(needle),
      !r.ok ? `line ${r.error.line}: ${r.error.message}` : 'unexpectedly ok',
    );
  }
}

// ─── interpreter: hello, ecall ───
console.log('interpreter · hello');
{
  const cpu = new Cpu(prog(`
        .text
hello:
        la      a0, msg
        li      a7, 4
        ecall
        li      a0, 10
        li      a7, 11
        ecall
        li      a0, 0
        li      a7, 10
        ecall

        .data
msg:
        .asciz "Hello, RISC-V!"
`));
  runToHalt(cpu);
  eq('console output', cpu.outputText, 'Hello, RISC-V!\n');
  eq('halted via exit', cpu.halted, 'exit');
  eq('exit code captured from a0', cpu.exitCode, 0);
  eq('a7 holds service 10', cpu.regs[17], 10);
  eq('10 instructions executed', cpu.steps, 10);
}

// ─── interpreter: sum 1..10 ───
console.log('interpreter · sum 1..10');
{
  const cpu = new Cpu(prog(`
        .text
        li      t0, 1
        li      t1, 10
        li      t2, 0
loop:
        add     t2, t2, t0
        addi    t0, t0, 1
        blt     t1, t0, done
        j       loop
done:
        mv      a0, t2
        li      a7, 1
        ecall
        li      a0, 10
        li      a7, 11
        ecall
        li      a0, 0
        li      a7, 10
        ecall
`));
  runToHalt(cpu);
  eq('t2 (x7) = 55', cpu.regs[7], 55);
  eq('prints 55 + newline', cpu.outputText, '55\n');
  check(
    'branch context recorded (blt taken)',
    cpu.lastBranch?.op === 'blt' && cpu.lastBranch.taken,
  );
}

// ─── interpreter: sign extension on lb/lh/lbu/lhu, sb/sh stores ───
console.log('interpreter · loads/stores');
{
  const cpu = new Cpu(prog(`
        .text
        li      t0, -1
        la      t1, buf
        sw      t0, 0(t1)
        lb      a0, 0(t1)
        lbu     t2, 0(t1)
        li      t3, 0x8000
        sh      t3, 2(t1)
        lh      t4, 2(t1)
        lhu     t5, 2(t1)
        sb      t0, 4(t1)
        li      a7, 10
        ecall

        .data
buf:
        .word 0
        .word 0
`));
  runToHalt(cpu);
  eq('lb sign-extends 0xFF -> -1', cpu.regs[10], -1);
  eq('lbu zero-extends 0xFF -> 255', cpu.regs[7], 255);
  eq('lh sign-extends 0x8000 -> -32768', cpu.regs[29], -32768);
  eq('lhu zero-extends 0x8000 -> 32768', cpu.regs[30], 32768);
  eq('sb wrote 0xFF at buf+4', cpu.readByte(cpu.prog.dataStart + 4), 0xff);
}

// ─── interpreter: M extension incl. div-by-zero semantics ───
console.log('interpreter · M extension');
{
  const cpu = new Cpu(prog(`
        .text
        li      t0, 7
        li      t1, 0
        div     t2, t0, t1
        rem     t3, t0, t1
        li      t4, -2147483648
        li      t5, -1
        div     t6, t4, t5
        rem     s0, t4, t5
        divu    s1, t0, t1
        remu    s2, t0, t1
        mul     a0, t0, t5
        li      a1, -1
        li      a3, 2
        mulh    a2, a1, a1
        mulhu   a4, a1, a3
        li      a7, 10
        ecall
`));
  runToHalt(cpu);
  eq('div by 0 -> -1', cpu.regs[7], -1);
  eq('rem by 0 -> dividend', cpu.regs[28], 7);
  eq('MIN_INT / -1 -> MIN_INT', cpu.regs[31], -2147483648);
  eq('MIN_INT % -1 -> 0', cpu.regs[8], 0);
  eq('divu by 0 -> 0xFFFFFFFF (as int32 -1)', cpu.regs[9], -1);
  eq('remu by 0 -> dividend', cpu.regs[18], 7);
  eq('mul 7 * -1 = -7', cpu.regs[10], -7);
  eq('mulh(-1,-1) high = 0', cpu.regs[12], 0);
  eq('mulhu(0xFFFFFFFF,2) high = 1', cpu.regs[14], 1);
}

// ─── Session contract: load/run/panels ───
console.log('session · contract');
const HELLO = `        .text
hello:
        la      a0, msg        # a0 -> address of the string
        li      a7, 4          # service 4: print string
        ecall
        li      a0, 10         # '\\n'
        li      a7, 11         # service 11: print char
        ecall
        li      a0, 0          # exit code 0
        li      a7, 10         # service 10: exit
        ecall

        .data
msg:
        .asciz "Hello, RISC-V!"
`;
const SUM = `        .text
        li      t0, 1          # i = 1
        li      t1, 10         # limit = 10
        li      t2, 0          # sum = 0
loop:
        add     t2, t2, t0     # sum += i
        addi    t0, t0, 1      # i++
        blt     t1, t0, done   # if 10 < i, leave the loop
        j       loop
done:
        mv      a0, t2
        li      a7, 1
        ecall
        li      a0, 10
        li      a7, 11
        ecall
        li      a0, 0
        li      a7, 10
        ecall
`;
const sumAddLine = SUM.split('\n').findIndex((l) => l.includes('add     t2')) + 1;

{
  eq('kernel id', riscvKernel.id, 'riscv');
  eq('kernel label', riscvKernel.label, 'RV32IM · interpreter');
  check('features.breakpoints', riscvKernel.features?.breakpoints === true);
  const session = riscvKernel.createSession();
  check('state() before load is []', session.state().length === 0);

  const load = await session.load(HELLO);
  check('load ok', load.ok, load.ok ? '' : `line ${load.line}: ${load.message}`);
  if (load.ok) check('summary mentions instructions', /loaded · \d+ instructions/.test(load.summary), load.summary);

  const run: RunResult = await session.run();
  eq('run finished', run.finished, true);
  eq('exit(0)', run.exit, 'exit(0)');

  const panels = session.state();
  eq('panel kinds (no branch in hello)', panels.map((p) => p.kind).join(','), 'fields,listing,hexdump,console');
  const fields = fieldsOf(panels);
  eq('registers panel has 32 regs + pc', fields.length, 33);
  check('key style `x8 (s0)`', fields.some((f) => f.key === 'x8 (s0)'));
  check('key style `x0 (zero)`', fields.some((f) => f.key === 'x0 (zero)'));
  check('pc field present', fields.some((f) => f.key === 'pc'));

  const rows = listingOf(panels);
  eq('listing bytes = encoded word hex (lui a0, 0x1)', rows[0]!.bytes, '00001537');
  eq('listing line map is 1-based (la on source line 3)', rows[0]!.line, 3);
  eq('li expansion rows share the source line', rows[1]!.line, 3);
  check('listing tip = trailing comment', rows[2]!.tip === 'service 4: print string', rows[2]!.tip ?? '(none)');

  const hexP = panels.find((p): p is HexdumpPanel => p.kind === 'hexdump');
  check(
    '.data hexdump shows the string',
    hexP !== undefined && hexP.rows.length > 0 && hexP.rows[0]!.ascii.startsWith('Hello, RISC-V'),
    hexP?.rows[0]?.ascii ?? '(no panel)',
  );
  eq('console text', consoleOf(panels), 'Hello, RISC-V!\n');
  session.dispose();
}

// ─── Session: breakpoints / pausedAt / step-from-pause / changed / reset ───
console.log('session · breakpoints, step, reset');
{
  const s = riscvKernel.createSession();
  await s.load(SUM);

  // changed flags after a single step: li t0,1 writes only x5 (+ pc).
  await s.step();
  let fields = fieldsOf(s.state());
  check('x5 flagged changed after step 1', fields.find((f) => f.key === 'x5 (t0)')!.changed === true);
  check('x6 not flagged', fields.find((f) => f.key === 'x6 (t1)')!.changed !== true);
  check('pc flagged changed', fields.find((f) => f.key === 'pc')!.changed === true);
  await s.step();
  fields = fieldsOf(s.state());
  check('x5 change flag cleared next step', fields.find((f) => f.key === 'x5 (t0)')!.changed !== true);
  check('x6 flagged on step 2', fields.find((f) => f.key === 'x6 (t1)')!.changed === true);

  // breakpoint: stop BEFORE the add, pausedAt set, then step executes it.
  await s.reset();
  const r = await s.run([sumAddLine]);
  eq('paused at add line', r.pausedAt, sumAddLine);
  eq('not finished at pause', r.finished, false);
  eq('three li instructions ran first', r.steps, 3);
  let st = s.state();
  check(
    'current listing row is the paused line',
    listingOf(st).some((row) => row.current === true && row.line === sumAddLine),
  );
  eq('paused before executing: t2 still 0', fieldsOf(st).find((f) => f.key === 'x7 (t2)')!.value, '0x00000000');

  const stepped = await s.step();
  check('step from pause executes it', stepped.ran === true && (stepped.result?.steps ?? 0) === 4);
  eq('after step, t2 = 1', fieldsOf(s.state()).find((f) => f.key === 'x7 (t2)')!.value, '0x00000001');

  // continue: same breakpoint re-trips on the next loop iteration…
  const r2 = await s.run([sumAddLine]);
  eq('breakpoint re-trips next iteration', r2.pausedAt, sumAddLine);
  // …and running without breakpoints finishes the program.
  const r3 = await s.run();
  eq('continues to completion', r3.finished, true);
  eq('exit(0) at the end', r3.exit, 'exit(0)');
  eq('console shows 55', consoleOf(s.state()), '55\n');
  check('branch context panel present after a branch', s.state().some((p) => p.kind === 'fields' && p.id === 'branch'));

  // reset restores the post-assemble state.
  s.reset();
  st = s.state();
  eq('reset: pc back to entry', fieldsOf(st).find((f) => f.key === 'pc')!.value, '0x00001000');
  eq('reset: console cleared', consoleOf(st), '');
  check('reset: no changed flags', fieldsOf(st).every((f) => f.changed !== true));
  const r4 = await s.run();
  eq('run again after reset finishes', r4.finished, true);
  eq('output again 55', consoleOf(s.state()), '55\n');
  s.dispose();
}

// ─── Session: budget + load errors ───
console.log('session · budget & load errors');
{
  const s = riscvKernel.createSession();
  await s.load('        .text\nloop:\n        j       loop');
  const r = await s.run();
  eq('budget stops the infinite loop', r.finished, false);
  check('budget error message', (r.error ?? '').includes('budget'), r.error ?? '');
  eq('budget is 1,000,000 steps', r.steps, 1_000_000);

  const bad = await s.load('        .text\n        addd t0, t0, t1');
  check(
    'load error is line-mapped',
    !bad.ok && bad.line === 2 && bad.message.includes('unknown mnemonic'),
    bad.ok ? 'unexpectedly ok' : `line ${bad.line}: ${bad.message}`,
  );
  s.dispose();
}

// ─── lesson/lesson.org: every block runs and matches its #+RESULTS: ───
console.log('session · lesson round-trip');
{
  const org = await Bun.file('lesson/lesson.org').text();
  const blocks: string[] = [];
  const expected: string[] = [];
  const lines = org.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('#+BEGIN_SRC riscv')) {
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
  eq('lesson has 3 executable blocks', blocks.length, 3);
  eq('lesson has 3 results slots', expected.length, 3);
  for (let k = 0; k < blocks.length; k++) {
    const s = riscvKernel.createSession();
    const load = await s.load(blocks[k]!);
    check(`lesson block ${k + 1} loads`, load.ok, load.ok ? '' : `line ${load.line}: ${load.message}`);
    const r = await s.run();
    check(`lesson block ${k + 1} finishes`, r.finished && r.error === undefined, r.error ?? '');
    eq(`lesson block ${k + 1} output = ${JSON.stringify(expected[k])}`, consoleOf(s.state()).trim(), expected[k]);
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
