// Session: the Kernel/Session contract over the Prolog machine. A block is
// a knowledge base (clauses) plus one or more `?-` queries, run in order.
// Panels tell the under-the-hood story:
//   Goal stack    — the current resolvent; the leftmost goal is current and
//                   annotated with which clause the cursor is about to try.
//   Choice points — each open alternative (predicate, which clause index it
//                   would try next), most recent first, head marked.
//   Bindings      — the query's named variables → bound terms, `changed`
//                   marking whatever the latest step created or undid.
//   Output        — write/nl text plus the Yes./bindings/No. reports.
//
// run() semantics: the FIRST run() of a block answers every query once —
// each runs to its first solution ('Yes.' + bindings) or exhausts ('No.')
// — and parks on the last query's solution. Each further run() asks that
// parked query for MORE solutions: the next solution re-reports, and when
// the search space is exhausted the block is finished with exit 'no'.

import { Machine, clauseTable } from './engine';
import type { Status } from './engine';
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
  private machine: Machine | null = null;
  private queryIdx = 0;
  /** Set when a query exhausts ('no'); run() after exhaustion stays 'no'. */
  private finalExit: 'no' | null = null;
  /** Previous rendered value per variable — drives `changed` flags. */
  private prevBindings = new Map<string, string>();
  private readonly console: string[] = [];

  async load(src: string): Promise<LoadResult> {
    let parsed;
    try {
      parsed = parseProgram(src);
    } catch (e) {
      const line = e instanceof Error && 'line' in e ? (e as { line?: number }).line : undefined;
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, line, message };
    }
    this.program = parsed;
    this.machine = null;
    this.queryIdx = 0;
    this.steps = 0;
    this.console.length = 0;
    this.finalExit = null;
    this.prevBindings = new Map();
    return {
      ok: true,
      summary: `consulted · ${parsed.clauses.length} clause${parsed.clauses.length === 1 ? '' : 's'} · ${parsed.queries.length} quer${parsed.queries.length === 1 ? 'y' : 'ies'}`,
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
          return { finished: true, steps: this.steps, exit: 'no' };
        }
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
      // Stop *before* a clause on a breakpointed line fires.
      const line = m.nextClauseLine();
      if (bps !== null && line !== null && bps.has(line)) {
        return { finished: false, steps: this.steps, pausedAt: line };
      }
      m.step();
      this.steps++;
    }
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
    this.machine = null;
    this.queryIdx = 0;
    this.finalExit = null;
    this.console.length = 0;
    this.prevBindings = new Map();
  }

  state(): Panel[] {
    const m = this.machine;
    if (m === null) {
      return [{ kind: 'console', id: 'output', title: 'Output', text: this.console.join('') }];
    }
    return [this.goalStack(m), this.choicePoints(m), this.bindings(m), {
      kind: 'console',
      id: 'output',
      title: 'Output',
      text: this.console.join('') + m.out.join(''),
    }];
  }

  dispose(): void {
    this.machine = null;
    this.program = null;
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
