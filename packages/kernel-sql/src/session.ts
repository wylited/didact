// session.ts — the Kernel/Session contract over the row-at-a-time engine.
// Panels tell the story the lesson teaches:
//   Plan        — one row per operator, live seen/passed/emitted counters,
//                 the working operator marked current.
//   Current row — the row the latest step touched, one field per column,
//                 changed marks on values that moved.
//   Tables      — row counts per table; the last touched table is current.
//   Results     — psql-style tables, one chunk per statement.

import { SqlSyntaxError } from './lexer';
import { parseProgram, type Stmt } from './parser';
import { Engine, type RowView } from './interp';
import { renderValue, SqlError } from './values';
import type { Field, ListingRow, LoadResult, Panel, RunResult, Session } from './types';

export class SqlSession implements Session {
  private stmts: Stmt[] | null = null;
  private engine: Engine | null = null;
  /** Previous Current-row display — drives `changed` flags. */
  private prevRow = new Map<string, string>();

  async load(src: string): Promise<LoadResult> {
    let stmts: Stmt[];
    try {
      stmts = parseProgram(src);
    } catch (e) {
      this.stmts = null;
      this.engine = null;
      if (e instanceof SqlSyntaxError) return { ok: false, line: e.line, message: e.message };
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    if (stmts.length === 0) return { ok: false, line: 1, message: 'no statements to run' };
    this.stmts = stmts;
    this.engine = new Engine(stmts);
    this.prevRow = new Map();
    return { ok: true, summary: `loaded · ${stmts.length} statements` };
  }

  async run(breakpoints?: number[]): Promise<RunResult> {
    const eng = this.engine;
    if (eng === null) return { finished: false, steps: 0, error: 'nothing is loaded' };
    if (eng.error !== null) return this.errResult(eng.error, eng.ops);
    const bps = new Set(breakpoints ?? []);
    // A statement we just paused at resumes without re-tripping its own
    // breakpoint; step()/reset()/load() clear the skip.
    const skipPc = eng.resumeSkipPc;
    eng.resumeSkipPc = null;
    for (;;) {
      if (!eng.running) {
        if (eng.pc >= eng.stmts.length) return { finished: true, steps: eng.ops, exit: 'exit(0)' };
        const stmt = eng.stmts[eng.pc]!;
        if (bps.has(stmt.line) && eng.pc !== skipPc) {
          eng.resumeSkipPc = eng.pc;
          return { finished: false, steps: eng.ops, pausedAt: stmt.line };
        }
        try {
          eng.beginStatement();
        } catch (e) {
          return this.caught(eng, e);
        }
        continue;
      }
      try {
        eng.performOp();
      } catch (e) {
        return this.caught(eng, e);
      }
    }
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    const eng = this.engine;
    if (eng === null) return { ran: false, result: { finished: false, steps: 0, error: 'nothing is loaded' } };
    if (eng.error !== null) return { ran: false, result: this.errResult(eng.error, eng.ops) };
    eng.resumeSkipPc = null;
    if (!eng.running) {
      if (eng.pc >= eng.stmts.length) {
        return { ran: false, result: { finished: true, steps: eng.ops, exit: 'exit(0)' } };
      }
      try {
        // Planning is not a row op. A zero-row statement (CREATE TABLE)
        // begins and completes here; anything else begins and immediately
        // performs its first row operation, so every step moves a row.
        eng.beginStatement();
      } catch (e) {
        return { ran: true, result: this.caught(eng, e) };
      }
      if (!eng.running) return { ran: true, result: this.progress(eng) };
    }
    try {
      eng.performOp();               // exactly one row operation
    } catch (e) {
      return { ran: true, result: this.caught(eng, e) };
    }
    return { ran: true, result: this.progress(eng) };
  }

  reset(): void {
    this.prevRow = new Map();
    if (this.stmts !== null) this.engine = new Engine(this.stmts);
  }

  state(): Panel[] {
    const eng = this.engine;
    if (eng === null) return [];
    return [
      this.planPanel(eng),
      this.rowPanel(eng),
      this.tablesPanel(eng),
      { kind: 'console', id: 'results', title: 'Results', text: eng.consoleText() },
    ];
  }

  dispose(): void {
    this.stmts = null;
    this.engine = null;
  }

  // -- helpers -------------------------------------------------------------

  private progress(eng: Engine): RunResult {
    if (!eng.running && eng.pc >= eng.stmts.length) {
      return { finished: true, steps: eng.ops, exit: 'exit(0)' };
    }
    return { finished: false, steps: eng.ops };
  }

  private errResult(e: SqlError, steps: number): RunResult {
    return { finished: false, steps, error: e.line > 0 ? `line ${e.line}: ${e.message}` : e.message };
  }

  /** Record and format a thrown SqlError. */
  private caught(eng: Engine, e: unknown): RunResult {
    const err = e instanceof SqlError ? e : new SqlError(0, e instanceof Error ? e.message : String(e));
    eng.error = err;
    return this.errResult(err, eng.ops);
  }

  private planPanel(eng: Engine): Panel {
    const rows: ListingRow[] = eng.stages.map((st, i) => ({
      addr: i,
      bytes: `${st.seen}/${st.passed}/${st.emitted}`,
      text: st.label,
      ...(eng.planLine > 0 ? { line: eng.planLine } : {}),
      ...(eng.running && i === eng.stageIdx ? { current: true } : {}),
      tip: `${st.tip} (counters: rows seen / passed / emitted)`,
    }));
    return {
      kind: 'listing',
      id: 'plan',
      title: 'Plan',
      tip: 'One row per operator with live counters: rows seen / passed / emitted. The highlighted operator does the current step\'s work.',
      rows,
    };
  }

  private rowPanel(eng: Engine): Panel {
    const view = this.currentRow(eng);
    const fields: Field[] = [];
    if (view === null) {
      this.prevRow = new Map();
    } else {
      view.schema.forEach((key, i) => {
        const value = renderValue(view.values[i] ?? null);
        fields.push({
          key,
          value,
          ...(this.prevRow.get(key) === value ? {} : { changed: true }),
          ...(view.types?.[i] === undefined ? {} : { tip: `${key} · ${view.types[i]}` }),
        });
        this.prevRow.set(key, value);
      });
    }
    return {
      kind: 'fields',
      id: 'row',
      title: 'Current row',
      tip: 'The row the latest step touched, one field per column. Highlighted fields changed.',
      fields,
    };
  }

  /** Most recent row view across stages (the row the last step touched). */
  private currentRow(eng: Engine): RowView | null {
    let view: RowView | null = null;
    for (const st of eng.stages) {
      if (st.last !== null) view = st.last;
    }
    return view;
  }

  private tablesPanel(eng: Engine): Panel {
    const rows: ListingRow[] = [...eng.db.tables.values()].map((table, i) => ({
      addr: i,
      bytes: String(table.rows.length),
      text: `${table.name} (${table.cols.map((c) => c.name).join(', ')})`,
      ...(eng.lastTouched === table ? { current: true } : {}),
      tip: `${table.name} · ${table.rows.length} row${table.rows.length === 1 ? '' : 's'} — INSERTs grow it live`,
    }));
    return {
      kind: 'listing',
      id: 'tables',
      title: 'Tables',
      tip: 'Row counts per table; the highlighted table was touched by the latest statement.',
      rows,
    };
  }
}
