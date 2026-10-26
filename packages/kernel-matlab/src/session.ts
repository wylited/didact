// session.ts — adapts the generator-based interpreter to the async
// Kernel/Session contract. The main generator yields before every
// statement; the driver keeps the pending yield as its resumption point,
// which gives step(), breakpoints and continue-after-pause for free — no
// state is unwound on pause.
//
// Panels (the under-the-hood story):
//   * Workspace  — every base-workspace variable: shape + preview;
//   * Matrices   — the most recently written base matrix, one row per
//                  ELEMENT with its column-major address (the layout
//                  lesson, visible); the last statement's writes marked;
//   * Call stack — script frame plus one frame per function call, each
//                  function's own workspace named;
//   * console    — disp/fprintf output and assignment echoes.

import { parse, ParseError } from './parser';
import { LexError } from './lexer';
import {
  Interpreter, RuntimeErr, BudgetErr, type YieldInfo, type WriteMark,
} from './interp';
import { fmtNum, hex64, preview } from './matrix';
import type { Field, ListingRow, LoadResult, Panel, RunResult, Session } from './types';
import type { Program } from './parser';

/** How many element rows the Matrices panel shows before truncating. */
const MAX_PANEL_ROWS = 64;

export class MatlabSession implements Session {
  private program: Program | null = null;
  private interp: Interpreter | null = null;
  /** The suspended main generator; null before the first step/run. */
  private gen: Generator<YieldInfo, void> | null = null;
  /** The yield we have peeked but not yet executed (step/pause unit). */
  private pending: IteratorResult<YieldInfo, void> | null = null;
  /** Workspace display that `changed` flags diff on. */
  private prevWs = new Map<string, string>();
  /** Error that crashed the current run; sticky until reset() (house
   *  pattern: a crashed program must not report exit(0) on re-run). */
  private runError: string | null = null;
  /** Line we last paused on, so a resumed run executes it first. */
  private pausedLine: number | null = null;

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
    const parts: string[] = [];
    if (this.program.functions.length > 0) {
      const f = this.program.functions.length;
      parts.push(`${f} function${f === 1 ? '' : 's'}`);
    }
    const n = this.program.body.length;
    parts.push(`${n} statement${n === 1 ? '' : 's'}`);
    return { ok: true, summary: `loaded · ${parts.join(', ')}` };
  }

  reset(): void {
    if (this.program === null) return;
    this.interp = new Interpreter(this.program);
    this.gen = null;
    this.pending = null;
    this.prevWs = new Map();
    this.runError = null;
    this.pausedLine = null;
  }

  // -- driver -----------------------------------------------------------

  /** Peek the next unit without executing it, starting the generator once. */
  private peek(): IteratorResult<YieldInfo, void> {
    if (this.interp === null) throw new Error('no program loaded');
    if (this.gen === null) this.gen = this.interp.runAll();
    if (this.pending === null) this.pending = this.gen.next();
    return this.pending;
  }

  /** Consume the peeked unit (execute one statement). */
  private consume(): void {
    this.pausedLine = null;
    this.pending = null;
    this.pending = this.gen!.next();
  }

  private result(overrides: Partial<RunResult> = {}): RunResult {
    const steps = this.interp?.steps ?? 0;
    return { finished: this.interp?.isDone() ?? false, steps, ...overrides };
  }

  /** Record a run error and report it; sticky until reset(). */
  private fail(e: unknown): RunResult {
    this.runError = this.fmtErr(e);
    return this.result({ finished: false, error: this.runError });
  }

  /** Run to completion, pausing *before* any statement on a breakpoint
   *  line (and re-tripping on every later iteration through that line). */
  async run(breakpoints?: number[]): Promise<RunResult> {
    if (this.interp === null) return this.result({ error: 'no program loaded' });
    if (this.runError !== null) return this.result({ finished: false, error: this.runError });
    const bps = breakpoints ?? [];
    this.snapshotWorkspace(); // `changed` flags diff across this run segment
    // Resuming after a pause first executes the paused statement itself
    // (otherwise the same pending line would re-trip its breakpoint).
    if (this.pending !== null && !this.pending.done
      && this.pausedLine !== null && this.pausedLine === this.pending.value.line) {
      try {
        this.consume();
      } catch (e) {
        return this.fail(e);
      }
    }
    for (;;) {
      let next: IteratorResult<YieldInfo, void>;
      try {
        next = this.peek();
      } catch (e) {
        return this.fail(e);
      }
      if (next.done) return this.result({ exit: 'exit(0)' });
      if (bps.includes(next.value.line)) {
        this.pausedLine = next.value.line;
        return this.result({ pausedAt: next.value.line });
      }
      try {
        this.consume();
      } catch (e) {
        return this.fail(e);
      }
    }
  }

  /** One step: a single statement (loop bodies step one statement at a
   *  time; a whole function call is one statement at ITS caller). */
  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    if (this.interp === null) return { ran: false, result: this.result({ error: 'no program loaded' }) };
    if (this.runError !== null) {
      return { ran: false, result: this.result({ finished: false, error: this.runError }) };
    }
    this.snapshotWorkspace(); // `changed` flags diff across this step
    let next: IteratorResult<YieldInfo, void>;
    try {
      next = this.peek();
    } catch (e) {
      return { ran: false, result: this.fail(e) };
    }
    if (next.done) {
      return { ran: false, result: this.result({ exit: this.interp.isDone() ? 'exit(0)' : undefined }) };
    }
    try {
      this.consume();
    } catch (e) {
      return { ran: true, result: this.fail(e) };
    }
    return { ran: true, result: this.result({ pausedAt: this.nextLine() }) };
  }

  /** Line of the next unit to execute (the panel's current-line marker). */
  private nextLine(): number | undefined {
    if (this.pending === null || this.pending.done) return undefined;
    return this.pending.value.line;
  }

  private fmtErr(e: unknown): string {
    // Only our own errors carry a trustworthy source line.
    if (e instanceof ParseError || e instanceof RuntimeErr) return `line ${e.line}: ${e.message}`;
    if (e instanceof BudgetErr) return `line ${e.line}: ${e.message}`;
    return e instanceof Error ? e.message : String(e);
  }

  // -- panels -----------------------------------------------------------

  state(): Panel[] {
    const interp = this.interp;
    if (interp === null) {
      return [{ kind: 'console', id: 'console', title: 'console', text: '' }];
    }
    return [
      workspacePanel(interp, this.prevWs),
      matricesPanel(interp),
      stackPanel(interp),
      { kind: 'console', id: 'console', title: 'console', text: interp.output },
    ];
  }

  /** Capture the workspace display the next `changed` flags diff against. */
  private snapshotWorkspace(): void {
    const interp = this.interp;
    if (interp === null) return;
    this.prevWs = new Map(
      [...interp.frames[0]!.ws].map(([name, m]) => [name, preview(m)] as const),
    );
  }

  dispose(): void {
    this.program = null;
    this.interp = null;
    this.gen = null;
    this.pending = null;
  }
}

// ─── panel builders ────────────────────────────────────────────────────────

function workspacePanel(interp: Interpreter, prev: Map<string, string>): Panel {
  const fields: Field[] = [];
  for (const [name, m] of interp.frames[0]!.ws) {
    const text = preview(m);
    fields.push({
      key: name,
      value: text,
      changed: prev.get(name) !== text,
      tip: `${name} is a ${m.rows}x${m.cols} matrix in the base workspace (${m.numel()} element${m.numel() === 1 ? '' : 's'}, column-major)`,
    });
  }
  return {
    kind: 'fields',
    id: 'workspace',
    title: 'Workspace',
    fields,
    tip: 'the base workspace — script writes land here, function locals never do',
  };
}

function matricesPanel(interp: Interpreter): Panel {
  const write: WriteMark | null = interp.lastWrite;
  const rows: ListingRow[] = [];
  if (write === null) {
    rows.push({
      addr: 0,
      bytes: '',
      text: 'no matrix written yet',
      current: true,
      tip: 'assign a matrix (A = [1 2; 3 4]) to see its memory layout',
    });
    return { kind: 'listing', id: 'matrix', title: 'Matrices', rows };
  }
  const m = interp.frames[0]!.ws.get(write.name);
  if (m === undefined) {
    rows.push({ addr: 0, bytes: '', text: `${write.name} is no longer in the workspace` });
    return { kind: 'listing', id: 'matrix', title: 'Matrices', rows };
  }
  if (m.numel() === 0) {
    rows.push({
      addr: 0,
      bytes: '',
      text: `${write.name} is ${m.rows}x${m.cols} (empty)`,
      line: write.line,
      current: true,
      tip: 'an empty matrix stores nothing — 0 elements',
    });
    return { kind: 'listing', id: 'matrix', title: 'Matrices', rows };
  }
  const current = interp.currentWrite();
  const touched = current !== null && current.name === write.name ? current.addrs : null;
  const touchedSet = touched === null ? undefined : new Set(touched);
  let shown = 0;
  // Column-major walk: down column 1, then column 2, … — the address is
  // (col-1)*rows + row - 1, 0-based, which is what the hex column shows.
  for (let k = 0; k < m.numel() && shown < MAX_PANEL_ROWS; k++) {
    const i = (k % m.rows) + 1;
    const j = Math.floor(k / m.rows) + 1;
    const value = m.data[k]!;
    const mark = touched === null
      ? true
      : touchedSet!.has(k);
    rows.push({
      addr: k,
      bytes: hex64(value),
      text: `${write.name}(${i},${j}) = ${fmtNum(value)}`,
      line: write.line,
      current: mark,
      tip: `addr ${(j - 1) * m.rows + i - 1} = (${j - 1})*${m.rows} + ${i - 1} — column-major: column ${j}, row ${i}`,
    });
    shown++;
  }
  if (shown < m.numel()) {
    rows.push({
      addr: shown,
      bytes: '',
      text: `… ${m.numel() - shown} more elements`,
      tip: `the panel shows the first ${MAX_PANEL_ROWS} of ${m.numel()} elements, always in column-major order`,
    });
  }
  return {
    kind: 'listing',
    id: 'matrix',
    title: 'Matrices',
    rows,
    tip: `${write.name}: one row per element, in column-major order — the address counts down each column first`,
  };
}

function stackPanel(interp: Interpreter): Panel {
  const rows: ListingRow[] = interp.frames.map((f, i) => {
    if (i === 0) {
      return {
        addr: 0,
        bytes: '',
        text: 'script · base workspace',
        line: f.line,
        current: interp.frames.length === 1,
        tip: 'the script shares one workspace: every assignment here is global to the script',
      };
    }
    const locals = [...f.ws.keys()].join(', ');
    return {
      addr: i,
      bytes: '',
      text: `${f.name} · own workspace: ${locals === '' ? '(empty)' : locals}`,
      line: f.line,
      current: i === interp.frames.length - 1,
      tip: `${f.name}'s variables are private — it cannot see or touch the base workspace`,
    };
  });
  return {
    kind: 'listing',
    id: 'stack',
    title: 'Call stack',
    rows,
    tip: 'scripts share the base workspace; every function call gets its own',
  };
}
