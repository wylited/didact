// Session: one executable python block over the shared Pyodide engine.
//
// Semantics:
//  - Fresh namespace per session: each block execs in its own dict passed
//    as `globals`, so state never carries between blocks — and load()
//    recreates the dict, so re-running a block starts from an empty slate.
//  - load(src) is a compile() gate: CPython's own SyntaxError, with
//    CPython's own line number, is surfaced verbatim. Engine-boot failures
//    surface as line-0 load failures.
//  - run() execs to completion (Pyodide has no notion of single-statement
//    steps, so features.stepping is false and step() never runs). stdout
//    and stderr are captured via setStdout/setStderr into one buffer, in
//    write order. The variables panel diffs the namespace before/after:
//    globals defined or changed by the run, keyed by name, value =
//    repr(value) truncated, sub = type name; dunder/underscore names and
//    modules are skipped.
//  - An uncaught exception finishes the run with error = "Type: message"
//    (the traceback's last line) and appends the full traceback to the
//    console panel.

import type { PyodideInterface } from 'pyodide';
import type { PyProxy } from 'pyodide/ffi';
import { loadEngine, serialized } from './vendor';
import type { Field, LoadResult, Panel, RunResult, Session } from './types';

const REPR_LIMIT = 40;
/** Traceback file name; real (not <>-wrapped) so tracebacks show source lines. */
const FILENAME = 'lesson.py';

/** name → [repr(value), type name] */
type Snapshot = Map<string, { repr: string; type: string }>;

// Python-side helpers, installed once per engine into the interpreter's own
// main namespace (underscore-prefixed, so they can never appear in a block
// snapshot). Results cross back to JS as JSON strings to avoid proxy churn.
const HELPERS = `
import json, types

def _lw_check(src):
    try:
        compile(src, ${JSON.stringify(FILENAME)}, 'exec')
    except SyntaxError as e:
        return json.dumps([e.lineno or 1, '%s: %s' % (type(e).__name__, e.msg)])
    except ValueError as e:
        return json.dumps([0, 'ValueError: %s' % e])
    return None

def _lw_snapshot(ns):
    snap = {}
    for name, value in ns.items():
        if name.startswith('_') or isinstance(value, types.ModuleType):
            continue
        try:
            snap[name] = [repr(value), type(value).__name__]
        except Exception:
            snap[name] = ['<unrepresentable>', type(value).__name__]
    return json.dumps(snap)
`;

/** Engines that already have the _lw_* helpers installed. */
const helperReady = new WeakSet<object>();

export class PythonSession implements Session {
  private readonly engine: () => Promise<PyodideInterface>;
  private py: PyodideInterface | null = null;
  /** This block's namespace dict (fresh per load); `null` before first load. */
  private ns: PyProxy | null = null;
  private src: string | null = null;
  private out: string[] = [];
  private fields: Field[] = [];

  constructor(engine: () => Promise<PyodideInterface> = loadEngine) {
    this.engine = engine;
  }

  async load(src: string): Promise<LoadResult> {
    let py: PyodideInterface;
    try {
      py = await this.engine();
    } catch (e) {
      return {
        ok: false,
        line: 0,
        message: `failed to load the Python engine: ${message(e)}`,
      };
    }
    this.py = py;
    let verdict: string | undefined;
    try {
      verdict = await serialized(async () => {
        await this.ensureHelpers(py);
        const locals = py.toPy({ src });
        try {
          return await py.runPythonAsync('_lw_check(src)', {
            globals: py.globals,
            locals,
          });
        } finally {
          locals.destroy();
        }
      });
    } catch (e) {
      return { ok: false, line: 0, message: `compile check failed: ${message(e)}` };
    }
    if (typeof verdict === 'string') {
      const [line, msg] = JSON.parse(verdict) as [number, string];
      return { ok: false, line, message: msg };
    }
    // Fresh namespace and a clean console for the run that follows.
    this.ns?.destroy();
    this.ns = py.toPy({ __name__: '__main__' });
    this.src = src;
    this.out = [];
    this.fields = [];
    return { ok: true, summary: `loaded · ${lineCount(src)} lines` };
  }

  async run(): Promise<RunResult> {
    const py = this.py;
    const ns = this.ns;
    const src = this.src;
    if (!py || !ns || src === null) {
      return { finished: false, steps: 0, error: 'nothing is loaded — press Run first' };
    }
    return serialized(async () => {
      const before = await this.snapshot(py, ns);
      py.setStdout({ batched: (s: string) => { this.out.push(s + '\n'); } });
      py.setStderr({ batched: (s: string) => { this.out.push(s + '\n'); } });
      let error: string | undefined;
      try {
        await py.runPythonAsync(src, { globals: ns, filename: FILENAME });
      } catch (e) {
        const traceback = message(e).trimEnd();
        error = traceback.split('\n').pop() ?? traceback;
        this.out.push(traceback + '\n');
      }
      const after = await this.snapshot(py, ns);
      this.fields = diff(before, after);
      return error === undefined
        ? { finished: true, steps: 0 }
        : { finished: false, steps: 0, error };
    });
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    return { ran: false }; // Pyodide executes to completion; there are no steps.
  }

  reset(): void {
    this.ns?.destroy();
    this.ns = null;
    this.src = null;
    this.out = [];
    this.fields = [];
  }

  state(): Panel[] {
    return [
      { kind: 'console', id: 'py-console', title: 'Console · stdout + stderr', text: this.out.join('') },
      { kind: 'fields', id: 'py-variables', title: 'Variables · block namespace', fields: this.fields },
    ];
  }

  dispose(): void {
    this.reset();
    this.py = null;
  }

  private async snapshot(py: PyodideInterface, ns: PyProxy): Promise<Snapshot> {
    const locals = py.toPy({ ns });
    try {
      const raw: unknown = await py.runPythonAsync('_lw_snapshot(ns)', {
        globals: py.globals,
        locals,
      });
      // The helper always returns json.dumps(...), a Python str → a JS string.
      const json = raw as string;
      const snap: Snapshot = new Map();
      const parsed = JSON.parse(json) as Record<string, [string, string]>;
      for (const [name, [repr, type]] of Object.entries(parsed)) {
        snap.set(name, { repr, type });
      }
      return snap;
    } finally {
      locals.destroy();
    }
  }

  private async ensureHelpers(py: PyodideInterface): Promise<void> {
    if (helperReady.has(py)) return;
    await py.runPythonAsync(HELPERS);
    helperReady.add(py);
  }
}

/** Fields for globals defined or changed by the run (untouched ones hidden). */
function diff(before: Snapshot, after: Snapshot): Field[] {
  const fields: Field[] = [];
  for (const [name, { repr, type }] of after) {
    const prev = before.get(name);
    if (prev !== undefined && prev.repr === repr) continue;
    const value = repr.length <= REPR_LIMIT
      ? repr
      : repr.slice(0, REPR_LIMIT - 1) + '…';
    fields.push({ key: name, value, sub: type, changed: true });
  }
  return fields;
}

function lineCount(src: string): number {
  const t = src.trimEnd();
  return t.length === 0 ? 0 : t.split('\n').length;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
