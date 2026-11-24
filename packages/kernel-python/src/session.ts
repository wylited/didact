// Session: one executable python block over the shared Pyodide engine.
//
// Semantics kept from the original kernel:
//  - Fresh namespace per session: each block execs in its own dict passed
//    as `globals`, so state never carries between blocks — and load()
//    recreates the dict, so re-running a block starts from an empty slate.
//  - load(src) is a compile() gate: CPython's own SyntaxError, with
//    CPython's own line number, is surfaced verbatim. Engine-boot failures
//    surface as line-0 load failures.
//  - stdout/stderr are captured via setStdout/setStderr `write` handlers —
//    every chunk verbatim, in write order — then flushed and reset at run
//    end, so an unflushed tail neither vanishes nor leaks into the next
//    session's console over the shared engine.
//  - An uncaught exception finishes the run with error = "Type: message"
//    (the traceback's last line) and appends the full traceback to the
//    console panel.
//
// Added by the x-ray (the engine side is toolkit.py):
//  - the block is compiled once, whole; a LINE hook counts every executed
//    line of its module and is always removed at run end (failure included);
//  - run() execs the block once, as one engine job, under the line hook:
//    hit counts, loop/branch flow, the frames and the grouped namespace all
//    come back in one snapshot when it finishes. There is NO per-statement
//    heartbeat: Pyodide cannot pause mid-job, so the panel updates on
//    attach and at the end (the progress line says how far it got);
//  - step() is a no-op (`ran: false`): CPython's only pause points are
//    before a code object starts, so a running block cannot be suspended
//    from outside. Line-level x-raying comes from the hook instead.
//  - the failure story keeps the traceback frames and the failing frame's
//    locals, and the snapshot groups the namespace.

import type { PyodideInterface } from 'pyodide';
import type { PyProxy } from 'pyodide/ffi';
import { loadEngine, serializedLive } from './vendor';
import { TOOLKIT_SOURCE } from './toolkit';
import {
  buildPanels,
  flattenTrace,
  sourceLines,
  type AnnotationRow,
  type FailureData,
  type FlowData,
  type Progress,
  type TraceMeta,
  type VarInfo,
} from './xray';
import type { LoadResult, Panel, RunResult, Session } from './types';

/** One top-level statement: its source text and line range. */
export interface Statement {
  /** The statement's source, dedented by the helper (null: not runnable). */
  text: string | null;
  first: number;
  last: number;
}

/** `lw_trace()` row: [line, statement number, hits, meta]. */
type RawTrace = readonly (readonly [number, number, number, TraceMeta | null])[];

/** Engines that have the `lw_*` helper installed. */
const helperReady = new WeakSet<object>();

export class PythonSession implements Session {
  private readonly engine: () => Promise<PyodideInterface>;
  private py: PyodideInterface | null = null;
  private ns: PyProxy | null = null;
  private src: string | null = null;
  private out: string[] = [];
  private statements: Statement[] = [];
  private hook: string | null = null;
  private trace: RawTrace | null = null;
  private flow: FlowData | null = null;
  private vars: Map<string, VarInfo> = new Map();
  /** The reprs the `changed` marks diff against (null = nothing changed). */
  private prevVars: Map<string, string> | null = null;
  private frames: [string, number][] = [];
  private failure: FailureData | null = null;
  private locals: Map<string, VarInfo> = new Map();
  private annotations: AnnotationRow[] = [];
  private progress: Progress | null = null;
  /** 0-based index of the next top-level statement to execute. */
  private cursor = 0;
  /** Bumped by reset()/dispose(): a live run stops at its next boundary. */
  private epoch = 0;


  constructor(engine: () => Promise<PyodideInterface> = loadEngine) {
    this.engine = engine;
  }

  // -- load / resume -------------------------------------------------------

  async load(src: string): Promise<LoadResult> {
    return this.prepare(src, false);
  }

  /** Continue the live namespace with another block (`:session <name>`). */
  async resume(src: string): Promise<LoadResult> {
    return this.prepare(src, true);
  }

  /**
   * The shared load path. `keepState` keeps the namespace, so an org
   * `:session` block sees the definitions and data of earlier blocks.
   * Every call resets the per-block run state (console, cursor, trace,
   * failure story), so the next run shows only this block's output.
   */
  private async prepare(src: string, keepState: boolean): Promise<LoadResult> {
    let py: PyodideInterface;
    try {
      py = await this.engine();
    } catch (e) {
      return { ok: false, line: 0, message: `failed to load the Python engine: ${message(e)}` };
    }
    this.py = py;
    let verdict: string | null;
    try {
      verdict = await serializedLive(async () => {
        await this.ensureHelpers(py);
        const syntax = (await this.helper(py, 'lw_check(src)', { src })) as unknown;
        if (syntax !== null && syntax !== undefined && syntax !== '') return String(syntax);
        await this.helper(py, 'lw_compile(src)', { src });
        return null;
      });
    } catch (e) {
      if (keepState) this.clearBlockView();
      return { ok: false, line: 0, message: `compile check failed: ${message(e)}` };
    }
    if (typeof verdict === 'string') {
      const [line, msg] = JSON.parse(verdict) as [number, string];
      if (keepState) this.clearBlockView();
      return { ok: false, line, message: msg };
    }
    if (!keepState || this.ns === null) {
      this.ns?.destroy();
      this.ns = py.toPy({ __name__: '__main__' });
    }
    this.src = src;
    this.out = [];
    this.cursor = 0;
    this.prevVars = null;
    this.failure = null;
    this.locals = new Map();
    this.annotations = [];
    this.progress = null;
    this.trace = null;
    this.flow = null;
    this.frames = [];
    this.statements = await this.json<Statement[]>(py, 'lw_split_json(src)', { src });
    await this.refresh(py, null);
    const verb = keepState ? 'resumed' : 'loaded';
    return { ok: true, summary: `${verb} · ${lineCount(src)} lines · ${this.statements.length} statements` };
  }

  /**
   * Drop the per-block view state after a failed resume, so the panels stop
   * describing the previous block. The namespace and engine stay alive: a
   * later successful resume continues from them.
   */
  private clearBlockView(): void {
    this.src = null;
    this.statements = [];
    this.out = [];
    this.cursor = 0;
    this.prevVars = null;
    this.vars = new Map();
    this.failure = null;
    this.locals = new Map();
    this.annotations = [];
    this.progress = null;
    this.trace = null;
    this.flow = null;
    this.frames = [];
  }

  // -- run / step ----------------------------------------------------------

  async run(): Promise<RunResult> {
    const py = this.py;
    const ns = this.ns;
    if (!py || !ns || this.src === null) {
      return { finished: false, steps: 0, error: 'nothing is loaded — press Run first' };
    }
    if (this.failure !== null) {
      return { finished: false, steps: 0, error: this.failure.error };
    }
    // steps stay 0: the block runs in one engine job, so there is no step
    // grain to count (see the module comment and features.stepping)
    return this.episode(py, ns);
  }

  /** No stepping: see the module comment. */
  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    return { ran: false };
  }

  reset(): void {
    this.epoch++;
    this.ns?.destroy();
    this.ns = null;
    this.src = null;
    this.out = [];
    this.prevVars = null;
    this.vars = new Map();
    this.trace = null;
    this.flow = null;
    this.frames = [];
    this.failure = null;
    this.locals = new Map();
    this.annotations = [];
    this.progress = null;
    this.cursor = 0;
    this.statements = [];
  }

  state(): Panel[] {
    return buildPanels({
      source: this.src === null ? [] : sourceLines(this.src),
      trace: this.trace === null ? null : flattenTrace(this.trace),
      flow: this.flow,
      vars: this.vars,
      prevVars: this.prevVars,
      frames: this.frames,
      failure: this.failure,
      locals: this.locals,
      annotations: this.annotations,
      console: this.out.join(''),
      running: this.progress?.live ?? false,
      progress: this.progress,
      hook: this.hook,
    });
  }

  dispose(): void {
    this.reset();
    this.py = null;
  }

  // -- the execution stream ------------------------------------------------

  /**
   * Execute the block in a single engine job under the line hook, then take
   * one snapshot of everything the x-ray shows. Any failure ends the job
   * with the failure story captured in the same serialized section.
   */
  private async episode(py: PyodideInterface, ns: PyProxy): Promise<RunResult> {
    const epoch = this.epoch;
    const total = this.statements.length;
    const from = this.cursor;
    // the diff baseline: the reprs the namespace held before this run, so
    // the vars panel can mark what the run changed (empty on a fresh block)
    this.prevVars = new Map([...this.vars].map(([name, info]) => [name, info.repr] as const));
    this.progress = { from: this.statements[from]?.first ?? 0, to: total, done: from, total, live: true };
    this.installWriters(py);
    let error: string | undefined;
    try {
      this.hook = String(await this.helper(py, 'lw_mode()'));
      await this.helper(py, 'lw_start()');
      // The block runs exactly as CPython compiled it (one exec, no per-
      // statement recompiles), so every hit count is the interpreter's own.
      // The hook samples its position; each sample re-reads the panels and
      // re-renders, which is the progress heartbeat.
      // Runs are not resumable at statement granularity: a second Run after
      // a pause restarts the block (see the final summary for why).
      await this.helper(py, 'lw_run(ns, True)', { ns });
      if (this.epoch === epoch) this.cursor = total;
    } catch (e) {
      // the helper recorded the failure; its `text` is the lesson's own
      // frames, so the console does not show pyodide's internals
      error = message(e);
      try {
        this.failure = (await this.json<FailureData | null>(py, 'lw_fail_exc()'))
          ?? { error, traceback: [] };
        error = this.failure.error;
        this.out.push((this.failure.text ?? message(e)).trimEnd() + '\n');
        this.locals = new Map(Object.entries(
          (await this.json<Record<string, VarInfo>>(py, 'lw_locals()')) ?? {},
        ));
      } catch {
        this.failure = { error, traceback: [] };
      }
    } finally {
      try {
        await this.helper(py, 'lw_stop()');
      } catch {
        // removing the hook must never mask the run's own result
      }
      try {
        py.runPython('import sys; sys.stdout.flush(); sys.stderr.flush()');
      } catch {
        // flushing must never mask the run's own result
      }
      py.setStdout();
      py.setStderr();
    }
    if (this.epoch === epoch) {
      await this.refresh(py, epoch);
      const last = this.cursor === 0 ? undefined : this.statements[this.cursor - 1];
      this.progress = {
        from: last?.first ?? 0,
        to: last?.last ?? 0,
        done: this.cursor,
        total,
        live: false,
      };
    }
    if (error !== undefined) return { finished: false, steps: 0, error };
    const finished = this.cursor >= total;
    return finished ? { finished: true, steps: 0 } : { finished: false, steps: 0 };
  }

  private installWriters(py: PyodideInterface): void {
    // Pyodide's `batched` handlers only deliver complete lines: an
    // unflushed tail would be dropped here and later leak into whichever
    // session writes the next newline (the handlers are engine-global).
    // `write` Writers receive every byte chunk verbatim instead.
    const decoder = new TextDecoder();
    const push = (b: Uint8Array): number => {
      this.out.push(decoder.decode(b, { stream: true }));
      return b.length;
    };
    py.setStdout({ write: push });
    py.setStderr({ write: push });
  }

  // -- snapshots -----------------------------------------------------------

  /**
   * Re-read every panel's data. `epoch` is null at rest (the diff baseline
   * becomes this snapshot); during a run the baseline stays the value the
   * run started with, so `changed` means "changed since the run started".
   */
  private async refresh(py: PyodideInterface, epoch: number | null): Promise<void> {
    const ns = this.ns;
    if (ns === null) return;
    const trace = await this.json<RawTrace>(py, 'lw_trace()');
    const annotations = await this.json<AnnotationRow[]>(py, 'lw_annotations(ns)', { ns });
    if (epoch !== null && this.epoch !== epoch) return;
    this.trace = trace;
    this.annotations = annotations;
    try {
      this.flow = await this.json<FlowData>(py, 'lw_flow()');
      this.frames = await this.json<[string, number][]>(py, 'lw_frames()');
    } catch {
      // frames/flow are diagnostics: never fail a snapshot over them
    }
    const vars = await this.json<Record<string, VarInfo>>(py, 'lw_snapshot(ns)', { ns });
    this.vars = new Map(Object.entries(vars ?? {}));
    // only a run fills in a missing baseline; at rest the marks set by the
    // last run stay visible until the next run (or reset) replaces them
    if (epoch !== null && this.prevVars === null) this.prevVars = new Map();
  }

  // -- engine plumbing -----------------------------------------------------

  private async ensureHelpers(py: PyodideInterface): Promise<void> {
    if (helperReady.has(py)) return;
    await py.runPythonAsync(TOOLKIT_SOURCE);
    helperReady.add(py);
  }

  /** Evaluate a helper expression with optional locals, decoded to JS. */
  private async helper(py: PyodideInterface, code: string, locals?: Record<string, unknown>): Promise<unknown> {
    const lc = locals === undefined ? null : py.toPy(locals);
    try {
      const raw = await py.runPythonAsync(code, {
        globals: py.globals,
        ...(lc === null ? {} : { locals: lc }),
      });
      return decode(raw);
    } finally {
      lc?.destroy();
    }
  }

  private async json<T>(py: PyodideInterface, code: string, locals?: Record<string, unknown>): Promise<T> {
    const text = await this.helper(py, code, locals);
    if (typeof text !== 'string') throw new Error(`helper ${code} returned ${typeof text}, expected JSON text`);
    return JSON.parse(text) as T;
  }
}

function lineCount(src: string): number {
  const t = src.trimEnd();
  return t.length === 0 ? 0 : t.split('\n').length;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A Python str arrives as a JS string; bytes as a view of the heap. */
function decode(raw: unknown): unknown {
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return raw;
}
