// wasi.test.ts — unit tests for the hand-written WASI shim (src/wasi.ts)
// on tiny hand-encoded wasm modules. No clang, no vendored engine, so these
// run in the normal vitest suite (unlike smoke.ts, which boots the ~105 MB
// toolchain and is excluded from vitest on purpose).
//
// The modules are assembled by `buildModule` from plain section bytes; their
// WAT equivalents are spelled out at each use site below.

import { describe, expect, it } from 'vitest';

import { runWasi } from '../src/wasi';

const OUTPUT_LIMIT = 1 << 20;
const TRUNCATED_NOTE = '… [output truncated at 1 MiB]';

// ────────────────────────── wasm assembly helpers ──────────────────────────

/** Unsigned LEB128: section/body/name lengths. */
function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

/** Signed LEB128: i32.const operands. */
function sleb(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    const done = (n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0);
    out.push(done ? b : b | 0x80);
    if (done) return out;
  }
}

function section(id: number, bytes: number[]): number[] {
  return [id, ...uleb(bytes.length), ...bytes];
}

/** Length-prefixed ASCII name (import module/field, export names). */
function name(s: string): number[] {
  const codes = [...s].map((c) => c.charCodeAt(0));
  return [...uleb(codes.length), ...codes];
}

const I32 = 0x7f;
const I64 = 0x7e;

/**
 * Assembles a wasm32-wasip1 command module that imports WASI functions,
 * exports its memory plus a `_start` running `body`, and loads `data` at
 * address 0. Import i gets type i (duplicates across imports are legal);
 * `_start` (type `() -> ()`) is function index `imports.length`.
 */
function buildModule(
  imports: { field: string; params: number[]; result: number | null }[],
  body: number[],
  data: Uint8Array,
): Uint8Array {
  const types: number[] = [...uleb(imports.length + 1)]; // vector count first
  for (const imp of imports) {
    types.push(0x60, ...uleb(imp.params.length), ...imp.params,
      imp.result === null ? 0x00 : 0x01,
      ...(imp.result === null ? [] : [imp.result]));
  }
  types.push(0x60, 0x00, 0x00); // () -> () for _start

  const importSec = section(2, [
    ...uleb(imports.length),
    ...imports.flatMap((imp, i) => [
      ...name('wasi_snapshot_preview1'), ...name(imp.field), 0x00, ...uleb(i),
    ]),
  ]);
  const funcSec = section(3, [0x01, ...uleb(imports.length)]);
  const memSec = section(5, [0x01, 0x00, 0x01]); // one page, min only
  const exportSec = section(7, [
    0x02,
    ...name('memory'), 0x02, 0x00,
    ...name('_start'), 0x00, ...uleb(imports.length),
  ]);
  const code = [0x00, ...body]; // zero local groups
  const codeSec = section(10, [0x01, ...uleb(code.length), ...code]);
  const dataSec = section(11, [
    0x01, 0x00, 0x41, 0x00, 0x0b, ...uleb(data.length), ...data,
  ]);
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
    ...section(1, types),
    ...importSec, ...funcSec, ...memSec, ...exportSec, ...codeSec, ...dataSec,
  ]);
}

// ─────────────────────────────── the modules ───────────────────────────────

const IOV_BASE = 200;
const WRITE_LEN = 3000; // deliberately does not divide 1 MiB

/**
 * A `for (;;)` of one 3000-byte stdout write — the audit's flood repro:
 *
 *   (import "wasi_snapshot_preview1" "fd_write" (func (param i32 i32 i32 i32) (result i32)))
 *   (memory (export "memory") 1)
 *   (func (export "_start")
 *     (loop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 4096))
 *           (drop) (br 0)))
 *   (data (i32.const 0) iov={base:200,len:3000} ++ "x"*3000)
 */
function floodModule(): Uint8Array {
  const data = new Uint8Array(IOV_BASE + WRITE_LEN);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, IOV_BASE, true);
  dv.setUint32(4, WRITE_LEN, true);
  data.fill(0x78, IOV_BASE); // 'x'
  return buildModule(
    [{ field: 'fd_write', params: [I32, I32, I32, I32], result: I32 }],
    [
      0x03, 0x40,              // loop
      0x41, 0x01,              //   i32.const 1      fd = stdout
      0x41, 0x00,              //   i32.const 0      iovs
      0x41, 0x01,              //   i32.const 1      iovs_len
      0x41, ...sleb(4096),     //   i32.const 4096   nwritten
      0x10, 0x00,              //   call fd_write
      0x1a,                    //   drop
      0x0c, 0x00,              //   br 0             forever
      0x0b,                    // end loop
      0x0b,                    // end _start
    ],
    data,
  );
}

/**
 * One fd_write whose two iovecs split the UTF-8 sequence of "é" (0xC3 0xA9):
 *
 *   (func (export "_start")
 *     (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 2) (i32.const 24))))
 *   (data (i32.const 0) iov={16,4},{20,3} ++ "caf" 0xC3 ++ 0xA9 "!\n")
 */
function splitIovModule(): Uint8Array {
  const data = new Uint8Array(24);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 16, true);  // iov[0].base
  dv.setUint32(4, 4, true);   // iov[0].len
  dv.setUint32(8, 20, true);  // iov[1].base
  dv.setUint32(12, 3, true);  // iov[1].len
  data.set([0x63, 0x61, 0x66, 0xc3], 16); // "caf" + lead byte of é
  data.set([0xa9, 0x21, 0x0a], 20);       // trail byte + "!\n"
  return buildModule(
    [{ field: 'fd_write', params: [I32, I32, I32, I32], result: I32 }],
    [
      0x41, 0x01,              // i32.const 1      fd = stdout
      0x41, 0x00,              // i32.const 0      iovs
      0x41, 0x02,              // i32.const 2      iovs_len
      0x41, 0x18,              // i32.const 24     nwritten
      0x10, 0x00,              // call fd_write
      0x1a,                    // drop
      0x0b,                    // end _start
    ],
    data,
  );
}

/**
 * Asks the shim for all three clock ids and writes the TOP byte of each
 * u64 timestamp (single bytes < 0x80 decode 1:1) to stdout:
 *
 *   (func (export "_start")
 *     (drop (call $clock_time_get (i32.const 0) (i64.const 0) (i32.const 32)))  ;; realtime
 *     (drop (call $clock_time_get (i32.const 1) (i64.const 0) (i32.const 40)))  ;; monotonic
 *     (drop (call $clock_time_get (i32.const 2) (i64.const 0) (i32.const 48)))  ;; process cputime
 *     ;; store8(@64, load8_u(32+7)) and likewise 40+7, 48+7
 *     (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 68))))
 *   (data (i32.const 0) iov={64,3})
 */
function clockModule(): Uint8Array {
  const data = new Uint8Array(8);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 64, true); // iov_base
  dv.setUint32(4, 3, true);  // iov_len
  const clock = (id: number, out: number): number[] => [
    0x41, id,                   // i32.const <clock id>
    0x42, 0x00,                 // i64.const 0 (precision)
    0x41, out,                  // i32.const <out pointer>
    0x10, 0x00,                 // call clock_time_get
    0x1a,                       // drop
  ];
  const msbTo = (from: number, to: number): number[] => [
    0x41, ...sleb(to),          // i32.const <store address>
    0x41, from,                 // i32.const <load address> (out + 7)
    0x2d, 0x00, 0x00,           // i32.load8_u
    0x3a, 0x00, 0x00,           // i32.store8
  ];
  return buildModule(
    [
      { field: 'clock_time_get', params: [I32, I64, I32], result: I32 },
      { field: 'fd_write', params: [I32, I32, I32, I32], result: I32 },
    ],
    [
      ...clock(0, 32),
      ...clock(1, 40),
      ...clock(2, 48),
      ...msbTo(39, 64),         // top byte of the realtime timestamp
      ...msbTo(47, 65),         // top byte of the monotonic timestamp
      ...msbTo(55, 66),         // top byte of the process-cputime timestamp
      0x41, 0x01,               // i32.const 1      fd = stdout
      0x41, 0x00,               // i32.const 0      iovs
      0x41, 0x01,               // i32.const 1      iovs_len
      0x41, ...sleb(68),         // i32.const 68     nwritten (2-byte SLEB)
      0x10, 0x01,               // call fd_write
      0x1a,                     // drop
      0x0b,                     // end _start
    ],
    data,
  );
}

// ─────────────────────────────── the tests ─────────────────────────────────

describe('runWasi', () => {
  it('caps a runaway fd_write loop at 1 MiB and appends the truncation note', async () => {
    const module = await WebAssembly.compile(floodModule());
    const r = await runWasi(module, 250);
    // the wall-clock guard still stops the loop…
    expect(r.error).toContain('budget');
    expect(r.calls).toBeGreaterThan(100);
    expect(r.stderr).toBe('');
    // …and the captured stdout is exactly 1 MiB plus the note: 3000 does
    // not divide 1 MiB, so the last accepted write is cut mid-buffer.
    expect(r.stdout).toBe('x'.repeat(OUTPUT_LIMIT) + TRUNCATED_NOTE);
  });

  it('merges one write\'s iovecs and decodes once (UTF-8 split across iovecs)', async () => {
    const module = await WebAssembly.compile(splitIovModule());
    const r = await runWasi(module, 1000);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('café!\n');
  });

  it('clock_time_get: wall clock for CLOCK_REALTIME, monotonic for the other ids', async () => {
    const module = await WebAssembly.compile(clockModule());
    const r = await runWasi(module, 1000);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBe(3);
    // top byte of an epoch-nanosecond timestamp is ~0x18 (year ~2026);
    // page-load-relative monotonic timestamps are far below 2^56 ns.
    expect(r.stdout.charCodeAt(0)).toBeGreaterThan(0); // CLOCK_REALTIME
    expect(r.stdout.charCodeAt(1)).toBe(0);            // CLOCK_MONOTONIC
    expect(r.stdout.charCodeAt(2)).toBe(0);            // CLOCK_PROCESS_CPUTIME_ID
  });
});
