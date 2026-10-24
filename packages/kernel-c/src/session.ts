// CSession: load() = real clang compilation (vendored YoWASP engine) of the
// block source to a wasm32-wasip1 module; run() = execution of that module
// through the hand-written WASI shim (src/wasi.ts). Not steppable — this
// kernel compiles and runs whole programs; step() reports { ran: false }.

import { loadEngine } from './vendor';
import { runWasi } from './wasi';
import type { Field, LoadResult, Panel, RunResult, Session } from './types';

const SOURCE = 'lesson.c';
const OUTPUT = 'lesson.wasm';
const RUN_BUDGET_MS = 5_000;
const HEXDUMP_BYTES = 256;
const HEXDUMP_ROW = 16;

interface RunState {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  calls: number;
  error?: string;
}

export class CSession implements Session {
  private module: WebAssembly.Module | null = null;
  private wasmBytes: Uint8Array | null = null;
  private compileMs: number | null = null;
  private diagText = '';
  private runState: RunState | null = null;

  async load(src: string): Promise<LoadResult> {
    let engine;
    try {
      engine = await loadEngine();
    } catch (e) {
      return {
        ok: false,
        // no line: a toolchain boot failure is not any source line's
        // fault, so core shows status text without an editor marker
        message: `failed to load the vendored clang toolchain: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const decoder = new TextDecoder();
    let diag = '';
    const capture = (): ((bytes: Uint8Array | null) => void) => (bytes) => {
      if (bytes) diag += decoder.decode(bytes);
    };

    const startedAt = nowMs();
    try {
      const files = await engine.runClang(
        ['clang', SOURCE, '-o', OUTPUT],
        { [SOURCE]: src },
        { stdout: capture(), stderr: capture() },
      );
      const out = files[OUTPUT];
      if (!(out instanceof Uint8Array)) {
        throw new Error(`clang did not produce ${OUTPUT}`);
      }
      // nanotar hands out views into the resource tar; keep the view itself
      // (no copy) — the intersection only narrows `buffer` for TS's
      // Uint8Array<ArrayBufferLike> vs BufferSource variance.
      this.module = await WebAssembly.compile(out as Uint8Array & { buffer: ArrayBuffer });
      this.wasmBytes = out;
      this.compileMs = Math.round(nowMs() - startedAt);
      this.diagText = diag.trim();
      this.runState = null;
      return {
        ok: true,
        summary: `loaded · ${formatBytes(out.length)} wasm · compiled in ${this.compileMs} ms`,
      };
    } catch (e) {
      this.module = null;
      this.wasmBytes = null;
      this.compileMs = null;
      this.diagText = diag.trim();
      const parsed = parseDiagnostic(diag, SOURCE);
      // No `lesson.c:<line>:<col>:` form (e.g. `wasm-ld: error: undefined
      // symbol`): report the message without a line — core renders status
      // text only and pins no editor marker to line 1.
      const message =
        parsed?.message ??
        firstDiagnosticLine(diag) ??
        `clang failed: ${e instanceof Error ? e.message : String(e)}`;
      return parsed !== null
        ? { ok: false, line: parsed.line, message }
        : { ok: false, message };
    }
  }

  async run(_breakpoints?: number[]): Promise<RunResult> {
    const module = this.module;
    if (!module) return { finished: false, steps: 0, error: 'nothing is loaded' };
    const r = await runWasi(module, RUN_BUDGET_MS);
    this.runState = r;
    if (r.error !== undefined) return { finished: false, steps: r.calls, error: r.error };
    return { finished: true, steps: r.calls, exit: `exit(${r.exitCode ?? 0})` };
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    return { ran: false };
  }

  reset(): void {
    this.runState = null; // back to just-compiled state
  }

  state(): Panel[] {
    if (!this.module || !this.wasmBytes) {
      // Compile failed (or nothing loaded yet): there is no module to show,
      // but clang's own diagnostics are still the under-the-hood story —
      // surface them as the panel's console instead of zero sections.
      if (this.diagText.length === 0) return [];
      return [
        {
          kind: 'console',
          id: 'diagnostics',
          title: 'Diagnostics',
          text: `$ clang ${SOURCE} -o ${OUTPUT}\n${this.diagText}\n`,
        },
      ];
    }

    const fields: Field[] = [
      {
        key: 'exit',
        value:
          this.runState !== null && this.runState.exitCode !== null
            ? `exit(${this.runState.exitCode})`
            : 'not run',
      },
      {
        key: 'wasm size',
        value: formatBytes(this.wasmBytes.length),
        sub: `${this.wasmBytes.length} bytes`,
      },
      {
        key: 'compile',
        value: this.compileMs !== null ? `${this.compileMs} ms` : '—',
      },
    ];

    const hexdump: { addr: number; bytes: number[]; ascii: string }[] = [];
    const bytes = this.wasmBytes.subarray(0, HEXDUMP_BYTES);
    for (let off = 0; off < bytes.length; off += HEXDUMP_ROW) {
      const row = Array.from(bytes.subarray(off, off + HEXDUMP_ROW));
      hexdump.push({
        addr: off,
        bytes: row,
        ascii: row.map((b) => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join(''),
      });
    }

    const consoleText =
      `$ clang ${SOURCE} -o ${OUTPUT}\n` +
      (this.diagText.length > 0 ? this.diagText + '\n' : '(no diagnostics)\n') +
      `\n$ ./${OUTPUT}\n` +
      (this.runState !== null
        ? this.runState.stdout +
            (this.runState.stderr.length > 0 ? this.runState.stderr + '\n' : '') +
            (this.runState.error !== undefined ? this.runState.error + '\n' : '')
        : '(not run yet)\n');

    return [
      { kind: 'console', id: 'console', title: 'Console', text: consoleText },
      { kind: 'fields', id: 'program', title: 'Program', fields },
      { kind: 'hexdump', id: 'wasm', title: 'Module · first 256 bytes', rows: hexdump },
    ];
  }

  dispose(): void {
    this.module = null;
    this.wasmBytes = null;
    this.runState = null;
    this.diagText = '';
  }
}

/**
 * Maps `lesson.c:<line>:<col>: error: <message>` (clang's diagnostic format)
 * to a line-mapped LoadResult error with clang's exact 1-based line.
 */
function parseDiagnostic(diag: string, source: string): { line: number; message: string } | null {
  const pattern = new RegExp(`^${escapeRegExp(source)}:(\\d+):(\\d+): (?:fatal )?error: (.+)$`, 'm');
  const match = pattern.exec(diag);
  if (!match) return null;
  return { line: Number(match[1]), message: match[3] };
}

function firstDiagnosticLine(diag: string): string | null {
  for (const line of diag.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatBytes(n: number): string {
  return `${(n / 1024).toFixed(1)} KiB`;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
