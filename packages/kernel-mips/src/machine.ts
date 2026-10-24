// MIPS32 interpreter: fetch–decode–execute.
//
// The machine is honest about the under-the-hood view: `.text` words are
// written into (little-endian) memory and every step *fetches* the word at
// pc and decodes its op/rs/rt/rd/shamt/funct fields — the listing's encoded
// column is exactly what executes. No branch delay slots (MARS/SPIM default
// teaching mode): a taken branch moves pc to the target immediately, and
// jal/jalr link pc+4, the address of the next instruction in program order.
//
// Teaching traps, all naming the source line and instruction:
//   - add/addi/sub signed overflow (the u-forms wrap instead)
//   - division by zero (real MIPS leaves hi/lo UNPREDICTABLE; we stop)
//   - unaligned lw/lh/sw/sh and access outside mapped memory
//   - stores into .text
//   - unknown syscalls (this kernel implements 1, 4, 10, 11)

import { ABI_NAMES, DATA_BASE, TEXT_BASE, type WordRow } from './asm';

const PAGE = 4096;
const STACK_INIT = 0x7fff_effc; // SPIM's initial $sp
const GP_INIT = 0x1000_8000;    // SPIM's $gp (global-pointer area base)
/** Stack segment: stores below this line may map pages on demand. */
const STACK_LOW = 0x7ff0_0000;
const INT32_MIN = -0x8000_0000, INT32_MAX = 0x7fff_ffff;
const MAX_STRING = 4096;        // print_string runaway guard

export interface Program { words: WordRow[]; data: Uint8Array }

function hex8(v: number): string { return (v >>> 0).toString(16).padStart(8, '0'); }

export class MipsMachine {
  readonly regs = new Uint32Array(32);
  hi = 0;
  lo = 0;
  pc = TEXT_BASE;
  output = '';
  finished = false;
  exitCode: number | null = null;
  error: string | null = null;
  steps = 0;
  /** Source line the machine is parked on (last breakpoint pause), if
   *  any; cleared once execution moves to a different line. */
  parkedLine: number | null = null;
  readonly changed = new Set<string>();
  readonly words: readonly WordRow[];
  readonly dataLen: number;

  private readonly pages = new Map<number, Uint8Array>();
  private readonly lineMap = new Map<number, { line: number; text: string }>();
  private readonly textEnd: number;

  constructor(prog: Program) {
    this.words = prog.words;
    this.dataLen = prog.data.length;
    this.textEnd = TEXT_BASE + prog.words.length * 4;
    for (const w of prog.words) {
      this.lineMap.set(w.addr, { line: w.line, text: w.text });
      this.write32(w.addr, w.word);
    }
    for (let i = 0; i < prog.data.length; i++) this.write8(DATA_BASE + i, prog.data[i]!);
    this.regs[28] = GP_INIT;
    this.regs[29] = STACK_INIT;
    this.regs[31] = 0; // jr $ra before any jal → caught as a jump outside .text
  }

  /** Run until finished/error/budget, or *before* an instruction whose
   *  source line is in `breakpoints`; returns the paused line or null. */
  run(budget: number, breakpoints: ReadonlySet<number> | null): number | null {
    // Resuming a parked machine must not immediately re-trip the
    // breakpoint it is parked on: skip every word of the entry line once
    // (a pseudo-op expands to several words with the same source line);
    // once execution moves to a different line, later hits pause again.
    const entryLine = this.lineMap.get(this.pc)?.line;
    let resuming = this.parkedLine !== null && entryLine === this.parkedLine;
    while (!this.finished && this.error === null) {
      if (this.steps >= budget) {
        this.error = `instruction budget of ${budget.toLocaleString('en-US')} steps exceeded — this looks like an infinite loop`;
        break;
      }
      const info = this.lineMap.get(this.pc);
      if (info !== undefined && breakpoints !== null && breakpoints.has(info.line)) {
        if (!resuming || info.line !== entryLine) {
          this.parkedLine = info.line;
          return info.line;
        }
      }
      if (resuming && info !== undefined && info.line !== entryLine) resuming = false;
      this.step();
      const nowLine = this.lineMap.get(this.pc)?.line;
      if (nowLine !== undefined && nowLine !== this.parkedLine) this.parkedLine = null;
    }
    return null;
  }

  /** Execute exactly one instruction. */
  step(): void {
    if (this.finished || this.error !== null) return;
    const info = this.lineMap.get(this.pc);
    const line = info !== undefined ? info.line : 0;
    const src = info !== undefined ? info.text.replace(/\s+/g, ' ') : `word at 0x${hex8(this.pc)}`;
    if (this.pc % 4 !== 0) return this.fail(line, `jumped to 0x${hex8(this.pc)} — not word-aligned`);
    if (this.pc === this.textEnd)
      return this.fail(line, `fell off the end of the program (pc 0x${hex8(this.pc)}) — end with li $v0, 10 / syscall`);
    if (this.pc < TEXT_BASE || this.pc > this.textEnd)
      return this.fail(line, `jumped to 0x${hex8(this.pc)} — outside .text (is $ra still 0? exit with syscall 10 instead of jr)`);

    const word = this.read32(this.pc);
    const op = word >>> 26;
    const rs = (word >>> 21) & 31;
    const rt = (word >>> 16) & 31;
    const rd = (word >>> 11) & 31;
    const sh = (word >>> 6) & 31;
    const funct = word & 63;
    const imm = word & 0xffff;
    const simm = imm >= 0x8000 ? imm - 0x10000 : imm;
    this.changed.clear();
    const w = (idx: number, val: number): void => {
      if (idx !== 0) { // writes to $zero are silently dropped, as in real MIPS
        this.regs[idx] = val >>> 0;
        this.changed.add(ABI_NAMES[idx]!);
      }
    };
    let next = this.pc + 4;
    const jump = (target: number): void => { next = target; this.changed.add('pc'); };

    // ---- helpers that trap -------------------------------------------------
    const addTrap = (a: number, b: number, mnem: string): number | null => {
      const sum = (a | 0) + (b | 0);
      if (sum > INT32_MAX || sum < INT32_MIN) {
        this.fail(line, `${src}: ${mnem} overflowed — ${a | 0} + ${b | 0} does not fit in a signed 32-bit register (use the u-form to wrap)`);
        return null;
      }
      return sum;
    };
    const subTrap = (a: number, b: number, mnem: string): number | null => {
      const diff = (a | 0) - (b | 0);
      if (diff > INT32_MAX || diff < INT32_MIN) {
        this.fail(line, `${src}: ${mnem} overflowed — ${a | 0} − ${b | 0} does not fit in a signed 32-bit register (use the u-form to wrap)`);
        return null;
      }
      return diff;
    };
    const addr2 = (): number | null => { // word-aligned data address
      const a = (this.regs[rs]! + simm) >>> 0;
      if (a % 4 !== 0) { this.fail(line, `${src}: unaligned word access at 0x${hex8(a)} (lw/sw need 4-byte alignment)`); return null; }
      return a;
    };
    const addr1 = (): number | null => { // halfword-aligned data address
      const a = (this.regs[rs]! + simm) >>> 0;
      if (a % 2 !== 0) { this.fail(line, `${src}: unaligned halfword access at 0x${hex8(a)} (lh/lhu/sh need 2-byte alignment)`); return null; }
      return a;
    };
    const loadU = (a: number, size: 1 | 2 | 4, mnem: string): number | null => {
      let v = 0;
      for (let i = 0; i < size; i++) {
        const b = this.readByte(a + i);
        if (b === null) {
          this.fail(line, `${src}: ${mnem} read unmapped memory at 0x${hex8((a + i) >>> 0)}`);
          return null;
        }
        v |= b << (8 * i); // little-endian, like SPIM on x86 hosts
      }
      return v >>> 0;
    };
    const store = (a: number, size: 1 | 2 | 4, val: number, mnem: string): void => {
      for (let i = 0; i < size; i++) {
        const at = (a + i) >>> 0;
        if (at >= TEXT_BASE && at < this.textEnd) {
          this.fail(line, `${src}: ${mnem} store into .text at 0x${hex8(at)} — .text is read-only in this kernel`);
          return;
        }
        // Wild stores must not silently succeed (and must not map pages):
        // only already-mapped pages (text/data) and the stack segment
        // accept writes; everything else is an unmapped-store fault, as
        // in SPIM.
        const inStack = at >= STACK_LOW && at < 0x8000_0000;
        if (!inStack && !this.pages.has(at & ~(PAGE - 1))) {
          this.fail(line, `${src}: ${mnem} store to unmapped memory at 0x${hex8(at)} (data is at 0x10010000, the stack grows down from 0x7fffeffc)`);
          return;
        }
        this.write8(at, val >>> (8 * i));
      }
    };

    switch (op) {
      case 0x00: // SPECIAL
        switch (funct) {
          case 0x00: w(rd, this.regs[rt]! << sh); break;
          case 0x02: w(rd, this.regs[rt]! >>> sh); break;
          case 0x03: w(rd, (this.regs[rt]! | 0) >> sh); break;
          case 0x04: w(rd, this.regs[rt]! << (this.regs[rs]! & 31)); break;
          case 0x06: w(rd, this.regs[rt]! >>> (this.regs[rs]! & 31)); break;
          case 0x07: w(rd, (this.regs[rt]! | 0) >> (this.regs[rs]! & 31)); break;
          case 0x08: jump(this.regs[rs]!); break; // jr
          case 0x09: w(rd, this.pc + 4); jump(this.regs[rs]!); break; // jalr (1-op form encoded rd=$ra)
          case 0x0c: this.syscall(line, src); break;
          case 0x10: w(rd, this.hi); break; // mfhi
          case 0x11: this.hi = this.regs[rs]!; this.changed.add('hi'); break; // mthi
          case 0x12: w(rd, this.lo); break; // mflo
          case 0x13: this.lo = this.regs[rs]!; this.changed.add('lo'); break; // mtlo
          case 0x18: case 0x19: { // mult/multu: exact 64-bit product in hi:lo
            const a = funct === 0x18 ? BigInt(this.regs[rs]! | 0) : BigInt(this.regs[rs]! >>> 0);
            const b = funct === 0x18 ? BigInt(this.regs[rt]! | 0) : BigInt(this.regs[rt]! >>> 0);
            const prod = a * b;
            this.hi = Number(BigInt.asUintN(32, prod >> 32n));
            this.lo = Number(BigInt.asUintN(32, prod));
            this.changed.add('hi'); this.changed.add('lo');
            break;
          }
          case 0x1a: case 0x1b: { // div/divu: quotient lo, remainder hi (truncate toward 0)
            if (this.regs[rt]! === 0) {
              this.fail(line, `${src}: division by zero — real MIPS leaves hi/lo UNPREDICTABLE; this kernel stops instead`);
              break;
            }
            const a = funct === 0x1a ? BigInt(this.regs[rs]! | 0) : BigInt(this.regs[rs]! >>> 0);
            const b = funct === 0x1a ? BigInt(this.regs[rt]! | 0) : BigInt(this.regs[rt]! >>> 0);
            this.lo = Number(BigInt.asUintN(32, a / b));
            this.hi = Number(BigInt.asUintN(32, a % b));
            this.changed.add('hi'); this.changed.add('lo');
            break;
          }
          case 0x20: { const s = addTrap(this.regs[rs]!, this.regs[rt]!, 'add'); if (s !== null) w(rd, s); break; }
          case 0x21: w(rd, this.regs[rs]! + this.regs[rt]!); break; // addu
          case 0x22: { const d = subTrap(this.regs[rs]!, this.regs[rt]!, 'sub'); if (d !== null) w(rd, d); break; }
          case 0x23: w(rd, this.regs[rs]! - this.regs[rt]!); break; // subu
          case 0x24: w(rd, this.regs[rs]! & this.regs[rt]!); break;
          case 0x25: w(rd, this.regs[rs]! | this.regs[rt]!); break;
          case 0x26: w(rd, this.regs[rs]! ^ this.regs[rt]!); break;
          case 0x27: w(rd, ~(this.regs[rs]! | this.regs[rt]!)); break; // nor
          case 0x2a: w(rd, (this.regs[rs]! | 0) < (this.regs[rt]! | 0) ? 1 : 0); break; // slt
          case 0x2b: w(rd, (this.regs[rs]! >>> 0) < (this.regs[rt]! >>> 0) ? 1 : 0); break; // sltu
          default:
            this.fail(line, `illegal instruction word 0x${hex8(word)} (funct 0x${funct.toString(16)})`);
        }
        break;

      case 0x01: // REGIMM: bltz (rt=0) / bgez (rt=1)
        if (rt === 0) { if ((this.regs[rs]! | 0) < 0) jump(this.pc + 4 + (simm << 2)); }
        else if (rt === 1) { if ((this.regs[rs]! | 0) >= 0) jump(this.pc + 4 + (simm << 2)); }
        else this.fail(line, `illegal instruction word 0x${hex8(word)} (REGIMM rt=${rt})`);
        break;

      case 0x02: jump(((this.pc + 4) & 0xf000_0000) | ((word & 0x03ff_ffff) << 2)); break; // j
      case 0x03: w(31, this.pc + 4); jump(((this.pc + 4) & 0xf000_0000) | ((word & 0x03ff_ffff) << 2)); break; // jal
      case 0x04: if (this.regs[rs]! === this.regs[rt]!) jump(this.pc + 4 + (simm << 2)); break; // beq
      case 0x05: if (this.regs[rs]! !== this.regs[rt]!) jump(this.pc + 4 + (simm << 2)); break; // bne
      case 0x06: if ((this.regs[rs]! | 0) <= 0) jump(this.pc + 4 + (simm << 2)); break; // blez
      case 0x07: if ((this.regs[rs]! | 0) > 0) jump(this.pc + 4 + (simm << 2)); break; // bgtz
      case 0x08: { const s = addTrap(this.regs[rs]!, simm, 'addi'); if (s !== null) w(rt, s); break; }
      case 0x09: w(rt, this.regs[rs]! + simm); break; // addiu
      case 0x0a: w(rt, (this.regs[rs]! | 0) < simm ? 1 : 0); break; // slti
      case 0x0b: w(rt, (this.regs[rs]! >>> 0) < (simm >>> 0) ? 1 : 0); break; // sltiu (imm sign-extended, compare unsigned)
      case 0x0c: w(rt, this.regs[rs]! & imm); break; // andi (zero-extended)
      case 0x0d: w(rt, this.regs[rs]! | imm); break; // ori
      case 0x0e: w(rt, this.regs[rs]! ^ imm); break; // xori
      case 0x0f: w(rt, imm << 16); break; // lui

      case 0x20: case 0x24: { // lb / lbu (no alignment requirement)
        const a = (this.regs[rs]! + simm) >>> 0;
        const b = loadU(a, 1, op === 0x20 ? 'lb' : 'lbu');
        if (b !== null) w(rt, op === 0x20 && b >= 0x80 ? b - 0x100 : b); // lb sign-extends
        break;
      }
      case 0x21: case 0x25: { // lh / lhu
        const a = addr1();
        if (a === null) break;
        const v = loadU(a, 2, op === 0x21 ? 'lh' : 'lhu');
        if (v !== null) w(rt, op === 0x21 && v >= 0x8000 ? v - 0x10000 : v); // lh sign-extends
        break;
      }
      case 0x23: { // lw
        const a = addr2();
        if (a === null) break;
        const v = loadU(a, 4, 'lw');
        if (v !== null) w(rt, v);
        break;
      }
      case 0x28: store((this.regs[rs]! + simm) >>> 0, 1, this.regs[rt]!, 'sb'); break;
      case 0x29: { // sh
        const a = addr1();
        if (a === null) break;
        store(a, 2, this.regs[rt]!, 'sh');
        break;
      }
      case 0x2b: { // sw
        const a = addr2();
        if (a === null) break;
        store(a, 4, this.regs[rt]!, 'sw');
        break;
      }
      default:
        this.fail(line, `illegal instruction word 0x${hex8(word)} (opcode 0x${op.toString(16)})`);
    }

    if (this.error !== null) return;
    this.pc = next >>> 0;
    this.steps++;
    // a manual step leaves the park once execution moves to a new line
    const nowLine = this.lineMap.get(this.pc)?.line;
    if (nowLine !== undefined && nowLine !== this.parkedLine) this.parkedLine = null;
  }

  /** Listing index of the instruction at pc (about to execute), or −1. */
  currentRowIndex(): number {
    const idx = (this.pc - TEXT_BASE) / 4;
    return Number.isInteger(idx) && idx >= 0 && idx < this.words.length ? idx : -1;
  }

  /** Byte at `addr` or null if unmapped (hexdump uses this). */
  readByte(addr: number): number | null {
    const page = this.pages.get((addr >>> 0) & ~(PAGE - 1));
    return page === undefined ? null : page[(addr >>> 0) & (PAGE - 1)]!;
  }

  // ---- internals -----------------------------------------------------------

  private syscall(line: number, src: string): void {
    const v0 = this.regs[2]!;
    const a0 = this.regs[4]!;
    switch (v0) {
      case 1: this.output += (a0 | 0).toString(10); break;
      case 4: { // print NUL-terminated string at $a0
        let s = '';
        for (let i = 0; i < MAX_STRING; i++) {
          const b = this.readByte(a0 + i);
          if (b === null) {
            this.fail(line, `${src}: print_string read unmapped memory at 0x${hex8((a0 + i) >>> 0)} — is $a0 a string address?`);
            return;
          }
          if (b === 0) break;
          s += String.fromCharCode(b);
        }
        if (s.length === MAX_STRING) {
          this.fail(line, `${src}: print_string hit its ${MAX_STRING}-byte limit — unterminated string?`);
          return;
        }
        this.output += s;
        break;
      }
      case 11: this.output += String.fromCharCode(a0 & 0xff); break;
      case 10: this.finished = true; this.exitCode = 0; break;
      default:
        this.fail(line, `${src}: syscall ${v0} is not implemented in this teaching kernel (supported: 1 print int, 4 print string, 10 exit, 11 print char)`);
    }
  }

  private fail(line: number, message: string): void {
    this.error = line > 0 ? `line ${line}: ${message}` : message;
  }

  private pageFor(addr: number): Uint8Array {
    const base = (addr >>> 0) & ~(PAGE - 1);
    let page = this.pages.get(base);
    if (page === undefined) { page = new Uint8Array(PAGE); this.pages.set(base, page); }
    return page;
  }

  private write8(addr: number, val: number): void {
    const a = addr >>> 0;
    this.pageFor(a)[a & (PAGE - 1)] = val & 0xff;
  }

  private write32(addr: number, val: number): void {
    this.write8(addr, val);
    this.write8(addr + 1, val >>> 8);
    this.write8(addr + 2, val >>> 16);
    this.write8(addr + 3, val >>> 24);
  }

  private read32(addr: number): number {
    return ((this.readByte(addr + 3)! << 24) | (this.readByte(addr + 2)! << 16)
      | (this.readByte(addr + 1)! << 8) | this.readByte(addr)!) >>> 0;
  }
}
