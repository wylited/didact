// session.test.ts — behavioral tests for CppSession against a deterministic
// fake bundle (the asm64 `fake keystone` pattern, applied to the YoWASP
// seam): no ~105 MB engine in vitest — the real toolchain is exercised by
// test/smoke.ts. What is asserted here is the session's OWN contract:
// the exact driver argv it passes to runClang, LoadResult line-mapping of
// clang's diagnostics, the console/fields/hexdump panel shape, and run()
// executing the compiled artifact through the WASI shim.
//
// The tiny wasm modules are assembled by `buildModule` from plain section
// bytes (helpers adapted from packages/kernel-c/test/wasi.test.ts); the
// WAT equivalents are spelled out at each use site.

import { describe, expect, it } from 'vitest';

import { CLANG_ARGS, COMPILE_BANNER, CppSession } from '../src/session';
import type { ClangBundle, Tree } from '../src/vendor';

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

/**
 * The stand-in for clang++'s artifact: a command module that writes `text`
 * to stdout once and returns 0.
 *
 *   (import "wasi_snapshot_preview1" "fd_write" (func (param i32 i32 i32 i32) (result i32)))
 *   (memory (export "memory") 1)
 *   (func (export "_start")
 *     (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 24))))
 *   (data (i32.const 0) iov={8,len} ++ text)
 */
function printsModule(text: string): Uint8Array {
  const payload = [...text].map((c) => c.charCodeAt(0) & 0xff);
  const data = new Uint8Array(8 + payload.length);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 8, true);                 // iov_base
  dv.setUint32(4, payload.length, true);    // iov_len
  data.set(payload, 8);
  return buildModule(
    [{ field: 'fd_write', params: [I32, I32, I32, I32], result: I32 }],
    [
      0x41, 0x01,              // i32.const 1      fd = stdout
      0x41, 0x00,              // i32.const 0      iovs
      0x41, 0x01,              // i32.const 1      iovs_len
      0x41, ...sleb(24),       // i32.const 24     nwritten
      0x10, 0x00,              // call fd_write
      0x1a,                    // drop
      0x0b,                    // end _start
    ],
    data,
  );
}

// ─────────────────────────── the fake bundle ───────────────────────────

interface FakeOutcome {
  /** The artifact the fake "links": returned as lesson.wasm. */
  wasm?: Uint8Array;
  /** Diagnostic text the fake clang emits (stderr) before failing. */
  diag?: string;
}

/**
 * Deterministic stand-in for the vendored bundle: records every runClang
 * call, replays `diag` on stderr (like clang), and either hands out the
 * prepared artifact or exits 1 like a failed driver.
 */
function fakeBundle(outcome: FakeOutcome): {
  bundle: ClangBundle;
  calls: { args: string[]; files: Tree }[];
} {
  const calls: { args: string[]; files: Tree }[] = [];
  const bundle: ClangBundle = {
    async runClang(args, files, options) {
      calls.push({ args: [...args], files });
      if (outcome.diag !== undefined) {
        const bytes = new TextEncoder().encode(outcome.diag);
        options.stderr?.(bytes);
        options.stderr?.(null); // stream end, as the real bundle signals it
      }
      if (outcome.wasm === undefined) throw new Error('Exited with status 1');
      return { 'lesson.wasm': outcome.wasm };
    },
  };
  return { bundle, calls };
}

/** A session wired to the fake bundle (never touches node_modules). */
const fakeSession = (outcome: FakeOutcome) => {
  const { bundle, calls } = fakeBundle(outcome);
  return { session: new CppSession(() => Promise.resolve(bundle)), calls };
};

const GOOD_SRC = [
  '#include <vector>',
  '#include <cstdio>',
  'int main() {',
  '  std::vector<int> v = {1, 2, 3};',
  '  for (int x : v) std::printf("%d ", x);',
  '  std::printf("\\n");',
  '  return 0;',
  '}',
].join('\n');

describe('CppSession.load: driver invocation', () => {
  it('passes the exact discovered clang++ argv and the source as lesson.cpp', async () => {
    const { session, calls } = fakeSession({ wasm: printsModule('cpp!\n') });
    const r = await session.load(GOOD_SRC);
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    // The milestone-0 gate's working recipe, frozen: the clang++ driver
    // name (C++ mode + libc++ link line picked by the driver itself),
    // C++20, and -fno-exceptions (the vendored libc++abi has no EH).
    expect(calls.length).toBe(1);
    expect(calls[0]!.args).toEqual(['clang++', '-std=c++20', '-fno-exceptions', 'lesson.cpp', '-o', 'lesson.wasm']);
    expect(calls[0]!.args).toEqual([...CLANG_ARGS]);
    expect(calls[0]!.files['lesson.cpp']).toBe(GOOD_SRC);
    session.dispose();
  });
});

describe('CppSession.load: success shape', () => {
  it('reports a size-and-time summary and compiles the artifact to a module', async () => {
    const wasm = printsModule('cpp!\n');
    const { session } = fakeSession({ wasm });
    const r = await session.load(GOOD_SRC);
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    expect(r.summary).toMatch(/^loaded · \d+\.\d KiB wasm · compiled in \d+ ms$/);
    expect(r.summary).toContain(`${(wasm.length / 1024).toFixed(1)} KiB`);
    session.dispose();
  });
});

describe('CppSession.load: diagnostics', () => {
  it('maps a clang error to its exact 1-based line and message', async () => {
    const { session } = fakeSession({
      diag: [
        'lesson.cpp:3:5: error: expected \';\' after expression',
        '    3 |   std::vector<int> v = {1, 2, 3}',
        '      |     ^',
        '1 error generated.',
        '',
      ].join('\n'),
    });
    const r = await session.load(GOOD_SRC);
    expect(r).toEqual({
      ok: false,
      line: 3,
      message: "expected ';' after expression",
    });
    session.dispose();
  });

  it('surfaces a wasm-ld error (no file:line form) without pinning a line', async () => {
    const { session } = fakeSession({
      diag: 'wasm-ld: error: undefined symbol: __cxa_throw\n',
    });
    const r = await session.load(GOOD_SRC);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.line).toBeUndefined();
      expect(r.message).toBe('wasm-ld: error: undefined symbol: __cxa_throw');
    }
    session.dispose();
  });

  it('reports a toolchain boot failure as line-less, naming the toolchain', async () => {
    const session = new CppSession(() => Promise.reject(new Error('fetch 404')));
    const r = await session.load(GOOD_SRC);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.line).toBeUndefined();
      expect(r.message).toBe('failed to load the vendored clang toolchain: fetch 404');
    }
  });
});

describe('CppSession: panels', () => {
  it('after load, before run: console banner + "(not run yet)", fields, hexdump', async () => {
    const { session } = fakeSession({ wasm: printsModule('cpp!\n') });
    await session.load(GOOD_SRC);
    const panels = session.state();
    expect(panels.map((p) => `${p.kind}:${p.id}`)).toEqual([
      'console:console', 'fields:program', 'hexdump:wasm',
    ]);
    const con = panels[0];
    if (con.kind !== 'console') throw new Error('unreachable');
    expect(con.text).toBe(
      `${COMPILE_BANNER}\n` +
        '(no diagnostics)\n' +
        '\n$ ./lesson.wasm\n' +
        '(not run yet)\n',
    );
    expect(con.text.startsWith('$ clang++ -std=c++20 -fno-exceptions lesson.cpp -o lesson.wasm\n')).toBe(true);
    const fields = panels[1];
    if (fields.kind !== 'fields') throw new Error('unreachable');
    expect(fields.fields.map((f) => [f.key, f.value])).toEqual([
      ['exit', 'not run'],
      ['wasm size', expect.stringMatching(/^\d+\.\d KiB$/)],
      ['compile', expect.stringMatching(/^\d+ ms$/)],
    ]);
    const hex = panels[2];
    if (hex.kind !== 'hexdump') throw new Error('unreachable');
    expect(hex.rows.length).toBe(Math.ceil(printsModule('cpp!\n').length / 16));
    // the module really is a wasm module: magic 00 61 73 6D renders ".asm"
    expect(hex.rows[0]!.bytes.slice(0, 4)).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(hex.rows[0]!.ascii.startsWith('.asm')).toBe(true);
    session.dispose();
  });

  it('after run: program stdout lands in the console, exit code in the fields', async () => {
    const { session } = fakeSession({ wasm: printsModule('1 2 3\n') });
    await session.load(GOOD_SRC);
    const run = await session.run();
    expect(run.finished).toBe(true);
    expect(run.exit).toBe('exit(0)');
    expect(run.error).toBeUndefined();
    expect(run.steps).toBeGreaterThanOrEqual(1); // at least the fd_write call
    const con = session.state()[0];
    if (con.kind !== 'console') throw new Error('unreachable');
    const at = con.text.indexOf('\n$ ./lesson.wasm\n');
    expect(at).toBeGreaterThan(0);
    expect(con.text.slice(at + '\n$ ./lesson.wasm\n'.length)).toBe('1 2 3\n');
    const fields = session.state()[1];
    if (fields.kind !== 'fields') throw new Error('unreachable');
    expect(fields.fields[0]).toEqual({ key: 'exit', value: 'exit(0)' });
    session.dispose();
  });

  it('a failed load yields a single Diagnostics console carrying the banner and clang text', async () => {
    const { session } = fakeSession({
      diag: [
        'lesson.cpp:5:31: error: expected expression',
        '1 error generated.',
        '',
      ].join('\n'),
    });
    await session.load(GOOD_SRC);
    const panels = session.state();
    expect(panels.length).toBe(1);
    const diag = panels[0];
    if (diag.kind !== 'console') throw new Error('unreachable');
    expect(diag.id).toBe('diagnostics');
    expect(diag.title).toBe('Diagnostics');
    expect(diag.text).toBe(
      `${COMPILE_BANNER}\n` +
        'lesson.cpp:5:31: error: expected expression\n' +
        '1 error generated.\n',
    );
    session.dispose();
  });
});

describe('CppSession: lifecycle', () => {
  it('run() before load() is a clean error, not a crash', async () => {
    const { session } = fakeSession({ wasm: printsModule('x\n') });
    const r = await session.run();
    expect(r).toEqual({ finished: false, steps: 0, error: 'nothing is loaded' });
  });

  it('step() is honest about not being steppable', async () => {
    const { session } = fakeSession({ wasm: printsModule('x\n') });
    expect(await session.step()).toEqual({ ran: false });
  });

  it('reset() returns to the just-compiled state and the module re-runs', async () => {
    const { session } = fakeSession({ wasm: printsModule('once\n') });
    await session.load(GOOD_SRC);
    await session.run();
    session.reset();
    const con = session.state()[0];
    if (con.kind !== 'console') throw new Error('unreachable');
    expect(con.text.endsWith('(not run yet)\n')).toBe(true);
    const again = await session.run();
    expect(again.finished).toBe(true);
    expect(again.exit).toBe('exit(0)');
    session.dispose();
  });

  it('dispose() clears everything; state() is empty', async () => {
    const { session } = fakeSession({ wasm: printsModule('x\n') });
    await session.load(GOOD_SRC);
    await session.run();
    session.dispose();
    expect(session.state()).toEqual([]);
  });
});
