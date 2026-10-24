import { describe, expect, it } from 'vitest';
import { assemble, ABI_NAMES, mipsKernel, MipsMachine, PROGRAMS, TEXT_BASE } from '../src/index';

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

describe('encoder: hand-computed MIPS32 words', () => {
  it('encodes R/I/J formats, loads, shifts, branches, syscall exactly', () => {
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
    expect(encoded).toEqual([
      0x012a4020, // add  $t0,$t1,$t2 : rs=9 rt=10 rd=8 funct=0x20
      0x2230fffb, // addi $s0,$s1,-5  : op=8 rs=17 rt=16 imm=0xfffb
      0x8fa80008, // lw   $t0,8($sp)  : op=0x23 rs=29 rt=8 imm=8
      0x00094080, // sll  $t0,$t1,2   : rt=9 rd=8 shamt=2 funct=0
      0x1085fffb, // beq  $a0,$a1,start : (0x400000-0x400014)/4 = -5 words
      0x08100000, // j    start       : 0x00400000 >>> 2
      0x0000000c, // syscall
      0x3c081001, // lui  $t0,0x1001  : op=0x0f rt=8
    ]);
  });

  it('expands li into lui+ori and blt into slt+bne, word for word', () => {
    expect(words('main:   li      $t0, 0x12345678')).toEqual([0x3c011234, 0x34285678]);
    expect(words('L:      blt     $t0, $t1, L')).toEqual([0x0109082a, 0x1420fffe]);
  });

  it('maps every word back to its 1-based source line', () => {
    const r = assemble('        .text\nmain:   li      $t0, 0x12345678\n        addiu   $t1, $zero, 5');
    if (!r.ok) throw new Error('assembly failed');
    expect(r.words.map((w) => w.line)).toEqual([2, 2, 3]);
    expect(r.words.map((w) => w.addr)).toEqual([TEXT_BASE, TEXT_BASE + 4, TEXT_BASE + 8]);
  });
});

describe('lesson programs, headless', () => {
  it('hello prints the string and exits 0', () => {
    const m = run(PROGRAMS.hello);
    expect(m.error).toBeNull();
    expect(m.finished).toBe(true);
    expect(m.output).toBe('Hello, MIPS!\n');
    expect(m.exitCode).toBe(0);
  });

  it('sum 1..10 prints 55 and leaves sum=55, i=11 in $t0/$t1', () => {
    const m = run(PROGRAMS.sum);
    expect(m.error).toBeNull();
    expect(m.output).toBe('55\n');
    expect(m.regs[ABI_NAMES.indexOf('t0')]).toBe(55);
    expect(m.regs[ABI_NAMES.indexOf('t1')]).toBe(11);
  });

  it('factorial(10) prints 3628800 with lo=3628800, hi=0', () => {
    const m = run(PROGRAMS.factorial);
    expect(m.error).toBeNull();
    expect(m.output).toBe('3628800\n');
    expect(m.lo).toBe(3628800); // low word of the last mult
    expect(m.hi).toBe(0);       // 10! fits in 32 bits
  });
});

describe('teaching traps are line-mapped and name the instruction', () => {
  it('add/addi/sub signed overflow traps; the u-forms wrap', () => {
    const m = run('main:   li      $t0, 0x7fffffff\n        addi    $t1, $t0, 1');
    expect(m.finished).toBe(false);
    expect(m.error).toContain('line 2');
    expect(m.error).toContain('addi $t1, $t0, 1');
    expect(m.error).toContain('overflow');
    const u = run('main:   li      $t0, 0x7fffffff\n        addiu   $t1, $t0, 1\n        li      $v0, 10\n        syscall');
    expect(u.regs[ABI_NAMES.indexOf('t1')]).toBe(0x80000000);
  });

  it('division by zero stops instead of leaving hi/lo unpredictable', () => {
    const m = run('main:   li      $t0, 3\n        div     $t0, $zero');
    expect(m.error).toContain('division by zero');
    expect(m.error).toContain('line 2');
  });

  it('unaligned lw and unknown mnemonics report the exact line', () => {
    const mis = run('        .data\ns:      .asciiz "hi"\n        .text\nmain:   lw      $t0, s+1');
    expect(mis.error).toContain('line 4');
    expect(mis.error).toContain('unaligned');
    const bad = assemble('        .text\nmain:   frobnicate $t0');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toMatchObject({ line: 2, message: expect.stringContaining('frobnicate') });
  });

  it('an infinite loop hits the 1,000,000-step budget with a clean error', () => {
    const m = run('spin:   b       spin');
    expect(m.error).toContain('budget');
    expect(m.steps).toBe(BUDGET);
  });
});

describe('session contract', () => {
  it('stops before an instruction on a breakpointed line, then resumes', async () => {
    const s = mipsKernel.createSession();
    const load = await s.load(PROGRAMS.sum);
    expect(load.ok).toBe(true);
    const paused = await s.run([5]); // the 'loop:' line
    expect(paused.finished).toBe(false);
    expect(paused.pausedAt).toBe(5);
    expect((await s.step()).ran).toBe(true);
    const done = await s.run();
    expect(done.finished).toBe(true);
    expect(done.exit).toBe('exit(0)');
    s.dispose();
  });

  it('panels: 32 ABI registers, hi/lo/pc, encoded-word listing with comment tips only', async () => {
    const s = mipsKernel.createSession();
    await s.load(PROGRAMS.sum);
    const panels = s.state();
    expect(panels.map((p) => p.kind)).toEqual(['fields', 'fields', 'listing', 'hexdump', 'console']);
    const regs = panels[0]!;
    if (regs.kind !== 'fields') throw new Error('unreachable');
    expect(regs.fields.map((f) => f.key)).toEqual([...ABI_NAMES]);
    expect(regs.fields.every((f) => f.tip === undefined)).toBe(true); // no hardcoded teaching text
    const listing = panels[2]!;
    if (listing.kind !== 'listing') throw new Error('unreachable');
    expect(listing.rows[0]!.bytes).toMatch(/^[0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2}$/);
    const loopRow = listing.rows.find((r) => r.line === 5)!;
    expect(loopRow.tip).toBe('sum += i'); // exactly the trailing # comment
    expect(listing.rows.find((r) => r.line === 2)?.tip).toBeUndefined();
    const out = panels[4]!;
    if (out.kind !== 'console') throw new Error('unreachable');
    expect(out.text).toBe('');
    await s.run();
    if (out.kind !== 'console') throw new Error('unreachable');
    const after = s.state()[4]!;
    if (after.kind !== 'console') throw new Error('unreachable');
    expect(after.text).toBe('55\n');
    s.dispose();
  });

  it('reset restores the just-assembled machine (registers and steps)', async () => {
    const s = mipsKernel.createSession();
    await s.load(PROGRAMS.sum);
    const first = await s.run();
    s.reset();
    const second = await s.run();
    expect(second.finished).toBe(true);
    expect(second.steps).toBe(first.steps);
    s.dispose();
  });
});
