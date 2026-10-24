// block.ts — executable block runtime: CM6 editor (Ayu Light), inline
// controls (Run/Step/Reset + mono status), line-mapped error box, current-
// line decoration, gutter breakpoints (when the kernel supports them),
// results-slot output (console + trusted kernel markup), restore-sample
// link.

import {
  EditorState,
  Range,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { ayuLight } from 'thememirror';
import { editorLanguage } from './languages';
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

/* ---- breakpoints (kernels with features.breakpoints): clicking a line
   number toggles a breakpoint on that 1-based line; filled black square
   markers live in a slim gutter; run() passes the active lines on. */

const toggleBreakpoint = StateEffect.define<number>(); // 1-based line

/** Sorted active breakpoint lines, mapped through doc changes with the
 * same keep-marks-on-their-text approach as `marksField`. */
const breakpointsField = StateField.define<number[]>({
  create: () => [],
  update(value, tr) {
    let v = value;
    for (const e of tr.effects) {
      if (!e.is(toggleBreakpoint)) continue;
      v = v.includes(e.value)
        ? v.filter((l) => l !== e.value)
        : [...v, e.value].sort((a, b) => a - b);
    }
    if (!tr.docChanged) return v;
    const shift = (line: number): number => {
      const clamped = Math.min(tr.startState.doc.lines, Math.max(1, line));
      const from = tr.changes.mapPos(tr.startState.doc.line(clamped).from);
      return tr.state.doc.lineAt(Math.max(0, from)).number;
    };
    const out: number[] = [];
    for (const line of v) {
      const shifted = shift(line);
      if (!out.includes(shifted)) out.push(shifted);
    }
    return out.sort((a, b) => a - b);
  },
});

class BreakpointMarker extends GutterMarker {
  constructor(readonly line: number) {
    super();
  }
  override eq(other: BreakpointMarker): boolean {
    return other.line === this.line;
  }
  override toDOM(): Node {
    const el = document.createElement('div');
    el.className = 'lw-bp';
    el.dataset.test = `breakpoint-${this.line}`;
    return el;
  }
}

/** Hidden width template: the marker gutter keeps its width before the
 * first breakpoint is placed. */
class BpSpacer extends GutterMarker {
  override eq(): boolean {
    return true;
  }
  override toDOM(): Node {
    const el = document.createElement('div');
    el.className = 'lw-bp';
    return el;
  }
}

const breakpointGutter = gutter({
  class: 'lw-bp-gutter',
  markers(view) {
    const { doc } = view.state;
    return RangeSet.of(
      view.state
        .field(breakpointsField)
        .filter((line) => line >= 1 && line <= doc.lines)
.map((line) => ({ from: doc.line(line).from, to: doc.line(line).from, value: new BreakpointMarker(line) })),
      true,
    );
  },
  lineMarkerChange: (update) =>
    update.startState.field(breakpointsField, false)
    !== update.state.field(breakpointsField, false),
  initialSpacer: () => new BpSpacer(),
});

/** data-test=gutter-N on every rendered line-number element (the hidden
 * width spacer and non-numeric elements are skipped). */
function labelLineNumberEls(view: EditorView): void {
  for (const el of view.dom.querySelectorAll<HTMLElement>(
    '.cm-lineNumbers .cm-gutterElement',
  )) {
    if (el.style.visibility === 'hidden') continue;
    const n = Number(el.textContent);
    if (Number.isInteger(n) && n >= 1) el.dataset.test = `gutter-${n}`;
  }
}

const labelGutterNumbers = EditorView.updateListener.of((update) => {
  if (
    update.docChanged || update.viewportChanged
    || update.geometryChanged || update.heightChanged
  ) {
    labelLineNumberEls(update.view);
  }
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
  /** True while the session sits mid-program (paused or stepped but not
   *  finished/errored): Run continues instead of restarting from scratch. */
  private midFlight = false;
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
    // kernels may opt out of stepping (features.stepping === false)
    if (kernel.features?.stepping !== false) head.appendChild(stepBtn);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.dataset.test = 'block-reset';
    resetBtn.textContent = '⟲ Reset';
    resetBtn.addEventListener('click', () => this.reset());
    head.appendChild(resetBtn);

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'lw-status';
    this.statusEl.dataset.test = 'block-status';
    this.statusEl.textContent = 'idle';
    head.appendChild(this.statusEl);

    this.el.appendChild(head);

    const editorHost = document.createElement('div');
    editorHost.dataset.test = 'editor';
    const canBreak = kernel.features?.breakpoints === true;
    if (canBreak) editorHost.dataset.bp = 'true';
    this.el.appendChild(editorHost);

    const extensions: Extension[] = [
      // clicking a line number toggles a breakpoint on that line
      canBreak
        ? lineNumbers({
            domEventHandlers: {
              mousedown: (view, line): boolean => {
                const n = view.state.doc.lineAt(line.from).number;
                view.dispatch({ effects: toggleBreakpoint.of(n) });
                return true;
              },
            },
          })
        : lineNumbers(),
      keymap.of(defaultKeymap),
      editorLanguage(kernel.editorSyntax) ?? [],
      ayuLight,
      marksField,
      markDecos,
      labelGutterNumbers,
    ];
    if (canBreak) extensions.push(breakpointsField, breakpointGutter);

    this.view = new EditorView({
      parent: editorHost,
      state: EditorState.create({ doc: node.code, extensions }),
    });
    labelLineNumberEls(this.view);

    const restore = document.createElement('a');
    restore.className = 'lw-restore';
    restore.href = '#';
    restore.dataset.test = 'restore-sample';
    restore.textContent = 'restore sample';
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
    try {
      // A mid-flight session (paused at a breakpoint, or mid-stepping)
      // continues; otherwise Run restarts from the current editor text.
      const resume = this.midFlight && this.loadedDoc === this.source;
      if (!resume) {
        this.status('assembling…');
        const load = await this.session.load(this.source);
        if (!load.ok) {
          this.loadedDoc = null;
          this.midFlight = false;
          this.finish(load);
          return;
        }
        this.loadedDoc = this.source;
      }
      this.status('running…');
      const result = await this.session.run(this.breakpointLines());
      if (this.disposed) return;
      this.setRunning(false);
      this.midFlight = result.finished !== true && result.error === undefined;
      this.reportResult(result, 'finished');
      this.syncAfterExecution();
    } catch (err) {
      // a kernel throw must not brick the block (busy flag, outline)
      this.setRunning(false);
      this.statusError(`error · ${(err instanceof Error ? err.message : String(err))}`);
    } finally {
      this.busy = false;
      if (!this.disposed) this.events.onActivity(this);
    }
  }

  async step(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.setRunning(true);
    this.setError(null);
    try {
      if (this.loadedDoc !== this.source) {
        this.status('assembling…');
        const load = await this.session.load(this.source);
        if (!load.ok) {
          this.loadedDoc = null;
          this.midFlight = false;
          this.finish(load);
          return;
        }
        this.loadedDoc = this.source;
      }
      this.status('stepping…');
      const { ran, result } = await this.session.step();
      if (this.disposed) return;
      this.setRunning(false);
      if (ran && result !== undefined) {
        this.midFlight = result.finished !== true && result.error === undefined;
        this.reportResult(result, 'step');
      } else {
        this.status('halted · nothing left to execute');
      }
      this.syncAfterExecution(result);
    } catch (err) {
      this.setRunning(false);
      this.statusError(`error · ${(err instanceof Error ? err.message : String(err))}`);
    } finally {
      this.busy = false;
      if (!this.disposed) this.events.onActivity(this);
    }
  }

  reset(): void {
    if (this.disposed) return;
    this.session.reset();
    this.loadedDoc = null;
    this.midFlight = false;
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

  /** Active breakpoint lines (sorted), or undefined when the kernel has
   * no breakpoint support. */
  private breakpointLines(): number[] | undefined {
    if (this.kernel.features?.breakpoints !== true) return undefined;
    return this.view.state.field(breakpointsField, false);
  }

  /** Results-slot output: the console text plus any trusted kernel
   * markup (e.g. rendered SVG), alongside each other. */
  private renderResults(el: HTMLElement): void {
    const panels = this.session.state();
    const nodes: Node[] = [];
    const con = panels.find(
      (p: Panel): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
    if (con !== undefined && con.text !== '') {
      const pre = document.createElement('pre');
      pre.textContent = con.text;
      nodes.push(pre);
    }
    for (const p of panels) {
      if (p.kind !== 'html') continue;
      const box = document.createElement('div');
      box.className = 'lw-html';
      box.innerHTML = p.html;
      nodes.push(box);
    }
    el.replaceChildren(...nodes);
  }

  private syncAfterExecution(result?: RunResult): void {
    if (this.resultsEl !== null) this.renderResults(this.resultsEl);
    const listing = this.session.state().find(
      (p: Panel): p is Extract<Panel, { kind: 'listing' }> => p.kind === 'listing');
    const row = listing?.rows.find((r) => r.current);
    // a breakpoint pause pins the editor decoration to the paused line
    this.setMarks({ current: result?.pausedAt ?? row?.line ?? null });
  }

  /** Shared tail for a failed load: red status, line-mapped error, attach. */
  private finish(load: { line?: number; message: string }): void {
    this.setRunning(false);
    this.statusError(
      load.line !== undefined
        ? `error · line ${load.line}: ${load.message}`
        : `error · ${load.message}`,
    );
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
    if (result.pausedAt !== undefined) {
      this.status(`paused · line ${result.pausedAt}`);
      return;
    }
    const exit = result.exit !== undefined && result.exit !== ''
      ? ` · ${result.exit}` : '';
    const verb = mode === 'step' ? 'stepped'
      : result.finished ? 'finished' : 'halted';
    // no step count for kernels that opted out of stepping — the count
    // is meaningless there (e.g. whole-program interpreters/compilers)
    if (this.kernel.features?.stepping === false) {
      this.status(`${verb}${exit}`);
      return;
    }
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

  private setError(load: { line?: number; message: string } | null): void {
    if (load === null) {
      this.errorEl.hidden = true;
      this.errorEl.textContent = '';
      this.setMarks({ error: null });
      return;
    }
    this.errorEl.hidden = false;
    // a line-less error (e.g. a linker failure) is text only — no marker
    this.errorEl.textContent =
      load.line !== undefined ? `line ${load.line}: ${load.message}` : load.message;
    this.setMarks({ error: load.line ?? null });
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
