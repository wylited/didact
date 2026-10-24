// Session: the pure-TS MIPS32 interpreter behind the Kernel/Session
// contract. Same discipline as the x86-64 kernel: 1,000,000-instruction
// run budget, stop-before-instruction breakpoints, one-instruction stepping,
// reset to the just-assembled state, and panels built from live machine
// state. The listing's bytes column shows the encoded 32-bit word of each
// machine instruction (pseudo-ops appear as their expanded rows, all mapped
// back to the source line); the hexdump shows live .data bytes.

import { ABI_NAMES, assemble, DATA_BASE, type WordRow } from './asm';
import { MipsMachine } from './machine';
import type { Field, LoadResult, ListingRow, Panel, RunResult, Session } from './types';

const RUN_BUDGET = 1_000_000;
const HEXDUMP_BYTES = 256;
const HEXDUMP_ROW = 16;

function hex8(v: number): string { return (v >>> 0).toString(16).padStart(8, '0'); }

export class MipsSession implements Session {
  private machine: MipsMachine | null = null;
  private program: { words: WordRow[]; data: Uint8Array } | null = null;
  private comments = new Map<number, string>();

  async load(src: string): Promise<LoadResult> {
    const result = assemble(src);
    if (!result.ok) {
      const first = result.errors[0] ?? { line: 1, message: 'cannot assemble this block' };
      return { ok: false, line: first.line, message: first.message };
    }
    this.program = { words: result.words, data: result.data };
    this.comments = result.comments;
    this.machine = new MipsMachine(this.program);
    return { ok: true, summary: `loaded · ${result.words.length} instructions` };
  }

  async run(breakpoints?: number[]): Promise<RunResult> {
    const m = this.machine;
    if (!m) return { finished: false, steps: 0, error: 'nothing is loaded' };
    if (m.error !== null) return { finished: false, steps: m.steps, error: m.error };
    if (m.finished) return { finished: true, steps: m.steps, ...exitOf(m) };
    const paused = m.run(RUN_BUDGET, breakpoints !== undefined ? new Set(breakpoints) : null);
    if (paused !== null) return { finished: false, steps: m.steps, pausedAt: paused };
    if (m.error !== null) return { finished: false, steps: m.steps, error: m.error };
    return { finished: true, steps: m.steps, ...exitOf(m) };
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    const m = this.machine;
    if (!m) return { ran: false, result: { finished: false, steps: 0, error: 'nothing is loaded' } };
    if (m.error !== null) return { ran: false, result: { finished: false, steps: m.steps, error: m.error } };
    if (m.finished) return { ran: false, result: { finished: true, steps: m.steps, ...exitOf(m) } };
    const before = m.steps;
    m.step();
    return m.steps > before ? { ran: true, result: runResult(m) } : { ran: false, result: runResult(m) };
  }

  reset(): void {
    if (this.program !== null) this.machine = new MipsMachine(this.program);
  }

  state(): Panel[] {
    const m = this.machine;
    if (!m) return [];
    const changed = m.changed;

    const fields: Field[] = ABI_NAMES.map((name, idx) => ({
      key: name,
      value: `0x${hex8(m.regs[idx]!)}`,
      sub: String(m.regs[idx]! | 0), // signed decimal: two's complement on display
      ...(changed.has(name) ? { changed: true } : {}),
    }));

    const hiLoPc: Field[] = [
      { key: 'hi', value: `0x${hex8(m.hi)}`, sub: String(m.hi | 0), ...(changed.has('hi') ? { changed: true } : {}) },
      { key: 'lo', value: `0x${hex8(m.lo)}`, sub: String(m.lo | 0), ...(changed.has('lo') ? { changed: true } : {}) },
      { key: 'pc', value: `0x${hex8(m.pc)}`, ...(changed.has('pc') ? { changed: true } : {}) },
    ];

    const current = m.currentRowIndex();
    const rows: ListingRow[] = m.words.map((w, i) => ({
      addr: w.addr,
      bytes: `${hex8(w.word).slice(0, 2)} ${hex8(w.word).slice(2, 4)} ${hex8(w.word).slice(4, 6)} ${hex8(w.word).slice(6, 8)}`,
      text: w.text,
      line: w.line,
      ...(i === current ? { current: true } : {}),
      // The only tooltip: the source line's own trailing # comment.
      ...(this.comments.get(w.line) !== undefined ? { tip: this.comments.get(w.line) } : {}),
    }));

    const hexdump: { addr: number; bytes: number[]; ascii: string }[] = [];
    const span = Math.min(m.dataLen, HEXDUMP_BYTES);
    for (let off = 0; off < span; off += HEXDUMP_ROW) {
      const row: number[] = [];
      for (let i = 0; i < HEXDUMP_ROW && off + i < span; i++) row.push(m.readByte(DATA_BASE + off + i) ?? 0);
      hexdump.push({
        addr: DATA_BASE + off,
        bytes: row,
        ascii: row.map((b) => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join(''),
      });
    }

    return [
      { kind: 'fields', id: 'registers', title: 'Registers', fields },
      { kind: 'fields', id: 'hi-lo-pc', title: 'hi · lo · pc', fields: hiLoPc },
      { kind: 'listing', id: 'listing', title: 'Program', rows },
      { kind: 'hexdump', id: 'memory', title: '.data', rows: hexdump },
      { kind: 'console', id: 'output', title: 'Output', text: m.output },
    ];
  }

  dispose(): void {
    this.machine = null;
  }
}

function exitOf(m: MipsMachine): { exit?: string } {
  return m.exitCode !== null ? { exit: `exit(${m.exitCode})` } : {};
}

function runResult(m: MipsMachine): RunResult {
  if (m.error !== null) return { finished: false, steps: m.steps, error: m.error };
  if (m.finished) return { finished: true, steps: m.steps, ...exitOf(m) };
  return { finished: false, steps: m.steps };
}

