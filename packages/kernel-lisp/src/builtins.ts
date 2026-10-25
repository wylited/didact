// Builtins: the fixed vocabulary every lesson gets for free. Pure functions
// over Values + a small context (output, heap, caller's env/line) — no
// machine internals, so they cannot disturb stepping or tail calls.

import { lispEqual, renderDisplay, renderWrite, withHeap, Builtin, BuiltinCtx, Closure, LispError, Macro, Ref, Sym, Value } from './value';

function num(args: Value[], i: number, who: string, line: number): number {
  const v = args[i]!;
  if (typeof v !== 'number') {
    throw new LispError(`${who}: expected a number, got ${renderWrite(v)}`, line);
  }
  return v;
}

function chainCompare(args: Value[], op: (a: number, b: number) => boolean, who: string, line: number): Value {
  for (let i = 0; i + 1 < args.length; i++) {
    if (!op(num(args, i, who, line), num(args, i + 1, who, line))) return false;
  }
  return true;
}

/** Fold numbers left-to-right, e.g. (- 10 1 2) = 7 — the Scheme way. */
function foldArith(args: Value[], init: number, op: (a: number, b: number) => number, who: string, line: number): number {
  let acc = init;
  for (let i = 0; i < args.length; i++) acc = op(acc, num(args, i, who, line));
  return acc;
}

function isList(v: Value, heap: BuiltinCtx['heap']): boolean {
  let cur = v;
  let n = 0;
  while (cur instanceof Ref) {
    cur = heap.get(cur.addr).cdr;
    // No cycles are constructible, but bound the walk defensively anyway.
    if (++n > 1_000_000) return false;
  }
  return cur === null;
}

/** The builtin table, installed into every machine's global frame. The one
 *  non-pure entry point is `macroexpand-1`, which delegates back into the
 *  machine through the injected `expander`. */
export function makeBuiltins(expander: (formValue: Value, env: BuiltinCtx['env']) => Value): Map<string, Value> {
  const defs: [string, number, number, (args: Value[], ctx: BuiltinCtx) => Value][] = [
    // ---- arithmetic ----
    ['+', 0, Infinity, (a, c) => foldArith(a, 0, (x, y) => x + y, '+', c.line)],
    ['*', 0, Infinity, (a, c) => foldArith(a, 1, (x, y) => x * y, '*', c.line)],
    ['-', 1, Infinity, (a, c) => {
      if (a.length === 1) return -num(a, 0, '-', c.line);
      return foldArith(a.slice(1), num(a, 0, '-', c.line), (x, y) => x - y, '-', c.line);
    }],
    ['/', 1, Infinity, (a, c) => {
      const divide = (x: number, y: number): number => {
        if (y === 0) throw new LispError('/: division by zero', c.line);
        return x / y;
      };
      return a.length === 1 ? divide(1, num(a, 0, '/', c.line))
        : foldArith(a.slice(1), num(a, 0, '/', c.line), divide, '/', c.line);
    }],
    ['=', 2, Infinity, (a, c) => chainCompare(a, (x, y) => x === y, '=', c.line)],
    ['<', 2, Infinity, (a, c) => chainCompare(a, (x, y) => x < y, '<', c.line)],
    ['>', 2, Infinity, (a, c) => chainCompare(a, (x, y) => x > y, '>', c.line)],
    ['<=', 2, Infinity, (a, c) => chainCompare(a, (x, y) => x <= y, '<=', c.line)],
    ['>=', 2, Infinity, (a, c) => chainCompare(a, (x, y) => x >= y, '>=', c.line)],
    ['modulo', 2, 2, (a, c) => {
      const x = num(a, 0, 'modulo', c.line);
      const y = num(a, 1, 'modulo', c.line);
      if (y === 0) throw new LispError('modulo: division by zero', c.line);
      return x - Math.floor(x / y) * y;
    }],
    ['remainder', 2, 2, (a, c) => {
      const x = num(a, 0, 'remainder', c.line);
      const y = num(a, 1, 'remainder', c.line);
      if (y === 0) throw new LispError('remainder: division by zero', c.line);
      return x % y;
    }],
    ['abs', 1, 1, (a, c) => Math.abs(num(a, 0, 'abs', c.line))],
    ['min', 1, Infinity, (a, c) => Math.min(...a.map((_, i) => num(a, i, 'min', c.line)))],
    ['max', 1, Infinity, (a, c) => Math.max(...a.map((_, i) => num(a, i, 'max', c.line)))],

    // ---- pairs & lists (the heap in action) ----
    ['cons', 2, 2, (a, c) => c.heap.alloc(a[0]!, a[1]!)],
    ['car', 1, 1, (a, c) => c.heap.car(a[0]!)],
    ['cdr', 1, 1, (a, c) => c.heap.cdr(a[0]!)],
    ['list', 0, Infinity, (a, c) => {
      let acc: Value = null;
      for (let i = a.length - 1; i >= 0; i--) acc = c.heap.alloc(a[i]!, acc);
      return acc;
    }],
    ['append', 0, Infinity, (a, c) => {
      if (a.length === 0) return null;
      // All but the last list are copied; the last is shared — sharing is
      // exactly what eq? on addresses makes visible.
      let acc: Value = a[a.length - 1]!;
      for (let i = a.length - 2; i >= 0; i--) {
        const lst = a[i]!;
        if (lst === null) continue;
        if (!(lst instanceof Ref)) throw new LispError(`append: expected a list, got ${renderWrite(lst)}`, c.line);
        const elems: Value[] = [];
        let cur: Value = lst;
        for (; cur instanceof Ref; cur = c.heap.get(cur.addr).cdr) {
          elems.push(c.heap.get(cur.addr).car);
        }
        // A dotted tail here would be silently dropped — refuse instead.
        if (cur !== null) throw new LispError('append: expected a proper list', c.line);
        for (let j = elems.length - 1; j >= 0; j--) acc = c.heap.alloc(elems[j]!, acc);
      }
      return acc;
    }],
    ['length', 1, 1, (a, c) => {
      let n = 0;
      let cur: Value = a[0]!;
      while (cur instanceof Ref) { n++; cur = c.heap.get(cur.addr).cdr; }
      if (cur !== null) throw new LispError(`length: expected a proper list, got ${renderWrite(a[0]!)}`, c.line);
      return n;
    }],
    ['reverse', 1, 1, (a, c) => {
      let cur: Value = a[0]!;
      let acc: Value = null;
      while (cur instanceof Ref) {
        acc = c.heap.alloc(c.heap.get(cur.addr).car, acc);
        cur = c.heap.get(cur.addr).cdr;
      }
      if (cur !== null) throw new LispError(`reverse: expected a proper list, got ${renderWrite(a[0]!)}`, c.line);
      return acc;
    }],

    // ---- predicates ----
    ['null?', 1, 1, (a) => a[0] === null],
    ['pair?', 1, 1, (a) => a[0] instanceof Ref],
    ['list?', 1, 1, (a, c) => isList(a[0]!, c.heap)],
    ['symbol?', 1, 1, (a) => a[0] instanceof Sym],
    ['number?', 1, 1, (a) => typeof a[0] === 'number'],
    ['string?', 1, 1, (a) => typeof a[0] === 'string'],
    ['procedure?', 1, 1, (a) => a[0] instanceof Builtin || a[0] instanceof Closure || a[0] instanceof Macro],
    ['eq?', 2, 2, (a) => a[0] === a[1]],
    ['eqv?', 2, 2, (a) => a[0] === a[1]],
    ['equal?', 2, 2, (a, c) => lispEqual(a[0]!, a[1]!, c.heap)],
    ['not', 1, 1, (a) => a[0] === false],

    // ---- I/O ----
    ['display', 1, 1, (a, c) => {
      c.out(withHeap(c.heap, () => renderDisplay(a[0]!)));
      return null;
    }],
    ['newline', 0, 0, (_a, c) => {
      c.out('\n');
      return null;
    }],
    ['error', 1, Infinity, (a, c) => {
      const parts = a.map((v) => withHeap(c.heap, () => renderDisplay(v)));
      throw new LispError(parts.join(' '), c.line);
    }],

    // ---- teaching helpers ----
    ['macroexpand-1', 1, 1, (a, c) => expander(a[0]!, c.env)],
  ];
  const table = new Map<string, Value>();
  for (const [name, min, max, fn] of defs) {
    table.set(name, new Builtin(name, min, max, fn));
  }
  return table;
}
