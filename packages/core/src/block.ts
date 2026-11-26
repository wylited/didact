// block.ts — executable block runtime: CM6 editor (Ayu Light), inline
// controls (Run/Step/Reset machine/Revert code/Copy Code + mono status),
// line-mapped error box, current-line decoration, gutter breakpoints (when
// the kernel supports them), results-slot output (console + trusted kernel
// markup), persisted editor text, and exercise checking.

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
import type {
  BlockRuntimeOptions,
  ExerciseOutcome,
  ExerciseSpec,
  StorageLike,
} from './teaching';

type SrcNode = Extract<OrgNode, { kind: 'src' }>;

type ExerciseState = 'pending' | 'running' | 'passed' | 'failed' | 'unchecked';

const CODE_KEY_PREFIX = 'didact:code:';

/** Trailing whitespace is insignificant when comparing exercise output. */
function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/** `Mod` is Meta on Apple platforms and Control elsewhere; the Run button
 *  advertises only the key that actually works on this machine. */
function isApplePlatform(): boolean {
  return typeof navigator !== 'undefined'
    && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** localStorage may be absent or throw (privacy mode, sandboxed iframe). */
function defaultStorage(): StorageLike | null {
  try {
    if (!('localStorage' in globalThis)) return null;
    const storage: StorageLike | null = globalThis.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

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

/** A named org-babel session shared by several blocks on one page.
 *  `supported` is false when the kernel has no `resume`, in which case
 *  each block gets its own wrapper and session, runs isolated, and the
 *  head badge warns. */
export interface SharedSession {
  /** The single session instance used by every block in the group. */
  session: Session;
  /** Session name from `:session <name>`. */
  name: string;
  /** Whether the kernel can continue a session (`Session.resume`). */
  supported: boolean;
  /** Source currently loaded into the shared session, or null after a
   *  reset. Blocks compare this with their own text so Step/Run always
   *  acts on the right program. */
  loadedSource: string | null;
  /** Tail of the group's serialized run/step chain: the session is a
   *  single mutable machine, so only one member may use it at a time. */
  queue: Promise<unknown>;
  /** Member blocks; each BlockRuntime registers itself in its constructor. */
  blocks: BlockRuntime[];
}

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
  private readonly revertBtn: HTMLButtonElement;
  private readonly errorEl: HTMLElement;
  private readonly resultsEl: HTMLElement | null;
  private readonly sample: string;
  /** Page-scoped id: enables saved code and identifies exercise results. */
  private readonly id: string | undefined;
  /** Backend for saved code; null when persistence is unavailable. */
  private readonly storage: StorageLike | null;
  private readonly exercise: ExerciseSpec | null;
  private exerciseBadge: HTMLElement | null = null;
  /** Last judged outcome, kept so Reset can restore it instead of
   *  discarding a completed pass/fail. */
  private exerciseResult: 'passed' | 'failed' | null = null;
  /** True once the current execution has emitted its outcome. */
  private exerciseJudged = false;
  private readonly onExerciseResult: ((outcome: ExerciseOutcome) => void) | undefined;
  private copyTimer: number | undefined;
  /** Status text/class to restore when the "copied" flash ends. */
  private copyRestore: { text: string; error: boolean } | null = null;
  /** Named-session group when this block carries `:session <name>`. */
  private readonly shared: SharedSession | undefined;
  /** True when `session` was created here and must be disposed here. */
  private readonly ownsSession: boolean;
  private loadedDoc: string | null = null;
  /** True while the session sits mid-program (paused or stepped but not
   *  finished/errored): Run continues instead of restarting from scratch. */
  private midFlight = false;
  private busy = false;
  private disposed = false;
  /** Bumped by every reset (standalone or shared). An in-flight load/run/
   *  step captures it right before touching the session and compares it
   *  after the await: a reset wins, so no stale result is reported into
   *  the fresh machine state. */
  private executionEpoch = 0;

  constructor(
    node: SrcNode,
    index: number,
    kernel: Kernel,
    mount: HTMLElement,
    resultsEl: HTMLElement | null,
    events: BlockEvents,
    shared?: SharedSession,
    options: BlockRuntimeOptions = {},
  ) {
    this.kernel = kernel;
    this.kernelLabel = kernel.label;
    this.shared = shared;
    this.session = shared?.session ?? kernel.createSession();
    this.ownsSession = shared === undefined;
    this.sample = node.code;
    this.resultsEl = resultsEl;
    this.events = events;
    this.title = node.name !== null ? `#${node.name}` : `Block ${index}`;
    this.id = options.id;
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.exercise = node.exercise;
    this.onExerciseResult = options.onExerciseResult;

    // A saved draft wins over the document's sample text; every read is
    // best-effort so unavailable/blocked storage never breaks the block.
    let initialCode = node.code;
    if (this.id !== undefined && this.storage !== null) {
      try {
        const saved = this.storage.getItem(CODE_KEY_PREFIX + this.id);
        if (saved !== null) initialCode = saved;
      } catch {
        // storage may be unavailable (privacy mode, quota, sandbox)
      }
    }

    this.el = document.createElement('div');
    this.el.className = 'lw-block';
    this.el.dataset.test = 'block';
    this.el.dataset.name = this.title;

    const head = document.createElement('div');
    head.className = 'lw-block-head';

    const meta = document.createElement('div');
    meta.className = 'lw-block-meta';

    const lang = document.createElement('span');
    lang.className = 'lw-lang';
    lang.textContent = node.lang;
    meta.appendChild(lang);

    const name = document.createElement('span');
    name.className = 'lw-block-name';
    name.textContent = this.title;
    meta.appendChild(name);

    if (shared !== undefined) {
      const sess = document.createElement('span');
      sess.className = 'lw-block-session';
      sess.dataset.test = 'block-session';
      sess.dataset.session = shared.name;
      sess.textContent = `:session ${shared.name}`;
      if (!shared.supported) {
        sess.classList.add('lw-session-unsupported');
        sess.title = 'this kernel cannot share :session state; blocks run isolated';
        sess.setAttribute('role', 'note');
        sess.setAttribute(
          'aria-label',
          `:session ${shared.name}: this kernel cannot share session state; blocks run isolated`,
        );
      }
      meta.appendChild(sess);
    }

    if (node.exercise !== null) {
      const badge = document.createElement('span');
      badge.className = 'lw-block-exercise';
      badge.dataset.test = 'block-exercise';
      badge.setAttribute('role', 'status');
      badge.setAttribute('aria-live', 'polite');
      meta.appendChild(badge);
      this.exerciseBadge = badge;
      // a previous visit's pass survives until this run is judged, so a
      // reset mid-rerun restores "passed" instead of forgetting it
      if (options.exercisePassed === true) this.exerciseResult = 'passed';
      this.setExerciseState(
        node.exercise.expected === null
          ? 'unchecked'
          : options.exercisePassed === true ? 'passed' : 'pending',
      );
    }

    head.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'lw-block-actions';

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'lw-btn lw-btn-primary';
    runBtn.dataset.test = 'block-run';
    runBtn.textContent = '▶ Run';
    runBtn.title = `Run the block (${isApplePlatform() ? '⌘' : 'Ctrl+'}Enter)`;
    runBtn.setAttribute(
      'aria-keyshortcuts',
      isApplePlatform() ? 'Meta+Enter' : 'Control+Enter',
    );
    runBtn.addEventListener('click', () => void this.run());
    actions.appendChild(runBtn);

    const stepBtn = document.createElement('button');
    stepBtn.type = 'button';
    stepBtn.className = 'lw-btn lw-btn-secondary';
    stepBtn.dataset.test = 'block-step';
    stepBtn.textContent = '⤵ Step';
    stepBtn.title = 'Step one instruction (Shift+Enter)';
    stepBtn.setAttribute('aria-keyshortcuts', 'Shift+Enter');
    stepBtn.addEventListener('click', () => void this.step());
    // kernels may opt out of stepping (features.stepping === false)
    if (kernel.features?.stepping !== false) actions.appendChild(stepBtn);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'lw-btn lw-btn-ghost';
    resetBtn.dataset.test = 'block-reset';
    resetBtn.textContent = '⟲';
    resetBtn.title = 'Reset session and clear output (keeps code)';
    resetBtn.setAttribute('aria-label', 'Reset session');
    resetBtn.addEventListener('click', () => this.reset());
    actions.appendChild(resetBtn);

    const revertBtn = document.createElement('button');
    revertBtn.type = 'button';
    revertBtn.className = 'lw-btn lw-btn-ghost';
    revertBtn.dataset.test = 'block-revert';
    revertBtn.dataset.dirty = String(initialCode !== this.sample);
    revertBtn.textContent = '↺';
    revertBtn.title = 'Revert to sample code (keeps session)';
    revertBtn.setAttribute('aria-label', 'Revert code');
    revertBtn.addEventListener('click', () => this.revertCode());
    actions.appendChild(revertBtn);
    this.revertBtn = revertBtn;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'lw-btn lw-btn-ghost';
    copyBtn.dataset.test = 'block-copy';
    copyBtn.textContent = '⧉';
    copyBtn.title = 'Copy code to clipboard';
    copyBtn.setAttribute('aria-label', 'Copy code');
    copyBtn.addEventListener('click', () => void this.copyCode());
    actions.appendChild(copyBtn);

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'lw-status';
    this.statusEl.dataset.test = 'block-status';
    this.statusEl.textContent = 'idle';

    head.append(actions, this.statusEl);
    this.el.appendChild(head);

    const editorHost = document.createElement('div');
    editorHost.dataset.test = 'editor';
    const canBreak = kernel.features?.breakpoints === true;
    if (canBreak) editorHost.dataset.bp = 'true';
    this.el.appendChild(editorHost);

    // Mod-Enter always runs. Shift-Enter maps to Step only when the kernel
    // exposes stepping; otherwise it must keep the editor's default action.
    const learnerKeys = [
      {
        key: 'Mod-Enter',
        run: (): boolean => {
          if (!this.busy && !this.disposed) void this.run();
          return true;
        },
      },
    ];
    if (kernel.features?.stepping !== false) {
      learnerKeys.push({
        key: 'Shift-Enter',
        run: (): boolean => {
          if (!this.busy && !this.disposed) void this.step();
          return true;
        },
      });
    }

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
      // learner shortcuts take precedence over the default keymap
      keymap.of(learnerKeys),
      keymap.of(defaultKeymap),
      editorLanguage(kernel.editorSyntax) ?? [],
      ayuLight,
      marksField,
      markDecos,
      labelGutterNumbers,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) this.persistCode();
      }),
    ];
    if (canBreak) extensions.push(breakpointsField, breakpointGutter);

    this.view = new EditorView({
      parent: editorHost,
      state: EditorState.create({ doc: initialCode, extensions }),
    });
    labelLineNumberEls(this.view);

    this.errorEl = document.createElement('div');
    this.errorEl.className = 'lw-error';
    this.errorEl.dataset.test = 'block-error';
    this.errorEl.hidden = true;
    this.el.appendChild(this.errorEl);

    mount.appendChild(this.el);

    shared?.blocks.push(this);
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
    await this.queueOnGroup(() => this.runSession());
  }

  /** Serialize the session-mutating part across a shared group: the
   *  session is one mutable machine, so a sibling waits its turn instead
   *  of interleaving loads/runs/steps. Normal blocks run immediately. A
   *  turn skipped because the block was disposed still releases the chain. */
  private queueOnGroup(task: () => Promise<void>): Promise<void> {
    const shared = this.shared;
    if (shared === undefined) return task();
    const turn = shared.queue.then(
      () => (this.disposed ? this.releaseTurn() : task()),
      () => (this.disposed ? this.releaseTurn() : task()),
    );
    // a rejected turn must not poison later members' turns
    shared.queue = turn.then(() => undefined, () => undefined);
    return turn;
  }

  private releaseTurn(): Promise<void> {
    this.busy = false;
    return Promise.resolve();
  }

  private async runSession(): Promise<void> {
    if (this.disposed) {
      this.busy = false;
      return;
    }
    this.setRunning(true);
    this.setError(null);
    this.beginExercise();
    let exerciseChecked = false;
    let epoch = this.executionEpoch;
    try {
      // A mid-flight session (paused at a breakpoint, or mid-stepping)
      // continues only when it still holds this block's program: a
      // sibling's run may have replaced it in the shared session.
      const resume = this.midFlight
        && this.loadedDoc === this.source
        && (this.shared === undefined || this.shared.loadedSource === this.source);
      if (!resume) {
        this.status('working…');
        // A supported named session continues its live state on every Run
        // (org-babel semantics: re-running accumulates definitions/data).
        const load = this.shared?.supported === true
            && this.session.resume !== undefined
          ? await this.session.resume(this.source)
          : await this.session.load(this.source);
        if (!load.ok) {
          this.loadedDoc = null;
          this.midFlight = false;
          // a failed load leaves the session holding no program — even a
          // sibling's source, which the failed load just displaced
          if (this.shared !== undefined) this.shared.loadedSource = null;
          this.finish(load);
          this.recordExercise(false, '');
          exerciseChecked = true;
          return;
        }
        this.loadedDoc = this.source;
        if (this.shared !== undefined) this.shared.loadedSource = this.source;
      }
      this.status('running…');
      // Captured after the load: a reset during a load keeps the old
      // behavior (the reload completes and a later run executes), but a
      // reset while the engine runs invalidates this execution.
      epoch = this.executionEpoch;
      const result = await this.session.run(this.breakpointLines());
      if (this.disposed || this.executionEpoch !== epoch) return;
      this.setRunning(false);
      this.midFlight = result.finished !== true && result.error === undefined;
      this.reportResult(result, 'finished');
      this.syncAfterExecution();
      this.checkExercise(result);
      exerciseChecked = true;
    } catch (err) {
      // a reset during the await already owns the block's state
      if (this.disposed || this.executionEpoch !== epoch) return;
      // a kernel throw must not brick the block (busy flag, outline)
      this.setRunning(false);
      this.statusError(`error · ${(err instanceof Error ? err.message : String(err))}`);
      if (!exerciseChecked) this.recordExercise(false, this.consoleText());
    } finally {
      this.busy = false;
      if (!this.disposed) this.events.onActivity(this);
    }
  }

  async step(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    await this.queueOnGroup(() => this.stepSession());
  }

  private async stepSession(): Promise<void> {
    if (this.disposed) {
      this.busy = false;
      return;
    }
    this.setRunning(true);
    this.setError(null);
    let epoch = this.executionEpoch;
    try {
      // A shared group's program identity lives in the session itself:
      // stepping block A after block B ran must first resume A's source.
      const needsLoad = this.shared === undefined
        ? this.loadedDoc !== this.source
        : this.shared.loadedSource !== this.source;
      if (needsLoad) {
        this.status('working…');
        // Same choice as run(): a supported named session continues its live
        // state instead of reloading (which would wipe the group's state).
        const load = this.shared?.supported === true
            && this.session.resume !== undefined
          ? await this.session.resume(this.source)
          : await this.session.load(this.source);
        if (!load.ok) {
          this.loadedDoc = null;
          this.midFlight = false;
          // a failed load leaves the session holding no program — even a
          // sibling's source, which the failed load just displaced
          if (this.shared !== undefined) this.shared.loadedSource = null;
          // The reload began a new execution and failed: judge a checked
          // exercise so a stale "passed" badge cannot survive it.
          this.beginExercise();
          this.recordExercise(false, '');
          this.finish(load);
          return;
        }
        this.loadedDoc = this.source;
        if (this.shared !== undefined) this.shared.loadedSource = this.source;
        // A step that reloads a fresh program begins a new execution.
        this.beginExercise();
      }
      this.status('stepping…');
      // Same epoch rule as run(): a reset during the load is preserved
      // (the reload completes), but a reset while stepping wins.
      epoch = this.executionEpoch;
      const { ran, result } = await this.session.step();
      if (this.disposed || this.executionEpoch !== epoch) return;
      this.setRunning(false);
      if (ran && result !== undefined) {
        this.midFlight = result.finished !== true && result.error === undefined;
        this.reportResult(result, 'step');
        // A step can be the terminal execution (paused program stepping to
        // completion); judge the exercise on it exactly like Run.
        if (result.finished === true || result.error !== undefined) {
          this.checkExercise(result);
        }
      } else {
        // Some kernels hand back the terminal result with ran === false
        // (the final step consumed no instruction); still judge it.
        if (result !== undefined
          && (result.finished === true || result.error !== undefined)) {
          this.midFlight = false;
          this.checkExercise(result);
        }
        this.status('halted · nothing left to execute');
      }
      this.syncAfterExecution(result);
    } catch (err) {
      // a reset during the await already owns the block's state
      if (this.disposed || this.executionEpoch !== epoch) return;
      this.setRunning(false);
      this.statusError(`error · ${(err instanceof Error ? err.message : String(err))}`);
      // A thrown step never reaches a result: do not leave the badge
      // stuck on "running".
      this.recordExercise(false, '');
    } finally {
      this.busy = false;
      if (!this.disposed) this.events.onActivity(this);
    }
  }

  reset(): void {
    if (this.disposed) return;
    // Resets the machine only: Code and its saved draft stay untouched.
    // A supported named session is one machine: reset it once and tell
    // every member block that their program and output are gone.
    this.session.reset();
    if (this.shared !== undefined) this.shared.loadedSource = null;
    if (this.shared !== undefined && this.shared.supported) {
      for (const block of this.shared.blocks) {
        block.applySharedReset();
      }
    } else {
      this.applySharedReset();
    }
    this.events.onActivity(this);
  }

  /** Invalidate a block after a shared group reset: no program is loaded,
   *  the visible result is gone, and an in-flight badge falls back to the
   *  last judged verdict (a completed pass/fail survives). */
  private applySharedReset(): void {
    if (this.disposed) return;
    // Any execution already awaiting the engine is now stale.
    this.executionEpoch++;
    this.loadedDoc = null;
    this.midFlight = false;
    this.exerciseJudged = false;
    this.setRunning(false);
    this.setError(null);
    this.setMarks({ current: null });
    if (this.resultsEl !== null) this.resultsEl.textContent = '';
    const shared = this.shared;
    this.status(shared !== undefined && shared.supported
      ? 'reset · shared session'
      : 'reset · ready');
    if (this.exerciseBadge?.dataset.state === 'running') {
      this.setExerciseState(this.exerciseResult ?? 'pending');
    }
  }

  /** Restore the sample text without touching the session or its output. */
  revertCode(): void {
    if (this.disposed) return;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: this.sample },
    });
    this.revertBtn.dataset.dirty = 'false';
    this.clearSavedCode();
  }

  /** Mirror the editor text into storage, or drop the draft when the text
   *  matches the sample. Never throws. */
  private persistCode(): void {
    this.revertBtn.dataset.dirty = String(this.source !== this.sample);
    if (this.id === undefined || this.storage === null) return;
    const key = CODE_KEY_PREFIX + this.id;
    try {
      if (this.source === this.sample) this.storage.removeItem(key);
      else this.storage.setItem(key, this.source);
    } catch {
      // storage may be unavailable (privacy mode, quota, sandbox)
    }
  }

  private clearSavedCode(): void {
    if (this.id === undefined || this.storage === null) return;
    try {
      this.storage.removeItem(CODE_KEY_PREFIX + this.id);
    } catch {
      // storage may be unavailable (privacy mode, quota, sandbox)
    }
  }

  private async copyCode(): Promise<void> {
    const text = this.source;
    let copied = false;
    try {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
        await clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) copied = this.fallbackCopy(text);
    if (this.disposed) return;
    if (!copied) {
      if (this.copyTimer !== undefined) {
        window.clearTimeout(this.copyTimer);
        this.copyTimer = undefined;
        this.copyRestore = null;
      }
      this.statusError('copy failed — select the code and copy manually');
      return;
    }
    this.showCopied();
  }

  /** Hidden-textarea fallback for browsers without the async clipboard. */
  private fallbackCopy(text: string): boolean {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    try {
      document.body.appendChild(area);
      area.select();
      return typeof document.execCommand === 'function' && document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }

  private showCopied(): void {
    // Capture once per flash so a repeated click does not snapshot "copied".
    if (this.copyTimer === undefined) {
      this.copyRestore = {
        text: this.statusEl.textContent ?? '',
        error: this.statusEl.classList.contains('lw-status-error'),
      };
    }
    this.status('copied');
    if (this.copyTimer !== undefined) window.clearTimeout(this.copyTimer);
    this.copyTimer = window.setTimeout(() => {
      this.copyTimer = undefined;
      if (this.disposed || this.copyRestore === null) return;
      const { text, error } = this.copyRestore;
      this.copyRestore = null;
      // A newer run/step status wins over the stale pre-copy snapshot.
      if (this.statusEl.textContent !== 'copied') return;
      // Keep a prior run error (or any other status) instead of erasing it.
      if (error) this.statusError(text);
      else this.status(text);
    }, 1200);
  }

  private beginExercise(): void {
    if (this.exercise !== null && this.exercise.expected !== null) {
      this.exerciseJudged = false;
      this.setExerciseState('running');
    }
  }

  /** Check the exercise once a run or step reached a terminal result
   *  (finished or errored). A breakpoint pause is still mid-flight and is
   *  not judged yet. */
  private checkExercise(result: RunResult): void {
    const exercise = this.exercise;
    if (exercise === null || exercise.expected === null) return;
    const errored = result.error !== undefined && result.error !== '';
    if (!errored) {
      if (result.pausedAt !== undefined) return;
      if (result.finished !== true) return;
    }
    const actual = this.consoleText();
    const passed = !errored
      && normalizeOutput(actual) === normalizeOutput(exercise.expected);
    this.recordExercise(passed, actual);
  }

  /** Publish one outcome and paint the badge. Unchecked drills never call
   *  here, so they can never be reported as pass/fail. An outcome needs a
   *  stable id; without one the badge still updates but no host callback
   *  fires (an empty-id outcome would collide across blocks). */
  private recordExercise(passed: boolean, actual: string): void {
    const exercise = this.exercise;
    if (exercise === null || exercise.expected === null) return;
    // One outcome per execution: extra terminal steps after the verdict
    // must not fire the host callback again.
    if (this.exerciseJudged) return;
    this.exerciseJudged = true;
    this.exerciseResult = passed ? 'passed' : 'failed';
    this.setExerciseState(this.exerciseResult);
    if (this.id === undefined) return;
    const outcome: ExerciseOutcome = {
      id: this.id,
      title: exercise.title,
      passed,
      actual,
    };
    try {
      this.onExerciseResult?.(outcome);
    } catch {
      // a host callback must not break the block
    }
  }

  private setExerciseState(state: ExerciseState): void {
    if (this.exerciseBadge === null) return;
    this.exerciseBadge.dataset.state = state;
    this.exerciseBadge.textContent = `Exercise · ${state}`;
  }

  private consoleText(): string {
    const panel = this.session.state().find(
      (p: Panel): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
    return panel?.text ?? '';
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
    // a program that does not load has no result to show
    if (this.resultsEl !== null) this.resultsEl.replaceChildren();
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
    if (this.copyTimer !== undefined) {
      window.clearTimeout(this.copyTimer);
      this.copyTimer = undefined;
    }
    const shared = this.shared;
    if (shared !== undefined) {
      const member = shared.blocks.indexOf(this);
      if (member !== -1) shared.blocks.splice(member, 1);
    }
    // A host-supplied named session belongs to the page, not this block.
    if (this.ownsSession) this.session.dispose();
    this.view.destroy();
    this.el.remove();
  }
}
