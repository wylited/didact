// smoke.ts — bun smoke test for @didact/kernel-lua.
// Run: `bun packages/kernel-lua/test/smoke.ts`.
// Covers: semantics spot checks, line-mapped errors, budget, the Session
// contract (panels, breakpoints, reset), and a round-trip of every lesson
// block against its #+RESULTS.

import { luaKernel } from '../src/index';
import type { Panel } from '../src/index';

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; } else { failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`); }
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${String(got)} want ${String(want)}`);
}

async function runSession(src: string): Promise<{ text: string; panels: Panel[]; result: { finished: boolean; error?: string; pausedAt?: number } }> {
  const s = luaKernel.createSession();
  const load = await s.load(src);
  if (!load.ok) throw new Error(`load failed: line ${load.line}: ${load.message}`);
  const result = await s.run();
  const panels = s.state();
  const c = panels.find((p) => p.kind === 'console');
  s.dispose();
  return { text: c !== undefined && c.kind === 'console' ? c.text : '', panels, result };
}

async function out(src: string): Promise<string> {
  const r = await runSession(src);
  if (r.result.error !== undefined) throw new Error(r.result.error);
  return r.text.trimEnd();
}

// ─── semantics ──────────────────────────────────────────────────────────────
console.log('semantics · swap, truncation, ints/floats, metatables');
eq('swap', await out(`local a, b = 1, 2\na, b = b, a\nprint(a, b)`), '2\t1');
eq('tail expansion vs truncation', await out(`local function two() return 1, 2 end
local x, y = two()
local z = two()
print(x, y, z, (two()))`), '1\t2\t1\t1');
eq('0 and empty string truthy', await out(`if 0 and '' then print('yes') end`), 'yes');
eq('1-based for', await out(`for i = 1, 3 do print(i) end`), '1\n2\n3');
eq('1 vs 1.0', await out(`print(1, 1.0, 1 // 1, 1.0 // 1)`), '1\t1.0\t1\t1.0');
eq('divisor-sign modulo', await out(`print(5 % -3, -5 % 3)`), '-1\t1');
eq('floor division floors down', await out(`print(-7 // 2, 7 // -2)`), '-4\t-4');
eq('method sugar passes self', await out(`local o = {n = 'me'}\nfunction o:who() return self.n end\nprint(o:who())`), 'me');
eq('two-level __index chain', await out(`local G = {v = 'grand'}
local M = {}
G.__index = G
setmetatable(M, {__index = G})
local K = {}
M.__index = M
setmetatable(K, {__index = M})
print(K.v)`), 'grand');
eq('closure over a local', await out(`local function mk() local n = 0 return function() n = n + 1 return n end end
local c = mk() c() c() print(c())`), '3');
eq('generic for', await out(`for k, v in pairs({7, 8}) do print(k, v) end`), '1\t7\n2\t8');
eq('library subset', await out(`print(math.floor(2.9), string.rep('ab', 2), tostring(1.0), tonumber('7'), type({}))`), '2\tabab\t1.0\t7\ttable');
console.log('semantics: exact-value checks done');

// ─── errors and budget ──────────────────────────────────────────────────────
console.log('bounds · errors, budget');
{
  const s = luaKernel.createSession();
  const bad = await s.load(`local ok = 1\nlocal x = = 2`);
  check('parse error line-mapped', !bad.ok && bad.line === 2, JSON.stringify(bad));
  s.dispose();
}
{
  const r = await runSession(`while true do end`);
  check('budget exceeded cleanly', r.result.error === 'line 1: budget exceeded: more than 1000000 operations', r.result.error ?? '');
}
{
  const r = await runSession(`print('a')\nlocal c = coroutine.create(print)`);
  eq('coroutine denied with line', r.result.error, 'line 2: coroutine is not in the Lua subset');
}
{
  const s = luaKernel.createSession();
  const bad = await s.load(`local f = function() return ... end`);
  check('varargs denied at parse', !bad.ok && bad.line === 1, JSON.stringify(bad));
  s.dispose();
}

// ─── session contract ───────────────────────────────────────────────────────
console.log('contract · session, panels, breakpoints');
{
  const s = luaKernel.createSession();
  await s.load(`local t = {1, name = 'x'}\nt[1] = 2\nprint(t[1])`);
  const r1 = await s.run([2]);
  eq('breakpoint pauses before line 2', r1.pausedAt, 2);
  const tables = s.state().find((p) => p.id === 'lua-tables');
  check('tables panel exists', tables !== undefined);
  const r2 = await s.run();
  check('continue after pause', r2.finished === true && r2.error === undefined, r2.error ?? '');
  const c = s.state().find((p) => p.kind === 'console');
  eq('console after resume', c !== undefined && c.kind === 'console' ? c.text.trimEnd() : '', '2');
  s.reset();
  const r3 = await s.run();
  check('reset gives a clean rerun', r3.finished === true, r3.error ?? '');
  s.dispose();
}
{
  const ids = (await runSession(`print('x')`)).panels.map((p) => p.id);
  for (const id of ['lua-globals', 'lua-tables', 'lua-stack', 'lua-console']) {
    check(`panel ${id} present`, ids.includes(id));
  }
}

// ─── lesson/lesson.org: every block runs and matches its #+RESULTS ─────────
console.log('session · lesson round-trip');
{
  const blocks: string[] = [];
  const expected: string[] = [];
  const org = await Bun.file(`${import.meta.dir}/../lesson/lesson.org`).text();
  const lines = org.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('#+BEGIN_SRC lua')) {
      const body: string[] = [];
      for (let j = i + 1; !lines[j]!.startsWith('#+END_SRC'); j++) body.push(lines[j]!);
      blocks.push(body.join('\n'));
    }
    if (lines[i]!.startsWith('#+RESULTS:')) {
      const body: string[] = [];
      for (let j = i + 1; lines[j] !== undefined && lines[j]!.startsWith(': '); j++) {
        body.push(lines[j]!.slice(2));
      }
      expected.push(body.join('\n'));
    }
  }
  eq('lesson has 6 executable blocks', blocks.length, 6);
  eq('lesson has 6 results slots', expected.length, 6);
  for (let k = 0; k < blocks.length; k++) {
    const s = luaKernel.createSession();
    const load = await s.load(blocks[k]!);
    check(`lesson block ${k + 1} loads`, load.ok, load.ok ? '' : `line ${load.line}: ${load.message}`);
    const r = await s.run();
    check(`lesson block ${k + 1} finishes`, r.finished && r.error === undefined, r.error ?? '');
    const c = s.state().find((p) => p.kind === 'console');
    const text = c !== undefined && c.kind === 'console' ? c.text.trim() : '';
    eq(`lesson block ${k + 1} output = ${JSON.stringify(expected[k])}`, text, expected[k]!);
    s.dispose();
  }
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} FAILED / ${pass} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`all ${pass} checks passed`);
