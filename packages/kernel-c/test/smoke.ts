// smoke.ts — bun smoke test for @literate/kernel-c.
// Run from anywhere: `bun packages/kernel-c/test/smoke.ts`.
//
// Drives the real vendored clang (YoWASP wasm build, ~86 MB under vendor/)
// headlessly through the package's public API: the hello block from
// lesson/lesson.org is compiled to a wasm32-wasip1 module and executed on
// the hand-written WASI shim; a broken block must surface clang's own
// line-mapped diagnostic, and a linker error must surface without a line.
// Excluded from vitest (include is **/*.test.ts)
//
// The lesson is read with readFileSync: an async Bun.file handle alive before
// the engine's streamed wasm fetch makes bun exit silently mid-load (bun 1.4).
import { readFileSync } from 'node:fs';

import { cKernel } from '../src/kernel';
import type { Panel } from '../src/types';

// bun 1.4 sometimes loses a race between WebAssembly.compileStreaming and
// the streamed file:// fetch body, exiting silently mid-boot (the same
// class of flake as the readFileSync note below). Buffer each response and
// compile from the ArrayBuffer — no stream, no race.
{
  type CompileStreaming = (source: Response | Promise<Response>) => Promise<WebAssembly.Module>;
  const wasm = WebAssembly as { compileStreaming: CompileStreaming };
  wasm.compileStreaming = async (source) =>
    WebAssembly.compile(await (await source).arrayBuffer());
}
process.on('unhandledRejection', (e) => {
  console.error('unhandled rejection:', e);
  process.exit(2);
});

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`smoke FAIL: ${msg}`);
  console.log('ok   ' + msg);
}

/** The console panel's stdout section: everything after `$ ./lesson.wasm`. */
function stdoutOf(panels: Panel[]): string {
  const con = panels.find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
  if (!con) throw new Error('smoke FAIL: no console panel');
  const marker = '\n$ ./lesson.wasm\n';
  const at = con.text.indexOf(marker);
  if (at < 0) throw new Error(`smoke FAIL: no run marker in console: ${JSON.stringify(con.text)}`);
  return con.text.slice(at + marker.length);
}

async function main(): Promise<void> {
  assert(cKernel.id === 'c', 'kernel id is c');
  assert(cKernel.label === 'C · clang wasm', 'kernel label is C · clang wasm');
  assert(cKernel.features?.stepping !== true, 'kernel is not steppable');

  // The lesson's first block is the hello program a student sees.
  const org = readFileSync(`${import.meta.dir}/../lesson/lesson.org`, 'utf8');
  const lines = org.split('\n');
  const begin = lines.findIndex((l) => l.startsWith('#+BEGIN_SRC c'));
  assert(begin >= 0, 'lesson has a c block');
  const body: string[] = [];
  for (let i = begin + 1; !lines[i]!.startsWith('#+END_SRC'); i++) body.push(lines[i]!);
  const hello = body.join('\n');

  // 1. compile + run the hello block; stdout must match #+RESULTS exactly.
  const s = cKernel.createSession();
  const load = await s.load(hello);
  assert(load.ok, `hello compiles${load.ok ? '' : ` — line ${load.line}: ${load.message}`}`);
  if (load.ok) {
    assert(/^loaded · \d+\.\d KiB wasm · compiled in \d+ ms$/.test(load.summary),
      `load summary format (got ${JSON.stringify(load.summary)})`);
  }
  const run = await s.run();
  assert(run.finished === true && run.exit === 'exit(0)' && run.error === undefined,
    `hello runs to exit(0) (got ${JSON.stringify(run)})`);
  const stdout = stdoutOf(s.state());
  assert(stdout === 'Hello, world!\n2 + 3 = 5\n',
    `stdout is exactly the lesson's #+RESULTS (got ${JSON.stringify(stdout)})`);

  // 2. step() is honest about not being steppable; reset() allows a re-run.
  const stepped = await s.step();
  assert(stepped.ran === false, 'step() reports { ran: false }');
  s.reset();
  const again = await s.run();
  assert(again.finished === true && stdoutOf(s.state()) === 'Hello, world!\n2 + 3 = 5\n',
    'after reset() the same module runs with identical stdout');
  s.dispose();

  // 3. one line-mapped diagnostic: a missing semicolon is clang's error,
  //    on clang's own 1-based line.
  const bad = cKernel.createSession();
  const diag = await bad.load('int main(void) {\n  return 0\n}\n');
  assert(!diag.ok, 'broken block fails to load');
  if (!diag.ok) {
    assert(diag.line === 2, `diagnostic is line-mapped to 2 (got line ${diag.line})`);
    assert(diag.message === "expected ';' after return statement",
      `clang reports the exact missing-semicolon diagnostic (got ${JSON.stringify(diag.message)})`);
  }

  // 4. the failed session's panel shows clang's diagnostics, not zero sections.
  const failedPanels = bad.state();
  const first = failedPanels[0];
  assert(first?.kind === 'console', `failed load yields a console panel (got ${first?.kind ?? 'none'})`);
  if (first?.kind === 'console') {
    assert(first.id === 'diagnostics', `failed-load panel is the diagnostics console (got id ${first.id})`);
    assert(
      first.text.includes('lesson.c:2:') && first.text.includes("expected ';' after return statement"),
      `panel text carries clang's line-mapped diagnostic (got ${JSON.stringify(first.text)})`,
    );
  }
  bad.dispose();

  // 5. a linker error has no file:line: form — it must surface WITHOUT a
  //    line (status text only), not pinned to line 1.
  const lnk = cKernel.createSession();
  const link = await lnk.load('void missing(void);\nint main(void) { missing(); return 0; }\n');
  assert(link.ok === false, 'undefined-symbol program fails to load');
  if (!link.ok) {
    assert(link.line === undefined, `linker error carries no line (got line ${link.line})`);
    assert(link.message.includes('undefined symbol'),
      `message is wasm-ld's undefined-symbol error (got ${JSON.stringify(link.message)})`);
  }
  lnk.dispose();

  // 6. one write across two iovecs that splits a UTF-8 sequence: the shim
  //    must merge the bytes and decode once (é = 0xC3 0xA9 across the split).
  const utf8 = cKernel.createSession();
  const utf8Load = await utf8.load([
    '#include <sys/uio.h>',
    'int main(void) {',
    '  static char head[] = "caf\\xc3";',
    '  static char tail[] = "\\xa9!\\n";',
    '  struct iovec iov[2];',
    '  iov[0].iov_base = head; iov[0].iov_len = 4;',
    '  iov[1].iov_base = tail; iov[1].iov_len = 3;',
    '  writev(1, iov, 2);',
    '  return 0;',
    '}',
  ].join('\n'));
  assert(utf8Load.ok,
    `writev program compiles${utf8Load.ok ? '' : ` — line ${utf8Load.line}: ${utf8Load.message}`}`);
  await utf8.run();
  assert(stdoutOf(utf8.state()) === 'café!\n',
    `split-UTF-8 writev decodes once as café! (got ${JSON.stringify(stdoutOf(utf8.state()))})`);
  utf8.dispose();

  // 7. clock ids: CLOCK_REALTIME is the wall clock; CLOCK_MONOTONIC is
  //    page-load-relative monotonic time, never the epoch. (The cputime
  //    ids are covered by wasi.test.ts at the WASI boundary — wasi-libc's
  //    clockid_t cannot even name them without the emulated-clocks lib.)
  const clk = cKernel.createSession();
  const clkLoad = await clk.load([
    '#include <stdio.h>',
    '#include <time.h>',
    'int main(void) {',
    '  struct timespec mono1, real, mono2;',
    '  if (clock_gettime(CLOCK_MONOTONIC, &mono1)) return 1;',
    '  if (clock_gettime(CLOCK_REALTIME, &real)) return 1;',
    '  if (clock_gettime(CLOCK_MONOTONIC, &mono2)) return 2;',
    '  printf("%lld\\n%lld\\n%lld\\n",',
    '    (long long)mono1.tv_sec * 1000000000LL + mono1.tv_nsec,',
    '    (long long)real.tv_sec * 1000000000LL + real.tv_nsec,',
    '    (long long)mono2.tv_sec * 1000000000LL + mono2.tv_nsec);',
    '  return 0;',
    '}',
  ].join('\n'));
  assert(clkLoad.ok,
    `clock program compiles${clkLoad.ok ? '' : ` — line ${clkLoad.line}: ${clkLoad.message}`}`);
  await clk.run();
  const ns = stdoutOf(clk.state()).trim().split('\n').map(Number);
  assert(ns.length === 3 && ns.every((n) => n >= 0),
    `clock program printed three timestamps (got ${JSON.stringify(ns)})`);
  if (ns.length === 3) {
    assert(ns[1]! > 1.6e18, `CLOCK_REALTIME is Unix-epoch nanoseconds (got ${ns[1]})`);
    assert(ns[0]! < 1e15, `CLOCK_MONOTONIC is page-load-relative, not the wall clock (got ${ns[0]})`);
    assert(ns[2]! >= ns[0]!, `CLOCK_MONOTONIC never goes backwards (${ns[0]} → ${ns[2]})`);
  }
  clk.dispose();
}

main()
  .then(() => console.log('\nALL C KERNEL SMOKE CHECKS PASSED'))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
