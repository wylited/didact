// Minimal hand-written WASI preview1 shim for wasm32-wasip1 modules, on the
// raw WebAssembly API — no npm dependency for execution.
//
// Implemented (enough for wasi-libc command programs like clang's output):
//  - fd_write         stdout/stderr captured to strings, one decode per
//                    write (iovecs merged), capped at 1 MiB per stream
//  - proc_exit        captured as the program's exit code
//  - random_get       crypto.getRandomValues (xorshift fallback)
//  - clock_time_get   CLOCK_REALTIME: wall clock; other ids: monotonic
//  - args/environ_*   empty argv and environment
//  - fd_close, fd_fdstat_get (fds 0–2 are character devices),
//    fd_fdstat_set_flags: no-ops; fd_seek returns errno 70 (unsupported —
//    stdout is not seekable)
//
// Every WASI call the shim does NOT know is a *clean runtime error*: the
// import namespace is a Proxy that links any name (so instantiation always
// succeeds) but throws `unsupported WASI call '<name>'` when the program
// actually calls it.
//
// Run guard: each shim call checks the wall clock against `budgetMs`, so any
// loop that performs I/O (or otherwise re-enters the shim) is stopped after
// the budget. A tight loop that makes NO WASI calls cannot be preempted on
// the raw WebAssembly API — that case is honestly unbounded (documented in
// the README/lesson; a worker + SharedArrayBuffer heartbeat would be needed
// to fix it).

/** Thrown by the shim when `proc_exit` is called; carries the exit code. */
export class ProcExit {
  readonly code: number;
  constructor(code: number) {
    this.code = code;
  }
}

/** Outcome of one program run through the shim. */
export interface WasiRunResult {
  stdout: string;
  stderr: string;
  /** Exit code from proc_exit, or 0 when _start returned normally. */
  exitCode: number | null;
  /** Number of WASI calls made (cheap proxy for program activity). */
  calls: number;
  /** Set when the program could not run to completion. */
  error?: string;
}

const ERRNO_BADF = 8;
const ERRNO_UNSUPPORTED = 70;

/** wasi clock id of the wall clock; every other id gets monotonic time. */
const CLOCK_REALTIME = 0;

/** Captured stdout/stderr cap per stream — 1 MiB, as in kernel-asm64. */
const OUTPUT_LIMIT = 1 << 20;
/** Appended to a stream that hit the cap. */
const TRUNCATED_NOTE = '… [output truncated at 1 MiB]';

const SUPPORTED = Object.freeze([
  'fd_write', 'proc_exit', 'random_get', 'clock_time_get',
  'args_sizes_get', 'args_get', 'environ_sizes_get', 'environ_get',
  'fd_close', 'fd_fdstat_get', 'fd_fdstat_set_flags', 'fd_seek',
]);

type WasiFn = (...args: number[]) => number;

export function runWasi(module: WebAssembly.Module, budgetMs: number): Promise<WasiRunResult> {
  return (async () => {
    const decoder = new TextDecoder();
    let stdout = '';
    let stderr = '';
    // bytes captured per stream — once a stream reaches OUTPUT_LIMIT it
    // stops growing, so a runaway printf loop cannot balloon the console
    // string (the audit's `for (;;) printf` hit 358 MB in 5 s)
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let calls = 0;
    const startedAt = now();

    let view = new DataView(new ArrayBuffer(0));
    let instance: WebAssembly.Instance | null = null;
    const memory = (): { view: DataView; buffer: ArrayBuffer } => {
      const mem = instance?.exports.memory;
      if (!(mem instanceof WebAssembly.Memory)) {
        throw new Error('module does not export a WebAssembly.Memory');
      }
      if (view.buffer !== mem.buffer) view = new DataView(mem.buffer);
      return { view, buffer: mem.buffer };
    };

    const guard = (): void => {
      if (now() - startedAt > budgetMs) {
        throw new Error(
          `wall-clock budget of ${budgetMs} ms exceeded — is there an infinite loop? ` +
            '(loops that never call into WASI cannot be preempted on the raw WebAssembly API)',
        );
      }
    };

    // One merged write, capped: past OUTPUT_LIMIT bytes a stream keeps the
    // bytes it has and drops the rest (the trailing note is added on return).
    const writeText = (fd: number, bytes: Uint8Array): void => {
      if (fd !== 1 && fd !== 2) return;
      const captured = fd === 1 ? stdoutBytes : stderrBytes;
      if (captured >= OUTPUT_LIMIT) return;
      const room = OUTPUT_LIMIT - captured;
      const take = bytes.length <= room ? bytes : bytes.subarray(0, room);
      const text = decoder.decode(take);
      if (fd === 1) {
        stdout += text;
        stdoutBytes += take.length;
      } else {
        stderr += text;
        stderrBytes += take.length;
      }
    };

    const shim: Record<string, WasiFn> = {
      fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number): number {
        guard();
        if (fd !== 1 && fd !== 2) return ERRNO_BADF;
        const { view: v, buffer } = memory();
        // Gather every iovec into one byte buffer, then decode once: a
        // UTF-8 sequence split across iovecs must not be decoded in pieces
        // (each decode is a complete stream — a lone tail byte would
        // surface as U+FFFD).
        let total = 0;
        const parts: Uint8Array[] = [];
        for (let i = 0; i < iovsLen; i++) {
          // wasm32 iovec: { u32 iov_base; u32 iov_len } — 8 bytes
          const base = v.getUint32(iovs + i * 8, true);
          const len = v.getUint32(iovs + i * 8 + 4, true);
          if (len > 0) parts.push(new Uint8Array(buffer, base, len));
          total += len;
        }
        v.setUint32(nwritten, total, true);
        if (parts.length === 1) {
          writeText(fd, parts[0]!);
        } else if (parts.length > 1) {
          const merged = new Uint8Array(total);
          let off = 0;
          for (const part of parts) {
            merged.set(part, off);
            off += part.length;
          }
          writeText(fd, merged);
        }
        return 0;
      },
      proc_exit(code: number): number {
        throw new ProcExit(code);
      },
      random_get(buf: number, bufLen: number): number {
        guard();
        const bytes = new Uint8Array(memory().buffer, buf, bufLen);
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
          crypto.getRandomValues(bytes);
        } else {
          let s = (Date.now() ^ 0x9e3779b9) >>> 0;
          for (let i = 0; i < bytes.length; i++) {
            s ^= s << 13; s >>>= 0;
            s ^= s >>> 17;
            s ^= s << 5; s >>>= 0;
            bytes[i] = s & 0xff;
          }
        }
        return 0;
      },
      clock_time_get(clockId: number, _precision: number, time: number): number {
        guard();
        // CLOCK_REALTIME (0) is the wall clock. Every other id —
        // CLOCK_MONOTONIC (1), CLOCK_PROCESS_CPUTIME_ID (2), … — gets
        // monotonic nanoseconds since page load: the web has no
        // per-process CPU-time counter, and unlike Date.now() this never
        // jumps when the system clock is adjusted.
        const ns =
          clockId === CLOCK_REALTIME
            ? BigInt(Date.now()) * 1000000n
            : BigInt(Math.round(now() * 1e6));
        memory().view.setBigUint64(time, ns, true);
        return 0;
      },
      args_sizes_get(argc: number, argvBufSize: number): number {
        guard();
        const v = memory().view;
        v.setUint32(argc, 0, true);
        v.setUint32(argvBufSize, 0, true);
        return 0;
      },
      args_get(): number {
        guard();
        return 0;
      },
      environ_sizes_get(envc: number, envBufSize: number): number {
        guard();
        const v = memory().view;
        v.setUint32(envc, 0, true);
        v.setUint32(envBufSize, 0, true);
        return 0;
      },
      environ_get(): number {
        guard();
        return 0;
      },
      fd_close(): number {
        guard();
        return 0;
      },
      fd_fdstat_get(fd: number, ptr: number): number {
        guard();
        if (fd < 0 || fd > 2) return ERRNO_BADF;
        const v = memory().view;
        for (let i = 0; i < 24; i++) v.setUint8(ptr + i, 0);
        v.setUint8(ptr, 2); // filetype: character device
        v.setBigUint64(ptr + 8, ~0n, true); // rights_base: all
        v.setBigUint64(ptr + 16, ~0n, true); // rights_inheriting: all
        return 0;
      },
      fd_fdstat_set_flags(): number {
        guard();
        return 0;
      },
      fd_seek(): number {
        guard();
        return ERRNO_UNSUPPORTED;
      },
    };

    const imports = new Proxy<Record<string, WasiFn>>(shim, {
      get(target, prop): WasiFn | undefined {
        if (typeof prop !== 'string') return undefined;
        const fn = target[prop];
        if (fn !== undefined) {
          return (...args: number[]) => {
            calls++;
            return fn(...args);
          };
        }
        return () => {
          throw new Error(
            `unsupported WASI call '${prop}' — this shim implements: ${SUPPORTED.join(', ')}`,
          );
        };
      },
    });

    let exitCode: number | null = null;
    let error: string | undefined;
    try {
      instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: imports });
      const start = instance.exports._start;
      if (typeof start !== 'function') {
        throw new Error("module does not export '_start' (only command modules are supported)");
      }
      start.call(instance.exports);
      exitCode = 0;
    } catch (e) {
      if (e instanceof ProcExit) {
        exitCode = e.code;
      } else {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    if (stdoutBytes >= OUTPUT_LIMIT) stdout += TRUNCATED_NOTE;
    if (stderrBytes >= OUTPUT_LIMIT) stderr += TRUNCATED_NOTE;
    return { stdout, stderr, exitCode, calls, ...(error !== undefined ? { error } : {}) };
  })();
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
