// session.ts — adapts the generator-based interpreter to the async
// Kernel/Session contract. The main generator yields before every
// statement (and before every event-loop task); the driver keeps the
// pending yield as its resumption point, which gives step(), breakpoints
// and continue-after-pause for free — no state is unwound on pause.

import { parse, ParseError } from './parser';
import {
  Interpreter, RuntimeErr, displayValue, describeCallable,
  type Frame, type YieldInfo, type Value,
} from './interp';
import type { Field, ListingRow, LoadResult, Panel, RunResult, Session } from './types';
import type { Program } from './parser';

export class JsSession implements Session {
  private program: Program | null = null;
  private interp: Interpreter | null = null;
  /** The suspended main generator; null before the first step/run. */
  private gen: Generator<YieldInfo, void> | null = null;
  /** The yield we have peeked but not yet executed (step/pause unit). */
  private pending: IteratorResult<YieldInfo, void> | null = null;
  /** Display snapshot that `changed` flags in the Scopes panel diff on. */
  private prevScope = new Map<string, string>();
  /** Error that crashed the current run; sticky until reset() (house pattern
   *  from kernel-lisp: a crashed program must not report exit(0) on re-run). */
  private runError: string | null = null;

  async load(src: string): Promise<LoadResult> {
    try {
      this.program = parse(src);
    } catch (e) {
      this.program = null;
      this.interp = null;
      if (e instanceof ParseError) return { ok: false, line: e.line, message: e.message };
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
    this.prevScope = new Map();
    this.runError = null;
  }

  // -- driver -----------------------------------------------------------

  /** Peek the next unit without executing it, starting the generator once. */
  private peek(): IteratorResult<YieldInfo, void> {
    if (this.interp === null || this.gen === null) {
      if (this.interp === null) throw new Error('no program loaded');
      this.gen = this.interp.runAll();
    }
    if (this.pending === null) this.pending = this.gen.next();
    return this.pending;
  }

  /** Consume the peeked unit (execute one statement or one whole task). */
  private consume(): void {
    this.pending = null;
    // A task marker runs its whole invocation; the statements inside it
    // yield too and are consumed here as part of the same unit.
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

  /** Run to completion, pausing *before* any statement on a breakpoint line. */
  async run(breakpoints?: number[]): Promise<RunResult> {
    if (this.interp === null) return this.result({ error: 'no program loaded' });
    // A crashed run keeps reporting its error instead of a clean exit.
    if (this.runError !== null) return this.result({ finished: false, error: this.runError });
    const bps = breakpoints ?? [];
    this.snapshotScopes(); // `changed` flags diff across this run segment
    for (;;) {
      let next: IteratorResult<YieldInfo, void>;
      try {
        next = this.peek();
      } catch (e) {
        return this.fail(e);
      }
      if (next.done) {
        return this.result({ exit: 'exit(0)' });
      }
      const info = next.value;
      // Tasks are never breakpointed; statements on a bp line pause before
      // executing (and re-trip on every later iteration through that line).
      if (info.task === undefined && bps.includes(info.line)) {
        return this.result({ pausedAt: info.line });
      }
      try {
        this.consume();
      } catch (e) {
        return this.fail(e);
      }
      if (info.task !== undefined) {
        // statements inside a task were consumed above; loop to next marker
        while (true) {
          let inner: IteratorResult<YieldInfo, void>;
          try {
            inner = this.peek();
          } catch (err) {
            return this.fail(err);
          }
          if (inner.done || inner.value.task !== undefined) break;
          try {
            this.consume();
          } catch (err) {
            return this.fail(err);
          }
        }
      }
    }
  }

  /** One step: a single statement in the body, one whole task between tasks. */
  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    if (this.interp === null) return { ran: false, result: this.result({ error: 'no program loaded' }) };
    // A crashed run keeps reporting its error instead of a clean exit.
    if (this.runError !== null) return { ran: false, result: this.result({ finished: false, error: this.runError }) };
    this.snapshotScopes(); // `changed` flags diff across this step
    let next: IteratorResult<YieldInfo, void>;
    try {
      next = this.peek();
    } catch (e) {
      return { ran: false, result: this.fail(e) };
    }
    if (next.done) return { ran: false, result: this.result({ exit: this.interp.isDone() ? 'exit(0)' : undefined }) };
    try {
      this.consume();
    } catch (e) {
      return { ran: true, result: this.fail(e) };
    }
    // A task invocation covers all statements it runs; keep consuming them.
    if (next.value.task !== undefined) {
      for (;;) {
        let inner: IteratorResult<YieldInfo, void>;
        try {
          inner = this.peek();
        } catch (err) {
          return { ran: true, result: this.fail(err) };
        }
        if (inner.done || inner.value.task !== undefined) break;
        try {
          this.consume();
        } catch (err) {
          return { ran: true, result: this.fail(err) };
        }
      }
    }
    return { ran: true, result: this.result({ pausedAt: this.pausedAt() }) };
  }

  /** Line of the next unit to execute (the panel's current-line marker). */
  private pausedAt(): number | undefined {
    if (this.pending === null || this.pending.done) return undefined;
    return this.pending.value.line;
  }

  private fmtErr(e: unknown): string {
    // Only our own errors carry a trustworthy source line (JSC also stamps
    // a host `line` on plain Errors — ignore it).
    if (e instanceof ParseError || e instanceof RuntimeErr) return `line ${e.line}: ${e.message}`;
    return e instanceof Error ? e.message : String(e);
  }

  // -- panels -----------------------------------------------------------

  state(): Panel[] {
    const interp = this.interp;
    if (interp === null) {
      return [{ kind: 'console', id: 'console', title: 'console', text: '' }];
    }
    const next = this.pausedAt();
    return [
      scopesPanel(interp, this.prevScope),
      stackPanel(interp, next),
      loopPanel(interp, next),
      { kind: 'console', id: 'console', title: 'console', text: interp.output },
    ];
  }

  /** Capture the scope display the next `changed` flags diff against. */
  private snapshotScopes(): void {
    const interp = this.interp;
    if (interp === null) return;
    this.prevScope = new Map(scopeEntries(interp).map((r) => [r.key, r.text] as const));
  }

  dispose(): void {
    this.program = null;
    this.interp = null;
    this.gen = null;
    this.pending = null;
  }
}

// ─── panel builders ────────────────────────────────────────────────────────

/** One [frameKey, binding display] row per live scope binding. */
function scopeEntries(interp: Interpreter): { key: string; name: string; frame: Frame; value: Value; kind: string; text: string }[] {
  const rows: { key: string; name: string; frame: Frame; value: Value; kind: string; text: string }[] = [];
  for (const frame of interp.frames) {
    for (const [name, b] of frame.env.vars) {
      if (b.builtin === true) continue; // console/Math/… are not lesson state
      rows.push({
        key: `${frame.name}.${name}`,
        name,
        frame,
        value: b.value,
        kind: b.kind,
        text: displayValue(b.value, true, 0),
      });
    }
  }
  return rows;
}

function scopesPanel(interp: Interpreter, prev: Map<string, string>): Panel {
  const fields: Field[] = [];
  for (const row of scopeEntries(interp)) {
    const changed = prev.get(row.key) !== row.text;
    fields.push({
      key: row.key,
      value: row.text,
      changed,
      tip: `${row.name} is a ${row.kind} binding in ${row.frame.name}`,
    });
  }
  return { kind: 'fields', id: 'scopes', title: 'Scopes', fields };
}

function stackPanel(interp: Interpreter, nextLine: number | undefined): Panel {
  const rows: ListingRow[] = interp.frames.map((f, i) => ({
    addr: i,
    bytes: '',
    text: i === 0 ? `${f.name} (script)` : `${f.name} (line ${f.line})`,
    line: f.line,
    current: i === interp.frames.length - 1,
    tip: i === 0 ? 'top-level script scope' : `call frame for ${f.name}`,
  }));
  return {
    kind: 'listing',
    id: 'stack',
    title: 'Call stack',
    rows,
    tip: nextLine === undefined ? undefined : `next statement: line ${nextLine}`,
  };
}

function loopPanel(interp: Interpreter, nextLine: number | undefined): Panel {
  const rows: ListingRow[] = [];
  let addr = 0;
  for (const job of interp.micro) {
    rows.push({
      addr: addr++,
      bytes: '',
      text: `microtask · ${job.label}`,
      line: job.line,
      current: false,
      tip: 'Promise.then callback — drains before the next macrotask',
    });
  }
  for (const task of interp.macro) {
    rows.push({
      addr: addr++,
      bytes: '',
      text: `macrotask · ${describeCallable(task.fn)}`,
      line: task.line,
      current: false,
      tip: 'setTimeout callback — runs only after every microtask has drained',
    });
  }
  if (rows.length === 0) {
    rows.push({ addr: 0, bytes: '', text: 'both queues empty', current: nextLine === undefined });
  } else {
    // Current phase: the head microtask if any, else the head macrotask
    // (which sits right after the microtask rows).
    rows[interp.micro.length > 0 ? 0 : interp.micro.length]!.current = true;
  }
  return {
    kind: 'listing',
    id: 'loop',
    title: 'Event loop',
    rows,
    tip: 'microtasks drain fully, then one macrotask, then microtasks again',
  };
}
