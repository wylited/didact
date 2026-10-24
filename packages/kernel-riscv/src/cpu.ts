// cpu.ts — RV32I(+M) simulator: decodes and executes the real encodings
// produced by asm.ts, with venus/RARS-style ecalls.
//
// Semantics (per unprivileged spec + the teaching choices in this header):
// - x0 is hard-wired to zero (writes are discarded).
// - Memory is a sparse byte map (unmapped bytes read 0), little-endian,
//   misaligned access allowed (teaching machine, no traps for it).
// - Arithmetic wraps mod 2^32 (Int32Array + |0).
// - div by 0 → quotient -1, rem = dividend; MIN_INT / -1 → MIN_INT, rem 0.
// - mulh: signed×signed high 32; mulhu unsigned; mulhsu mixed.
// - Branches update a "branch context" record (this ISA has no flags —
//   RISC-V compares and branches in one instruction).

import { REG_ABI, STACK_INIT, type Assembled } from "./asm";

/** Operands + outcome of the most recent compare/branch (replaces x86 flags). */
export interface BranchInfo {
  op: string;
  rs1: string;
  rs2: string;
  v1: number;
  v2: number;
  taken: boolean;
}

const utf8 = new TextDecoder("utf-8");

/** signed high 32 of a×b */
function mulhS(a: number, b: number): number {
  return Number((BigInt(a) * BigInt(b) >> 32n) & 0xffffffffn) | 0;
}
/** unsigned high 32 */
function mulhU(a: number, b: number): number {
  return Number((BigInt(a >>> 0) * BigInt(b >>> 0) >> 32n) & 0xffffffffn) | 0;
}
/** signed × unsigned high 32 */
function mulhSU(a: number, b: number): number {
  return Number((BigInt(a) * BigInt(b >>> 0) >> 32n) & 0xffffffffn) | 0;
}
function divS(a: number, b: number): number {
  if (b === 0) return -1; // RISC-V: div-by-0 → -1 (no trap)
  if (a === -0x80000000 && b === -1) return a; // overflow → MIN_INT
  return (a / b) | 0;
}
function remS(a: number, b: number): number {
  if (b === 0) return a; // rem-by-0 → dividend
  if (a === -0x80000000 && b === -1) return 0;
  return a % b;
}
function divU(a: number, b: number): number {
  if (b === 0) return -1; // 0xFFFFFFFF
  return ((a >>> 0) / (b >>> 0)) | 0;
}
function remU(a: number, b: number): number {
  if (b === 0) return a;
  return (a >>> 0) % (b >>> 0);
}

const BRANCH_NAMES = ["beq", "bne", "?", "?", "blt", "bge", "bltu", "bgeu"];

export class Cpu {
  readonly prog: Assembled;
  readonly regs = new Int32Array(32);
  /** Byte address of the next instruction to execute. */
  pc = 0;
  /** Sparse little-endian memory: address → byte. */
  readonly mem = new Map<number, number>();
  /** "exit" | "ebreak" | "end" | "budget" once the program has stopped. */
  halted: string | null = null;
  error: string | null = null;
  errorLine: number | null = null;
  lastBranch: BranchInfo | null = null;
  /** Instructions executed so far (the step budget counter). */
  steps = 0;
  /** Everything the program has printed (for restoring the console). */
  outputText = "";
  /** a0 at the exit ecall (services 10/93), once the program has exited. */
  exitCode: number | null = null;

  constructor(prog: Assembled) {
    this.prog = prog;
    this.reset();
  }

  /** Restore the just-assembled machine: memory image, registers, pc. */
  reset(): void {
    this.mem.clear();
    for (const ins of this.prog.insns) {
      for (let i = 0; i < 4; i++) this.mem.set(ins.addr + i, ins.bytes[i]!);
    }
    for (const ch of this.prog.data) {
      for (let i = 0; i < ch.bytes.length; i++) this.mem.set(ch.addr + i, ch.bytes[i]!);
    }
    this.regs.fill(0);
    this.pc = this.prog.entry;
    this.regs[2] = STACK_INIT; // sp — stack grows down from 0x7ffffffc
    this.halted = null;
    this.error = null;
    this.errorLine = null;
    this.exitCode = null;
    this.lastBranch = null;
    this.steps = 0;
    this.outputText = "";
  }

  readByte(addr: number): number {
    return this.mem.get(addr) ?? 0;
  }

  private setReg(i: number, v: number): void {
    if (i !== 0) this.regs[i] = v | 0; // x0 is immutable
  }

  private emit(s: string): void {
    this.outputText += s;
  }

  /** Read a NUL-terminated string from memory (for ecall 4). */
  private readString(addr: number): string | null {
    const bytes: number[] = [];
    let a = addr >>> 0;
    for (let i = 0; i < 4096; i++, a = (a + 1) >>> 0) {
      const b = this.mem.get(a) ?? 0;
      if (b === 0) return utf8.decode(new Uint8Array(bytes));
      bytes.push(b);
    }
    return null; // caller reports the error
  }

  private fail(msg: string, line: number | null): void {
    this.error = msg;
    this.errorLine = line;
  }

  /**
   * Execute exactly one instruction. After `halted`/`error` this is a no-op.
   */
  step(): void {
    if (this.halted || this.error) return;

    const insn = this.prog.insnAt.get(this.pc);
    if (insn === undefined) {
      if (this.pc === this.prog.textEnd) {
        this.halted = "end"; // fell off the end of .text
      } else {
        this.fail(
          `no instruction at pc 0x${(this.pc >>> 0).toString(16)} — control left the program (bad jump, or returned with an empty ra?)`,
          null,
        );
      }
      return;
    }

    this.steps++;

    const b = insn.bytes;
    const w = (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
    const opcode = w & 0x7f;
    const rd = (w >>> 7) & 31;
    const f3 = (w >>> 12) & 7;
    const rs1 = (w >>> 15) & 31;
    const rs2 = (w >>> 20) & 31;
    const f7 = w >>> 25;
    const immI = w >> 20; // sign-extended imm[31:20]
    let next = (this.pc + 4) >>> 0;

    const rs1v = this.regs[rs1];
    const rs2v = this.regs[rs2];

    switch (opcode) {
      case 0x33: {
        // OP (+M via funct7 = 0000001)
        let val: number = 0;
        switch (f3) {
          case 0:
            val = f7 === 0x01 ? Math.imul(rs1v, rs2v)
              : f7 === 0x20 ? (rs1v - rs2v) | 0
              : f7 === 0x00 ? (rs1v + rs2v) | 0
              : this.illegal(w);
            break;
          case 1:
            val = f7 === 0x01 ? mulhS(rs1v, rs2v)
              : f7 === 0x00 ? rs1v << (rs2v & 31)
              : this.illegal(w);
            break;
          case 2:
            val = f7 === 0x01 ? mulhSU(rs1v, rs2v)
              : f7 === 0x00 ? (rs1v < rs2v ? 1 : 0)
              : this.illegal(w);
            break;
          case 3:
            val = f7 === 0x01 ? mulhU(rs1v, rs2v)
              : f7 === 0x00 ? ((rs1v >>> 0) < (rs2v >>> 0) ? 1 : 0)
              : this.illegal(w);
            break;
          case 4:
            val = f7 === 0x01 ? divS(rs1v, rs2v)
              : f7 === 0x00 ? rs1v ^ rs2v
              : this.illegal(w);
            break;
          case 5:
            val = f7 === 0x01 ? divU(rs1v, rs2v)
              : f7 === 0x00 ? rs1v >>> (rs2v & 31)
              : f7 === 0x20 ? rs1v >> (rs2v & 31)
              : this.illegal(w);
            break;
          case 6: // rem (signed) — funct3 6 per spec
            val = f7 === 0x01 ? remS(rs1v, rs2v)
              : f7 === 0x00 ? rs1v | rs2v
              : this.illegal(w);
            break;
          case 7: // remu (unsigned) — funct3 7 per spec
            val = f7 === 0x01 ? remU(rs1v, rs2v)
              : f7 === 0x00 ? rs1v & rs2v
              : this.illegal(w);
            break;
        }
        if (this.error === null) this.setReg(rd, val);
        break;
      }

      case 0x13: {
        // OP-IMM
        let val: number = 0;
        switch (f3) {
          case 0: val = (rs1v + immI) | 0; break;
          case 2: val = rs1v < immI ? 1 : 0; break;
          case 3: val = (rs1v >>> 0) < (immI >>> 0) ? 1 : 0; break;
          case 4: val = rs1v ^ immI; break;
          case 6: val = rs1v | immI; break;
          case 7: val = rs1v & immI; break;
          case 1:
            val = f7 === 0x00 ? rs1v << rs2 : this.illegal(w); // slli, shamt = rs2 field
            break;
          case 5:
            val = f7 === 0x00 ? rs1v >>> rs2
              : f7 === 0x20 ? rs1v >> rs2
              : this.illegal(w);
            break;
        }
        if (this.error === null) this.setReg(rd, val);
        break;
      }

      case 0x03: {
        // LOAD — little-endian, sign/zero extension per width, misaligned OK
        const addr = (rs1v + immI) >>> 0;
        const b0 = this.mem.get(addr) ?? 0;
        const b1 = this.mem.get((addr + 1) >>> 0) ?? 0;
        const b2 = this.mem.get((addr + 2) >>> 0) ?? 0;
        const b3 = this.mem.get((addr + 3) >>> 0) ?? 0;
        let val: number;
        switch (f3) {
          case 0: val = (b0 & 0x80) !== 0 ? b0 | 0xffffff00 : b0; break; // lb
          case 1: { // lh
            const h = b0 | (b1 << 8);
            val = (h & 0x8000) !== 0 ? h | 0xffff0000 : h;
            break;
          }
          case 2: val = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) | 0; break; // lw
          case 4: val = b0; break; // lbu
          case 5: val = b0 | (b1 << 8); break; // lhu
          default: val = this.illegal(w); break;
        }
        if (this.error === null) this.setReg(rd, val);
        break;
      }

      case 0x23: {
        // STORE
        const immS = (((w >>> 25) << 5) | ((w >>> 7) & 31)) << 20 >> 20;
        const addr = (rs1v + immS) >>> 0;
        if (f3 === 0) {
          this.mem.set(addr, rs2v & 255); // sb
        } else if (f3 === 1) {
          this.mem.set(addr, rs2v & 255);
          this.mem.set((addr + 1) >>> 0, (rs2v >>> 8) & 255); // sh
        } else if (f3 === 2) {
          this.mem.set(addr, rs2v & 255);
          this.mem.set((addr + 1) >>> 0, (rs2v >>> 8) & 255);
          this.mem.set((addr + 2) >>> 0, (rs2v >>> 16) & 255);
          this.mem.set((addr + 3) >>> 0, (rs2v >>> 24) & 255); // sw
        } else {
          this.illegal(w);
        }
        break;
      }

      case 0x63: {
        // BRANCH — record operands + outcome for the branch-context panel
        const imm =
          ((((w >>> 31) & 1) << 12) | (((w >>> 7) & 1) << 11) |
            (((w >>> 25) & 0x3f) << 5) | (((w >>> 8) & 0xf) << 1)) << 19 >> 19;
        let taken = false;
        switch (f3) {
          case 0: taken = rs1v === rs2v; break; // beq
          case 1: taken = rs1v !== rs2v; break; // bne
          case 4: taken = rs1v < rs2v; break; // blt (signed)
          case 5: taken = rs1v >= rs2v; break; // bge (signed)
          case 6: taken = (rs1v >>> 0) < (rs2v >>> 0); break; // bltu
          case 7: taken = (rs1v >>> 0) >= (rs2v >>> 0); break; // bgeu
          default: this.illegal(w); break;
        }
        this.lastBranch = {
          op: BRANCH_NAMES[f3] ?? "b?",
          rs1: REG_ABI[rs1]!,
          rs2: REG_ABI[rs2]!,
          v1: rs1v,
          v2: rs2v,
          taken,
        };
        if (taken) next = (this.pc + imm) >>> 0;
        break;
      }

      case 0x37: // lui
        this.setReg(rd, w & 0xfffff000);
        break;

      case 0x17: // auipc
        this.setReg(rd, (this.pc + (w & 0xfffff000)) | 0);
        break;

      case 0x6f: {
        // jal
        const imm =
          ((((w >>> 31) & 1) << 20) | (((w >>> 21) & 0x3ff) << 1) |
            (((w >>> 20) & 1) << 11) | (((w >>> 12) & 0xff) << 12)) << 11 >> 11;
        this.setReg(rd, (this.pc + 4) | 0);
        next = (this.pc + imm) >>> 0;
        break;
      }

      case 0x67: {
        // jalr (funct3 must be 0); target clears bit 0
        if (f3 !== 0) {
          this.illegal(w);
        } else {
          this.setReg(rd, (this.pc + 4) | 0);
          next = ((rs1v + immI) & ~1) >>> 0;
        }
        break;
      }

      case 0x73: {
        // SYSTEM: ecall / ebreak
        if (f3 !== 0) {
          this.illegal(w);
        } else if (immI === 0) {
          this.ecall(insn.sourceLine);
        } else if (immI === 1) {
          this.halted = "ebreak";
        } else {
          this.illegal(w);
        }
        break;
      }

      case 0x0f:
        // MISC-MEM: fence — a no-op on this single-hart teaching machine
        break;

      default:
        this.illegal(w);
        break;
    }

    if (this.error === null) this.pc = next;
  }

  private ecall(line: number): void {
    const a7 = this.regs[17];
    const a0 = this.regs[10];
    switch (a7) {
      case 1: // print int (signed decimal)
        this.emit(String(a0));
        break;
      case 4: {
        // print NUL-terminated string at a0
        const s = this.readString(a0 >>> 0);
        if (s === null) {
          this.fail(`ecall 4: string at 0x${(a0 >>> 0).toString(16)} has no NUL within 4096 bytes`, line);
        } else {
          this.emit(s);
        }
        break;
      }
      case 11: // print char (low byte of a0)
        this.emit(String.fromCharCode(a0 & 0xff));
        break;
      case 10:
      case 93:
        this.exitCode = a0;
        this.halted = "exit";
        break;
      default:
        this.fail(`unsupported ecall service a7=${a7} (supported: 1 print int, 4 print string, 11 print char, 10/93 exit)`, line);
        break;
    }
  }

  /** Record an illegal-encoding failure (never returns a useful value). */
  private illegal(w: number): number {
    this.fail(
      `illegal instruction encoding 0x${(w >>> 0).toString(16).padStart(8, "0")} at 0x${(this.pc >>> 0).toString(16)}`,
      this.prog.insnAt.get(this.pc)?.sourceLine ?? null,
    );
    return 0;
  }
}
