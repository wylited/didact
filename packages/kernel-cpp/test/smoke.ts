// smoke.ts — bun smoke test for @didact/kernel-cpp.
// Run from anywhere: `bun packages/kernel-cpp/test/smoke.ts`.
//
// Drives the real clang++ (YoWASP wasm build, ~105 MB via node_modules)
// headlessly through the package's public API: EVERY lesson block in
// lesson/lesson.org is compiled to a wasm32-wasip1 module (linked against
// the vendored libc++) and executed on the hand-written WASI shim; each
// block's stdout must match its #+RESULTS exactly. A broken block must
// surface clang++'s own line-mapped diagnostic, and a `throw` — impossible
// under this toolchain's -fno-exceptions libc++ — must surface clang's
// cannot-use-throw diagnostic on its exact line. Excluded from vitest
// (include is **/*.test.ts).
//
// The lesson is read with readFileSync: an async Bun.file handle alive before
// the engine's streamed wasm fetch makes bun exit silently mid-load (bun 1.4).
import { readFileSync } from 'node:fs';

import { cppKernel } from '../src/kernel';
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

/** One lesson block: its source and the exact stdout promised under it. */
interface LessonBlock {
  name: string;
  src: string;
  results: string;
}

/**
 * Parses lesson/lesson.org: every `#+BEGIN_SRC cpp` block's source plus the
 * `: `-prefixed lines of the #+RESULTS: that follows it.
 */
function parseLesson(org: string): LessonBlock[] {
  const lines = org.split('\n');
  const blocks: LessonBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith('#+BEGIN_SRC cpp')) continue;
    const name =
      i > 0 && lines[i - 1]!.startsWith('#+NAME:')
        ? lines[i - 1]!.slice('#+NAME:'.length).trim()
        : `block-${blocks.length}`;
    const body: string[] = [];
    let j = i + 1;
    for (; !lines[j]!.startsWith('#+END_SRC'); j++) body.push(lines[j]!);
    // the #+RESULTS: keyword, then `: ` content lines until a blank
    let k = j + 1;
    while (k < lines.length && lines[k]!.trim() !== '#+RESULTS:') k++;
    assert(k < lines.length, `block ${name} has a #+RESULTS:`);
    const out: string[] = [];
    for (k = k + 1; k < lines.length && lines[k]!.startsWith(': '); k++) {
      out.push(lines[k]!.slice(2));
    }
    blocks.push({ name, src: body.join('\n'), results: out.join('\n') + (out.length > 0 ? '\n' : '') });
    i = k;
  }
  return blocks;
}

async function main(): Promise<void> {
  assert(cppKernel.id === 'cpp', 'kernel id is cpp');
  assert(cppKernel.label === 'C++ · clang wasm', 'kernel label is C++ · clang wasm');
  assert(cppKernel.features?.stepping !== true && cppKernel.features?.breakpoints !== true,
    'kernel is neither steppable nor breakable');

  // 1. compile + run EVERY lesson block; stdout must match #+RESULTS exactly.
  const org = readFileSync(`${import.meta.dir}/../lesson/lesson.org`, 'utf8');
  const blocks = parseLesson(org);
  assert(blocks.length === 5, `lesson has 5 cpp blocks (found ${blocks.length})`);
  for (const b of blocks) {
    const s = cppKernel.createSession();
    const load = await s.load(b.src);
    assert(load.ok, `${b.name} compiles${load.ok ? '' : ` — line ${load.line}: ${load.message}`}`);
    const run = await s.run();
    assert(run.finished === true && run.exit === 'exit(0)' && run.error === undefined,
      `${b.name} runs to exit(0) (got ${JSON.stringify(run)})`);
    const stdout = stdoutOf(s.state());
    assert(stdout === b.results,
      `${b.name} stdout is exactly its #+RESULTS (got ${JSON.stringify(stdout)}, want ${JSON.stringify(b.results)})`);
    s.dispose();
  }

  // 2. step() is honest about not being steppable; reset() allows a re-run.
  const first = blocks[0]!;
  const s = cppKernel.createSession();
  const load = await s.load(first.src);
  assert(load.ok, `lesson block ${first.name} compiles`);
  await s.run();
  const stepped = await s.step();
  assert(stepped.ran === false, 'step() reports { ran: false }');
  s.reset();
  const again = await s.run();
  assert(again.finished === true && stdoutOf(s.state()) === first.results,
    'after reset() the same module runs with identical stdout');
  s.dispose();

  // 3. one line-mapped diagnostic: a missing semicolon is clang++'s error,
  //    on clang's own 1-based line.
  const bad = cppKernel.createSession();
  const diag = await bad.load('int main() {\n  return 0\n}\n');
  assert(!diag.ok, 'broken block fails to load');
  if (!diag.ok) {
    assert(diag.line === 2, `diagnostic is line-mapped to 2 (got line ${diag.line})`);
    assert(diag.message === "expected ';' after return statement",
      `clang++ reports the exact missing-semicolon diagnostic (got ${JSON.stringify(diag.message)})`);
  }

  // 4. the failed session's panel shows clang++'s diagnostics, banner included.
  const failedPanels = bad.state();
  const firstPanel = failedPanels[0];
  assert(firstPanel?.kind === 'console', `failed load yields a console panel (got ${firstPanel?.kind ?? 'none'})`);
  if (firstPanel?.kind === 'console') {
    assert(firstPanel.id === 'diagnostics', `failed-load panel is the diagnostics console (got id ${firstPanel.id})`);
    assert(
      firstPanel.text.startsWith('$ clang++ -std=c++20 -fno-exceptions lesson.cpp -o lesson.wasm\n'),
      `panel text carries the real driver line as its banner (got ${JSON.stringify(firstPanel.text.slice(0, 80))})`,
    );
    assert(
      firstPanel.text.includes('lesson.cpp:2:') && firstPanel.text.includes("expected ';' after return statement"),
      `panel text carries clang++'s line-mapped diagnostic (got ${JSON.stringify(firstPanel.text)})`,
    );
  }
  bad.dispose();

  // 5. the toolchain's honest limit: no exceptions. A `throw` is a
  //    line-mapped compile-time error, not a mysterious wasm-ld failure.
  const thr = cppKernel.createSession();
  const threw = await thr.load('int main() {\n  throw 1;\n}\n');
  assert(!threw.ok, 'throwing block fails to load under -fno-exceptions');
  if (!threw.ok) {
    assert(threw.line === 2, `throw diagnostic is line-mapped to 2 (got line ${threw.line})`);
    assert(threw.message === "cannot use 'throw' with exceptions disabled",
      `clang reports cannot-use-throw (got ${JSON.stringify(threw.message)})`);
  }
  thr.dispose();
}
main()
  .then(() => console.log('\nALL C++ KERNEL SMOKE CHECKS PASSED'))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
