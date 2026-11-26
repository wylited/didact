// session.ts — adapts the generator-based Fortran interpreter to the
// async Kernel/Session contract. The main generator yields before every
// statement, so step(), breakpoints and continue-after-pause work without
// unwinding loop/call state (the generator IS the resumption point).
//
// `resume` (org `:session <name>`) keeps the shared state — main-program
// variables, module variables, derived types and procedures — and runs the
// next block's statements in that same main scope. A fresh `load` starts a
// fresh program.

import { parse, ParseError } from './parser';
import { LexError } from './lexer';
import { Interpreter, type YieldInfo } from './interp';
import { RuntimeErr, BudgetErr, valueSignature } from './value';
import { arraysPanel, loopsPanel, modulesPanel, stackPanel, workspacePanel } from './panels';
import type { Panel, LoadResult, RunResult, Session } from './types';
import type { Program } from './parser';

export class FortranSession implements Session {
  private program: Program | null = null;
  private interp: Interpreter | null = null;
  private gen: Generator<YieldInfo, void> | null = null;
  private pending: IteratorResult<YieldInfo, void> | null = null;
  private prevWs = new Map<string, string>();
  private runError: string | null = null;
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
    try {
      this.reset();
    } catch (e) {
      this.program = null;
      this.interp = null;
      if (e instanceof RuntimeErr) return { ok: false, line: e.line, message: e.message };
      if (e instanceof RangeError) return { ok: false, message: e.message };
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, summary: this.summary(this.program, 'loaded') };
  }

  /** Continue the live session with another block's source. */
  async resume(src: string): Promise<LoadResult> {
    if (this.interp === null) return this.load(src);
    let program: Program;
    try {
      program = parse(src);
    } catch (e) {
      if (e instanceof ParseError || e instanceof LexError) {
        return { ok: false, line: e.line, message: e.message };
      }
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    try {
      this.interp = new Interpreter(program, this.interp.shared);
    } catch (e) {
      if (e instanceof RuntimeErr) return { ok: false, line: e.line, message: e.message };
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    this.program = program;
    this.gen = null;
    this.pending = null;
    this.prevWs = new Map();
    this.runError = null;
    this.pausedLine = null;
    return { ok: true, summary: this.summary(program, 'resumed') };
  }

  private summary(program: Program, verb: string): string {
    const parts: string[] = [];
    const statements = program.main?.body.length ?? 0;
    parts.push(`${statements} statement${statements === 1 ? '' : 's'}`);
    const modules = program.modules.length;
    if (modules > 0) parts.push(`${modules} module${modules === 1 ? '' : 's'}`);
    const procs = program.externals.length + (program.main?.internal.length ?? 0)
      + program.modules.reduce((n, m) => n + m.internal.length, 0);
    if (procs > 0) parts.push(`${procs} procedure${procs === 1 ? '' : 's'}`);
    return `${verb} · ${parts.join(', ')}`;
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

  private peek(): IteratorResult<YieldInfo, void> {
    if (this.interp === null) throw new Error('no program loaded');
    if (this.gen === null) this.gen = this.interp.runAll();
    if (this.pending === null) this.pending = this.gen.next();
    return this.pending;
  }

  private consume(): void {
    const line = this.pending !== null && !this.pending.done ? this.pending.value.line : 0;
    this.pausedLine = null;
    this.pending = null;
    try {
      this.pending = this.gen!.next();
    } catch (e) {
      if (e instanceof RangeError) throw new RuntimeErr(e.message, line);
      throw e;
    }
  }

  private result(overrides: Partial<RunResult> = {}): RunResult {
    const steps = this.interp?.steps ?? 0;
    return { finished: this.interp?.done ?? false, steps, ...overrides };
  }

  private fail(e: unknown): RunResult {
    this.runError = this.fmtErr(e);
    return this.result({ finished: false, error: this.runError });
  }

  async run(breakpoints?: number[]): Promise<RunResult> {
    if (this.interp === null) return this.result({ error: 'no program loaded' });
    if (this.runError !== null) return this.result({ finished: false, error: this.runError });
    const bps = breakpoints ?? [];
    this.snapshotWorkspace();
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
      if (next.done) {
        return this.result({ exit: this.interp.exitText });
      }
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

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    if (this.interp === null) {
      return { ran: false, result: this.result({ error: 'no program loaded' }) };
    }
    if (this.runError !== null) {
      return { ran: false, result: this.result({ finished: false, error: this.runError }) };
    }
    this.snapshotWorkspace();
    let next: IteratorResult<YieldInfo, void>;
    try {
      next = this.peek();
    } catch (e) {
      return { ran: false, result: this.fail(e) };
    }
    if (next.done) {
      return { ran: false, result: this.result({ exit: this.interp.done ? this.interp.exitText : undefined }) };
    }
    try {
      this.consume();
    } catch (e) {
      return { ran: true, result: this.fail(e) };
    }
    return { ran: true, result: this.result({ pausedAt: this.nextLine() }) };
  }

  private nextLine(): number | undefined {
    if (this.pending === null || this.pending.done) return undefined;
    return this.pending.value.line;
  }

  private fmtErr(e: unknown): string {
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
    const panels: Panel[] = [
      workspacePanel(interp, this.prevWs),
      arraysPanel(interp),
      loopsPanel(interp),
      stackPanel(interp),
    ];
    const modules = modulesPanel(interp);
    if (modules !== null) panels.splice(1, 0, modules);
    panels.push({ kind: 'console', id: 'console', title: 'console', text: interp.output });
    return panels;
  }

  private snapshotWorkspace(): void {
    const interp = this.interp;
    if (interp === null) return;
    this.prevWs = new Map(
      interp.workspaceEntries().map((entry) => [entry.name, valueSignature(entry.value)] as const),
    );
  }

  dispose(): void {
    this.program = null;
    this.interp = null;
    this.gen = null;
    this.pending = null;
  }
}
