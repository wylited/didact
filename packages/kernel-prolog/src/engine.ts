// engine.ts — the SLD resolution machine. Every state the search needs is
// explicit so the panels can tell the story:
//   goals  — the resolvent: what still has to be proven (leftmost first).
//   cps    — choice points: untried clause alternatives, innermost last.
//   ctx    — the substitution (bindings + trail) shared by one query run.
// One step() is one resolution micro-step: try a clause for the current
// goal (unify or mismatch), execute a builtin, take a cut, or backtrack.
//
// Cut semantics: each goal carries the `barrier` — the choice-point stack
// height when its parent goal was selected. `!` truncates the stack to its
// barrier, discarding every choice point created since, including the
// parent's own clause choice. That is the standard "parent-goal" cut.
//
// run()/run() contract: a query runs to its FIRST solution, then stops
// (status 'solution'); the next step()/run() backtracks and searches for
// MORE solutions, until the search space is exhausted (status 'no').

import type { Clause, Query } from './parse';
import { flattenConj } from './parse';
import {
  PrologError, deref, freshVar, listOf, newCtx, predOf, reify,
  renameClause, renderResolved, renderTerm, undoTo, unify,
  type Ctx, type Term,
} from './terms';

export type Status = 'running' | 'solution' | 'no' | 'error';
export type StepKind =
  | 'resolve' | 'mismatch' | 'backtrack' | 'redo' | 'cut'
  | 'builtin' | 'builtin-fail' | 'solution' | 'no';

export interface Goal {
  term: Term;
  /** Choice-point stack height when the parent goal was selected. */
  barrier: number;
  /** 1-based line of the clause (or query) this goal came from. */
  fromLine: number;
}

interface ChoicePoint {
  /** The goal to retry, with its original variables. */
  goal: Term;
  /** Resolvent after that goal (snapshot at push time). */
  rest: Goal[];
  /** Clause index the retry should try next (-1: ;/2 alternative). */
  nextIdx: number;
  /** Trail height to restore on backtrack. */
  trailTop: number;
  /** Parent barrier for cuts inside the retried goal's clause body. */
  barrier: number;
  fromLine: number;
  pred: string;
  nclauses: number;
}

export const BUDGET = 1_000_000;

/** TS over-narrows `m.status` across method calls; read it fresh. */
function freshStatus(m: Machine): Status { return m.status; }
export class Machine {
  readonly ctx: Ctx;
  goals: Goal[] = [];
  cps: ChoicePoint[] = [];
  /** Clause cursor for the current (leftmost) goal. */
  tryIdx = 0;
  status: Status = 'running';
  error: PrologError | null = null;
  lastKind: StepKind | null = null;
  readonly out: string[] = [];
  /** The query's named variables, for the Bindings panel and `Yes` report. */
  readonly queryVars: { t: 'var'; id: number; name: string }[];
  /** Trail height at query start — restored when the query finally fails. */
  private readonly baseTop: number;
  constructor(
    private readonly program: Map<string, Clause[]>,
    query: Query,
    /** findall shares its caller's substitution and step budget; the
     *  goal's variables are already live cells and must NOT be renamed. */
    shared?: Ctx,
  ) {
    this.ctx = shared ?? newCtx(BUDGET);
    this.baseTop = this.ctx.trail.length;
    if (shared !== undefined) {
      this.queryVars = [];
      this.goals = query.goals.map((g) => ({ term: g, barrier: 0, fromLine: query.line }));
      return;
    }
    // Give the query's variables real cells, then seed the resolvent.
    const map = new Map<number, { t: 'var'; id: number; name: string }>();
    const rwVar = (t: { t: 'var'; id: number; name: string }) => {
      let v = map.get(t.id);
      if (v === undefined) {
        v = freshVar(this.ctx, t.name) as { t: 'var'; id: number; name: string };
        map.set(t.id, v);
      }
      return v;
    };
    const rw = (t: Term): Term => {
      if (t.t === 'var') return rwVar(t);
      if (t.t === 'str') return { t: 'str', name: t.name, args: t.args.map(rw) };
      return t;
    };
    this.queryVars = query.vars.map(rwVar);
    this.goals = query.goals.map((g) => ({ term: rw(g), barrier: 0, fromLine: query.line }));
  }
  step(): boolean {
    if (this.status === 'error' || this.status === 'no') return false;
    try {
      return this.stepInner();
    } catch (e) {
      if (e instanceof PrologError) {
        this.status = 'error';
        this.error = new PrologError(e.message, e.line ?? this.goals[0]?.fromLine ?? 1);
        return true;
      }
      throw e;
    }
  }

  private stepInner(): boolean {
    this.ctx.steps++;
    if (this.ctx.steps > this.ctx.budget) {
      this.status = 'error';
      this.error = new PrologError(
        `budget exceeded: more than ${this.ctx.budget.toLocaleString('en-US')} resolution steps (runaway recursion?)`,
        this.goals[0]?.fromLine ?? 1,
      );
      return true;
    }
    if (this.goals.length === 0 && this.status === 'solution') {
      // Redo: hunt for the next solution by backtracking.
      this.backtrackOrNo();
      if (freshStatus(this) === 'no') this.lastKind = 'no';
      else { this.status = 'running'; this.lastKind = 'redo'; }
      return true;
    }
    if (this.goals.length === 0) {
      this.reportSolution();
      this.lastKind = 'solution';
      return true;
    }
    const g = this.goals[0]!;

    // A conjunction/disjunction reached by unification (e.g. via findall(G, …))
    // is flattened into the resolvent; disjunction pushes an alternative.
    if (g.term.t === 'str' && g.term.name === ',' && g.term.args.length === 2) {
      this.goals = [
        { term: g.term.args[0]!, barrier: g.barrier, fromLine: g.fromLine },
        { term: g.term.args[1]!, barrier: g.barrier, fromLine: g.fromLine },
        ...this.goals.slice(1),
      ];
      this.lastKind = 'builtin';
      return true;
    }
    if (g.term.t === 'str' && g.term.name === ';' && g.term.args.length === 2) {
      this.cps.push({
        goal: g.term.args[1]!, rest: this.goals.slice(1), nextIdx: -1,
        trailTop: this.ctx.trail.length, barrier: g.barrier, fromLine: g.fromLine,
        pred: ';/2 alternative', nclauses: 0,
      });
      // The left disjunct's barrier sits ABOVE the just-pushed alternative:
      // a cut inside the left disjunct prunes its own clause choices but
      // must leave the right disjunct reachable (parent-goal semantics).
      this.goals = [{ term: g.term.args[0]!, barrier: this.cps.length, fromLine: g.fromLine }, ...this.goals.slice(1)];
      this.lastKind = 'builtin';
      return true;
    }
    const pred = predOf(g.term);
    const clauses = this.program.get(pred);
    if (clauses !== undefined) {
      if (this.tryIdx >= clauses.length) {
        this.backtrackOrNo();
        this.lastKind = this.status === 'no' ? 'no' : 'backtrack';
        return true;
      }
      const clause = clauses[this.tryIdx]!;
      const mark = this.ctx.trail.length;
      const renamed = renameClause(clause.head, clause.body, this.ctx, new Map());
      if (unify(g.term, renamed.head, this.ctx)) {
        // Selection barrier: the stack height when this goal was selected —
        // a cut in the clause body prunes back to here, taking the clause
        // choice pushed below (and everything deeper) with it.
        const barrier = this.cps.length;
        if (this.tryIdx + 1 < clauses.length) {
          this.cps.push({
            goal: g.term, rest: this.goals.slice(1), nextIdx: this.tryIdx + 1,
            trailTop: mark, barrier: g.barrier, fromLine: g.fromLine,
            pred, nclauses: clauses.length,
          });
        }
        this.goals = [
          ...renamed.body.map((b) => ({ term: b, barrier, fromLine: clause.line })),
          ...this.goals.slice(1),
        ];
        this.tryIdx = 0;
        this.lastKind = 'resolve';
        return true;
      }
      undoTo(mark, this.ctx);
      this.tryIdx++;
      this.lastKind = 'mismatch';
      return true;
    }

    if (this.tryBuiltin(g)) return true;
    // Not a clause, not a builtin: calling something nobody defined.
    this.status = 'error';
    this.error = new PrologError(`undefined predicate ${pred}`, g.fromLine);
    return true;
  }

  /** Line of the clause the *next* step would try — breakpoint probe. */
  nextClauseLine(): number | null {
    if (this.status !== 'running' || this.goals.length === 0) return null;
    const clauses = this.program.get(predOf(this.goals[0]!.term));
    if (clauses === undefined || this.tryIdx >= clauses.length) return null;
    return clauses[this.tryIdx]!.line;
  }

  /** For the Goal stack panel: clause-cursor annotation of the head goal. */
  attemptInfo(): string | null {
    if (this.status !== 'running' || this.goals.length === 0) return null;
    const clauses = this.program.get(predOf(this.goals[0]!.term));
    if (clauses === undefined) return null;
    return `← clause ${Math.min(this.tryIdx + 1, clauses.length)}/${clauses.length}`;
  }

  private backtrackOrNo(): void {
    const cp = this.cps.pop();
    if (cp === undefined) {
      undoTo(this.baseTop, this.ctx);
      this.status = 'no';
      this.goals = [];
      this.out.push('No.\n');
      return;
    }
    undoTo(cp.trailTop, this.ctx);
    this.goals = [{ term: cp.goal, barrier: cp.barrier, fromLine: cp.fromLine }, ...cp.rest];
    this.tryIdx = Math.max(cp.nextIdx, 0); // -1: ;/2 alternative — fresh cursor
  }

  private reportSolution(): void {
    this.status = 'solution';
    this.out.push('Yes.\n');
    for (const v of this.queryVars) {
      this.out.push(`${v.name} = ${renderResolved(v, this.ctx)}\n`);
    }
  }

  // ─── builtins ──────────────────────────────────────────────────────────────

  /** Try `g` as a builtin. Returns true if it WAS one, whatever happened. */
  private tryBuiltin(g: Goal): boolean {
    const name = g.term.t === 'atom' ? g.term.name : g.term.t === 'str' ? g.term.name : null;
    const args = g.term.t === 'str' ? g.term.args : [];
    const advance = (): void => {
      this.goals = this.goals.slice(1);
      this.tryIdx = 0;
      this.lastKind = 'builtin';
    };
    const failGoal = (): void => {
      this.backtrackOrNo();
      this.lastKind = this.status === 'no' ? 'no' : 'builtin-fail';
    };

    if (name === 'true' && args.length === 0) { advance(); return true; }
    if (name === 'fail' && args.length === 0) { failGoal(); return true; }
    if (name === '!' && args.length === 0) {
      // Cut: prune every choice point created since the parent goal was
      // selected — including the parent's own clause choice.
      this.cps.length = g.barrier;
      this.goals = this.goals.slice(1);
      this.tryIdx = 0;
      this.lastKind = 'cut';
      return true;
    }
    if (name === 'nl' && args.length === 0) { this.out.push('\n'); advance(); return true; }
    if (name === 'write' && args.length === 1) {
      this.out.push(renderResolved(args[0]!, this.ctx));
      advance();
      return true;
    }
    if (name === '=' && args.length === 2) {
      if (unify(args[0]!, args[1]!, this.ctx)) advance();
      else failGoal();
      return true;
    }
    if (name === '\\=' && args.length === 2) {
      const mark = this.ctx.trail.length;
      let unifiable = false;
      try {
        unifiable = unify(args[0]!, args[1]!, this.ctx);
      } catch (e) {
        if (!(e instanceof PrologError)) throw e;
        unifiable = false; // an infinite term is not unifiable, so \= holds
      }
      undoTo(mark, this.ctx); // \= never leaves bindings behind
      if (unifiable) failGoal();
      else advance();
      return true;
    }
    if (name === '==' && args.length === 2) {
      if (termEq(args[0]!, args[1]!, this.ctx)) advance();
      else failGoal();
      return true;
    }
    if (name === '\\==' && args.length === 2) {
      if (!termEq(args[0]!, args[1]!, this.ctx)) advance();
      else failGoal();
      return true;
    }
    if (name === 'is' && args.length === 2) {
      try {
        const n = evalArith(args[1]!, this.ctx, g.fromLine);
        if (unify(args[0]!, { t: 'int', n }, this.ctx)) advance();
        else failGoal();
      } catch (e) {
        this.arithError(e, g.fromLine);
      }
      return true;
    }
    const isCmp = name === '=:=' || name === '=\\=' || name === '<' || name === '>' || name === '=<' || name === '>=';
    if (isCmp && args.length === 2) {
      try {
        const a = evalArith(args[0]!, this.ctx, g.fromLine);
        const b = evalArith(args[1]!, this.ctx, g.fromLine);
        const holds = name === '=:=' ? a === b : name === '=\\=' ? a !== b
          : name === '<' ? a < b : name === '>' ? a > b : name === '=<' ? a <= b : a >= b;
        if (holds) advance();
        else failGoal();
      } catch (e) {
        this.arithError(e, g.fromLine);
      }
      return true;
    }
    if (name === 'findall' && args.length === 3) {
      this.doFindall(g, args);
      return true;
    }
    return false;
  }

  private arithError(e: unknown, line: number): void {
    this.status = 'error';
    this.error = e instanceof PrologError ? new PrologError(e.message, e.line ?? line) : new PrologError(String(e), line);
  }

  /** findall(Template, Goal, List): nested SLD search collecting each
   *  solution's Template. Shares the substitution (so Template's outer
   *  variables resolve) but restores it afterwards — findall is true once. */
  private doFindall(g: Goal, args: Term[]): void {
    const [tmpl, goalTerm, listArg] = args as [Term, Term, Term];
    const sub = new Machine(this.program, { goals: flattenConj(goalTerm), line: g.fromLine, vars: [] }, this.ctx);
    const collected: Term[] = [];
    for (;;) {
      sub.step();
      if (sub.status === 'solution') collected.push(reify(tmpl, this.ctx));
      if (sub.status === 'no' || sub.status === 'error') break;
    }
    if (sub.status === 'error') {
      this.status = 'error';
      this.error = sub.error;
      return;
    }
    if (unify(listArg, listOf(collected), this.ctx)) {
      this.goals = this.goals.slice(1);
      this.tryIdx = 0;
      this.lastKind = 'builtin';
    } else {
      this.backtrackOrNo();
      this.lastKind = this.status === 'no' ? 'no' : 'builtin-fail';
    }
  }
}

/** Structural equality under the current substitution (no binding). */
function termEq(a: Term, b: Term, ctx: Ctx): boolean {
  const x = deref(a, ctx);
  const y = deref(b, ctx);
  if (x.t === 'var' || y.t === 'var') return x.t === 'var' && y.t === 'var' && x.id === y.id;
  if (x.t === 'int' && y.t === 'int') return x.n === y.n;
  if (x.t === 'atom' && y.t === 'atom') return x.name === y.name;
  if (x.t === 'str' && y.t === 'str') {
    return x.name === y.name && x.args.length === y.args.length
      && x.args.every((ai, i) => termEq(ai, y.args[i]!, ctx));
  }
  return false;
}

/** Arithmetic evaluation: integers, unary +/-, + - * // mod. */
export function evalArith(t: Term, ctx: Ctx, line: number): number {
  const d = deref(t, ctx);
  if (d.t === 'int') return d.n;
  if (d.t === 'var') throw new PrologError(`arithmetic: ${renderTerm(d)} is not bound to a number`, line);
  if (d.t === 'str') {
    const a = d.args.map((x) => evalArith(x, ctx, line));
    if (d.name === '+' && a.length === 1) return a[0]!;
    if (d.name === '-' && a.length === 1) return -a[0]!;
    if (d.name === '+' && a.length === 2) return a[0]! + a[1]!;
    if (d.name === '-' && a.length === 2) return a[0]! - a[1]!;
    if (d.name === '*' && a.length === 2) return a[0]! * a[1]!;
    if (d.name === '//' && a.length === 2) {
      if (a[1] === 0) throw new PrologError('// by zero', line);
      return Math.trunc(a[0]! / a[1]!);
    }
    if (d.name === 'mod' && a.length === 2) {
      if (a[1] === 0) throw new PrologError('mod by zero', line);
      return a[0]! - a[1]! * Math.trunc(a[0]! / a[1]!);
    }
  }
  throw new PrologError(`arithmetic: ${renderTerm(d)} is not a number`, line);
}

/** Build the clause table keyed 'name/arity', in source order. */
export function clauseTable(clauses: Clause[]): Map<string, Clause[]> {
  const table = new Map<string, Clause[]>();
  for (const c of clauses) {
    const key = predOf(c.head);
    const bucket = table.get(key);
    if (bucket === undefined) table.set(key, [c]);
    else bucket.push(c);
  }
  return table;
}
