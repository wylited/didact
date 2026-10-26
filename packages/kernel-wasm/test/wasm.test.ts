import { describe, expect, it } from 'vitest';
import { BUDGET, Machine, compile, wasmKernel } from '../src/index';
import type { LoadResult, Panel, RunResult } from '../src/index';

/** Wrap a function body in the standard module shell. */
function mod(body: string, extra = ''): string {
  return `(module
  (import "didact" "print" (func $print (param i32)))
  (import "didact" "print_char" (func $print_char (param i32)))
  ${extra}
  (func (export "main")
    ${body}))`;
}

/** Load + run a module; return [console text, RunResult, panels]. */
async function run(src: string, breakpoints?: number[]): Promise<{ text: string; result: RunResult; panels: Panel[] }> {
  const s = wasmKernel.createSession();
  const load = await s.load(src);
  if (!load.ok) throw new Error(`load failed: line ${load.line}: ${load.message}`);
  const result = await s.run(breakpoints);
  const panels = s.state();
  const con = panels.find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
  return { text: con?.text ?? '', result, panels };
}

/** Load only — for validation errors; returns the LoadResult. */
async function loadOnly(src: string): Promise<LoadResult> {
  const s = wasmKernel.createSession();
  return s.load(src);
}

describe('values wrap at 32 bits', () => {
  it('0xFFFFFFFF + 1 = 0', async () => {
    const { text } = await run(mod('(call $print (i32.add (i32.const 4294967295) (i32.const 1)))'));
    expect(text).toBe('0\n');
  });

  it('-1 and 0xFFFFFFFF are the same bit pattern (shown as 0xffffffff on the stack)', async () => {
    const src = `(module
  (import "didact" "print" (func $print (param i32)))
  (func (export "main")
    (call $print (i32.sub (i32.const 0) (i32.const 1)))
    (call $print (i32.and (i32.const -1) (i32.const 65535)))))`;
    const { text } = await run(src);
    expect(text).toBe('-1\n65535\n');
    // and the panel shows the u32 hex for -1:
    const s = wasmKernel.createSession();
    await s.load(mod('(drop (i32.const -1))'));
    await s.step();
    const stack = s.state().find((p): p is Extract<Panel, { kind: 'listing' }> => p.kind === 'listing' && p.id === 'stack')!;
    expect(stack.rows).toHaveLength(1);
    expect(stack.rows[0]).toMatchObject({ addr: 0, bytes: '0xffffffff', text: '-1', current: true });
  });

  it('mul wraps: 65536 * 65536 = 0, and shl uses the low 5 bits', async () => {
    const { text } = await run(mod(`(call $print (i32.mul (i32.const 65536) (i32.const 65536)))
    (call $print (i32.shl (i32.const 1) (i32.const 33)))`));
    expect(text).toBe('0\n2\n');
  });
});

describe('division and shifts', () => {
  it('div_s truncates toward zero, div_u reads bits as unsigned', async () => {
    const { text } = await run(mod(`(call $print (i32.div_s (i32.const 7) (i32.const 2)))
    (call $print (i32.div_s (i32.const -7) (i32.const 2)))
    (call $print (i32.div_u (i32.const -1) (i32.const 2)))
    (call $print (i32.rem_s (i32.const -7) (i32.const 2)))`));
    expect(text).toBe('3\n-3\n2147483647\n-1\n');
  });

  it('divide by zero traps with the line', async () => {
    const { result } = await run(mod('(call $print (i32.div_s (i32.const 1) (i32.const 0)))'));
    expect(result.finished).toBe(false);
    expect(result.error).toBe('integer divide by zero (line 6)');
  });

  it('INT_MIN / -1 traps as integer overflow', async () => {
    const { result } = await run(mod('(call $print (i32.div_s (i32.const -2147483648) (i32.const -1)))'));
    expect(result.error).toBe('integer overflow (line 6)');
  });

  it('shr_s sign-extends, shr_u does not', async () => {
    const { text } = await run(mod(`(call $print (i32.shr_s (i32.const -1) (i32.const 28)))
    (call $print (i32.shr_u (i32.const -1) (i32.const 28)))
    (call $print (i32.shr_s (i32.const -16) (i32.const 2)))
    (call $print (i32.shr_u (i32.const -16) (i32.const 2)))`));
    expect(text).toBe('-1\n15\n-4\n1073741820\n');
  });
});

describe('folded source becomes flat instructions, lines preserved', () => {
  it('operands first, operator after, each keeps its own line', async () => {
    const src = `(module
  (func (export "main") (result i32)
    (i32.add
      (i32.const 1)
      (i32.const 2))))`;
    const s = wasmKernel.createSession();
    const load = await s.load(src);
    expect(load).toEqual({ ok: true, summary: 'loaded · 4 instructions' });
    const m = new Machine(compile(src));
    const flat = m.frames[0]!.func.code;
    expect(flat.map((i) => [i.op, i.line])).toEqual([
      ['i32.const', 4], ['i32.const', 5], ['i32.add', 3], ['end', 2],
    ]);
  });

  it('the instructions panel lists the flat form with real opcodes', async () => {
    const s = wasmKernel.createSession();
    await s.load(mod('(drop (i32.add (i32.const 1) (i32.const 2)))'));
    const panel = s.state().find((p): p is Extract<Panel, { kind: 'listing' }> => p.kind === 'listing' && p.id === 'instructions')!;
    expect(panel.title).toBe('Instructions · main');
    expect(panel.rows.map((r) => `${r.bytes} ${r.text}`).slice(0, 4)).toEqual([
      '0x41 i32.const 1', '0x41 i32.const 2', '0x6a i32.add', '0x1a drop',
    ]);
    expect(panel.rows[0]!.current).toBe(true); // nothing has run yet
  });
});

describe('structured control: block vs loop labels', () => {
  it('br 0 exits a block, skipping the rest of its body', async () => {
    // $print consumes the block's value, so main re-reads $v for its own
    // (result i32) — the 9 after the br is dead code in both readings.
    const src = `(module
  (import "didact" "print" (func $print (param i32)))
  (func (export "main") (result i32)
    (local $v i32)
    (local.set $v
      (block (result i32)
        (br 0 (i32.const 7))
        (i32.const 9)))
    (call $print (local.get $v))
    (local.get $v)))`;
    const { text, result } = await run(src);
    expect(text).toBe('7\n');
    expect(result.exit).toBe('main → 7');
  });

  it('br to a loop label repeats it — a counted loop sums 1..5', async () => {
    const src = `(module
  (import "didact" "print" (func $print (param i32)))
  (func (export "main")
    (local $i i32)
    (local $sum i32)
    (block $done
      (loop $again
        (br_if $done (i32.gt_s (local.get $i) (i32.const 5)))
        (local.set $sum (i32.add (local.get $sum) (local.get $i)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $again)))
    (call $print (local.get $sum))))`;
    const { text } = await run(src);
    expect(text).toBe('15\n');
  });

  it('br out of nested labels: depth counts innermost-first', async () => {
    const src = `(module
  (import "didact" "print" (func $print (param i32)))
  (func (export "main") (result i32)
    (block $outer (result i32)
      (loop $inner
        (br $outer (i32.const 42)))
      (i32.const 0))))`;
    const { result } = await run(src);
    expect(result.exit).toBe('main → 42');
  });
});

describe('if / else', () => {
  const ifMod = `(module
  (import "didact" "print" (func $print (param i32)))
  (func (export "main") (local $x i32)
    (local.set $x (i32.const 0))
    (call $print (if (result i32) (i32.eqz (local.get $x))
      (then (i32.const 10))
      (else (i32.const 20))))))`;

  it('picks the else branch when the condition is 0', async () => {
    // $x = 5 → (i32.eqz 5) = 0 → the condition is 0 → else
    const src = ifMod.replace('(i32.const 0))', '(i32.const 5))');
    const { text } = await run(src);
    expect(text).toBe('20\n');
  });

  it('picks the then branch when the condition is nonzero', async () => {
    // $x = 0 → (i32.eqz 0) = 1 → the condition is nonzero → then
    const { text } = await run(ifMod);
    expect(text).toBe('10\n');
  });

  it('an if with (result i32) and no else fails validation before running', async () => {
    const bad = `(module
  (func (export "main") (result i32)
    (if (result i32) (i32.const 1) (then (i32.const 1)))))`;
    const load = await loadOnly(bad);
    expect(load.ok).toBe(false);
    if (!load.ok) expect(load.line).toBe(3);
  });
});

describe('calls, returns, locals', () => {
  it('factorial by recursion: fact(10) = 3628800', async () => {
    const src = `(module
  (import "didact" "print" (func $print (param i32)))
  (func $fact (param $n i32) (result i32)
    (if (result i32) (i32.le_s (local.get $n) (i32.const 1))
      (then (i32.const 1))
      (else (i32.mul (local.get $n) (call $fact (i32.sub (local.get $n) (i32.const 1)))))))
  (func (export "main")
    (call $print (call $fact (i32.const 10)))))`;
    const { text, result } = await run(src);
    expect(text).toBe('3628800\n');
    expect(result.exit).toBe('main returned');
  });

  it('callee locals never leak into the caller, even with the same names', async () => {
    const src = `(module
  (import "didact" "print" (func $print (param i32)))
  (func $clobber (param $x i32) (result i32)
    (local.set $x (i32.const 99))
    (local.get $x))
  (func (export "main") (local $x i32)
    (local.set $x (i32.const 5))
    (call $print (call $clobber (local.get $x)))
    (call $print (local.get $x))))`;
    const { text } = await run(src);
    expect(text).toBe('99\n5\n');
  });

  it('locals start at zero every call; tee writes and keeps the value', async () => {
    const src = `(module
  (import "didact" "print" (func $print (param i32)))
  (func $fresh (result i32) (local $t i32) (local.get $t))
  (func (export "main") (local $x i32)
    (call $print (call $fresh))
    (call $print (local.tee $x (i32.const 3)))
    (call $print (local.get $x))))`;
    const { text } = await run(src);
    expect(text).toBe('0\n3\n3\n');
  });
});

describe('memory is bytes', () => {
  const memMod = `(module
  (import "didact" "print" (func $print (param i32)))
  (import "didact" "print_char" (func $print_char (param i32)))
  (memory 1)
  (func (export "main")
    (i32.store (i32.const 0) (i32.const 42))
    (call $print (i32.load8_u (i32.const 0)))
    (call $print_char (i32.load8_u (i32.const 0)))))`;

  it('store 0x2A then load8_u round-trips; print_char shows the byte as a character', async () => {
    const { text } = await run(memMod);
    expect(text).toBe('42\n*');
  });

  it('load8_s sign-extends the byte, load8_u does not; stores are little-endian', async () => {
    const src = `(module
  (import "didact" "print" (func $print (param i32)))
  (memory 1)
  (func (export "main")
    (i32.store8 (i32.const 8) (i32.const -1))
    (call $print (i32.load8_s (i32.const 8)))
    (call $print (i32.load8_u (i32.const 8)))
    (i32.store16 (i32.const 12) (i32.const 0x1234))
    (call $print (i32.load8_u (i32.const 12)))
    (call $print (i32.load8_u (i32.const 13)))))`;
    const { text } = await run(src);
    expect(text).toBe('-1\n255\n52\n18\n'); // 0x34 first — little-endian
  });

  it('out-of-bounds loads and stores trap with the line', async () => {
    const load = await run(`(module (import "didact" "print" (func $print (param i32))) (memory 1)
  (func (export "main") (call $print (i32.load (i32.const 65534)))))`);
    expect(load.result.error).toBe('out of bounds memory access: address 65534 + 4 bytes is past the end (65536 bytes) (line 2)');
    const store = await run(`(module (memory 1)
  (func (export "main") (i32.store8 (i32.const 65536) (i32.const 1))))`);
    expect(store.result.error).toBe('out of bounds memory access: address 65536 + 1 bytes is past the end (65536 bytes) (line 2)');
  });

  it('offset= adds to the address before the bounds check', async () => {
    const ok = await run(`(module (import "didact" "print" (func $print (param i32))) (memory 1)
  (func (export "main") (i32.store offset=100 (i32.const 0) (i32.const 7)) (call $print (i32.load8_u offset=100 (i32.const 0)))))`);
    expect(ok.text).toBe('7\n');
    const bad = await run(`(module (memory 1)
  (func (export "main") (drop (i32.load8_u offset=1 (i32.const 65536)))))`);
    expect(bad.result.error).toContain('out of bounds memory access: address 65537');
  });

  it('memory.size and memory.grow speak in pages', async () => {
    const src = `(module
  (import "didact" "print" (func $print (param i32)))
  (memory 1)
  (func (export "main")
    (call $print (memory.size))
    (call $print (memory.grow (i32.const 2)))
    (call $print (memory.size))
    (call $print (memory.grow (i32.const 100)))))`;
    const { text } = await run(src);
    expect(text).toBe('1\n1\n3\n-1\n'); // grow returns the OLD page count; -1 = refused
  });

  it('the memory hexdump shows the first 256 bytes and the last written region', async () => {
    const s = wasmKernel.createSession();
    await s.load(`(module (memory 1) (func (export "main") (i32.store (i32.const 512) (i32.const 1))))`);
    await s.run();
    const mem = s.state().find((p): p is Extract<Panel, { kind: 'hexdump' }> => p.kind === 'hexdump')!;
    expect(mem.rows).toHaveLength(17); // 16 rows of the first 256 bytes + 1 at 0x200
    expect(mem.rows[0]!.addr).toBe(0);
    expect(mem.rows[16]).toMatchObject({ addr: 512 });
    expect(mem.rows[16]!.bytes[0]).toBe(1); // 0x01 00 00 00 little-endian
    expect(mem.rows[16]!.ascii).toBe('................'); // a row is 16 bytes; 0x01 and zeros are all non-printable
  });
});

describe('globals', () => {
  it('get, set and initialization before main', async () => {
    const src = `(module
  (import "didact" "print" (func $print (param i32)))
  (global $counter (mut i32) (i32.const 10))
  (global $fixed i32 (i32.const 3))
  (func (export "main")
    (call $print (global.get $counter))
    (global.set $counter (i32.add (global.get $counter) (global.get $fixed)))
    (call $print (global.get $counter))))`;
    const { text } = await run(src);
    expect(text).toBe('10\n13\n');
  });

  it('global.set on an immutable global is refused at load', async () => {
    const load = await loadOnly(`(module (global $g i32 (i32.const 0))
  (func (export "main") (global.set $g (i32.const 1))))`);
    expect(load.ok).toBe(false);
    if (!load.ok) {
      expect(load.line).toBe(2);
      expect(load.message).toBe('$g is immutable — global.set needs a (mut i32) global');
    }
  });
});

describe('validation refuses before anything runs', () => {
  it('type mismatch: drop with an empty stack', async () => {
    const load = await loadOnly(mod('(drop (nop))'));
    expect(load.ok).toBe(false);
    if (!load.ok) {
      expect(load.line).toBe(6);
      expect(load.message).toBe('drop needs 1 value on the stack — only 0 available');
    }
  });

  it('type mismatch: a (result i32) block that ends with no value', async () => {
    const load = await loadOnly(`(module (func (export "main") (result i32)
  (block (result i32) (drop (i32.const 1)))))`);
    expect(load.ok).toBe(false);
    if (!load.ok) expect(load.line).toBe(2);
  });

  it('unknown function, unknown local, unknown global', async () => {
    const f = await loadOnly(mod('(call $nope)'));
    expect(f).toMatchObject({ ok: false, line: 6, message: 'unknown function $nope' });
    const l = await loadOnly(mod('(drop (local.get $nope))'));
    expect(l).toMatchObject({ ok: false, line: 6, message: 'unknown local $nope in main' });
    const g = await loadOnly(mod('(drop (global.get $nope))'));
    expect(g).toMatchObject({ ok: false, line: 6, message: 'unknown global $nope' });
  });

  it('br depth out of range', async () => {
    const load = await loadOnly(mod('(br 1)'));
    expect(load).toMatchObject({ ok: false, line: 6, message: 'br 1: label depth out of range — 1 label encloses this point' });
  });

  it('nothing executes when validation fails', async () => {
    const s = wasmKernel.createSession();
    const load = await s.load(mod('(call $print (i32.add (i32.const 1)))'));
    expect(load.ok).toBe(false);
    const result = await s.run();
    expect(result).toEqual({ finished: false, steps: 0, error: 'nothing is loaded' });
    expect(s.state()).toEqual([]);
  });

  it('i64 and f64 are outside the subset, wherever they appear', async () => {
    const t = await loadOnly('(module (func (export "main") (param i64)))');
    expect(t).toMatchObject({ ok: false, line: 1, message: "'i64' is not in the teaching subset — this kernel interprets the 32-bit integer core only" });
    const op = await loadOnly(mod('(drop (i64.add (i64.const 1) (i64.const 2)))'));
    expect(op).toMatchObject({ ok: false, line: 6, message: "'i64.add' is not in the teaching subset — this kernel interprets the 32-bit integer core only" });
    const clz = await loadOnly(mod('(drop (i32.clz (i32.const 1)))'));
    expect(clz).toMatchObject({ ok: false, line: 6, message: "'i32.clz' is not in the teaching subset" });
  });

  it('const literals must fit in 32 bits', async () => {
    const load = await loadOnly(mod('(drop (i32.const 4294967296))'));
    expect(load).toMatchObject({
      ok: false,
      line: 6,
      message: "'4294967296' does not fit in 32 bits — i32 literals run from -2147483648 to 4294967295",
    });
  });

  it('imports are print and print_char from didact, exactly once each', async () => {
    const badModule = await loadOnly('(module (import "env" "log" (func $log (param i32))) (func (export "main")))');
    expect(badModule).toMatchObject({ ok: false, line: 1 });
    const badField = await loadOnly('(module (import "didact" "read" (func $read (param i32))) (func (export "main")))');
    expect(badField).toMatchObject({ ok: false, line: 1 });
    const twice = await loadOnly('(module (import "didact" "print" (func $p (param i32))) (import "didact" "print" (func $q (param i32))) (func (export "main")))');
    expect(twice).toMatchObject({ ok: false, line: 1, message: 'didact "print" is imported twice' });
  });

  it('a module without a main export refuses to load', async () => {
    const load = await loadOnly('(module (func $f (result i32) (i32.const 1)))');
    expect(load).toMatchObject({ ok: false, line: 1, message: 'no function exports "main" — add (export "main") to the entry (func …)' });
  });

  it('reader errors carry 1-based lines', async () => {
    const unclosed = await loadOnly('(module\n(func (export "main") (drop (i32.const 1))');
    expect(unclosed).toMatchObject({ ok: false, line: 2, message: "unclosed '(' opened on this line" });
    const extra = await loadOnly('(module)\n(module)');
    expect(extra).toMatchObject({ ok: false, line: 2 });
    const flat = await loadOnly('(module (func (export "main") drop))');
    expect(flat).toMatchObject({ ok: false, line: 1, message: 'flat unparenthesized instructions are not in the teaching subset — write every instruction as a list, e.g. (drop)' });
  });
});

describe('traps and the instruction budget', () => {
  it('unreachable traps with its line', async () => {
    const { result } = await run(mod('(unreachable)'));
    expect(result.error).toBe('unreachable executed (line 6)');
  });

  it('an endless loop stops at exactly 1 000 000 instructions', async () => {
    const { result } = await run('(module (func (export "main") (loop $l (br $l))))');
    expect(result.finished).toBe(false);
    expect(result.steps).toBe(BUDGET);
    expect(result.error).toBe('instruction budget exceeded (1000000) (line 1)');
  });

  it('a slow-but-finite loop inside the budget completes', async () => {
    const src = `(module
  (import "didact" "print" (func $print (param i32)))
  (func (export "main") (local $i i32)
    (loop $again
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $again (i32.lt_u (local.get $i) (i32.const 100000))))
    (call $print (local.get $i))))`;
    const { text, result } = await run(src);
    expect(text).toBe('100000\n');
    expect(result.finished).toBe(true);
  });
});

describe('the session contract', () => {
  it('step() runs exactly one instruction at a time', async () => {
    const s = wasmKernel.createSession();
    await s.load(mod('(call $print (i32.add (i32.const 20) (i32.const 22)))'));
    const first = await s.step();
    expect(first).toMatchObject({ ran: true });
    expect(first.result!.steps).toBe(1);
    const stack = s.state().find((p): p is Extract<Panel, { kind: 'listing' }> => p.kind === 'listing' && p.id === 'stack')!;
    expect(stack.rows.map((r) => r.text)).toEqual(['20']);
    await s.step();
    await s.step(); // the add
    const after = s.state().find((p): p is Extract<Panel, { kind: 'listing' }> => p.kind === 'listing' && p.id === 'stack')!;
    expect(after.rows.map((r) => r.text)).toEqual(['42']);
    let steps = 3;
    while ((await s.step()).ran) steps++;
    expect(steps).toBe(5); // 2 consts + add + call $print + the function's end
    expect((await s.step()).ran).toBe(false); // finished: nothing more runs
  });

  it('breakpoints pause before the instruction on that source line', async () => {
    const s = wasmKernel.createSession();
    const src = `(module
  (import "didact" "print" (func $print (param i32)))
  (func (export "main")
    (call $print (i32.const 1))
    (call $print (i32.const 2))
    (call $print (i32.const 3))))`;
    await s.load(src);
    const paused = await s.run([5]);
    expect(paused.pausedAt).toBe(5);
    expect(paused.finished).toBe(false);
    const con = s.state().find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console')!;
    expect(con.text).toBe('1\n'); // line 5's print has NOT run
    const done = await s.run();
    expect(done.finished).toBe(true);
    expect(s.state().find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console')!.text).toBe('1\n2\n3\n');
  });

  it('panels expose locals with changed flags and a live call stack', async () => {
    const s = wasmKernel.createSession();
    await s.load(`(module
  (import "didact" "print" (func $print (param i32)))
  (func $double (param $n i32) (result i32)
    (i32.add (local.get $n) (local.get $n)))
  (func (export "main") (local $x i32)
    (local.set $x (call $double (i32.const 21)))))`);
    await s.step(); // i32.const 21
    await s.step(); // call $double — now inside $double
    const panels = s.state();
    const locals = panels.find((p): p is Extract<Panel, { kind: 'fields' }> => p.kind === 'fields' && p.id === 'locals')!;
    expect(locals.title).toBe('Locals · $double');
    expect(locals.fields).toEqual([
      { key: '$n', value: '0x00000015', sub: '21', changed: true, tip: 'parameter — set by the caller' },
    ]);
    const calls = panels.find((p): p is Extract<Panel, { kind: 'listing' }> => p.kind === 'listing' && p.id === 'callstack')!;
    expect(calls.rows.map((r) => r.text)).toEqual(['main · waiting at line 6', '$double · line 4']);
    // the changed flag clears once the snapshot has been read
    const again = s.state().find((p): p is Extract<Panel, { kind: 'fields' }> => p.kind === 'fields' && p.id === 'locals')!;
    expect(again.fields[0]!.changed).toBe(false);
  });

  it('main with (result i32) reports its return value', async () => {
    const { result } = await run('(module (func (export "main") (result i32) (i32.const -3)))');
    expect(result.exit).toBe('main → -3');
  });

  it('reset() rewinds to the freshly loaded state', async () => {
    const s = wasmKernel.createSession();
    await s.load(mod('(call $print (i32.const 9))'));
    await s.run();
    s.reset();
    const again = await s.run();
    expect(again).toMatchObject({ finished: true });
    expect(s.state().find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console')!.text).toBe('9\n');
  });

  it('select, eq/ne and comparisons signed vs unsigned', async () => {
    const { text } = await run(mod(`(call $print (select (i32.const 1) (i32.const 2) (i32.const 1)))
    (call $print (select (i32.const 1) (i32.const 2) (i32.const 0)))
    (call $print (i32.lt_s (i32.const -1) (i32.const 1)))
    (call $print (i32.lt_u (i32.const -1) (i32.const 1)))
    (call $print (i32.eq (i32.const 4) (i32.const 4)))
    (call $print (i32.ne (i32.const 4) (i32.const 4)))`));
    expect(text).toBe('1\n2\n1\n0\n1\n0\n');
  });
});
