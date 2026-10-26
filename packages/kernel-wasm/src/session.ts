// session.ts — the Kernel/Session contract over the wasm machine. Panels
// tell the under-the-hood story the lesson teaches:
//   Instructions — the flat sequence your folded source became; the bytes
//                   column carries the real wasm binary opcodes.
//   Operand stack — bottom → top, signed decimal + hex, top marked.
//   Locals/Globals — per-call locals and module globals, writes flagged.
//   Call stack    — who called whom, and the line each returns to.
//   Memory        — first 256 bytes plus the last written region.
//   Output        — didact print / print_char text.

import type { Field, ListingRow, LoadResult, Panel, RunResult, Session } from './types';
import { compile } from './compile';
import type { Module } from './compile';
import { WatError } from './reader';
import { Machine } from './machine';

const hex32 = (v: number): string => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
const hex2 = (v: number): string => `0x${v.toString(16).padStart(2, '0')}`;

/** Unnamed functions get '#index'; the entry point reads better as main. */
function displayNameOf(f: { name: string; exportName: string | null }): string {
  return f.exportName === 'main' ? 'main' : f.name;
}
export class WasmSession implements Session {
  private module: Module | null = null;
  private machine: Machine | null = null;

  async load(src: string): Promise<LoadResult> {
    try {
      this.module = compile(src);
    } catch (e) {
      this.module = null;
      this.machine = null;
      if (e instanceof WatError) return { ok: false, line: e.line, message: e.message };
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    this.machine = new Machine(this.module);
    return { ok: true, summary: `loaded · ${this.module.instrCount} instructions` };
  }

  async run(breakpoints?: number[]): Promise<RunResult> {
    const m = this.machine;
    if (m === null) return { finished: false, steps: 0, error: 'nothing is loaded' };
    const bps = breakpoints !== undefined ? new Set(breakpoints) : null;
    while (!m.finished && m.error === null) {
      const line = m.currentLine();
      // Pause *before* running an instruction whose source line is a break.
      if (bps !== null && line !== null && bps.has(line)) {
        return { ...this.result(m), pausedAt: line };
      }
      m.step();
    }
    return this.result(m);
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    const m = this.machine;
    if (m === null) return { ran: false, result: { finished: false, steps: 0, error: 'nothing is loaded' } };
    if (m.finished || m.error !== null) return { ran: false, result: this.result(m) };
    m.step();
    return { ran: true, result: this.result(m) };
  }

  reset(): void {
    if (this.module !== null) this.machine = new Machine(this.module);
  }

  state(): Panel[] {
    const m = this.machine;
    if (m === null) return [];
    return [
      this.instructionsPanel(m),
      this.stackPanel(m),
      this.localsPanel(m),
      this.globalsPanel(m),
      this.callStackPanel(m),
      this.memoryPanel(m),
      { kind: 'console', id: 'output', title: 'Output', text: m.output },
    ];
  }

  dispose(): void {
    this.machine = null;
    this.module = null;
  }

  private result(m: Machine): RunResult {
    if (m.error !== null) return { finished: false, steps: m.steps, error: m.error };
    if (m.finished) {
      return m.exitValue === null
        ? { finished: true, steps: m.steps, exit: 'main returned' }
        : { finished: true, steps: m.steps, exit: `main → ${m.exitValue}` };
    }
    return { finished: false, steps: m.steps };
  }

  private instructionsPanel(m: Machine): Panel {
    const func = m.displayFunc();
    const top = m.frames[m.frames.length - 1];
    const inThisFunc = top !== undefined && top.func === func;
    const rows: ListingRow[] = func.code.map((ins, pc) => ({
      addr: pc,
      bytes: hex2(ins.opcode),
      text: ins.text,
      line: ins.line,
      current: inThisFunc && top.pc === pc,
    }));
    return {
      kind: 'listing',
      id: 'instructions',
      title: `Instructions · ${displayNameOf(func)}`,
      tip: 'The flat instruction sequence your folded source translated to. The bytes column is the real WebAssembly opcode — the same bytes a compiled C lesson ships.',
      rows,
    };
  }

  private stackPanel(m: Machine): Panel {
    const rows: ListingRow[] = m.valueStack.map((v, i) => ({
      addr: i,
      bytes: hex32(v),
      text: String(v),
      current: i === m.valueStack.length - 1,
      tip: i === m.valueStack.length - 1 ? 'top of the stack — the next instruction consumes from here' : undefined,
    }));
    return {
      kind: 'listing',
      id: 'stack',
      title: `Operand stack · ${rows.length} value${rows.length === 1 ? '' : 's'}`,
      tip: 'Bottom → top. Every value is 32 bits: decimal reading, and the exact bit pattern in hex.',
      rows,
    };
  }

  private localsPanel(m: Machine): Panel {
    const top = m.frames[m.frames.length - 1];
    const fields: Field[] = [];
    if (top !== undefined) {
      for (let i = 0; i < top.locals.length; i++) {
        const v = top.locals[i]!;
        fields.push({
          key: top.func.localNames[i] ?? `#${i}`,
          value: hex32(v),
          sub: String(v),
          changed: top.localsDirty[i] === true,
          tip: i < top.func.paramCount ? 'parameter — set by the caller' : 'local — starts at 0 every call',
        });
      }
      top.localsDirty.fill(false); // flags cover "since the previous step"
    }
    return {
      kind: 'fields',
      id: 'locals',
      title: top !== undefined ? `Locals · ${displayNameOf(top.func)}` : 'Locals',
      tip: 'Parameters first, then (local …) declarations. Each call gets a fresh set.',
      fields,
    };
  }

  private globalsPanel(m: Machine): Panel {
    const fields: Field[] = this.module!.globals.map((g, i) => ({
      key: g.name ?? `#${i}`,
      value: hex32(m.globals[i]!),
      sub: String(m.globals[i]),
      changed: m.globalsDirty[i] === true,
      tip: g.mutable ? 'mutable global — module-wide, shared by every call' : 'immutable global',
    }));
    m.globalsDirty.fill(false);
    return {
      kind: 'fields',
      id: 'globals',
      title: `Globals · ${fields.length}`,
      tip: 'Declared in the module, initialized before main runs, shared by every call.',
      fields,
    };
  }

  private callStackPanel(m: Machine): Panel {
    const rows: ListingRow[] = m.frames.map((f, i) => {
      const name = displayNameOf(f.func);
      const waiting = m.frames[i + 1]; // the call this frame is suspended in
      return {
        addr: i,
        bytes: hex2(f.func.index),
        text: waiting === undefined
          ? `${name} · line ${f.func.code[f.pc]?.line ?? '—'}`
          : `${name} · waiting at line ${waiting.retLine ?? '—'}`,
        current: i === m.frames.length - 1,
      };
    });
    return {
      kind: 'listing',
      id: 'callstack',
      title: `Call stack · ${rows.length} frame${rows.length === 1 ? '' : 's'}`,
      tip: 'Outermost first. Each frame keeps its own locals and control stack; calls never share state.',
      rows,
    };
  }

  /** First 256 bytes, then exactly the 16-byte rows covering the most
   *  recent store once it moves past them — little-endian bytes. */
  private memoryPanel(m: Machine): Panel {
    const mem = m.memory;
    const rows: { addr: number; bytes: number[]; ascii: string }[] = [];
    const rowAt = (addr: number): void => {
      const bytes: number[] = [];
      let ascii = '';
      for (let i = 0; i < 16; i++) {
        const b = addr + i < mem.length ? mem[addr + i]! : 0;
        bytes.push(b);
        ascii += b >= 32 && b <= 126 ? String.fromCharCode(b) : '.';
      }
      rows.push({ addr, bytes, ascii });
    };
    for (let addr = 0; addr < Math.min(256, mem.length); addr += 16) rowAt(addr);
    if (m.lastWrite !== null && m.lastWrite.min >= 256) {
      const start = m.lastWrite.min - (m.lastWrite.min % 16);
      const end = m.lastWrite.max - (m.lastWrite.max % 16); // row containing the last byte
      for (let addr = start; addr <= end && addr < mem.length; addr += 16) rowAt(addr);
    }
    return {
      kind: 'hexdump',
      id: 'memory',
      title: m.pages === 0 ? 'Memory · none' : `Memory · ${m.pages} page${m.pages === 1 ? '' : 's'} · ${mem.length} bytes`,
      tip: 'One page is 65536 bytes. Shows the first 256 bytes, then the region of the most recent store.',
      rows,
    };
  }
}
