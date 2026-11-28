// Session: the Kernel/Session contract over the Prolog machine. A block is
// a knowledge base (clauses) plus one or more `?-` queries, run in order.
// Panels tell the under-the-hood story:
//   Goal stack    — the current resolvent; the leftmost goal is current and
//                   annotated with which clause the cursor is about to try.
//   Choice points — each open alternative (predicate, which clause index it
//                   would try next), most recent first, head marked.
//   Bindings      — the query's named variables → bound terms, `changed`
//                   marking whatever the latest step created or undid.
//   Search        — what the last step *did* (resolve / mismatch /
//                   backtrack / cut / builtin / solution / no), the clause
//                   line the cursor tries next, and the depth of the
//                   choice-point stack: the transition that x86 shows as
//                   its flags update.
//   Output        — write/nl text plus the Yes./bindings/No. reports.
//
// run() semantics: the FIRST run() of a block answers every query once —
// each runs to its first solution ('Yes.' + bindings) or exhausts ('No.')
// — and parks on the last query's solution. Each further run() asks that
// parked query for MORE solutions: the next solution re-reports, and when
// the search space is exhausted the block is finished with exit 'no'.

import { Machine, clauseTable } from './engine';
import type { Status, StepKind } from './engine';
import { parseProgram, type Program } from './parse';
import type { Field, ListingRow, LoadResult, Panel, RunResult, Session } from './types';
import { predOf, renderResolved, renderTerm } from './terms';
/** TS over-narrows `m.status` across the m.step() call; read it fresh. */
function statusOf(m: Machine): Status { return m.status; }

/** A machine error as the RunResult error string, with its source line. */
function renderError(m: Machine): string {
  return m.error !== null ? `${m.error.message} (line ${m.error.line ?? '?'})` : 'error';
}

export class PrologSession implements Session {
  private program: Program | null = null;
  /** The most recently loaded/resumed block on its own (so reset() drops
   *  clauses accumulated from earlier `:session` blocks). */
  private blockProgram: Program | null = null;
  private machine: Machine | null = null;
  private queryIdx = 0;
  private steps = 0;
  /** Set when a query exhausts ('no'); run() after exhaustion stays 'no'. */
  private finalExit: 'no' | null = null;
  /** Previous rendered value per variable — drives `changed` flags. */
  private prevBindings = new Map<string, string>();
  /** The last run() backtracked every query to exhaustion: the machine is
   *  gone, but its final trace is still the Search panel's story. */
  private lastRunExhausted = false;
  /** Line we last paused on, so a resumed run executes that clause attempt first. */
  private pausedLine: number | null = null;
  private readonly console: string[] = [];

  private clearState(): void {
    this.program = null;
    this.blockProgram = null;
    this.machine = null;
    this.lastRunExhausted = false;
    this.queryIdx = 0;
    this.steps = 0;
    this.finalExit = null;
    this.console.length = 0;
    this.prevBindings = new Map();
    this.pausedLine = null;
  }

  async load(src: string): Promise<LoadResult> {
    let parsed: Program;
    try {
      parsed = parseProgram(src);
    } catch (e) {
      this.clearState();
      const line = e instanceof Error && 'line' in e ? (e as { line?: number }).line : undefined;
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, line, message };
    }
    this.program = parsed;
    this.blockProgram = parsed;
    this.machine = null;
    this.lastRunExhausted = false;
    this.queryIdx = 0;
    this.steps = 0;
    this.console.length = 0;
    this.finalExit = null;
    this.prevBindings = new Map();
    this.pausedLine = null;
    return {
      ok: true,
      summary: `consulted · ${parsed.clauses.length} clause${parsed.clauses.length === 1 ? '' : 's'} · ${parsed.queries.length} quer${parsed.queries.length === 1 ? 'y' : 'ies'}`,
    };
  }

  /** Continue this session's knowledge base by appending new clauses and
   *  running the new block's queries against the combined KB. */
  async resume(src: string): Promise<LoadResult> {
    if (this.program === null) return this.load(src);
    let parsed: Program;
    try {
      parsed = parseProgram(src);
    } catch (e) {
      const line = e instanceof Error && 'line' in e ? (e as { line?: number }).line : undefined;
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, line, message };
    }
    this.blockProgram = parsed;
    this.program = {
      clauses: [...this.program.clauses, ...parsed.clauses],
      queries: parsed.queries,
    };
    this.machine = null;
    this.lastRunExhausted = false;
    this.queryIdx = 0;
    this.steps = 0;
    this.console.length = 0;
    this.finalExit = null;
    this.prevBindings = new Map();
    this.pausedLine = null;
    return {
      ok: true,
      summary: `resumed · ${parsed.clauses.length} clause${parsed.clauses.length === 1 ? '' : 's'} · ${parsed.queries.length} quer${parsed.queries.length === 1 ? 'y' : 'ies'}`,
    };
  }

  async run(breakpoints?: number[]): Promise<RunResult> {
    if (this.program === null) return { finished: false, steps: 0, error: 'nothing is loaded' };
    const bps = breakpoints !== undefined ? new Set(breakpoints) : null;
    if (this.machine === null && this.queryIdx >= this.program.queries.length) {
      // No queries at all, or every query already answered: a bare consult
      // counts as done.
      return { finished: true, steps: this.steps, exit: this.finalExit ?? 'yes' };
    }
    // Parked on a solution? This run() asks the CURRENT query for MORE
    // solutions: one redo step starts the backtrack; the next solution
    // re-reports; exhaustion prints 'No.'.
    if (this.machine !== null && this.machine.status === 'solution') {
      this.machine.step();
      this.steps++;
      const r = this.drive(this.machine, bps);
      if (r !== null) return r;
      // Exhausted ('No.' printed); fall through to the next query, if any.
      this.machine = null;
      this.queryIdx++;
    }
    // solution or its 'No.' — parking on the last query's solution.
    for (;;) {
      if (this.machine === null) {
        if (this.queryIdx >= this.program.queries.length) {
          this.finalExit = 'no';
          this.lastRunExhausted = true; // the Search panel keeps the final trace
          return { finished: true, steps: this.steps, exit: 'no' };
        }
        this.lastRunExhausted = false;
        this.machine = new Machine(clauseTable(this.program.clauses), this.program.queries[this.queryIdx]!);
        this.prevBindings = new Map();
      }
      const r = this.drive(this.machine, bps);
      if (r !== null) return r; // paused, errored, or parked on a solution
      this.machine = null;
      this.queryIdx++;
    }
  }

  /** Step `m` until it settles; flush its console; return a RunResult for
   *  pause/error/parked-solution, or null when it exhausted ('No.'). */
  private drive(m: Machine, bps: Set<number> | null): RunResult | null {
    while (m.status === 'running') {
      // Stop *before* a clause on a breakpointed line fires; resuming from a
      // pause on that same line executes the paused attempt first.
      const line = m.nextClauseLine();
      if (line !== null && this.pausedLine === line) {
        this.pausedLine = null;
      } else if (bps !== null && line !== null && bps.has(line)) {
        this.pausedLine = line;
        return { finished: false, steps: this.steps, pausedAt: line };
      } else {
        this.pausedLine = null;
      }
      m.step();
      this.steps++;
    }
    this.pausedLine = null;
    this.console.push(...m.out);
    m.out.length = 0;
    if (m.status === 'error') return { finished: false, steps: this.steps, error: renderError(m) };
    if (m.status === 'solution') {
      // Park on it — unless more queries are still waiting for their run.
      const more = this.program !== null && this.queryIdx + 1 < this.program.queries.length;
      return more ? null : { finished: true, steps: this.steps, exit: 'yes' };
    }
    return null; // 'no': the caller advances to the next query
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    if (this.program === null) return { ran: false, result: { finished: false, steps: 0, error: 'nothing is loaded' } };
    this.pausedLine = null;
    if (this.machine === null && this.queryIdx >= this.program.queries.length) {
      return { ran: false, result: { finished: true, steps: this.steps, exit: 'yes' } };
    }
    if (this.machine === null) {
      this.machine = new Machine(clauseTable(this.program.clauses), this.program.queries[this.queryIdx]!);
      this.prevBindings = new Map();
      return { ran: true, result: { finished: false, steps: this.steps } };
    }
    const m = this.machine;
    if (m.status === 'no' || m.status === 'error') {
      this.console.push(...m.out);
      m.out.length = 0;
      const result: RunResult = m.status === 'error'
        ? { finished: false, steps: this.steps, error: renderError(m) }
        : { finished: true, steps: this.steps, exit: 'no' };
      this.machine = null;
      this.queryIdx++;
      return { ran: false, result };
    }
    m.step();
    this.steps++;
    const st = statusOf(m);
    if (st !== 'running') {
      this.console.push(...m.out);
      m.out.length = 0;
    }
    const result: RunResult = st === 'solution'
      ? { finished: true, steps: this.steps, exit: 'yes' }
      : st === 'error'
        ? { finished: false, steps: this.steps, error: renderError(m) }
        : { finished: false, steps: this.steps };
    return { ran: true, result };
  }

  reset(): void {
    this.program = this.blockProgram;
    this.machine = null;
    this.lastRunExhausted = false;
    this.queryIdx = 0;
    this.steps = 0;
    this.finalExit = null;
    this.console.length = 0;
    this.prevBindings = new Map();
    this.pausedLine = null;
  }

  state(): Panel[] {
    // Loaded but not started: the Search panel says so instead of vanishing
    // (guarded for clause-only blocks that carry no queries).
    const nextQuery = this.program !== null && !this.lastRunExhausted
      ? this.program.queries[this.queryIdx]
      : undefined;
    const m = this.machine ?? (nextQuery !== undefined
      ? new Machine(clauseTable(this.program!.clauses), nextQuery)
      : null);
    if (m === null) {
      const output: Panel = { kind: 'console', id: 'output', title: 'Output', text: this.console.join('') };
      return this.lastRunExhausted ? [exhaustedPanel(), output] : [output];
    }
    return [this.goalStack(m), this.choicePoints(m), this.bindings(m), this.searchPanel(m), {
      kind: 'console',
      id: 'output',
      title: 'Output',
      text: this.console.join('') + m.out.join(''),
    }];
  }

  dispose(): void {
    this.clearState();
  }

  /** The resolvent, leftmost goal current, with the clause cursor. */
  private goalStack(m: Machine): Panel {
    const rows: ListingRow[] = [];
    if (m.status === 'solution') {
      rows.push({ addr: 0, bytes: '✓', text: 'solution found — resolvent empty', current: true });
    } else if (m.goals.length === 0) {
      rows.push({ addr: 0, bytes: '·', text: 'resolvent empty', current: true });
    } else {
      const note = m.attemptInfo();
      m.goals.forEach((g, i) => {
        rows.push({
          addr: i,
          bytes: predOf(g.term),
          text: renderTerm(g.term) + (i === 0 && note !== null ? ` ${note}` : ''),
          line: g.fromLine,
          current: i === 0,
          tip: i === 0 ? 'current goal — resolved next' : undefined,
        });
      });
    }
    return {
      kind: 'listing',
      id: 'goals',
      title: 'Goal stack',
      tip: 'What still has to be proven, leftmost first. The highlighted goal is next; the annotation shows which clause the cursor would try.',
      rows,
    };
  }

  /** Open alternatives, most recent (innermost) first. */
  private choicePoints(m: Machine): Panel {
    const rows: ListingRow[] = [];
    for (let i = m.cps.length - 1; i >= 0; i--) {
      const cp = m.cps[i]!;
      rows.push({
        addr: i,
        bytes: cp.pred,
        text: cp.nextIdx < 0
          ? `disjunction alternative: ${renderTerm(cp.goal)}`
          : `retry ${renderTerm(cp.goal)} → clause ${cp.nextIdx + 1} of ${cp.pred}`,
        line: cp.fromLine,
        current: rows.length === 0,
        tip: 'what backtracking would try if the current path fails',
      });
    }
    return {
      kind: 'listing',
      id: 'choices',
      title: 'Choice points',
      tip: 'Every untried alternative, innermost first. Backtracking pops the highlighted head; cut discards them.',
      rows,
    };
  }

  /** The machine's last resolution step: what the engine just *did*. */
  private searchPanel(m: Machine): Panel {
    const step = describeStep(m.lastKind);
    const fields: Field[] = [{ key: 'last step', value: step.what, tip: step.tip }];
    if (m.nextClauseLine() !== null || m.attemptInfo() !== null) {
      // The clause the cursor would try next is the line a breakpoint there
      // would stop *before* — the one line that matters for this goal.
      const line = m.nextClauseLine();
      if (line !== null) fields.push({ key: 'next clause', value: `line ${line}`, tip: 'the clause the cursor tries on the next step' });
    }
    fields.push({
      key: 'choice points',
      value: String(m.cps.length),
      tip: 'open alternatives on the stack — 0 means the next failure backtracks to "No."',
    });
    return {
      kind: 'fields',
      id: 'search',
      title: 'Search',
      tip: 'One row per engine transition: resolve, mismatch, backtrack, cut. Watch it flip between resolve and mismatch before it settles.',
      fields,
    };
  }

  /** The query's named variables with their current bindings. */
  private bindings(m: Machine): Panel {
    const fields: Field[] = m.queryVars.map((v) => {
      const value = renderResolved(v, m.ctx);
      const changed = this.prevBindings.get(v.name) !== value;
      this.prevBindings.set(v.name, value);
      return { key: v.name, value, ...(changed ? { changed: true } : {}) };
    });
    return {
      kind: 'fields',
      id: 'bindings',
      title: 'Bindings',
      tip: 'The query\u2019s variables under the current substitution. Highlighted values changed with the latest step.',
      fields,
    };
  }
}

// One row of the Search panel per StepKind the engine records on the way
// through (engine.ts sets lastKind wherever it moves the machine).
const STEP_TEXT: Record<StepKind, { what: string; tip: string }> = {
  resolve: { what: 'resolve', tip: 'unified the goal with its next clause, pushed alternatives, replaced the goal by the body' },
  mismatch: { what: 'mismatch', tip: 'the clause did not unify — undo its bindings, advance the clause cursor' },
  backtrack: { what: 'backtrack', tip: 'the current path failed — popped the newest choice point and restored its bindings' },
  redo: { what: 'redo', tip: 'another solution was requested — backtracking toward the next one' },
  cut: { what: 'cut', tip: 'pruned every alternative created since the clause was selected' },
  builtin: { what: 'builtin', tip: 'a builtin /2, is/2, write/1 … ran: no clause lookup' },
  'builtin-fail': { what: 'builtin failed', tip: 'the builtin held false and the search backtracked from it' },
  solution: { what: 'solution', tip: 'the resolvent emptied — every goal is proven under the current substitution' },
  no: { what: 'no', tip: 'no clause and no choice point left — the search is exhausted' },
};

/** The Search panel's reading of the machine's last transition. */
export function describeStep(kind: StepKind | null): { what: string; tip: string } {
  return kind === null ? { what: '—', tip: 'no step taken yet' } : STEP_TEXT[kind];
}

/** After the search exhausted: the machine is gone, its verdict is not. */
function exhaustedPanel(): Panel {
  return {
    kind: 'fields',
    id: 'search',
    title: 'Search',
    tip: 'The run ended with "No." — every query was answered, and the last one had nothing left to backtrack.',
    fields: [
      { key: 'last step', value: 'no', tip: STEP_TEXT.no.tip },
      { key: 'choice points', value: '0', tip: 'an empty choice-point stack is exactly why "No." is final' },
    ],
  };
}
