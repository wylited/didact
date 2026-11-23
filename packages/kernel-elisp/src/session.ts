// Session: the Kernel/Session contract over the Emacs Lisp machine.
//
// Panels tell the Emacs story the lessons need:
//   Control stack — the pending eval/apply chain, with the arrow row on
//                   the source line that drives the editor marker.
//   Buffer        — the simulated buffer's metadata and text, point row
//                   highlighted (this is the "live" part of Emacs).
//   Environments  — lexical frames first, then dynamic frames, marked by
//                   the step that changed a binding.
//   Symbols       — Lisp-2 made visible: value cell and function cell side
//                   by side, including "—" for void.
//   Hooks         — hook variables with a non-empty function list.
//   Keymaps       — key sequence → command for every created keymap.
//   Output        — message/princ/print text.

import { ElispMachine, type LoadedSource } from './machine';
import { readProgram } from './reader';
import { Runtime } from './runtime';
import type { Field, ListingRow, LoadResult, Panel, RunResult, Session } from './types';
import {
  Buffer, Closure, Cons, DynFrame, Env, Keymap, LispError, Macro, Sym,
  arrayOf, nil, renderSummary, type Form, type Value,
} from './value';

const MAX_ROWS = 40;
const MAX_STACK_ROWS = 24;
const MAX_FIELDS = 40;
const MAX_LINE_CHARS = 200;
const MAX_CONSOLE_CHARS = 20_000;

export class ElispSession implements Session {
  private forms: Form[] | null = null;
  private lexicalBinding = false;
  private machine: ElispMachine | null = null;
  /** Line we already paused at: resuming runs past this occurrence. */
  private resumeLine: number | null = null;

  async load(src: string): Promise<LoadResult> {
    this.resumeLine = null;
    let forms: Form[];
    try {
      forms = readProgram(src);
    } catch (e) {
      this.discard();
      if (e instanceof LispError) return { ok: false, line: e.line, message: e.message };
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    if (forms.length === 0) {
      this.discard();
      return { ok: false, line: 1, message: 'no forms to evaluate' };
    }
    this.forms = forms;
    this.lexicalBinding = detectLexicalBinding(src);
    this.buildMachine();
    return {
      ok: true,
      summary: `loaded · ${forms.length} form${forms.length === 1 ? '' : 's'}${this.lexicalBinding ? ' · lexical binding' : ''}`,
    };
  }

  private discard(): void {
    this.machine = null;
    this.forms = null;
  }

  private buildMachine(): void {
    if (this.forms === null) return;
    const lines = (this.forms as Form[] & { lines?: number[] }).lines;
    const source: LoadedSource = { forms: this.forms, lines, lexicalBinding: this.lexicalBinding };
    this.machine = new ElispMachine(source, new Runtime());
  }

  async run(breakpoints?: number[]): Promise<RunResult> {
    const m = this.machine;
    if (m === null) return { finished: false, steps: 0, error: 'nothing is loaded' };
    const bps = breakpoints !== undefined ? new Set(breakpoints) : null;
    let sinceYield = 0;
    while (!m.finished && m.error === null) {
      const line = m.currentLine();
      if (line !== this.resumeLine) {
        if (bps !== null && line !== null && bps.has(line)) {
          this.resumeLine = line;
          return this.result(m);
        }
        this.resumeLine = null;
      }
      m.step();
      if (++sinceYield >= 10_000) {
        sinceYield = 0;
        // let the page paint and keep a long-but-legal run interruptible
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.machine !== m) {
          return { finished: false, steps: m.steps, error: 'run interrupted by reset' };
        }
      }
    }
    this.resumeLine = null;
    return this.result(m);
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    const m = this.machine;
    if (m === null) {
      return { ran: false, result: { finished: false, steps: 0, error: 'nothing is loaded' } };
    }
    if (m.finished || m.error !== null) return { ran: false, result: this.result(m, false) };
    const resume = this.resumeLine;
    m.step();
    // a step that leaves the paused line clears the suppression; one that
    // stays on it (a nested subform) keeps Run from stopping there again
    if (resume !== null && m.currentLine() !== resume) this.resumeLine = null;
    return { ran: true, result: this.result(m, false) };
  }

  reset(): void {
    this.resumeLine = null;
    this.buildMachine();
  }

  dispose(): void {
    this.machine = null;
    this.forms = null;
  }

  state(): Panel[] {
    const m = this.machine;
    if (m === null) return [];
    const changed = new Set([...m.changed, ...m.runtime.changed]);
    return [
      controlPanel(m),
      ...bufferPanels(m),
      ...envPanels(m, changed),
      ...symbolPanels(m, changed),
      ...hookPanel(m, changed),
      ...keymapPanel(m, changed),
      { kind: 'console', id: 'output', title: 'Output', text: outputText(m) },
    ];
  }

  private result(m: ElispMachine, paused = true): RunResult {
    if (m.error !== null) return { finished: false, steps: m.steps, error: m.error };
    if (m.finished) return { finished: true, steps: m.steps, exit: `=> ${renderSummary(m.lastValue)}` };
    const line = m.currentLine();
    return paused && line !== null
      ? { finished: false, steps: m.steps, pausedAt: line }
      : { finished: false, steps: m.steps };
  }
}

/** Explicit output, then — once the program has finished — its last value.
 *  The results slot renders the first console panel, so this is also the
 *  block's REPL-style result line. */
function outputText(m: ElispMachine): string {
  let text = m.output;
  if (text.length > MAX_CONSOLE_CHARS) {
    text = `… earlier output omitted …\n${text.slice(-MAX_CONSOLE_CHARS)}`;
  }
  // Expression-only blocks show their value; printed output stays verbatim.
  if (text === '' && m.finished) return renderSummary(m.lastValue);
  return text;
}

/** `;; -*- lexical-binding: t; -*-` in the first two lines (file-local
 *  variable convention). Runtime `(setq lexical-binding t)` also works. */
function detectLexicalBinding(src: string): boolean {
  const lines = src.split('\n', 2);
  // Emacs reads the cookie from line 1, or line 2 after a shebang
  const line = lines[0]!.startsWith('#!') ? (lines[1] ?? '') : lines[0]!;
  return /-\*-.*lexical-binding:\s*t\s*;?.*-\*-/.test(line);
}

// ---- panels ---------------------------------------------------------------

function controlPanel(m: ElispMachine): Panel {
  const stack = m.current?.stack ?? [];
  const hidden = Math.max(0, stack.length - MAX_STACK_ROWS);
  const shown = hidden > 0 ? stack.slice(-MAX_STACK_ROWS) : stack;
  const rows: ListingRow[] = [];
  if (hidden > 0) {
    rows.push({ addr: 0, bytes: '', text: `… ${hidden} deeper` });
  }
  for (const label of shown) {
    rows.push({ addr: rows.length, bytes: '', text: label });
  }
  const current = m.current;
  rows.push(current === null
    ? { addr: rows.length, bytes: '', text: '→ done', current: true }
    : {
      addr: rows.length,
      bytes: '',
      text: `→ ${current.label}`,
      line: current.line,
      current: true,
    });
  return {
    kind: 'listing',
    id: 'control',
    title: `Control stack · ${m.steps} step${m.steps === 1 ? '' : 's'}`,
    tip: 'What each pending evaluation is waiting for; the arrow row is the form that reduces next.',
    rows,
  };
}

function bufferPanels(m: ElispMachine): Panel[] {
  const buf = m.runtime.current;
  const fields: Field[] = [
    { key: 'buffer', value: buf.name.slice(0, MAX_LINE_CHARS) },
    { key: 'point', value: `${buf.point} / ${buf.pointMax}` },
    { key: 'mark', value: buf.mark === null ? '—' : String(buf.mark) },
    { key: 'modified', value: buf.modified ? 'yes' : 'no' },
    { key: 'mode', value: buf.majorMode },
  ];
  const lines = buf.text.split('\n');
  const pointLine = lineAt(buf, buf.point);
  const shown = lines.slice(0, MAX_ROWS);
  const rows: ListingRow[] = shown.map((text, i) => ({
    addr: i + 1,
    bytes: '',
    text: `${i === pointLine ? '▸' : ' '} ${String(i + 1).padStart(2, ' ')} │ ${text.slice(0, MAX_LINE_CHARS)}`,
    current: i === pointLine,
  }));
  if (lines.length > MAX_ROWS) {
    rows.push({
      addr: lines.length,
      bytes: '',
      text: `… ${lines.length - MAX_ROWS} more lines`,
    });
  }
  return [
    {
      kind: 'fields',
      id: 'buffer',
      title: 'Buffer',
      tip: 'The current Emacs buffer: point is the insertion cursor and the highlighted text row.',
      fields,
    },
    {
      kind: 'listing',
      id: 'buffer-text',
      title: `${buf.name.slice(0, MAX_LINE_CHARS)} · ${lines.length} line${lines.length === 1 ? '' : 's'}`,
      tip: 'Buffer text with the point row marked. insert/delete-region/goto-char change this live.',
      rows,
    },
  ];
}

function lineAt(buf: Buffer, point: number): number {
  const upto = buf.text.slice(0, Math.max(0, Math.min(point - 1, buf.text.length)));
  return upto.split('\n').length - 1;
}

function envPanels(m: ElispMachine, changed: Set<string>): Panel[] {
  const panels: Panel[] = [];
  let env: Env | null = m.current?.env ?? null;
  const seen = new Set<Env>();
  while (env !== null && !seen.has(env)) {
    seen.add(env);
    panels.push({
      kind: 'fields',
      id: `env-${env.label}-${panels.length}`,
      title: `lexical · ${env.chain()}`,
      tip: 'Lexical bindings captured by closures (or created by let under lexical-binding).',
      fields: fieldsOf(env.vars, changed),
    });
    env = env.parent;
  }
  for (let i = m.dynamic.length - 1; i >= 0; i--) {
    const frame: DynFrame = m.dynamic[i]!;
    panels.push({
      kind: 'fields',
      id: `dyn-${i}`,
      title: `dynamic · ${frame.label}`,
      tip: 'Dynamic bindings: visible to every function called inside this extent, then popped.',
      fields: fieldsOf(frame.vars, changed),
    });
  }
  return panels;
}

function fieldsOf(vars: Map<string, Value>, changed: Set<string>): Field[] {
  const fields: Field[] = [];
  for (const [key, value] of vars) {
    if (fields.length >= MAX_FIELDS) {
      fields.push({ key: '…', value: `${vars.size - MAX_FIELDS} more` });
      break;
    }
    fields.push({
      key,
      value: renderSummary(value),
      ...(changed.has(key) ? { changed: true } : {}),
    });
  }
  return fields;
}

function symbolPanels(m: ElispMachine, changed: Set<string>): Panel[] {
  const names = m.touchedNames();
  if (names.length === 0) return [];
  const rows: ListingRow[] = [];
  for (const name of names.slice(0, MAX_ROWS)) {
    const value = m.runtime.getVariable(name);
    const fn = m.runtime.globalFunctions.get(name);
    rows.push({
      addr: rows.length,
      bytes: '',
      text: `${name.slice(0, 120)} · value ${value === undefined ? '—' : renderSummary(value)} · fn ${fn === undefined ? '—' : describeFn(fn)}`,
      ...(changed.has(name) ? { current: true } : {}),
    });
  }
  if (names.length > MAX_ROWS) {
    rows.push({ addr: rows.length, bytes: '', text: `… ${names.length - MAX_ROWS} more` });
  }
  return [{
    kind: 'listing',
    id: 'symbols',
    title: 'Symbols · value cell / function cell',
    tip: 'Lisp-2: a symbol holds a value and a function separately. setq writes the left cell; defun/fset the right.',
    rows,
  }];
}

function describeDesignator(fn: Value): string {
  if (fn instanceof Sym) return fn.name;
  return describeFn(fn);
}

function describeFn(fn: Value): string {
  if (fn instanceof Closure) return `#<${fn.command ? 'command' : 'function'} ${fn.name ?? 'lambda'}>`;
  if (fn instanceof Macro) return `#<macro ${fn.name}>`;
  if (fn instanceof Sym) return `alias → ${fn.name}`;
  return renderSummary(fn);
}

function hookPanel(m: ElispMachine, changed: Set<string>): Panel[] {
  const rows: ListingRow[] = [];
  const sources: [string, Value, boolean][] = [
    ...m.runtime.globalValues,
  ].map(([name, value]): [string, Value, boolean] => [name, value, false]);
  for (const [name, value] of m.runtime.current.locals) {
    if (name.endsWith('-hook')) sources.push([name, value, true]);
  }
  for (const [name, value, local] of sources) {
    if (!name.endsWith('-hook')) continue;
    let fns: Value[];
    try {
      fns = value instanceof Cons ? arrayOf(value, name) : value === nil ? [] : [value];
    } catch (e) {
      // a bad hook value must not break rendering the rest of the state
      fns = [];
      const why = e instanceof Error && /circular/.test(e.message)
        ? '<circular list>'
        : '<invalid hook value>';
      rows.push({
        addr: rows.length,
        bytes: '',
        text: `${name}: ${why}${local ? ' (local)' : ''}`,
        ...(changed.has(name) ? { current: true } : {}),
      });
      continue;
    }
    if (fns.length === 0) continue;
    if (rows.length >= MAX_ROWS) {
      rows.push({ addr: rows.length, bytes: '', text: `… more hooks` });
      break;
    }
    const shown = fns.slice(0, 8).map(describeDesignator);
    if (fns.length > 8) shown.push(`… ${fns.length - 8} more`);
    rows.push({
      addr: rows.length,
      bytes: '',
      text: `${name.slice(0, 120)}${local ? ' (local)' : ''}: ${shown.join(', ').slice(0, 300)}`,
      ...(changed.has(name) ? { current: true } : {}),
    });
  }
  if (rows.length === 0) return [];
  return [{
    kind: 'listing',
    id: 'hooks',
    title: 'Hooks',
    tip: 'Hook variables are ordinary lists of functions; run-hooks calls them in order.',
    rows,
  }];
}

function keymapPanel(m: ElispMachine, _changed: Set<string>): Panel[] {
  const maps: Keymap[] = [m.runtime.globalMap, ...m.runtime.keymaps];
  const seen = new Set<Keymap>();
  const rows: ListingRow[] = [];
  for (const map of maps) {
    if (seen.has(map) || map.bindings.size === 0) continue;
    seen.add(map);
    for (const [key, cmd] of map.bindings) {
      if (rows.length >= MAX_ROWS) {
        rows.push({ addr: rows.length, bytes: '', text: '… more bindings' });
        return [{ kind: 'listing', id: 'keymaps', title: 'Keymaps', rows }];
      }
      rows.push({ addr: rows.length, bytes: '', text: `${map.name}  ${key.slice(0, 120)}  →  ${describeDesignator(cmd)}`.slice(0, 300) });
    }
  }
  if (rows.length === 0) return [];
  return [{
    kind: 'listing',
    id: 'keymaps',
    title: 'Keymaps',
    tip: 'define-key stores key sequence → command; lookup-key and call-interactively use them.',
    rows,
  }];
}
