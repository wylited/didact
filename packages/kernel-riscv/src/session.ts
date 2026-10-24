// Session: adapts the proven v0.1 RV32IM assembler + interpreter
// (asm.ts / cpu.ts) to the async Kernel/Session contract. Semantics are
// preserved: sparse little-endian memory, x0 hard-wired to zero, venus-style
// ecalls (1 print int, 4 print string, 11 print char, 10/93 exit), RISC-V
// div/rem-by-zero semantics, and line-mapped assembly errors. This adapter
// adds: a 1,000,000-instruction run budget, stop-before breakpoints keyed by
// 1-based source line (`pausedAt`), register `changed` flags since the
// previous step, and panel snapshots (registers + pc, branch context,
// listing, .data hex view, console).

import { assemble, lineComments, hex32, REG_ABI, type Assembled } from './asm';
import { Cpu } from './cpu';
import type { Field, LoadResult, ListingRow, Panel, RunResult, Session } from './types';

const RUN_BUDGET = 1_000_000;
const HEXDUMP_BYTES = 256;
const HEXDUMP_ROW = 16;

export class RiscvSession implements Session {
  private cpu: Cpu | null = null;
  /** 1-based source line → trailing `#` comment (listing row tips). */
  private comments = new Map<number, string>();
  /** Register/pc snapshot after the previous step/run/reset (change flags). */
  private prevRegs: Int32Array | null = null;
  private prevPc = 0;
  /** Line the last run() paused on, if any (continue-past semantics). */
  private pausedLine: number | null = null;

  async load(src: string): Promise<LoadResult> {
    const result = assemble(src);
    if (!result.ok) {
      return { ok: false, line: result.error.line, message: result.error.message };
    }
    this.cpu = new Cpu(result.program);
    this.comments = lineComments(src);
    this.pausedLine = null;
    this.snapshot();
    return { ok: true, summary: `loaded · ${result.program.insns.length} instructions` };
  }

  async run(breakpoints?: number[]): Promise<RunResult> {
    const c = this.cpu;
    if (!c) return { finished: false, steps: 0, error: 'nothing is loaded' };
    if (c.error) return { finished: false, steps: c.steps, error: this.formatError(c) };
    if (c.halted !== null) return { finished: true, steps: c.steps, ...exitOf(c) };

    const bps = new Set(breakpoints ?? []);
    // Continuing from a pause on this very instruction must execute it
    // (matching `step()` from pause), not re-trip the same breakpoint.
    let skipFirstCheck =
      this.pausedLine !== null &&
      c.prog.insnAt.get(c.pc)?.sourceLine === this.pausedLine;
    this.pausedLine = null;
    // Baseline for `changed` flags: the state before this run's first step.
    this.snapshot();
    let budgetExceeded = false;

    while (c.halted === null && c.error === null) {
      const insn = c.prog.insnAt.get(c.pc);
      if (insn !== undefined && !skipFirstCheck && bps.has(insn.sourceLine)) {
        this.pausedLine = insn.sourceLine;
        break;
      }
      skipFirstCheck = false;
      c.step();
      if (c.steps >= RUN_BUDGET && c.halted === null && c.error === null) {
        budgetExceeded = true;
        break;
      }
    }


    if (budgetExceeded) {
      return {
        finished: false,
        steps: c.steps,
        error: `instruction budget of ${RUN_BUDGET.toLocaleString('en-US')} exceeded — is there an infinite loop?`,
      };
    }
    return runResult(c, this.pausedLine, this.formatError(c));
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    const c = this.cpu;
    if (!c) return { ran: false, result: { finished: false, steps: 0, error: 'nothing is loaded' } };
    if (c.error) return { ran: false, result: { finished: false, steps: c.steps, error: this.formatError(c) } };
    if (c.halted !== null) return { ran: false, result: { finished: true, steps: c.steps, ...exitOf(c) } };
    this.pausedLine = null;
    // Baseline for `changed` flags: the state before this instruction.
    this.snapshot();
    const before = c.steps;
    c.step();
    const ran = c.steps > before;
    return ran || c.halted !== null || c.error !== null
      ? { ran, result: runResult(c, null, this.formatError(c)) }
      : { ran };
  }

  reset(): void {
    const c = this.cpu;
    if (!c) return;
    c.reset();
    this.pausedLine = null;
    this.snapshot();
  }

  state(): Panel[] {
    const c = this.cpu;
    if (!c) return [];

    const fields: Field[] = [];
    for (let i = 0; i < 32; i++) {
      fields.push({
        key: `x${i} (${REG_ABI[i]})`,
        value: hex32(c.regs[i]),
        sub: String(c.regs[i]),
        ...(i !== 0 && this.prevRegs !== null && c.regs[i] !== this.prevRegs[i]
          ? { changed: true }
          : {}),
      });
    }
    fields.push({
      key: 'pc',
      value: hex32(c.pc),
      sub: String(c.pc >>> 0),
      ...(c.pc !== this.prevPc ? { changed: true } : {}),
    });

    const rows: ListingRow[] = c.prog.insns.map((ins) => {
      const tip = this.comments.get(ins.sourceLine);
      return {
        addr: ins.addr,
        bytes: wordHex(ins.bytes),
        text: ins.text,
        line: ins.sourceLine,
        ...(ins.addr === c.pc ? { current: true } : {}),
        ...(tip !== undefined ? { tip } : {}),
      };
    });

    const panels: Panel[] = [{ kind: 'fields', id: 'registers', title: 'Registers', fields }];

    // RISC-V has no flags register — the most recent branch *is* the state.
    if (c.lastBranch !== null) {
      const b = c.lastBranch;
      panels.push({
        kind: 'fields',
        id: 'branch',
        title: 'Branch',
        fields: [
          { key: b.rs1, value: hex32(b.v1), sub: String(b.v1) },
          { key: b.rs2, value: hex32(b.v2), sub: String(b.v2) },
          { key: b.op, value: b.taken ? 'taken' : 'not taken' },
        ],
      });
    }

    panels.push({ kind: 'listing', id: 'disassembly', title: 'Disassembly', rows });
    panels.push({ kind: 'hexdump', id: 'data', title: '.data', rows: dataRows(c) });
    panels.push({ kind: 'console', id: 'output', title: 'Output', text: c.outputText });
    return panels;
  }


  /** Capture the machine state that `changed` flags diff against. */
  private snapshot(): void {
    const c = this.cpu;
    if (!c) return;
    this.prevRegs = Int32Array.from(c.regs);
    this.prevPc = c.pc;
  }

  private formatError(c: Cpu): string {
    return c.error === null
      ? ''
      : c.errorLine !== null ? `line ${c.errorLine}: ${c.error}` : c.error;
  }

  dispose(): void {
    this.cpu = null;
  }
}

/** First `HEXDUMP_BYTES` of .data, read from live memory, 16 per row. */
function dataRows(c: Cpu): { addr: number; bytes: number[]; ascii: string }[] {
  const prog: Assembled = c.prog;
  const rows: { addr: number; bytes: number[]; ascii: string }[] = [];
  const end = Math.min(prog.dataEnd, prog.dataStart + HEXDUMP_BYTES);
  for (let a = prog.dataStart; a < end; a += HEXDUMP_ROW) {
    const bytes: number[] = [];
    for (let i = 0; i < HEXDUMP_ROW; i++) bytes.push(c.readByte(a + i));
    rows.push({
      addr: a,
      bytes,
      ascii: bytes.map((b) => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join(''),
    });
  }
  return rows;
}

/** Encoded 32-bit instruction word as 8 hex digits (e.g. 00410093). */
function wordHex(bytes: number[]): string {
  return (
    (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0
  )
    .toString(16)
    .padStart(8, '0');
}

function exitOf(c: Cpu): { exit?: string } {
  if (c.halted === 'exit') return { exit: `exit(${c.exitCode ?? 0})` };
  if (c.halted === 'ebreak') return { exit: 'ebreak' };
  if (c.halted === 'end') return { exit: 'end of .text' };
  return {};
}

function runResult(c: Cpu, pausedLine: number | null, formattedError: string): RunResult {
  if (c.error !== null) return { finished: false, steps: c.steps, error: formattedError };
  if (pausedLine !== null) return { finished: false, steps: c.steps, pausedAt: pausedLine };
  return { finished: c.halted !== null, steps: c.steps, ...exitOf(c) };
}
