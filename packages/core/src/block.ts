// block.ts — executable block runtime: CM6 editor, inline controls
// (Run/Step/Reset machine/Revert code/Copy Code + mono status), line-mapped
// error box, current-line decoration, gutter breakpoints (when the kernel
// supports them), results-slot output, persisted editor text, and exercise
// checking.

import type { EditorView } from '@codemirror/view';
import {
  createBlockEditor,
  dispatchLineMarks,
  getBreakpointLines,
  type LineMarks,
} from './block-editor';
import { ExerciseController } from './block-exercise';
import {
  DEFAULT_STORAGE_PREFIX,
  clearSavedCode,
  copyToClipboard,
  defaultStorage,
  extractConsoleText,
  isApplePlatform,
  normalizeStoragePrefix,
  readSavedCode,
  renderBlockResults,
  writeSavedCode,
} from './block-io';
import type { Kernel, Panel, RunResult, Session } from './kernel';
import type { OrgNode } from './org';
import type { BlockRuntimeOptions, StorageLike } from './teaching';

type SrcNode = Extract<OrgNode, { kind: 'src' }>;

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
  /** Block that loaded `loadedSource`, so identical-source siblings never
   *  falsely skip reload or continue another sibling's mid-flight state. */
  loadedBlock?: BlockRuntime | null;
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
  private readonly doc: Document;
  private readonly win: Window;
  private readonly events: BlockEvents;
  private readonly view: EditorView;
  private readonly statusEl: HTMLElement;
  /** Null in a read-only mount: no revert control is created. */
  private readonly revertBtn: HTMLButtonElement | null;
  private readonly errorEl: HTMLElement;
  private readonly resultsEl: HTMLElement | null;
  private readonly sample: string;
  /** Page-scoped id: enables saved code and identifies exercise results. */
  private readonly id: string | undefined;
  /** Backend for saved code; null when persistence is unavailable. */
  private readonly storage: StorageLike | null;
  private readonly storagePrefix: string;
  private readonly exerciseCtrl: ExerciseController;
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
    this.doc = mount.ownerDocument ?? document;
    this.win = this.doc.defaultView ?? window;
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
    this.storagePrefix = normalizeStoragePrefix(
      options.storagePrefix ?? DEFAULT_STORAGE_PREFIX,
    );

    // A saved draft wins over the document's sample text; every read is
    // best-effort so unavailable/blocked storage never breaks the block.
    // A read-only mount always shows the document's sample: a draft left
    // by an earlier writable visit must not shadow it.
    const saved = options.readOnly === true
      ? null
      : readSavedCode(this.storage, this.storagePrefix, this.id);
    const initialCode = saved ?? node.code;

    this.el = this.doc.createElement('div');
    this.el.className = 'lw-block';
    this.el.dataset.test = 'block';
    this.el.dataset.name = this.title;

    const head = this.doc.createElement('div');
    head.className = 'lw-block-head';

    const meta = this.doc.createElement('div');
    meta.className = 'lw-block-meta';

    const lang = this.doc.createElement('span');
    lang.className = 'lw-lang';
    lang.textContent = node.lang;
    meta.appendChild(lang);

    const name = this.doc.createElement('span');
    name.className = 'lw-block-name';
    name.textContent = this.title;
    meta.appendChild(name);

    if (shared !== undefined) {
      const sess = this.doc.createElement('span');
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

    this.exerciseCtrl = new ExerciseController(
      node.exercise,
      this.id,
      options.exercisePassed === true,
      options.onExerciseResult,
      this.doc,
    );
    if (this.exerciseCtrl.badge !== null) {
      meta.appendChild(this.exerciseCtrl.badge);
    }

    head.appendChild(meta);

    const actions = this.doc.createElement('div');
    actions.className = 'lw-block-actions';

    const apple = isApplePlatform();
    const runBtn = this.doc.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'lw-btn lw-btn-primary';
    runBtn.dataset.test = 'block-run';
    runBtn.textContent = '▶ Run';
    runBtn.title = `Run the block (${apple ? '⌘' : 'Ctrl+'}Enter)`;
    runBtn.setAttribute('aria-keyshortcuts', apple ? 'Meta+Enter' : 'Control+Enter');
    runBtn.addEventListener('click', () => void this.run());
    actions.appendChild(runBtn);

    const canStep = kernel.features?.stepping !== false;
    const stepBtn = this.doc.createElement('button');
    stepBtn.type = 'button';
    stepBtn.className = 'lw-btn lw-btn-secondary';
    stepBtn.dataset.test = 'block-step';
    stepBtn.textContent = '⤵ Step';
    stepBtn.title = 'Step one instruction (Shift+Enter)';
    stepBtn.setAttribute('aria-keyshortcuts', 'Shift+Enter');
    stepBtn.addEventListener('click', () => void this.step());
    if (canStep) actions.appendChild(stepBtn);

    const resetBtn = this.doc.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'lw-btn lw-btn-ghost';
    resetBtn.dataset.test = 'block-reset';
    resetBtn.textContent = '⟲';
    resetBtn.title = 'Reset session and clear output (keeps code)';
    resetBtn.setAttribute('aria-label', 'Reset session');
    resetBtn.addEventListener('click', () => this.reset());
    actions.appendChild(resetBtn);

    if (options.readOnly === true) {
      // nothing to revert to in a read-only mount
      this.revertBtn = null;
    } else {
      const revertBtn = this.doc.createElement('button');
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
    }

    const copyBtn = this.doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'lw-btn lw-btn-ghost';
    copyBtn.dataset.test = 'block-copy';
    copyBtn.textContent = '⧉';
    copyBtn.title = 'Copy code to clipboard';
    copyBtn.setAttribute('aria-label', 'Copy code');
    copyBtn.addEventListener('click', () => void this.copyCode());
    actions.appendChild(copyBtn);

    this.statusEl = this.doc.createElement('span');
    this.statusEl.className = 'lw-status';
    this.statusEl.dataset.test = 'block-status';
    this.statusEl.setAttribute('aria-live', 'polite');
    this.statusEl.textContent = 'idle';

    head.append(actions, this.statusEl);
    this.el.appendChild(head);

    const editorHost = this.doc.createElement('div');
    editorHost.dataset.test = 'editor';
    const canBreak = kernel.features?.breakpoints === true;
    if (canBreak) editorHost.dataset.bp = 'true';
    this.el.appendChild(editorHost);

    const language = options.editorLanguage ?? null;

    this.view = createBlockEditor({
      parent: editorHost,
      initialCode,
      canBreak,
      canStep,
      language,
      syntax: kernel.editorSyntax,
      theme: options.editorTheme,
      extensions: options.editorExtensions,
      readOnly: options.readOnly,
      onRun: () => {
        if (!this.busy && !this.disposed) void this.run();
      },
      onStep: () => {
        if (!this.busy && !this.disposed) void this.step();
      },
      onDocChanged: () => this.persistCode(),
    });

    this.errorEl = this.doc.createElement('div');
    this.errorEl.className = 'lw-error';
    this.errorEl.dataset.test = 'block-error';
    this.errorEl.setAttribute('role', 'alert');
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
    this.exerciseCtrl.begin();
    let exerciseChecked = false;
    let epoch = this.executionEpoch;
    try {
      const src = this.source;
      // A mid-flight session (paused at a breakpoint, or mid-stepping)
      // continues only when it still holds this block's program: a
      // sibling's run may have replaced it in the shared session.
      const resume = this.midFlight
        && this.loadedDoc === src
        && (this.shared === undefined
          || (this.shared.loadedSource === src
            && (this.shared.loadedBlock === undefined || this.shared.loadedBlock === this)));
      if (!resume) {
        this.status('working…');
        // A supported named session continues its live state on every Run
        // (org-babel semantics: re-running accumulates definitions/data).
        const load = this.shared?.supported === true
            && this.session.resume !== undefined
          ? await this.session.resume(src)
          : await this.session.load(src);
        if (this.disposed) return;
        if (!load.ok) {
          this.loadedDoc = null;
          this.midFlight = false;
          // a failed load leaves the session holding no program — even a
          // sibling's source, which the failed load just displaced
          if (this.shared !== undefined) {
            this.shared.loadedSource = null;
            this.shared.loadedBlock = null;
          }
          this.finish(load);
          this.exerciseCtrl.record(false, '');
          exerciseChecked = true;
          return;
        }
        this.loadedDoc = src;
        if (this.shared !== undefined) {
          const previous = this.shared.loadedBlock;
          this.shared.loadedSource = src;
          this.shared.loadedBlock = this;
          // the sibling that owned the session no longer shows a live line
          if (previous !== undefined && previous !== null && previous !== this) {
            previous.clearCurrentMark();
          }
        }
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
      this.syncAfterExecution(result);
      this.exerciseCtrl.check(result, this.consoleText());
      exerciseChecked = true;
    } catch (err) {
      // a reset during the await already owns the block's state
      if (this.disposed || this.executionEpoch !== epoch) return;
      // a kernel throw must not brick the block (busy flag, outline)
      this.setRunning(false);
      this.statusError(`error · ${(err instanceof Error ? err.message : String(err))}`);
      if (!exerciseChecked) this.exerciseCtrl.record(false, this.consoleText());
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
      const src = this.source;
      // A shared group's program identity lives in the session itself:
      // stepping block A after block B ran must first resume A's source,
      // even when A and B carry identical source text.
      const needsLoad = this.shared === undefined
        ? this.loadedDoc !== src
        : this.shared.loadedSource !== src
          || (this.shared.loadedBlock !== undefined && this.shared.loadedBlock !== this);
      if (needsLoad) {
        this.status('working…');
        // Same choice as run(): a supported named session continues its live
        // state instead of reloading (which would wipe the group's state).
        const load = this.shared?.supported === true
            && this.session.resume !== undefined
          ? await this.session.resume(src)
          : await this.session.load(src);
        if (this.disposed) return;
        if (!load.ok) {
          this.loadedDoc = null;
          this.midFlight = false;
          // a failed load leaves the session holding no program — even a
          // sibling's source, which the failed load just displaced
          if (this.shared !== undefined) {
            this.shared.loadedSource = null;
            this.shared.loadedBlock = null;
          }
          // The reload began a new execution and failed: judge a checked
          // exercise so a stale "passed" badge cannot survive it.
          this.exerciseCtrl.begin();
          this.exerciseCtrl.record(false, '');
          this.finish(load);
          return;
        }
        this.loadedDoc = src;
        if (this.shared !== undefined) {
          const previous = this.shared.loadedBlock;
          this.shared.loadedSource = src;
          this.shared.loadedBlock = this;
          // the sibling that owned the session no longer shows a live line
          if (previous !== undefined && previous !== null && previous !== this) {
            previous.clearCurrentMark();
          }
        }
        // A step that reloads a fresh program begins a new execution.
        this.exerciseCtrl.begin();
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
          this.exerciseCtrl.check(result, this.consoleText());
        }
      } else {
        // Some kernels hand back the terminal result with ran === false
        // (the final step consumed no instruction); still judge it.
        if (result !== undefined
          && (result.finished === true || result.error !== undefined)) {
          this.midFlight = false;
          this.exerciseCtrl.check(result, this.consoleText());
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
      this.exerciseCtrl.record(false, this.consoleText());
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
    if (this.shared !== undefined) {
      this.shared.loadedSource = null;
      this.shared.loadedBlock = null;
    }
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
    this.setRunning(false);
    this.setError(null);
    this.setMarks({ current: null });
    if (this.resultsEl !== null) this.resultsEl.textContent = '';
    const shared = this.shared;
    this.status(shared !== undefined && shared.supported
      ? 'reset · shared session'
      : 'reset · ready');
    this.exerciseCtrl.reset();
  }

  /** Restore the sample text without touching the session or its output. */
  revertCode(): void {
    // a read-only mount has no revert control and must leave storage alone
    if (this.disposed || this.revertBtn === null) return;
    if (this.source !== this.sample) {
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: this.sample },
      });
    }
    this.revertBtn.dataset.dirty = 'false';
    clearSavedCode(this.storage, this.storagePrefix, this.id);
  }

  private persistCode(): void {
    if (this.revertBtn !== null) {
      this.revertBtn.dataset.dirty = String(this.source !== this.sample);
    }
    writeSavedCode(this.storage, this.storagePrefix, this.id, this.source, this.sample);
  }

  private async copyCode(): Promise<void> {
    const copied = await copyToClipboard(this.source, this.doc);
    if (this.disposed) return;
    if (!copied) {
      if (this.copyTimer !== undefined) {
        this.win.clearTimeout(this.copyTimer);
        this.copyTimer = undefined;
        this.copyRestore = null;
      }
      this.statusError('copy failed — select the code and copy manually');
      return;
    }
    this.showCopied();
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
    if (this.copyTimer !== undefined) this.win.clearTimeout(this.copyTimer);
    this.copyTimer = this.win.setTimeout(() => {
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

  private consoleText(): string {
    return extractConsoleText(this.session.state());
  }

  private breakpointLines(): number[] | undefined {
    return getBreakpointLines(this.view, this.kernel.features?.breakpoints === true);
  }

  private syncAfterExecution(result?: RunResult): void {
    const panels = this.session.state();
    if (this.resultsEl !== null) renderBlockResults(this.resultsEl, panels, this.doc);
    const listing = panels.find(
      (p: Panel): p is Extract<Panel, { kind: 'listing' }> => p.kind === 'listing');
    const row = listing?.rows.find((r) => r.current);
    // a breakpoint pause pins the editor decoration to the paused line
    this.setMarks({ current: result?.pausedAt ?? row?.line ?? null });
  }

  /** Shared tail for a failed load: red status, line-mapped error, clear results.
   *  The surrounding `finally` block clears `busy` and notifies `onActivity`. */
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
    dispatchLineMarks(this.view, marks);
  }

  /** Drop the paused-line decoration when a sibling takes over the shared
   *  session: the line is no longer where either block is executing. */
  private clearCurrentMark(): void {
    if (this.disposed) return;
    this.setMarks({ current: null });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.copyTimer !== undefined) {
      this.win.clearTimeout(this.copyTimer);
      this.copyTimer = undefined;
    }
    const shared = this.shared;
    if (shared !== undefined) {
      const member = shared.blocks.indexOf(this);
      if (member !== -1) shared.blocks.splice(member, 1);
      if (shared.loadedBlock === this) shared.loadedBlock = null;
    }
    // A host-supplied named session belongs to the page, not this block.
    if (this.ownsSession) this.session.dispose();
    this.view.destroy();
    this.el.remove();
  }
}
