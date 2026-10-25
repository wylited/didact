// session.ts — the Kernel/Session contract over the Lua interpreter.
// Panels tell the under-the-hood story:
//   Locals / Globals — the current frame's bindings and the _G table,
//                      `changed` marks what the last step created or rewrote;
//   Tables           — the heap view: every table ever allocated, array part
//                      first ([1]=…), then hash rows (key=…), new/changed
//                      rows marked;
//   Call stack       — one row per live frame;
//   Console          — print output.

import { Interpreter, type YieldInfo } from './interp';
import { LexError, ParseError, parse } from './parser';
import {
  LuaError, Table, toStr, typeName,
  type Key, type LuaValue, type Program,
} from './value';
import type { Field, ListingRow, LoadResult, Panel, RunResult, Session } from './types';

export class LuaSession implements Session {
  private program: Program | null = null;
  private interp: Interpreter | null = null;
  private gen: Generator<YieldInfo, void> | null = null;
  private pending: IteratorResult<YieldInfo, void> | null = null;
  /** Display snapshots the `changed` flags diff against. */
  private prevLocals = new Map<string, string>();
  private prevGlobals = new Map<string, string>();
  /** Per-table entry snapshots: tableId -> (key -> display). */
  private prevTables = new Map<number, Map<Key, string>>();
  private prevTableIds = new Set<number>();
  /** A crashed run keeps reporting its error until reset() (house pattern). */
  private runError: string | null = null;

  async load(src: string): Promise<LoadResult> {
    try {
      this.program = parse(src);
    } catch (e) {
      this.program = null;
      this.interp = null;
      if (e instanceof ParseError || e instanceof LexError) {
        return { ok: false, line: e.line, message: e.message };
      }
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    this.reset();
    return { ok: true, summary: `loaded · ${this.program.body.length} top-level statements` };
  }

  reset(): void {
    if (this.program === null) return;
    this.interp = new Interpreter(this.program);
    this.gen = null;
    this.pending = null;
    this.prevLocals = new Map();
    this.prevGlobals = new Map();
    this.prevTables = new Map();
    this.prevTableIds = new Set();
    this.runError = null;
  }

  // -- driver (house pattern from kernel-javascript) -----------------------

  private peek(): IteratorResult<YieldInfo, void> {
    if (this.interp === null) throw new Error('no program loaded');
    if (this.gen === null) this.gen = this.interp.runAll();
    if (this.pending === null) this.pending = this.gen.next();
    return this.pending;
  }

  private consume(): void {
    if (this.pending === null) return;
    this.pending = this.gen!.next();
  }

  private result(overrides: Partial<RunResult> = {}): RunResult {
    const steps = this.interp?.steps ?? 0;
    return { finished: this.interp?.isDone() ?? false, steps, ...overrides };
  }

  private fail(e: unknown): RunResult {
    this.runError = this.fmtErr(e);
    return this.result({ finished: false, error: this.runError });
  }

  private fmtErr(e: unknown): string {
    if (e instanceof LuaError && e.line !== null) return `line ${e.line}: ${e.message}`;
    return e instanceof Error ? e.message : String(e);
  }

  async run(breakpoints?: number[]): Promise<RunResult> {
    if (this.interp === null) return this.result({ error: 'no program loaded' });
    if (this.runError !== null) return this.result({ finished: false, error: this.runError });
    const bps = breakpoints ?? [];
    this.snapshotPrev(); // `changed` flags diff across this run segment
    for (;;) {
      let next: IteratorResult<YieldInfo, void>;
      try {
        next = this.peek();
      } catch (e) {
        return this.fail(e);
      }
      if (next.done) {
        // keep the baseline from the start of this run segment
        return this.result({ exit: 'exit(0)' });
      }
      if (bps.includes(next.value.line)) {
        return this.result({ pausedAt: next.value.line });
      }
      try {
        this.consume();
      } catch (e) {
        // baseline stays at the run-segment start for the error view
        return this.fail(e);
      }
    }
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    if (this.interp === null) {
      return { ran: false, result: this.result({ error: 'no program loaded' }) };
    }
    if (this.runError !== null) {
      return { ran: false, result: this.result({ finished: false, error: this.runError }) };
    }
    this.snapshotPrev(); // baseline: state before this step executes
    let next: IteratorResult<YieldInfo, void>;
    try {
      next = this.peek();
    } catch (e) {
      return { ran: false, result: this.fail(e) };
    }
    if (next.done) return { ran: false, result: this.result({ exit: 'exit(0)' }) };
    try {
      this.consume();
    } catch (e) {
        // baseline stays at the step's start for the error view
      return { ran: true, result: this.fail(e) };
    }
    // baseline for the next step's `changed` flags
    return { ran: true };
  }

  /** Freeze the current display state as the next diff's baseline. */
  private snapshotPrev(): void {
    const m = this.interp;
    if (m === null) return;
    const top = m.frames[m.frames.length - 1];
    if (top !== undefined) {
      this.prevLocals = new Map([...top.env.vars].map(([k, v]) => [k, toStr(v)]));
    }
    const gprev: [string, string][] = [];
    for (const e of m.globals.entries.values()) {
      if (typeof e.key === 'string' && e.key !== '_G') gprev.push([e.key, toStr(e.value)]);
    }
    this.prevGlobals = new Map(gprev);
    this.prevTables = new Map();
    this.prevTableIds = new Set();
    for (const t of m.tables) {
      this.prevTableIds.add(t.id);
      this.prevTables.set(t.id, new Map([...t.entries].map(([k, e]) => [k, toStr(e.value)])));
    }
  }

  dispose(): void {
    this.interp = null;
    this.gen = null;
    this.pending = null;
  }

  // -- panels --------------------------------------------------------------

  state(): Panel[] {
    const m = this.interp;
    if (m === null) {
      return [{ kind: 'console', id: 'lua-console', title: 'Console', text: '' }];
    }
    return [
      ...this.scopePanels(m),
      this.tablesPanel(m),
      this.stackPanel(m),
      { kind: 'console', id: 'lua-console', title: 'Console', text: m.out },
    ];
  }

  private scopePanels(m: Interpreter): Panel[] {
    const panels: Panel[] = [];
    const top = m.frames[m.frames.length - 1];
    if (top !== undefined && top.env.vars.size > 0) {
      const fields: Field[] = [];
      for (const [k, v] of top.env.vars) {
        const text = toStr(v);
        fields.push({
          key: k,
          value: text,
          sub: typeName(v),
          changed: this.prevLocals.get(k) !== text,
          tip: `${k} is a local of the current frame`,
        });
      }
      panels.push({
        kind: 'fields', id: 'lua-locals', title: 'Locals',
        tip: 'Bindings of the current frame; marked rows changed in the last step',
        fields,
      });
    }
    const gfields: Field[] = [];
    for (const e of m.globals.entries.values()) {
      if (typeof e.key !== 'string' || e.key === '_G') continue;
      const text = toStr(e.value);
      gfields.push({
        key: e.key,
        value: text,
        sub: typeName(e.value),
        changed: this.prevGlobals.get(e.key) !== text,
        tip: `${e.key} lives in _G, the globals table`,
      });
    }
    panels.push({
      kind: 'fields', id: 'lua-globals', title: 'Globals (_G)',
      tip: "The environment table _G — every name that isn't a local",
      fields: gfields,
    });
    return panels;
  }

  private tablesPanel(m: Interpreter): Panel {
    const rows: ListingRow[] = [];
    for (const t of m.tables) {
      if (t.internal) continue; // _G and the libraries have their own panels
      const fresh = !this.prevTableIds.has(t.id);
      rows.push({
        addr: t.id,
        bytes: fresh ? 'new' : '',
        text: `t${t.id}${t.metatable !== null ? ` · metatable t${t.metatable.id}` : ''} (#${t.length()})`,
      });
      const len = t.length();
      for (let i = 1; i <= len; i++) {
        const key = `i${i}`;
        const e = t.entries.get(key)!;
        this.pushRow(rows, t, key, e.value, `[${i}] = ${toStr(e.value)}`);
      }
      for (const [key, e] of t.entries) {
        if (/^i\d+$/.test(key) && Number(key.slice(1)) <= len) continue;
        this.pushRow(rows, t, key, e.value, `${renderKey(e.key)} = ${toStr(e.value)}`);
      }
    }
    return {
      kind: 'listing', id: 'lua-tables', title: 'Tables',
      tip: 'Every table ever allocated (no GC): array part first, then the hash part; Δ marks rows the last step added or changed',
      rows,
    };
  }

  private pushRow(rows: ListingRow[], t: Table, key: Key, value: LuaValue, text: string): void {
    const prev = this.prevTables.get(t.id);
    const changed = prev === undefined || prev.get(key) !== toStr(value);
    rows.push({
      addr: t.id,
      bytes: changed ? 'Δ' : '',
      text,
      current: changed,
    });
  }

  private stackPanel(m: Interpreter): Panel {
    const rows: ListingRow[] = [];
    for (let i = m.frames.length - 1; i >= 0; i--) {
      const f = m.frames[i]!;
      const isTop = i === m.frames.length - 1;
      if (f.closure === null) {
        rows.push({ addr: i, bytes: '', text: `chunk at line ${f.line}`, current: isTop });
        continue;
      }
      const args = f.closure.params.map((p) => toStr(f.env.vars.get(p) ?? null));
      rows.push({
        addr: i, bytes: '',
        text: `${f.closure.name}(${args.join(', ')}) at line ${f.line}`,
        current: isTop,
      });
    }
    return {
      kind: 'listing', id: 'lua-stack', title: 'Call stack',
      tip: 'Innermost frame first; "chunk" is the top-level block',
      rows,
    };
  }
}

/** Render a table key the way Lua's constructor would write it. */
function renderKey(k: LuaValue): string {
  if (typeof k === 'string') return JSON.stringify(k);
  return toStr(k);
}
