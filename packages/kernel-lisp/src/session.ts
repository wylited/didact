// Session: the Kernel/Session contract over the Lisp machine. Panels tell
// the under-the-hood story the lesson teaches:
//   Heap          — every cons cell ever allocated, at a stable address;
//                   cells allocated by the latest step are highlighted.
//   Environment   — one fields panel per live frame, innermost first, with
//                   `changed` marks bindings a step created or reassigned.
//   Control stack — what each pending continuation is waiting for.
//   Output        — display/newline text.

import { makeBuiltins } from './builtins';
import { Machine } from './machine';
import { readProgram } from './reader';
import type { Field, ListingRow, LoadResult, Panel, RunResult, Session } from './types';
import { Builtin, Env, Form, LispError, Sym, renderWrite, withHeap } from './value';

function runResult(m: Machine): RunResult {
  if (m.error !== null) return { finished: false, steps: m.steps, error: m.error };
  if (m.finished) return { finished: true, steps: m.steps };
  return { finished: false, steps: m.steps };
}

/** Render a syntax form for the control stack (never allocates heap). */
function renderForm(f: Form): string {
  if (Array.isArray(f)) {
    const parts = f.slice(0, 6).map(renderForm);
    if (f.length > 6) parts.push('…');
    return `(${parts.join(' ')})`;
  }
  return renderWrite(f);
}

export class LispSession implements Session {
  private forms: Form[] | null = null;
  private machine: Machine | null = null;
  /** Previous binding snapshot per env frame — drives `changed` flags. */
  private prevSnapshot = new WeakMap<Env, Map<string, string>>();

  private buildMachine(forms: Form[]): Machine {
    let machine!: Machine;
    // The one impure builtin (macroexpand-1) delegates back into the
    // machine it belongs to, so wire the table before constructing it.
    const builtins = makeBuiltins((formValue, env) => machine.macroExpandOnce(formValue, env));
    machine = new Machine(forms, builtins);
    return machine;
  }

  async load(src: string): Promise<LoadResult> {
    try {
      this.forms = readProgram(src);
    } catch (e) {
      if (e instanceof LispError) return { ok: false, line: e.line, message: e.message };
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    if (this.forms.length === 0) return { ok: false, line: 1, message: 'no forms to evaluate' };
    this.machine = this.buildMachine(this.forms);
    return { ok: true, summary: `loaded · ${this.forms.length} forms` };
  }

  async run(breakpoints?: number[]): Promise<RunResult> {
    const m = this.machine;
    if (m === null) return { finished: false, steps: 0, error: 'nothing is loaded' };
    const bps = breakpoints !== undefined ? new Set(breakpoints) : null;
    while (!m.finished && m.error === null) {
      const line = m.currentLine();
      // Stop *before* reducing a form whose source line is a breakpoint.
      if (bps !== null && line !== null && bps.has(line)) {
        return { ...runResult(m), pausedAt: line };
      }
      m.step();
    }
    return runResult(m);
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    const m = this.machine;
    if (m === null) return { ran: false, result: { finished: false, steps: 0, error: 'nothing is loaded' } };
    if (m.finished || m.error !== null) return { ran: false, result: runResult(m) };
    m.step();
    return { ran: true, result: runResult(m) };
  }

  reset(): void {
    this.prevSnapshot = new WeakMap();
    if (this.forms !== null) this.machine = this.buildMachine(this.forms);
  }

  state(): Panel[] {
    const m = this.machine;
    if (m === null) return [];
    return [
      this.heapPanel(m),
      ...this.envPanels(m),
      this.stackPanel(m),
      { kind: 'console', id: 'output', title: 'Output', text: m.output },
    ];
  }

  dispose(): void {
    this.machine = null;
    this.forms = null;
  }

  /** Every cons cell, at its stable address; fresh cells highlighted. */
  private heapPanel(m: Machine): Panel {
    const rows: ListingRow[] = withHeap(m.heap, () =>
      m.heap.cells.map((cell, i) => ({
        // One cell = one car word + one cdr word = 16 bytes in the teaching
        // fiction, so addresses read like real memory (0x0000, 0x0010, …).
        addr: i * 16,
        bytes: 'cons',
        text: `car ${renderWrite(cell.car, 1)} · cdr ${renderWrite(cell.cdr, 1)}`,
        // The listing contract has no `changed` flag; `current` marks the
        // cells this reduction allocated (there is no heap pointer).
        ...(m.heap.fresh.has(i) ? { current: true } : {}),
      })),
    );
    return {
      kind: 'listing',
      id: 'heap',
      title: `Heap · ${m.heap.cells.length} cells`,
      tip: 'One row per cons cell, forever — no garbage collection. Highlighted rows were allocated by the latest step.',
      rows,
    };
  }

  /** Innermost-first environment frames, outer chain in each title. */
  private envPanels(m: Machine): Panel[] {
    const chain: Env[] = [];
    let e: Env | null = m.envInnermost();
    while (e !== null) { chain.push(e); e = e.parent; }
    const panels: Panel[] = [];
    for (const env of chain) {
      const prev = this.prevSnapshot.get(env);
      const fields: Field[] = [];
      for (const [name, value] of env.vars) {
        // Builtins live in the global frame but would bury the lesson's
        // own bindings — hide them; the lesson names them anyway.
        if (value instanceof Builtin) continue;
        const rendered = withHeap(m.heap, () => renderWrite(value));
        fields.push({
          key: name,
          value: rendered,
          // changed = created or reassigned since the previous state() call
          ...(prev === undefined || prev.get(name) !== rendered ? { changed: true } : {}),
        });
      }
      this.prevSnapshot.set(env, new Map(fields.map((f) => [f.key, f.value])));
      panels.push({
        kind: 'fields',
        id: `env-${env.name}`,
        title: env.chain(),
        tip: 'Bindings in this frame; the title shows the outer chain.',
        fields,
      });
    }
    return panels;
  }

  /** Pending continuations, outermost first, plus the focus on top. */
  private stackPanel(m: Machine): Panel {
    const rows: ListingRow[] = m.stack.map((frame, i) => ({
      addr: i,
      bytes: '',
      text: describeFrame(frame),
      line: 'line' in frame ? frame.line : undefined,
    }));
    const focus = m.focus;
    const focusText = focus.t === 'eval' ? `→ eval ${renderForm(focus.form)}`
      : focus.t === 'apply' ? '→ apply operator to arguments'
      : focus.t === 'value' ? `→ value ${withHeap(m.heap, () => renderWrite(focus.value))}`
      : '→ done';
    rows.push({
      addr: m.stack.length,
      bytes: '',
      text: focusText,
      line: focus.t === 'eval' || focus.t === 'apply' ? focus.line : m.currentLine() ?? undefined,
      current: true,
    });
    return {
      kind: 'listing',
      id: 'control',
      title: 'Control stack',
      tip: 'What each pending evaluation is waiting for; the arrow row is what reduces next.',
      rows,
    };
  }
}

/** One line of "what is this continuation waiting for". */
function describeFrame(frame: Machine['stack'][number]): string {
  switch (frame.t) {
    case 'opwait': return `application — waiting for the operator's value`;
    case 'args': {
      const total = frame.done.length + 1 + frame.rest.length;
      return `application — waiting for operand ${frame.done.length + 1} of ${total}`;
    }
    case 'if': return `if — waiting for the test, then takes a branch`;
    case 'cond': return `cond — waiting for the test of clause ${renderForm(frame.clause)}`;
    case 'seq': return `sequence — ${frame.rest.length} form${frame.rest.length === 1 ? '' : 's'} left after the current one`;
    case 'let': {
      const binding = frame.rest[0];
      const name = binding !== undefined && binding[0] instanceof Sym ? binding[0].name : '…';
      return `${frame.kind} — waiting for the value of ${name}`;
    }
    case 'define': return `define ${frame.name} — waiting for its value`;
    case 'defmacro': return `define-macro ${frame.name} — waiting for its transformer`;
    case 'set': return `set! ${frame.name} — waiting for its new value`;
    case 'and': return `and — waiting for an operand (short-circuits on #f)`;
    case 'or': return `or — waiting for an operand (short-circuits on non-#f)`;
    case 'expand': return `macro expansion — running the transformer, then evaluating the result`;
  }
}
