import { describe, expect, it } from 'vitest';
import { assemble, Cpu, REG_ABI, riscvKernel, TEXT_BASE } from '../src/index';
import type { Assembled, Panel, RunResult } from '../src/index';

/** assemble() or throw (fixtures are known-good). */
function prog(src: string): Assembled {
  const r = assemble(src);
  if (!r.ok) throw new Error(`fixture failed to assemble: line ${r.error.line}: ${r.error.message}`);
  return r.program;
}

/** Recombine 4 little-endian bytes into the encoded 32-bit word. */
function word(bytes: number[]): number {
  return (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
}

/** Drive a raw Cpu until it halts, faults, or burns `budget` steps. */
function runToHalt(cpu: Cpu, budget = 1_000_000): void {
  while (cpu.halted === null && cpu.error === null && cpu.steps < budget) cpu.step();
}


function fieldsOf(panels: Panel[]): Map<string, { value: string; changed?: boolean }> {
  const p = panels.find((q): q is Extract<Panel, { kind: 'fields' }> => q.kind === 'fields' && q.id === 'registers');
  if (p === undefined) throw new Error('missing registers panel');
  return new Map(p.fields.map((f) => [f.key, f] as const));
}

// ─── assembler: encoding table, bit-level derivations ───────────────────────

describe('encoder: hand-computed RV32IM words', () => {
  it('encodes I/S/B/J/R formats incl. a backward branch, word for word', () => {
    const p = prog(`
        .text
loop:   addi    t0, t0, 1
        bne     t0, t1, loop
        addi    x1, x2, 4
        lw   x1, 8(x2)
        sw   x1, 8(x2)
        beq  x1, x2, over
        jal  x1, far
        nop
        nop
over:   ret
far:    ecall
        add  t0, t1, t2
        mul  t0, t1, t2
`);
    const got = p.insns.map((i) => word(i.bytes));
    // addi t0,t0,1 : (1<<20)|(5<<15)|(5<<7)|0x13                       = 0x00128293
    expect(got[0]).toBe(0x00128293);
    // bne t0,t1,loop (pc 0x1004 → 0x1000, imm −4): imm[12|10:5]=0b1111111
    // <<25, rs2=6<<20, rs1=5<<15, f3=1<<12, imm[4:1]=0b1110<<8, imm[11]=1<<7, op 0x63
    expect(got[1]).toBe(0xfe629ee3);
    expect(got[2]).toBe(0x00410093); // addi x1,x2,4 : (4<<20)|(2<<15)|(1<<7)|0x13
    expect(got[3]).toBe(0x00812083); // lw x1,8(x2)  : (8<<20)|(2<<15)|(2<<12)|(1<<7)|0x03
    expect(got[4]).toBe(0x00112423); // sw x1,8(x2)  : (1<<20)|(2<<15)|(2<<12)|(8<<7)|0x23
    expect(got[5]).toBe(0x00208863); // beq x1,x2,+16: (2<<20)|(1<<15)|(8<<8)|0x63
    expect(got[6]).toBe(0x010000ef); // jal x1,+16   : (8<<21)|(1<<7)|0x6F
    expect(got[9]).toBe(0x00008067); // ret = jalr x0,0(x1)
    expect(got[10]).toBe(0x00000073); // ecall
    expect(got[11]).toBe(0x007302b3); // add t0,t1,t2: (6<<20)|(5<<15)|(5<<7)|(0<<25… f7=0)|0x33
    expect(got[12]).toBe(0x027302b3); // mul t0,t1,t2: same but funct7=0x01 → 0x02<<25
    expect(p.entry).toBe(TEXT_BASE);
    expect(p.insns[11]!.text).toBe('add t0, t1, t2'); // listing text uses ABI names
    expect(p.insns[1]!.sourceLine).toBe(4); // bne is on source line 4 (1 = blank, 2 = .text)
  });
});

// ─── interpreter: M extension corner cases ──────────────────────────────────

describe('M extension: div/rem corner cases', () => {
  it('div/rem by zero follow the RISC-V spec: −1 quotient, dividend remainder', () => {
    const cpu = new Cpu(prog(`
        .text
        li      t0, 7
        li      t1, 0
        div     t2, t0, t1
        rem     t3, t0, t1
        divu    t4, t0, t1
        remu    t5, t0, t1
        li      a7, 10
        ecall
`));
    runToHalt(cpu);
    expect(cpu.error).toBeNull();
    expect(cpu.regs[REG_ABI.indexOf('t2')]).toBe(-1); // div  7/0 → −1 (all ones)
    expect(cpu.regs[REG_ABI.indexOf('t3')]).toBe(7);  // rem  7%0 → dividend
    expect(cpu.regs[REG_ABI.indexOf('t4')]).toBe(-1); // divu 7/0 → 0xFFFFFFFF (int32 view: −1)
    expect(cpu.regs[REG_ABI.indexOf('t5')]).toBe(7);  // remu 7%0 → dividend
  });

  it('MIN_INT / −1 overflows to MIN_INT with remainder 0', () => {
    const cpu = new Cpu(prog(`
        .text
        li      t0, -2147483648
        li      t1, -1
        div     t2, t0, t1
        rem     t3, t0, t1
        li      a7, 10
        ecall
`));
    runToHalt(cpu);
    expect(cpu.error).toBeNull();
    expect(cpu.regs[REG_ABI.indexOf('t2')]).toBe(-2147483648); // the one case 32-bit div wraps
    expect(cpu.regs[REG_ABI.indexOf('t3')]).toBe(0);
  });
});

// ─── interpreter: load sign- vs zero-extension ─────────────────────────────

describe('loads: lb/lbu/lh/lhu sign- vs zero-extension', () => {
  it('sign-extends lb/lh and zero-extends lbu/lhu to the exact values', () => {
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
        li      a7, 10
        ecall

        .data
buf:
        .word 0
        .word 0
`));
    runToHalt(cpu);
    expect(cpu.error).toBeNull();
    expect(cpu.regs[REG_ABI.indexOf('a0')]).toBe(-1);     // lb  0xFF → sign-extended
    expect(cpu.regs[REG_ABI.indexOf('t2')]).toBe(255);    // lbu 0xFF → zero-extended
    expect(cpu.regs[REG_ABI.indexOf('t4')]).toBe(-32768); // lh  0x8000 → sign-extended
    expect(cpu.regs[REG_ABI.indexOf('t5')]).toBe(32768);  // lhu 0x8000 → zero-extended
    expect(cpu.readByte(cpu.prog.dataStart)).toBe(0xff); // the stored bytes
    expect(cpu.readByte(cpu.prog.dataStart + 2)).toBe(0x00);
    expect(cpu.readByte(cpu.prog.dataStart + 3)).toBe(0x80);
  });
});

// ─── session: breakpoint semantics ──────────────────────────────────────────

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
/** 1-based source line of the `add t2, t2, t0` loop body. */
const ADD_LINE = SUM.split('\n').findIndex((l) => l.includes('add     t2')) + 1;

describe('session: breakpoints pause before, re-trip, and count steps exactly', () => {
  it('stops before the breakpointed instruction with the register still at its pre-value', async () => {
    const s = riscvKernel.createSession();
    const load = await s.load(SUM);
    expect(load.ok).toBe(true);
    expect(ADD_LINE).toBe(6); // the fixture's `add t2, t2, t0` line

    const r: RunResult = await s.run([ADD_LINE]);
    expect(r.pausedAt).toBe(ADD_LINE);
    expect(r.finished).toBe(false);
    expect(r.steps).toBe(3); // exactly the three li instructions ran

    const t2 = fieldsOf(s.state()).get('x7 (t2)')!;
    expect(t2.value).toBe('0x00000000'); // paused BEFORE the add: t2 untouched

    const stepped = await s.step();
    expect(stepped.ran).toBe(true);
    expect(stepped.result?.steps).toBe(4); // the add itself executed
    expect(fieldsOf(s.state()).get('x7 (t2)')!.value).toBe('0x00000001');
    s.dispose();
  });

  it('the same breakpoint re-trips on the second loop iteration, then runs to completion', async () => {
    const s = riscvKernel.createSession();
    await s.load(SUM);
    await s.run([ADD_LINE]);
    await s.step(); // past the first trip

    const again = await s.run([ADD_LINE]);
    expect(again.pausedAt).toBe(ADD_LINE); // re-tripped one iteration later
    expect(again.finished).toBe(false);

    const done = await s.run(); // no breakpoints → finish
    expect(done.finished).toBe(true);
    expect(done.exit).toBe('exit(0)');
    const con = s.state().find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
    expect(con?.text).toBe('55\n');
    s.dispose();
  });
});
