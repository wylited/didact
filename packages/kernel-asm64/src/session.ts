// Session: adapts the synchronous v0.1 Machine (unicorn/keystone/capstone)
// to the async Kernel/Session contract. All hard-won execution semantics are
// preserved: fresh unicorn instance per load, `jmp $` trap after the code,
// HOOK_CODE stop-before-second-instruction stepping, 1,000,000-instruction
// run budget, syscall interception for write/exit, engine recreation after
// failures, and line-mapped assemble errors.

import { assemble, DATA_BASE, lineComments } from './asm';
import { Machine, formatHex64, formatDec64, GPR_NAMES, FLAG_DEFS } from './machine';
import { loadEngines, KeystoneFacade } from './vendor';
import type { Field, LoadResult, ListingRow, Panel, RunResult, Session } from './types';

const RUN_BUDGET = 1_000_000;
const HEXDUMP_BYTES = 256;
const HEXDUMP_ROW = 16;

export class Asm64Session implements Session {
  private machine: Machine | null = null;
  private notes: string[] = [];
  /** 1-based source line → trailing `;` comment (listing row tips). */
  private comments = new Map<number, string>();

  async load(src: string): Promise<LoadResult> {
    let engines;
    try {
      engines = await loadEngines();
    } catch (e) {
      return {
        ok: false,
        line: 1,
        message: `failed to load the emulator engines: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const ks = new KeystoneFacade(engines.keystone);
    const result = assemble(src, ks);
    if (!result.ok) {
      const first = result.errors[0] ?? { line: 1, message: 'cannot assemble this block' };
      return { ok: false, line: first.line, message: first.message };
    }
    const disasm = new engines.capstone.Capstone(engines.capstone.ARCH_X86, engines.capstone.MODE_64);
    const machine = new Machine(engines.unicorn, disasm, {
      onNote: (text) => this.notes.push(text),
    });
    machine.load(result.program);
    this.machine = machine;
    this.notes = [];
    this.comments = lineComments(src);
    return { ok: true, summary: `loaded · ${machine.rows.length} instructions` };
  }

  async run(breakpoints?: number[]): Promise<RunResult> {
    const m = this.machine;
    if (!m) return { finished: false, steps: 0, error: 'nothing is loaded' };
    if (m.phase === 'error' || m.error) {
      return { finished: false, steps: m.totalInsns, error: m.error ?? 'the emulator faulted — press Reset' };
    }
    if (m.finished) {
      return { finished: true, steps: m.totalInsns, ...exitOf(m) };
    }
    m.run(RUN_BUDGET, breakpoints);
    return runResult(m);
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    const m = this.machine;
    if (!m) return { ran: false, result: { finished: false, steps: 0, error: 'nothing is loaded' } };
    if (m.phase === 'error' || m.error) {
      return { ran: false, result: { finished: false, steps: m.totalInsns, error: m.error ?? 'the emulator faulted — press Reset' } };
    }
    if (m.finished) {
      return { ran: false, result: { finished: true, steps: m.totalInsns, ...exitOf(m) } };
    }
    const before = m.totalInsns;
    m.step();
    const ran = m.totalInsns > before;
    return ran || m.finished || m.error
      ? { ran, result: runResult(m) }
      : { ran };
  }

  reset(): void {
    this.machine?.reset();
    this.notes = [];
  }

  state(): Panel[] {
    const m = this.machine;
    if (!m) return [];
    const regs = m.snapshot();
    const changed = m.changedSinceLastStep();
    const currentRow = m.currentRowIndex();

    const fields: Field[] = GPR_NAMES.map((name) => ({
      key: name,
      value: formatHex64(regs.gpr[name]),
      sub: formatDec64(regs.gpr[name]),
      ...(changed.has(name) ? { changed: true } : {}),
    }));
    fields.push({
      key: 'rip',
      value: formatHex64(regs.rip),
      sub: formatDec64(regs.rip),
      ...(changed.has('rip') ? { changed: true } : {}),
    });

    const flagFields: Field[] = FLAG_DEFS.map((f) => ({
      key: f.name,
      value: m.isFlagSet(f.bit) ? '1' : '0',
    }));

    const rows: ListingRow[] = m.rows.map((r, i) => {
      const comment = r.line !== null ? this.comments.get(r.line) : undefined;
      return {
        addr: r.addr,
        bytes: Array.from(r.bytes).map((b) => b.toString(16).padStart(2, '0')).join(' '),
        text: r.text,
        ...(r.line !== null ? { line: r.line } : {}),
        ...(i === currentRow ? { current: true } : {}),
        ...(comment !== undefined ? { tip: comment } : {}),
      };
    });

    const view = m.dataView();
    const hexdump: { addr: number; bytes: number[]; ascii: string }[] = [];
    for (let off = 0; off < Math.min(view.length, HEXDUMP_BYTES); off += HEXDUMP_ROW) {
      const row = Array.from(view.subarray(off, off + HEXDUMP_ROW));
      hexdump.push({
        addr: DATA_BASE + off,
        bytes: row,
        ascii: row.map((b) => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join(''),
      });
    }

    const consoleText =
      m.outputText + (this.notes.length > 0 ? (m.outputText && !m.outputText.endsWith('\n') ? '\n' : '') + this.notes.join('\n') + '\n' : '');

    return [
      { kind: 'fields', id: 'registers', title: 'Registers', fields },
      { kind: 'fields', id: 'eflags', title: 'EFLAGS', fields: flagFields },
      { kind: 'listing', id: 'disassembly', title: 'Disassembly', rows },
      { kind: 'hexdump', id: 'memory', title: '.data', rows: hexdump },
      { kind: 'console', id: 'output', title: 'Output', text: consoleText },
    ];
  }

  dispose(): void {
    this.machine?.dispose();
    this.machine = null;
  }
}

function exitOf(m: Machine): { exit?: string } {
  return m.exitCode !== null ? { exit: `exit(${m.exitCode})` } : {};
}

function runResult(m: Machine): RunResult {
  if (m.error) return { finished: false, steps: m.totalInsns, error: m.error };
  if (m.budgetExceeded) {
    return {
      finished: false,
      steps: m.totalInsns,
      error: `instruction budget of ${RUN_BUDGET.toLocaleString('en-US')} exceeded — is there an infinite loop?`,
    };
  }
  return {
    finished: m.finished,
    steps: m.totalInsns,
    ...(m.pausedAtLine !== null ? { pausedAt: m.pausedAtLine } : {}),
    ...exitOf(m),
  };
}
