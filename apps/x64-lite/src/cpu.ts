// cpu.ts — the x86-64 teaching interpreter.
//
// Registers are BigInt (exact 64-bit values). Memory is a sparse byte map:
// `.text` lives at 0x401000, `.data` above it, and the stack pointer starts at
// 0x7fff_ffff_f000 and grows down. Flags ZF CF SF OF PF AF follow real x86
// semantics for the implemented subset (see README for the exact table).

import { STACK_TOP, type Insn, type MemOp, type Op, type Program, type RegOp, type XOp } from "./asm";

const M64 = (1n << 64n) - 1n;
const M32 = 0xffffffffn;

const RAX = 0, RCX = 1, RDX = 2, RSP = 4, RSI = 6, RDI = 7;
const RUN_BUDGET = 1_000_000;

export class CpuError extends Error {}

export interface Flags {
  zf: boolean; cf: boolean; sf: boolean; of: boolean; pf: boolean; af: boolean;
}

export type MachineStatus = "loaded" | "finished" | "error";

export class Machine {
  readonly prog: Program;
  regs: bigint[] = new Array(16).fill(0n);
  rip = 0n;
  flags: Flags = { zf: false, cf: false, sf: false, of: false, pf: false, af: false };
  mem = new Map<number, number>();
  out: number[] = [];
  steps = 0;
  status: MachineStatus = "loaded";
  error: string | null = null;
  exitCode: bigint | null = null;
  finishNote: string | null = null;
  /** indices 0..15 = changed GPRs, 16 = rip — reset on every step */
  changed = new Set<number>();
  private byAddr = new Map<number, Insn>();

  constructor(prog: Program) {
    this.prog = prog;
    for (const ins of prog.insns) this.byAddr.set(ins.addr, ins);
    this.reset();
  }

  reset(): void {
    this.regs = new Array(16).fill(0n);
    this.flags = { zf: false, cf: false, sf: false, of: false, pf: false, af: false };
    this.mem = new Map(this.prog.data);
    this.out = [];
    this.steps = 0;
    this.status = "loaded";
    this.error = null;
    this.exitCode = null;
    this.finishNote = null;
    this.changed = new Set();
    this.regs[RSP] = BigInt(STACK_TOP);
    this.pushRaw(0n); // entry sentinel: `ret` from the outermost frame finishes
    this.rip = this.prog.entry;
  }

  /** Execute exactly one instruction (no-op when finished or errored). */
  step(): void {
    if (this.status !== "loaded") return;
    const before = this.regs.slice();
    const ripBefore = this.rip;
    const insn = this.byAddr.get(Number(this.rip));
    if (insn === undefined) {
      this.status = "error";
      this.error = this.rip === BigInt(this.prog.textEnd)
        ? "execution ran past the last instruction — missing exit syscall?"
        : `instruction pointer 0x${this.rip.toString(16)} is outside .text`;
      return;
    }
    try {
      this.exec(insn.op, insn);
    } catch (e) {
      this.status = "error";
      this.error = e instanceof CpuError ? e.message : `internal error: ${String(e)}`;
      return;
    }
    this.steps++;
    const changed = new Set<number>();
    for (let i = 0; i < 16; i++) {
      if (before[i] !== this.regs[i]) changed.add(i);
    }
    if (ripBefore !== this.rip) changed.add(16);
    this.changed = changed;
  }

  /** Instruction at the current rip, if any (used for line highlighting). */
  insnAt(): Insn | undefined {
    return this.byAddr.get(Number(this.rip));
  }

  /** Run until finished/error or the 1,000,000-instruction budget runs out. */
  run(): void {
    while (this.status === "loaded" && this.steps < RUN_BUDGET) this.step();
    if (this.status === "loaded") {
      this.status = "error";
      this.error = `instruction budget exceeded (${RUN_BUDGET} steps) — is this an infinite loop?`;
    }
  }

  // ---- execution ----------------------------------------------------------

  private exec(op: Op, insn: Insn): void {
    this.rip = BigInt(insn.addr + insn.len); // default: fall through
    switch (op.t) {
      case "mov": {
        const v = this.read(op.s, this.sizeOf(op.d));
        this.write(op.d, v);
        break;
      }
      case "alu": {
        const size = this.sizeOf(op.d);
        const mask = size === 8 ? M64 : M32;
        const bits = BigInt(size * 8);
        const a = this.read(op.d, size);
        const b = this.read(op.s, size);
        let r: bigint;
        if (op.a === "add") {
          r = (a + b) & mask;
          this.setAdd(a, b, r, bits);
        } else if (op.a === "sub") {
          r = (a - b) & mask;
          this.setSub(a, b, r, bits);
        } else {
          r = op.a === "and" ? a & b : op.a === "or" ? a | b : a ^ b;
          this.setLogic(r, bits);
        }
        this.write(op.d, r);
        break;
      }
      case "cmp": {
        const size = this.sizeOf(op.a);
        const mask = size === 8 ? M64 : M32;
        const a = this.read(op.a, size);
        const b = this.read(op.b, size);
        this.setSub(a, b, (a - b) & mask, BigInt(size * 8));
        break;
      }
      case "test": {
        const size = this.sizeOf(op.a);
        this.setLogic(this.read(op.a, size) & this.read(op.b, size), BigInt(size * 8));
        break;
      }
      case "lea": {
        this.write(op.d, BigInt(this.ea(op.m)) & M64);
        break;
      }
      case "imul": {
        const size = op.d.size;
        const prod = BigInt.asIntN(size * 8, this.read(op.d, size))
          * BigInt.asIntN(size * 8, this.read(op.s, size));
        const low = prod & (size === 8 ? M64 : M32);
        this.write(op.d, low);
        this.flags.cf = this.flags.of = BigInt.asIntN(size * 8, low) !== prod;
        break;
      }
      case "imul3": {
        const size = op.d.size;
        const prod = BigInt.asIntN(size * 8, this.read(op.s, size)) * op.imm;
        const low = prod & (size === 8 ? M64 : M32);
        this.write(op.d, low);
        this.flags.cf = this.flags.of = BigInt.asIntN(size * 8, low) !== prod;
        break;
      }
      case "idiv": {
        const size = this.sizeOf(op.s);
        const bits = size * 8;
        const d = BigInt.asIntN(bits, this.read(op.s, size));
        if (d === 0n) throw new CpuError("integer division by zero (#DE)");
        const dend = size === 8
          ? BigInt.asIntN(128, (this.regs[RDX]! << 64n) | this.regs[RAX]!)
          : BigInt.asIntN(64, ((this.regs[RDX]! & M32) << 32n) | (this.regs[RAX]! & M32));
        const q = dend / d; // BigInt division truncates toward zero, like idiv
        const r = dend % d;
        const limit = size === 8 ? 1n << 63n : 1n << 31n;
        if (q < -limit || q >= limit) throw new CpuError("integer overflow in division (#DE)");
        if (size === 8) {
          this.regs[RAX] = q & M64;
          this.regs[RDX] = r & M64;
        } else {
          this.regs[RAX] = q & M32;
          this.regs[RDX] = r & M32;
        }
        break;
      }
      case "div": {
        const size = this.sizeOf(op.s);
        const d = this.read(op.s, size);
        if (d === 0n) throw new CpuError("integer division by zero (#DE)");
        const dend = size === 8
          ? (this.regs[RDX]! << 64n) | this.regs[RAX]!
          : ((this.regs[RDX]! & M32) << 32n) | (this.regs[RAX]! & M32);
        const q = dend / d;
        const r = dend % d;
        if (q > (size === 8 ? M64 : M32)) throw new CpuError("integer overflow in division (#DE)");
        if (size === 8) {
          this.regs[RAX] = q;
          this.regs[RDX] = r;
        } else {
          this.regs[RAX] = q & M32;
          this.regs[RDX] = r & M32;
        }
        break;
      }
      case "un": {
        const size = this.sizeOf(op.d);
        const mask = size === 8 ? M64 : M32;
        const bits = BigInt(size * 8);
        const v = this.read(op.d, size);
        const cfBefore = this.flags.cf;
        let r: bigint;
        if (op.u === "inc") {
          r = (v + 1n) & mask;
          this.setAdd(v, 1n, r, bits);
          this.flags.cf = cfBefore; // inc/dec leave CF alone
        } else if (op.u === "dec") {
          r = (v - 1n) & mask;
          this.setSub(v, 1n, r, bits);
          this.flags.cf = cfBefore;
        } else if (op.u === "neg") {
          r = (0n - v) & mask;
          this.setSub(0n, v, r, bits); // gives CF = (v != 0) and OF = (v == INT_MIN)
        } else {
          r = ~v & mask; // not: no flags
        }
        this.write(op.d, r);
        break;
      }
      case "shift": {
        const size = this.sizeOf(op.d);
        const mask = size === 8 ? M64 : M32;
        const bits = BigInt(size * 8);
        const nbits = size * 8;
        const rawCnt = op.by === "cl" ? Number(this.regs[RCX]! & 0xffn) : Number(op.by);
        const cnt = rawCnt & (nbits - 1); // 64-bit ops mask to 63, 32-bit to 31
        if (cnt !== 0) {
          const f = this.flags;
          const v = this.read(op.d, size);
          let r: bigint;
          if (op.sh === "shl") {
            f.cf = ((v >> BigInt(nbits - cnt)) & 1n) === 1n;
            r = (v << BigInt(cnt)) & mask;
            if (cnt === 1) f.of = ((r & (1n << BigInt(nbits - 1))) !== 0n) !== f.cf;
          } else if (op.sh === "shr") {
            f.cf = ((v >> BigInt(cnt - 1)) & 1n) === 1n;
            r = v >> BigInt(cnt);
            if (cnt === 1) f.of = (v & (1n << BigInt(nbits - 1))) !== 0n;
          } else {
            const sv = BigInt.asIntN(nbits, v);
            f.cf = ((sv >> BigInt(cnt - 1)) & 1n) === 1n;
            r = (sv >> BigInt(cnt)) & mask;
            if (cnt === 1) f.of = false;
          }
          this.setZsp(r, bits);
          f.af = false; // undefined on hardware; cleared in this subset
          this.write(op.d, r);
        }
        break;
      }
      case "jmp":
        this.rip = op.to;
        break;
      case "jmpind":
        this.rip = this.read(op.s, 8);
        break;
      case "jcc":
        this.rip = this.cond(op.cc) ? op.to : this.rip;
        break;
      case "call":
        this.pushRaw(this.rip);
        this.rip = op.to;
        break;
      case "callind": {
        const to = this.read(op.s, 8);
        this.pushRaw(this.rip);
        this.rip = to;
        break;
      }
      case "ret": {
        const a = this.popRaw();
        if (a === 0n) {
          this.status = "finished";
          this.finishNote = "returned from entry";
          this.rip = BigInt(this.prog.textEnd);
        } else {
          this.rip = a;
        }
        break;
      }
      case "push":
        this.pushRaw(this.read(op.s, 8));
        break;
      case "pop": {
        const v = this.popRaw();
        this.write(op.d, v);
        break;
      }
      case "syscall":
        this.syscall();
        break;
      case "nop":
        break;
    }
  }

  private syscall(): void {
    const nr = this.regs[RAX]!;
    if (nr === 1n) {
      const fd = this.regs[RDI]!;
      if (fd !== 1n && fd !== 2n) {
        throw new CpuError(`write() to fd ${fd} is not supported (use 1 = stdout or 2 = stderr)`);
      }
      const len = this.regs[RDX]!;
      if (len < 0n || len > 1_000_000n) throw new CpuError(`write length ${len} is out of range`);
      const addr = Number(this.regs[RSI]! & M64);
      for (let i = 0; i < Number(len); i++) this.out.push(this.mem.get(addr + i) ?? 0);
      this.regs[RAX] = len; // write() returns the number of bytes written
    } else if (nr === 60n) {
      this.status = "finished";
      this.exitCode = this.regs[RDI]!;
      this.finishNote = `exit(${this.regs[RDI]})`;
    } else {
      throw new CpuError(`syscall ${nr} is not supported in this teaching subset (rax = 1: write, 60: exit)`);
    }
  }

  /** jcc condition from flags, using the hardware cc encoding (0..15). */
  private cond(cc: number): boolean {
    const f = this.flags;
    let base: boolean;
    switch (cc >> 1) {
      case 0: base = f.of; break;
      case 1: base = f.cf; break;
      case 2: base = f.zf; break;
      case 3: base = f.cf || f.zf; break;
      case 4: base = f.sf; break;
      case 5: base = f.pf; break;
      case 6: base = f.sf !== f.of; break;
      default: base = f.zf || f.sf !== f.of; break;
    }
    return (cc & 1) === 1 ? !base : base;
  }

  // ---- operand access -----------------------------------------------------

  private sizeOf(o: XOp): 8 | 4 {
    if (o.k === "imm") throw new Error("immediate operand has no size");
    return o.size;
  }

  private ea(m: MemOp): number {
    let a = m.disp;
    if (m.base !== null) a += this.regs[m.base]!;
    if (m.index !== null) a += this.regs[m.index]! * BigInt(m.scale);
    return Number(a & M64);
  }

  private read(o: XOp, size: 8 | 4): bigint {
    const mask = size === 8 ? M64 : M32;
    if (o.k === "imm") return o.v & mask;
    if (o.k === "reg") return this.regs[o.r]! & mask;
    return this.readMem(this.ea(o), size);
  }

  private write(o: RegOp | MemOp, v: bigint): void {
    if (o.k === "reg") {
      this.regs[o.r] = o.size === 8 ? v & M64 : v & M32; // 32-bit writes zero-extend
      return;
    }
    const mask = o.size === 8 ? M64 : M32;
    this.writeMem(this.ea(o), v & mask, o.size);
  }

  private readMem(addr: number, size: 8 | 4): bigint {
    let v = 0n;
    for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.mem.get(addr + i) ?? 0);
    return v;
  }

  private writeMem(addr: number, v: bigint, size: 8 | 4): void {
    for (let i = 0; i < size; i++) {
      const a = addr + i;
      if (a >= this.prog.textBase && a < this.prog.textEnd) {
        throw new CpuError("writing to the .text section is not supported in this teaching subset");
      }
      this.mem.set(a, Number(v & 0xffn));
      v >>= 8n;
    }
  }

  private pushRaw(v: bigint): void {
    this.regs[RSP] = (this.regs[RSP]! - 8n) & M64;
    this.writeMem(Number(this.regs[RSP]!), v & M64, 8);
  }

  private popRaw(): bigint {
    const v = this.readMem(Number(this.regs[RSP]!), 8);
    this.regs[RSP] = (this.regs[RSP]! + 8n) & M64;
    return v;
  }

  // ---- flags --------------------------------------------------------------

  private setAdd(a: bigint, b: bigint, r: bigint, bits: bigint): void {
    const f = this.flags;
    f.cf = a + b > (1n << bits) - 1n;
    f.of = (~(a ^ b) & (a ^ r) & (1n << (bits - 1n))) !== 0n;
    f.af = ((a ^ b ^ r) & 0x10n) !== 0n;
    this.setZsp(r, bits);
  }

  private setSub(a: bigint, b: bigint, r: bigint, bits: bigint): void {
    const f = this.flags;
    f.cf = a < b;
    f.of = ((a ^ b) & (a ^ r) & (1n << (bits - 1n))) !== 0n;
    f.af = ((a ^ b ^ r) & 0x10n) !== 0n;
    this.setZsp(r, bits);
  }

  private setLogic(r: bigint, bits: bigint): void {
    this.flags.cf = false;
    this.flags.of = false;
    this.flags.af = false; // undefined after and/or/xor/test; cleared here
    this.setZsp(r, bits);
  }

  private setZsp(r: bigint, bits: bigint): void {
    const f = this.flags;
    f.zf = r === 0n;
    f.sf = (r & (1n << (bits - 1n))) !== 0n;
    let p = 0;
    let v = Number(r & 0xffn);
    for (let i = 0; i < 8; i++) { p ^= v & 1; v >>= 1; }
    f.pf = p === 0; // PF set when the low byte has even parity
  }
}
