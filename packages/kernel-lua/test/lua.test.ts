// lua.test.ts — behavioral tests with exact expected values.

import { describe, expect, it } from 'vitest';
import { luaKernel } from '../src/index';
import type { Panel } from '../src/index';

/** Run src to completion; return [console text, run result]. */
async function run(src: string): Promise<{ text: string; finished: boolean; error?: string; steps: number; pausedAt?: number }> {
  const s = luaKernel.createSession();
  const load = await s.load(src);
  if (!load.ok) throw new Error(`load failed: line ${load.line}: ${load.message}`);
  const r = await s.run();
  const text = consoleOf(s.state());
  s.dispose();
  return { text: text.replace(/\n$/, ''), finished: r.finished, error: r.error, steps: r.steps, pausedAt: r.pausedAt };
}

function consoleOf(panels: Panel[]): string {
  const c = panels.find((p) => p.kind === 'console');
  return c !== undefined && c.kind === 'console' ? c.text : '';
}

async function out(src: string): Promise<string> {
  const r = await run(src);
  expect(r.error).toBeUndefined();
  return r.text;
}

describe('lua kernel identity', () => {
  it('declares id, label, syntax, features', () => {
    expect(luaKernel.id).toBe('lua');
    expect(luaKernel.label).toBe('Lua · interpreter');
    expect(luaKernel.editorSyntax).toBe('lua');
    expect(luaKernel.features).toEqual({ breakpoints: true, stepping: true });
  });
});

describe('multiple assignment and returns', () => {
  it('swaps via a, b = b, a', async () => {
    expect(await out(`local a, b = 1, 2\na, b = b, a\nprint(a, b)`)).toBe('2\t1');
  });

  it('expands the last call, truncates elsewhere', async () => {
    expect(await out(`local function two() return 1, 2 end
local x, y = two()
print(x, y)
local z = two()
print(z)
print((two()))
print(two())`)).toBe('1\t2\n1\n1\n1\t2');
  });

  it('expands a tail call in an argument list and a return', async () => {
    expect(await out(`local function two() return 1, 2 end
local function pass() return 0, two() end
local function count(a, b, c) return a + b + c end
print(count(pass()))
print(count(0, two()))`)).toBe('3\n3');
  });

  it('pads missing values with nil and drops extras', async () => {
    expect(await out(`local a, b, c = 1\nprint(a, b, c)\na, b = 1, 2, 3\nprint(a, b)`)).toBe('1\tnil\tnil\n1\t2');
  });
});

describe('truthiness and indexing', () => {
  it('treats 0 and the empty string as truthy', async () => {
    expect(await out(`if 0 then print('0 truthy') end
if '' then print("'' truthy") end
if nil then print('nil') elseif false then print('false') else print('only nil/false falsy') end`))
      .toBe("0 truthy\n'' truthy\nonly nil/false falsy");
  });

  it('indexes tables from 1', async () => {
    expect(await out(`local t = {'a', 'b', 'c'}\nprint(t[1], t[3], #t)`)).toBe('a\tc\t3');
  });

  it('runs a 1-based numeric for, integer and 0.5 steps', async () => {
    expect(await out(`for i = 1, 3 do print(i) end
for x = 0, 1, 0.5 do print(x) end
for d = 3, 1, -1 do print(d) end`)).toBe('1\n2\n3\n0\n0.5\n1.0\n3\n2\n1');
  });

  it('iterates ipairs and pairs', async () => {
    expect(await out(`local t = {10, 20, name = 'x'}
for i, v in ipairs(t) do print(i, v) end
for k, v in pairs(t) do print(k, v) end`)).toBe('1\t10\n2\t20\n1\t10\n2\t20\nname\tx');
  });
});

describe('integers vs floats', () => {
  it('prints 1 and 1.0 differently', async () => {
    expect(await out(`print(1, 1.0, 2 ^ 31, 7 / 2)`)).toBe('1\t1.0\t2147483648.0\t3.5');
  });

  it('keeps // integer when both are integers, float otherwise', async () => {
    expect(await out(`print(7 // 2, 7.0 // 2, -7 // 2, 7 // -2)`)).toBe('3\t3.0\t-4\t-4');
  });

  it('follows the divisor sign for %', async () => {
    expect(await out(`print(5 % 3, 5 % -3, -5 % 3, -5 % -3, 5.0 % -3)`)).toBe('2\t-1\t1\t-2\t-1.0');
  });

  it('compares 1 == 1.0 numerically but keeps type distinct', async () => {
    expect(await out(`print(1 == 1.0, type(1), type(1.0))`)).toBe('true\tnumber\tnumber');
  });
});

describe('functions, methods, closures', () => {
  it('passes self through the colon sugar both ways', async () => {
    expect(await out(`local obj = {n = 'lua'}
function obj:greet(punct) return self.n .. punct end
local f = obj.greet
print(obj:greet('!'), f(obj, '?'))`)).toBe('lua!\tlua?');
  });

  it('closes over a local across calls', async () => {
    expect(await out(`local function counter()
  local n = 0
  return function() n = n + 1 return n end
end
local c = counter()
c() c()
print(c(), c())`)).toBe('3\t4');
  });

  it('handles recursion and repeat/while/break', async () => {
    expect(await out(`local function fact(n) if n <= 1 then return 1 end return n * fact(n - 1) end
print(fact(5))
local i = 0
repeat i = i + 1 until i >= 3
while true do if i > 4 then break end i = i + 1 end
print(i)`)).toBe('120\n5');
  });

  it('concatenates numbers and strings with ..', async () => {
    expect(await out(`print('a' .. 1 .. 'b', #('abc\\n'), 'x\\ty')`)).toBe('a1b\t4\tx\ty');
  });
});

describe('metatables', () => {
  it('follows a two-level __index chain', async () => {
    expect(await out(`local Grand = {where = 'grand'}
local Mid = {}
Grand.__index = Grand
setmetatable(Mid, {__index = Grand})
local Kid = {}
Mid.__index = Mid
setmetatable(Kid, {__index = Mid})
print(Kid.where)`)).toBe('grand');
  });

  it('calls an __index function for misses', async () => {
    expect(await out(`local t = setmetatable({}, {__index = function(t, k) return k .. '!' end})
print(t.miss)`)).toBe('miss!');
  });

  it('supports __newindex as a function', async () => {
    expect(await out(`local log = {}
local t = setmetatable({}, {__newindex = function(t, k, v) log[#log + 1] = k .. '=' .. v end})
t.a = 1
t.b = 2
print(#t, log[1], log[2])`)).toBe('0\ta=1\tb=2');
  });

  it('reads own keys without consulting __index', async () => {
    expect(await out(`local base = {x = 'base'}
local t = setmetatable({x = 'own'}, {__index = base})
print(t.x, t.y)`)).toBe('own\tnil');
  });
});

describe('standard-library subset', () => {
  it('tostring / tonumber / type / math / string', async () => {
    expect(await out(`print(tostring(10), tostring(1.5), tonumber('42'), tonumber('x'))
print(type(nil), type(true), type(1), type('s'), type({}), type(print))
print(math.floor(3.7), math.abs(-2), math.max(1, 9, 4), math.min(1, 9, 4))
print(string.upper('ab'), string.lower('AB'), string.rep('ab', 3))`))
      .toBe('10\t1.5\t42\tnil\nnil\tboolean\tnumber\tstring\ttable\tfunction\n3\t2\t9\t1\nAB\tab\tababab');
  });
});

describe('errors and budget', () => {
  it('maps parse errors to 1-based lines', async () => {
    const s = luaKernel.createSession();
    const r = await s.load(`local ok = 1\nprint(ok)\nlocal x = = 2`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.line).toBe(3);
    s.dispose();
  });

  it('maps runtime errors to 1-based lines', async () => {
    const r = await run(`local t = {}\nprint(t.x.y)`);
    expect(r.finished).toBe(false);
    expect(r.error).toMatch(/^line 2: attempt to index a nil value/);
  });

  it('rejects coroutine with the offending line', async () => {
    const r = await run(`print('a')\nlocal c = coroutine.wrap(print)`);
    expect(r.error).toBe('line 2: coroutine is not in the Lua subset');
  });

  it('rejects varargs at parse time with the line', async () => {
    const s = luaKernel.createSession();
    const r = await s.load(`local f = function(a)\n  return a, ...\nend`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.line).toBe(2);
    s.dispose();
  });

  it('stops an empty infinite loop at the budget', async () => {
    const r = await run('while true do end');
    expect(r.finished).toBe(false);
    expect(r.error).toBe('line 1: budget exceeded: more than 1000000 operations');
  });
});

describe('session contract', () => {
  it('steps one statement at a time and marks changed locals', async () => {
    const s = luaKernel.createSession();
    await s.load(`local n = 0\nn = n + 1\nn = n + 0`);
    expect((await s.step()).ran).toBe(true);
    let locals = s.state().find((p) => p.kind === 'fields' && p.id === 'lua-locals');
    expect(locals && locals.kind === 'fields' ? locals.fields.find((f) => f.key === 'n')?.changed : false).toBe(true);
    await s.step();
    locals = s.state().find((p) => p.kind === 'fields' && p.id === 'lua-locals');
    expect(locals && locals.kind === 'fields' ? locals.fields.find((f) => f.key === 'n')?.value : '').toBe('1');
    await s.step(); // n unchanged in value: no new mark relative to that step
    locals = s.state().find((p) => p.kind === 'fields' && p.id === 'lua-locals');
    expect(locals && locals.kind === 'fields' ? locals.fields.find((f) => f.key === 'n')?.changed : true).toBe(false);
    s.dispose();
  });

  it('pauses before a breakpoint line and can continue', async () => {
    const s = luaKernel.createSession();
    await s.load(`local a = 1\nlocal b = 2\nprint(a + b)`);
    const r = await s.run([2]);
    expect(r.pausedAt).toBe(2);
    expect(consoleOf(s.state())).toBe('');
    const r2 = await s.run();
    expect(r2.finished).toBe(true);
    expect(consoleOf(s.state())).toBe('3\n');
    s.dispose();
  });

  it('renders the heap view with changed-marked rows', async () => {
    const s = luaKernel.createSession();
    await s.load(`local t = {1, 2, name = 'x'}\nt[1] = 99`);
    await s.step();
    const rows1 = tablesRows(s.state());
    expect(rows1.some((r) => r.text === '[1] = 1' && r.bytes === 'Δ')).toBe(true);
    await s.run();
    const rows2 = tablesRows(s.state());
    expect(rows2.find((r) => r.text === '[1] = 99')?.bytes).toBe('Δ');
    expect(rows2.find((r) => r.text === '[2] = 2')?.bytes).toBe('');
    expect(rows2.find((r) => r.text === '"name" = x')?.bytes).toBe('');
    s.dispose();
  });

  it('shows the call stack while inside a call', async () => {
    const s = luaKernel.createSession();
    await s.load(`local function inner(x)\n  return x\nend\nlocal function outer()\n  return inner(7)\nend\nouter()`);
    await s.run([2]);
    const stack = s.state().find((p) => p.id === 'lua-stack');
    expect(stack && stack.kind === 'listing' ? stack.rows.map((r) => r.text) : []).toEqual([
      'inner(7) at line 2',
      'outer() at line 5',
      'chunk at line 7',
    ]);
    s.dispose();
  });

  it('globals appear in the _G panel', async () => {
    const s = luaKernel.createSession();
    await s.load(`g = 5\nlocal l = 1`);
    await s.run();
    const g = s.state().find((p) => p.id === 'lua-globals');
    const fields = g && g.kind === 'fields' ? g.fields : [];
    expect(fields.find((f) => f.key === 'g')?.value).toBe('5');
    expect(fields.find((f) => f.key === 'l')).toBeUndefined();
    s.dispose();
  });

  it('reset() restores a clean run', async () => {
    const s = luaKernel.createSession();
    await s.load(`n = 1\nprint(n)`);
    await s.run();
    s.reset();
    const r = await s.run();
    expect(r.finished).toBe(true);
    expect(consoleOf(s.state())).toBe('1\n');
    s.dispose();
  });
});

function tablesRows(panels: Panel[]): { text: string; bytes: string }[] {
  const t = panels.find((p) => p.id === 'lua-tables');
  return t !== undefined && t.kind === 'listing'
    ? t.rows.map((r) => ({ text: r.text, bytes: r.bytes }))
    : [];
}

describe('review regression fixes', () => {
  it('parses keyword not as unary', async () => {
    expect(await out(`print(not true, not 0, not nil)
if not nil then print('runs') end`)).toBe('false\tfalse\ttrue\nruns');
  });

  it('a redeclared local does not alias through closures', async () => {
    expect(await out(`local x = 1
local f = function() return x end
local x = 2
print(f(), x)`)).toBe('1\t2');
  });

  it('local f = function() ... end does not see its own binding', async () => {
    expect(await out(`f = 42
local f = function() return f end
print(f())`)).toBe('42');
  });

  it('nil positional fields still occupy their slot', async () => {
    expect(await out(`local t = {1, nil, 2}
print(#t, t[2], t[3])
for i, v in ipairs(t) do print(i, v) end`)).toBe('3\tnil\t2\n1\t1');
  });

  it('a call in the last positional field expands', async () => {
    expect(await out(`local function two() return 1, 2 end
local t = {two()}
print(#t, t[1], t[2])`)).toBe('2\t1\t2');
  });

  it('integer //0 and %0 are errors; floats keep inf', async () => {
    expect((await run(`print(1 // 0)`)).error).toBe('line 1: attempt to divide by zero');
    expect((await run(`print(1 % 0)`)).error).toBe("line 1: attempt to perform 'n%0'");
    expect(await out('print(1.0 // 0, 1.0 % 0)')).toBe('inf\tnan');
  });

  it('tonumber reads hex and string arithmetic stays integral', async () => {
    expect(await out(`print(tonumber('0x10'), '10' + 5, '7' % 3)`)).toBe('16\t15\t1');
  });

  it('floats print like Lua %.14g', async () => {
    expect(await out(`print(1 / 3, 1e20, 2 ^ 53, 1 / 0, -1 / 0, 0 / 0, -0.0)`))
      .toBe('0.33333333333333\t1e+20\t9.007199254741e+15\tinf\t-inf\tnan\t-0.0');
  });

  it('refuses integer literals beyond 2^53 at load time with the line', async () => {
    const s = luaKernel.createSession();
    const r = await s.load(`local ok = 1\nlocal x = 9007199254740993`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.line).toBe(2);
      expect(r.message).toBe(
        'integer literals beyond 2^53 are not in the teaching subset — ' +
        'Lua integers are 64-bit, this interpreter is not');
    }
    s.dispose();
  });

  it('guards recursive __index metamethods with a line-mapped error', async () => {
    const r = await run(`local t = {}
setmetatable(t, {__index = function(tt, k) return tt[k] end})
local v = t.x`);
    expect(r.finished).toBe(false);
    expect(r.error).toBe(
      "line 2: '__index' metamethod recursion exceeds 200 frames; possible loop");
  });
});
