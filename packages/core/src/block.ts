// block.ts — executable block runtime: CM6 editor (Ayu Light), inline
// controls (Run/Step/Reset + mono status), line-mapped error box, current-
// line decoration, results-slot output, restore-sample link.

import { EditorState, Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { ayuLight } from 'thememirror';
import { intelAsm } from './asm';
import type { Kernel, Panel, RunResult, Session } from './kernel';
import type { OrgNode } from './org';

type SrcNode = Extract<OrgNode, { kind: 'src' }>;

interface LineMarks { current: number | null; error: number | null }

const setMarks = StateEffect.define<Partial<LineMarks>>();

const marksField = StateField.define<LineMarks>({
  create: () => ({ current: null, error: null }),
  update(value, tr) {
    let v = value;
    for (const e of tr.effects) {
      if (e.is(setMarks)) v = { ...v, ...e.value };
    }
    if (!tr.docChanged) return v;
    // keep marks on their text when the student edits around them
    const shift = (line: number | null): number | null => {
      if (line === null) return null;
      const clamped = Math.min(tr.startState.doc.lines, Math.max(1, line));
      const from = tr.changes.mapPos(tr.startState.doc.line(clamped).from);
      return tr.state.doc.lineAt(Math.max(0, from)).number;
    };
    return { current: shift(v.current), error: shift(v.error) };
  },
});

const markDecos = EditorView.decorations.compute([marksField], (state) => {
  const { current, error } = state.field(marksField);
  const ranges: Range<Decoration>[] = [];
  const add = (line: number | null, cls: string): void => {
    if (line !== null && line >= 1 && line <= state.doc.lines) {
      const deco = Decoration.line({ class: cls });
      ranges.push(deco.range(state.doc.line(line).from));
    }
  };
  add(current, 'lw-current-line');
  add(error, 'lw-error-line');
  return Decoration.set(ranges);
});

/** Block lifecycle callbacks, supplied by the host that mounts the block. */
export interface BlockEvents {
  /** Fired after every run, step, reset, or failed load. */
  onActivity: (block: BlockRuntime) => void;
}

export class BlockRuntime {
  readonly el: HTMLElement;
  readonly kernel: Kernel;
  /** Kernel display label, e.g. 'x86-64 · Unicorn'. */
  readonly kernelLabel: string;
  readonly session: Session;
  /** `#name` or `Block N`. */
  readonly title: string;
  private readonly events: BlockEvents;
  private readonly view: EditorView;
  private readonly statusEl: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly resultsEl: HTMLElement | null;
  private readonly sample: string;
  private loadedDoc: string | null = null;
  private busy = false;
  private disposed = false;

  constructor(
    node: SrcNode,
    index: number,
    kernel: Kernel,
    mount: HTMLElement,
    resultsEl: HTMLElement | null,
    events: BlockEvents,
  ) {
    this.kernel = kernel;
    this.kernelLabel = kernel.label;
    this.session = kernel.createSession();
    this.sample = node.code;
    this.resultsEl = resultsEl;
    this.events = events;
    this.title = node.name !== null ? `#${node.name}` : `Block ${index}`;

    this.el = document.createElement('div');
    this.el.className = 'lw-block';
    this.el.dataset.test = 'block';
    this.el.dataset.name = this.title;

    const head = document.createElement('div');
    head.className = 'lw-block-head';

    const lang = document.createElement('span');
    lang.className = 'lw-lang';
    lang.textContent = node.lang;
    head.appendChild(lang);

    const name = document.createElement('span');
    name.className = 'lw-block-name';
    name.textContent = this.title;
    head.appendChild(name);

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.dataset.test = 'block-run';
    runBtn.textContent = '▶ Run';
    runBtn.addEventListener('click', () => void this.run());
    head.appendChild(runBtn);

    const stepBtn = document.createElement('button');
    stepBtn.type = 'button';
    stepBtn.dataset.test = 'block-step';
    stepBtn.textContent = '⤵ Step';
    stepBtn.addEventListener('click', () => void this.step());
    head.appendChild(stepBtn);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.dataset.test = 'block-reset';
    resetBtn.textContent = '⟲ Reset';
    resetBtn.addEventListener('click', () => this.reset());
    head.appendChild(resetBtn);

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'lw-status';
    this.statusEl.dataset.test = 'block-status';
    this.statusEl.dataset.tip = 'Block status: assemble, run and step outcomes for this block.';
    this.statusEl.textContent = 'idle';
    head.appendChild(this.statusEl);

    this.el.appendChild(head);

    const editorHost = document.createElement('div');
    editorHost.dataset.test = 'editor';
    this.el.appendChild(editorHost);

    this.view = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        doc: node.code,
        extensions: [
          lineNumbers(),
          keymap.of(defaultKeymap),
          intelAsm,
          ayuLight,
          marksField,
          markDecos,
        ],
      }),
    });

    const restore = document.createElement('a');
    restore.className = 'lw-restore';
    restore.href = '#';
    restore.dataset.test = 'restore-sample';
    restore.textContent = 'restore sample';
    restore.dataset.tip = 'Put the original lesson code back into this editor.';
    restore.addEventListener('click', (ev) => {
      ev.preventDefault();
      this.restoreSample();
    });
    this.el.appendChild(restore);

    this.errorEl = document.createElement('div');
    this.errorEl.className = 'lw-error';
    this.errorEl.dataset.test = 'block-error';
    this.errorEl.hidden = true;
    this.el.appendChild(this.errorEl);

    mount.appendChild(this.el);
  }

  get source(): string {
    return this.view.state.doc.toString();
  }

  /** Under-the-hood panels for this block's session (panel host feed). */
  state(): Panel[] {
    return this.session.state();
  }

  async run(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.setRunning(true);
    this.setError(null);
    this.status('running…');
    const load = await this.session.load(this.source);
    if (!load.ok) {
      this.loadedDoc = null;
      this.finish(load);
      return;
    }
    this.loadedDoc = this.source;
    const result = await this.session.run();
    this.setRunning(false);
    this.reportResult(result, 'finished');
    this.syncAfterExecution();
    this.busy = false;
    this.events.onActivity(this);
  }

  async step(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.setRunning(true);
    this.setError(null);
    if (this.loadedDoc !== this.source) {
      this.status('assembling…');
      const load = await this.session.load(this.source);
      if (!load.ok) {
        this.loadedDoc = null;
        this.finish(load);
        return;
      }
      this.loadedDoc = this.source;
    }
    this.status('stepping…');
    const { ran, result } = await this.session.step();
    this.setRunning(false);
    if (ran && result !== undefined) {
      this.reportResult(result, 'step');
    } else {
      this.status('halted · nothing left to execute');
    }
    this.syncAfterExecution();
    this.busy = false;
    this.events.onActivity(this);
  }

  reset(): void {
    if (this.disposed) return;
    this.session.reset();
    this.loadedDoc = null;
    this.setError(null);
    this.setMarks({ current: null });
    if (this.resultsEl !== null) this.resultsEl.textContent = '';
    this.status('reset · ready');
    this.events.onActivity(this);
  }

  restoreSample(): void {
    if (this.disposed) return;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: this.sample },
    });
  }

  /** Program output for the results slot: the session's console panel. */
  private consoleText(): string {
    const panels = this.session.state();
    const con = panels.find(
      (p: Panel): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
    return con?.text ?? '';
  }

  private syncAfterExecution(): void {
    if (this.resultsEl !== null) this.resultsEl.textContent = this.consoleText();
    const listing = this.session.state().find(
      (p: Panel): p is Extract<Panel, { kind: 'listing' }> => p.kind === 'listing');
    const row = listing?.rows.find((r) => r.current);
    this.setMarks({ current: row?.line ?? null });
  }

  /** Shared tail for a failed load: red status, line-mapped error, attach. */
  private finish(load: { line: number; message: string }): void {
    this.setRunning(false);
    this.statusError(`error · line ${load.line}: ${load.message}`);
    this.setError(load);
    this.setMarks({ current: null });
    this.busy = false;
    this.events.onActivity(this);
  }

  private reportResult(result: RunResult, mode: 'finished' | 'step'): void {
    if (result.error !== undefined && result.error !== '') {
      this.statusError(`error · ${result.error}`);
      return;
    }
    const exit = result.exit !== undefined && result.exit !== ''
      ? ` · ${result.exit}` : '';
    const verb = mode === 'step' ? 'stepped'
      : result.finished ? 'finished' : 'halted';
    this.status(`${verb}${exit} · ${result.steps} step${result.steps === 1 ? '' : 's'}`);
  }

  private status(text: string): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.remove('lw-status-error');
  }

  private statusError(text: string): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.add('lw-status-error');
  }

  private setError(load: { line: number; message: string } | null): void {
    if (load === null) {
      this.errorEl.hidden = true;
      this.errorEl.textContent = '';
      this.setMarks({ error: null });
      return;
    }
    this.errorEl.hidden = false;
    this.errorEl.textContent = `line ${load.line}: ${load.message}`;
    this.setMarks({ error: load.line });
  }

  private setRunning(on: boolean): void {
    this.el.classList.toggle('lw-running', on);
  }

  private setMarks(marks: Partial<LineMarks>): void {
    this.view.dispatch({ effects: setMarks.of(marks) });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.dispose();
    this.view.destroy();
    this.el.remove();
  }
}
