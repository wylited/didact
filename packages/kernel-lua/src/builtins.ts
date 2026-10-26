// builtins.ts — the standard-library subset. `print` is wired in interp.ts
// because it writes interpreter output. pairs/ipairs are honored only inside
// `for … in` (see parser); calling them directly is a clean error.

import {
  Builtin, LuaError, LuaFloat, LuaInt, LuaValue, Table, isNum, numOf, toStr,
  typeName,
} from './value';

function checkArg(args: LuaValue[], i: number, name: string, wants: 'table' | 'number'): LuaValue {
  const v = args[i] ?? null;
  const ok = wants === 'table' ? v instanceof Table : isNum(v);
  if (!ok) {
    throw new LuaError(
      `bad argument #${i + 1} to '${name}' (${wants} expected, got ${typeName(v)})`);
  }
  return v;
}

export function makeBuiltins(): Record<string, Builtin> {
  const defs: [string, (args: LuaValue[]) => LuaValue[]][] = [
    ['tostring', (a) => [toStr(a[0] ?? null)]],
    ['tonumber', (a) => {
      const v = a[0] ?? null;
      if (isNum(v)) return [v];
      if (typeof v === 'string') {
        const t = v.trim();
        if (/^-?0[xX][0-9a-fA-F]+$/.test(t)) {
          const n = parseInt(t, 16);
          return [Number.isSafeInteger(n) ? new LuaInt(n) : new LuaFloat(n)];
        }
        if (/^-?\d+$/.test(t)) return [new LuaInt(Number(t))];
        if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return [new LuaFloat(Number(t))];
      }
      return [null];
    }],
    ['type', (a) => [typeName(a[0] ?? null)]],
    ['setmetatable', (a) => {
      const t = checkArg(a, 0, 'setmetatable', 'table') as Table;
      const raw = a[1] ?? null;
      t.metatable = raw === null ? null : checkArg(a, 1, 'setmetatable', 'table') as Table;
      return [t];
    }],
    ['getmetatable', (a) => {
      const t = checkArg(a, 0, 'getmetatable', 'table') as Table;
      return [t.metatable];
    }],
    ['pairs', () => {
      throw new LuaError("in this subset, pairs is only used inside 'for k, v in pairs(t)'");
    }],
    ['ipairs', () => {
      throw new LuaError("in this subset, ipairs is only used inside 'for i, v in ipairs(t)'");
    }],
    ['math.floor', (a) => {
      const v = checkArg(a, 0, 'floor', 'number');
      return [new LuaInt(Math.floor(numOf(v)))];
    }],
    ['math.abs', (a) => {
      const v = checkArg(a, 0, 'abs', 'number');
      return v instanceof LuaInt
        ? [new LuaInt(Math.abs(v.v))]
        : [new LuaFloat(Math.abs(numOf(v)))];
    }],
    ['math.max', (a) => {
      let best = checkArg(a, 0, 'max', 'number');
      for (let i = 1; i < a.length; i++) {
        const n = checkArg(a, i, 'max', 'number');
        if (numOf(n) > numOf(best)) best = n;
      }
      return [best];
    }],
    ['math.min', (a) => {
      let best = checkArg(a, 0, 'min', 'number');
      for (let i = 1; i < a.length; i++) {
        const n = checkArg(a, i, 'min', 'number');
        if (numOf(n) < numOf(best)) best = n;
      }
      return [best];
    }],
    ['string.upper', (a) => [toStr(a[0] ?? null).toUpperCase()]],
    ['string.lower', (a) => [toStr(a[0] ?? null).toLowerCase()]],
    ['string.rep', (a) => {
      const s = toStr(a[0] ?? null);
      const n = Math.floor(numOf(checkArg(a, 1, 'rep', 'number')));
      if (n <= 0) return [''];
      if (s.length * n > 1_000_000) throw new LuaError('string.rep result too large (over 1 MB)');
      return [s.repeat(n)];
    }],
  ];

  const table: Record<string, Builtin> = {};
  for (const [name, call] of defs) table[name] = new Builtin(name, call);
  return table;
}
