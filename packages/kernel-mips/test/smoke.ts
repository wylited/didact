// Headless smoke test — run with:  bun packages/kernel-mips/test/smoke.ts
// Asserts (1) the encoder against hand-computed MIPS32 words, (2) the three
// lesson programs end-to-end (output + final registers/hi/lo), and (3) the
// teaching traps: overflow, budget, breakpoints, alignment, $zero writes.

import assert from 'node:assert/strict';
import { assemble, MipsMachine, PROGRAMS, mipsKernel } from '../src/index';

const BUDGET = 1_000_000;

function run(src: string): MipsMachine {
  const r = assemble(src);
  if (!r.ok) throw new Error(`assembly failed: ${JSON.stringify(r.errors)}`);
  const m = new MipsMachine({ words: r.words, data: r.data });
  m.run(BUDGET, null);
  return m;
}

function words(src: string): number[] {
  const r = assemble(src);
  if (!r.ok) throw new Error(`assembly failed: ${JSON.stringify(r.errors)}`);
  return r.words.map((w) => w.word);
}

// ---- 1. Encoder vs hand-computed words -------------------------------------

const encoded = words(`
        .text
start:  add     $t0, $t1, $t2
        addi    $s0, $s1, -5
        lw      $t0, 8($sp)
        sll     $t0, $t1, 2
        beq     $a0, $a1, start
        j       start
        syscall
        lui     $t0, 0x1001
`);
assert.deepEqual(encoded, [
  0x012a4020, // add  $t0,$t1,$t2  : rs=9 rt=10 rd=8 funct=0x20
  0x2230fffb, // addi $s0,$s1,-5   : op=8 rs=17 rt=16 imm=0xfffb
  0x8fa80008, // lw   $t0,8($sp)   : op=0x23 rs=29 rt=8 imm=8
  0x00094080, // sll  $t0,$t1,2    : rt=9 rd=8 sh=2 funct=0
  0x1085fffb, // beq  $a0,$a1,start: off=(0x400000-0x400014)/4=-5 words
  0x08100000, // j    start        : (0x00400000 >>> 2)
  0x0000000c, // syscall           : SPECIAL funct 0x0c
  0x3c081001, // lui  $t0,0x1001   : op=0x0f rt=8
]);
assert.equal(encoded.length, 8);

// Pseudo-expansion encodings: li (lui+ori) and blt (slt+bne).
assert.deepEqual(words(`
        .text
main:   li      $t0, 0x12345678
`), [
  0x3c011234, // lui $at, 0x1234
  0x34285678, // ori $t0, $at, 0x5678
]);
assert.deepEqual(words(`
        .text
L:      blt     $t0, $t1, L
`), [
  0x0109082a, // slt $at, $t0, $t1 : rs=8 rt=9 rd=1 funct=0x2a
  0x1420fffe, // bne $at, $zero, L : off=(0x400000-0x400008)/4=-2
]);
console.log('encoder: 8 instruction types + 2 pseudo expansions match hand-computed words');

// ---- 2. The three lesson programs, headless ---------------------------------

const hello = run(PROGRAMS.hello);
assert.equal(hello.error, null);
assert.ok(hello.finished);
assert.equal(hello.output, 'Hello, MIPS!\n');
assert.equal(hello.exitCode, 0);

const sum = run(PROGRAMS.sum);
assert.equal(sum.error, null);
assert.ok(sum.finished);
assert.equal(sum.output, '55\n');
assert.equal(sum.regs[8], 55);  // $t0 = sum
assert.equal(sum.regs[9], 11);  // $t1 = i, one past the end

const fact = run(PROGRAMS.factorial);
assert.equal(fact.error, null);
assert.ok(fact.finished);
assert.equal(fact.output, '3628800\n');
assert.equal(fact.regs[2], 10);         // $v0's final job: selecting syscall 10 (exit)
assert.equal(fact.lo, 3628800);      // low 32 bits of the last product
assert.equal(fact.hi, 0);            // 10! fits in 32 bits
assert.ok(fact.steps > 20 && fact.steps < 100);
console.log(`lesson programs: hello/sum/factorial printed exactly; fact took ${fact.steps} steps`);

// ---- 3. Semantics edge cases -------------------------------------------------

const sem = run(`
        .text
main:   li      $t0, -8
        sra     $t1, $t0, 1
        srl     $t2, $t0, 28
        slt     $t3, $t0, $zero
        sltu    $t4, $t0, $zero
        addiu   $zero, $t0, 5
        li      $v0, 10
        syscall
`);
assert.equal(sem.error, null);
assert.equal(sem.regs[9], 0xfffffffc);  // sra: -8 >> 1 = -4
assert.equal(sem.regs[10], 0xf);        // srl: 0xfffffff8 >>> 28
assert.equal(sem.regs[11], 1);          // slt: -8 < 0 signed
assert.equal(sem.regs[12], 0);          // sltu: huge unsigned is not < 0
assert.equal(sem.regs[0], 0);           // $zero write discarded

const mul = run(`
        .text
main:   li      $t1, -3
        mult    $t1, $t1
        mflo    $t2
        mfhi    $t3
        li      $t0, 0x7fffffff
        multu   $t0, $t0
        li      $v0, 10
        syscall
`);
assert.equal(mul.error, null);
assert.equal(mul.regs[10], 9);          // (-3)² via signed mult, low word
assert.equal(mul.regs[11], 0);          // high word 0
assert.equal(mul.hi, 0x3fffffff);       // (2³¹−1)² = 0x3fffffff_00000001
assert.equal(mul.lo, 1);

const dv = run(`
        .text
main:   li      $a0, -7
        li      $a1, 2
        div     $a0, $a1
        li      $v0, 10
        syscall
`);
assert.equal(dv.error, null);
assert.equal(dv.lo, 0xfffffffd);        // div: quotient −3 (truncates toward 0)
assert.equal(dv.hi, 0xffffffff);        // div: remainder −1 (sign of dividend)
assert.equal(dv.regs[4], 0xfffffff9);   // div reads $a0/$a1, writes only hi/lo
console.log('semantics: sra/srl/slt/sltu, 64-bit mult, signed div, $zero all correct');

const ext = run(`
        .data
buf:    .space  8
        .text
main:   li      $t0, -2
        sb      $t0, buf
        lb      $t1, buf
        lbu     $t2, buf
        sh      $t0, buf+2
        lh      $t3, buf+2
        lhu     $t4, buf+2
        li      $v0, 10
        syscall
`);
assert.equal(ext.error, null);
assert.equal(ext.regs[9], 0xfffffffe); // lb sign-extends
assert.equal(ext.regs[10], 254);       // lbu zero-extends
assert.equal(ext.regs[11], 0xfffffffe); // lh sign-extends
assert.equal(ext.regs[12], 65534);     // lhu zero-extends
console.log('loads/stores: sign vs zero extension through .data correct');

// ---- 4. Teaching traps --------------------------------------------------------

const ovf = run(`
        .text
main:   li      $t0, 0x7fffffff
        addi    $t1, $t0, 1
`);
assert.equal(ovf.finished, false);
assert.ok(ovf.error !== null && ovf.error.includes('line 4') && ovf.error.includes('addi $t1, $t0, 1') && ovf.error.includes('overflow'));

const spin = run(`
        .text
spin:   b       spin
`);
assert.ok(spin.error !== null && spin.error.includes('budget'));
assert.equal(spin.steps, BUDGET);

const mis = run(`
        .data
s:      .asciiz "hi"
        .text
main:   lw      $t0, s+1
`);
assert.ok(mis.error !== null && mis.error.includes('line 5') && mis.error.includes('unaligned'));

const badReg = assemble(`
        .text
main:   frobnicate $t0
`);
assert.ok(!badReg.ok && badReg.errors[0]!.line === 3 && badReg.errors[0]!.message.includes('frobnicate'));

console.log('traps: overflow names instruction+line, budget, unaligned lw, load-error line map');

// ---- 5. Contract: session, breakpoints, panels --------------------------------

const session = mipsKernel.createSession();
const loadResult = await session.load(PROGRAMS.sum);
assert.equal(loadResult.ok, true);
if (loadResult.ok) assert.match(loadResult.summary, /^loaded · \d+ instructions$/);

// Breakpoint: the 'loop:' line (5) pauses before executing; stepping then
// executing lets a resume without breakpoints finish.
const paused = await session.run([5]);
assert.equal(paused.finished, false);
assert.equal(paused.pausedAt, 5);
const stepped = await session.step();
assert.equal(stepped.ran, true);
const done = await session.run();
assert.equal(done.finished, true);
assert.equal(done.exit, 'exit(0)');

const panels = session.state();
assert.deepEqual(panels.map((p) => p.kind), ['fields', 'fields', 'listing', 'hexdump', 'console']);
const regs = panels[0]!;
if (regs.kind !== 'fields') throw new Error('unreachable');
assert.equal(regs.fields.length, 32);
assert.equal(regs.fields[0]!.key, 'zero');
assert.equal(regs.fields[31]!.key, 'ra');
const listing = panels[2]!;
if (listing.kind !== 'listing') throw new Error('unreachable');
assert.match(listing.rows[0]!.bytes, /^[0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2}$/);
const loopRow = listing.rows.find((r) => r.line === 5)!;
assert.equal(loopRow.tip, 'sum += i');  // tip = that line's trailing # comment
assert.equal(listing.rows.find((r) => r.line === 2)?.tip, undefined); // no comment → no tip
assert.ok(regs.fields.every((f) => f.tip === undefined)); // no hardcoded teaching text
const consolePanel = panels[4]!;
if (consolePanel.kind !== 'console') throw new Error('unreachable');
assert.equal(consolePanel.text, '55\n');

session.reset();
const fresh = await session.run();
assert.equal(fresh.finished, true);
assert.equal(fresh.steps, done.steps); // reset really rebuilt the machine
session.dispose();

console.log('contract: load/run/step/reset/state + breakpoints honored');
console.log('mips smoke: ALL ASSERTS PASSED');
