// Builtins: the fixed vocabulary every Emacs Lisp lesson gets for free.
//
// A builtin is a leaf: it inspects plain values and the Runtime, and never
// calls a user function. That keeps stepping observable — every user-level
// call the machine sees is a real closure/macro application. `funcall`,
// `apply`, `mapcar`, `run-hooks`, `macroexpand` and friends therefore live
// in machine.ts, not here.
//
// The one place builtins look at functions is `add-hook`/`remove-hook`,
// where function objects are compared with `eq` (never invoked).

import {
  Buffer,
  Builtin,
  BuiltinCtx,
  Closure,
  Cons,
  Keymap,
  LispError,
  Float,
  HashTable,
  Marker,
  Overlay,
  Macro,
  Sym,
  Value,
  Vec,
  eq,
  equal,
  eql,
  listLength,
  listOf,
  nil,
  renderDisplay,
  renderWrite,
  t,
  truthy,
} from './value';
import type { Runtime } from './runtime';

type Fn = (args: Value[], ctx: BuiltinCtx) => Value;

// ---- argument helpers ----------------------------------------------------

const runtimeOf = (ctx: BuiltinCtx): Runtime => ctx.runtime as Runtime;
const bool = (b: boolean): Value => (b ? t : nil);

function num(args: Value[], i: number, who: string, line: number): number {
  const v = args[i];
  if (v instanceof Float) return v.value;
  if (typeof v !== 'number') {
    throw new LispError(`${who}: expected a number, got ${renderWrite(v ?? nil)}`, line, 'wrong-type-argument');
  }
  return v;
}

function int(args: Value[], i: number, who: string, line: number): number {
  if (args[i] instanceof Float) {
    throw new LispError(`${who}: expected an integer, got ${renderWrite(args[i]!)}`, line, 'wrong-type-argument');
  }
  const n = num(args, i, who, line);
  if (!Number.isSafeInteger(n)) {
    throw new LispError(`${who}: expected an integer, got ${renderWrite(n)}`, line, 'wrong-type-argument');
  }
  return n;
}

function str(args: Value[], i: number, who: string, line: number): string {
  const v = args[i];
  if (typeof v !== 'string') {
    throw new LispError(`${who}: expected a string, got ${renderWrite(v ?? nil)}`, line, 'wrong-type-argument');
  }
  return v;
}

function sym(args: Value[], i: number, who: string, line: number): Sym {
  const v = args[i];
  if (!(v instanceof Sym)) {
    throw new LispError(`${who}: expected a symbol, got ${renderWrite(v ?? nil)}`, line, 'wrong-type-argument');
  }
  return v;
}

function cons(args: Value[], i: number, who: string, line: number): Cons {
  const v = args[i];
  if (!(v instanceof Cons)) {
    throw new LispError(`${who}: expected a list, got ${renderWrite(v ?? nil)}`, line, 'wrong-type-argument');
  }
  return v;
}

/** Walk a proper list, attaching the caller's source line to errors. */
function items(v: Value, who: string, line: number): Value[] {
  const out: Value[] = [];
  const seen = new Set<Cons>();
  let cur = v;
  while (cur instanceof Cons) {
    if (seen.has(cur)) {
      throw new LispError(`${who}: circular list`, line, 'circular-list');
    }
    seen.add(cur);
    out.push(cur.car);
    cur = cur.cdr;
  }
  if (cur !== nil) {
    throw new LispError(`${who}: expected a proper list, got ${renderWrite(v)}`, line);
  }
  return out;
}

/** Buffer argument resolution that needs the real runtime. */
function asBuffer(v: Value | undefined, rt: Runtime, who: string, line: number): Buffer {
  if (v instanceof Buffer) {
    if (!rt.isLive(v)) throw new LispError(`Selecting deleted buffer: ${v.name}`, line, 'error');
    return v;
  }
  if (typeof v === 'string') {
    const buf = rt.getBuffer(v);
    if (buf !== undefined) return buf;
    throw new LispError(`${who}: no such buffer ${renderWrite(v)}`, line, 'error');
  }
  throw new LispError(`${who}: expected a buffer, got ${renderWrite(v ?? nil)}`, line);
}

function optionalBuffer(args: Value[], rt: Runtime, who: string, line: number): Buffer {
  return args.length === 0 || args[0] === nil ? rt.current : asBuffer(args[0], rt, who, line);
}

/** 1-based position clamped to the buffer's valid range. */
function clampPos(buf: Buffer, p: number): number {
  if (!Number.isFinite(p)) throw new LispError('invalid buffer position');
  return Math.max(buf.pointMin, Math.min(buf.pointMax, Math.trunc(p)));
}

function searchForward(a: Value[], c: BuiltinCtx, regexp: boolean): Value {
  const rt = runtimeOf(c);
  const buf = rt.current;
  const pattern = str(a, 0, regexp ? 're-search-forward' : 'search-forward', c.line);
  const bound = a.length > 1 && a[1] !== nil ? clampPos(buf, int(a, 1, 'search', c.line)) : buf.pointMax;
  const noerror = a.length > 2 && truthy(a[2]!);
  const from = buf.point - 1;
  const to = Math.max(from, bound - 1);
  const window = buf.text.slice(from, to);
  let start = -1;
  let end = -1;
  let groups: (string | undefined)[] = [];
  let indices: [number, number][] = [];
  if (regexp) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'dgm');
    } catch {
      throw new LispError(`re-search-forward: invalid regexp ${renderWrite(pattern)}`, c.line, 'invalid-regexp');
    }
    const m = re.exec(window);
    if (m !== null) {
      start = from + m.index + 1;
      end = start + m[0].length;
      groups = [m[0], ...m.slice(1)];
      indices = (m.indices ?? []).map((pair): [number, number] =>
        pair === undefined ? [0, 0] : [from + pair[0] + 1, from + pair[1] + 1]);
    }
  } else {
    const at = window.indexOf(pattern);
    if (at >= 0) {
      start = from + at + 1;
      end = start + pattern.length;
      groups = [pattern];
      indices = [[start, end]];
    }
  }
  if (start < 0) {
    if (noerror) return nil;
    throw new LispError(`${regexp ? 're-search-forward' : 'search-forward'}: search failed`, c.line, 'search-failed');
  }
  buf.point = end;
  rt.matchData = { text: buf.text, start, end, groups, indices };
  return end;
}

function matchEdge(a: Value[], c: BuiltinCtx, which: 'beginning' | 'end'): Value {
  const rt = runtimeOf(c);
  if (rt.matchData === null) return nil;
  const n = int(a, 0, `match-${which}`, c.line);
  const pair = rt.matchData.indices[n];
  if (pair === undefined) return nil;
  return which === 'beginning' ? pair[0] : pair[1];
}

function matchString(a: Value[], c: BuiltinCtx, _props: boolean): Value {
  const rt = runtimeOf(c);
  if (rt.matchData === null) return nil;
  const n = int(a, 0, 'match-string', c.line);
  return rt.matchData.groups[n] ?? nil;
}

function lineStart(text: string, point: number): number {
  if (point <= 1) return 1;
  const i = text.lastIndexOf('\n', point - 2);
  return i < 0 ? 1 : i + 2;
}

function lineEnd(text: string, point: number): number {
  const i = text.indexOf('\n', point - 1);
  return i < 0 ? text.length + 1 : i + 1;
}

/** Move to the beginning of a line; returns lines it could not move. */
function forwardLine(buf: Buffer, n: number): number {
  let point = buf.point;
  let left = Math.trunc(n);
  while (left > 0) {
    const i = buf.text.indexOf('\n', point - 1);
    if (i < 0) { point = buf.length + 1; break; }
    point = i + 2;
    left--;
  }
  while (left < 0) {
    const start = lineStart(buf.text, point);
    if (start <= 1) { point = 1; break; }
    point = lineStart(buf.text, start - 1);
    left++;
  }
  buf.point = clampPos(buf, point);
  return left;
}

// ---- rendering / formatting ---------------------------------------------

/** PRINTCHARFUN: absent → the output panel; a buffer/name → that buffer. */
function writeOut(text: string, target: Value | undefined, ctx: BuiltinCtx, who: string): void {
  const rt = runtimeOf(ctx);
  if (target === undefined || target === nil) {
    rt.emit(text);
    return;
  }
  insertText(asBuffer(target, rt, who, ctx.line), text);
}

function formatText(fmt: string, args: Value[], who: string, line: number): string {
  let out = '';
  let ai = 0;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i]!;
    if (ch !== '%') {
      out += ch;
      if (out.length > MAX_STRING) throw new LispError(`${who}: string limit exceeded (${MAX_STRING} characters)`, line);
      continue;
    }
    i++;
    if (i >= fmt.length) throw new LispError(`${who}: trailing % in format string`, line);
    const spec = fmt[i]!;
    if (spec === '%') { out += '%'; continue; }
    if (ai >= args.length) {
      throw new LispError(`${who}: not enough arguments for format string`, line);
    }
    const arg = args[ai++]!;
    if (spec === 's') out += renderDisplay(arg);
    else if (spec === 'S') out += renderWrite(arg);
    else if (spec === 'd') {
      if (typeof arg !== 'number') {
        throw new LispError(`${who}: %d expected a number, got ${renderWrite(arg)}`, line, 'wrong-type-argument');
      }
      out += String(Math.trunc(arg));
    } else {
      throw new LispError(`${who}: invalid format operation %${spec}`, line);
    }
    if (out.length > MAX_STRING) {
      throw new LispError(`${who}: string limit exceeded (${MAX_STRING} characters)`, line);
    }
  }
  return out;
}

// ---- comparisons / arithmetic -------------------------------------------

function chain(args: Value[], who: string, line: number, ok: (a: number, b: number) => boolean): Value {
  for (let i = 0; i + 1 < args.length; i++) {
    if (!ok(num(args, i, who, line), num(args, i + 1, who, line))) return nil;
  }
  return t;
}

function fold(args: Value[], who: string, line: number, init: number, op: (a: number, b: number) => number): number {
  let acc = init;
  for (let i = 0; i < args.length; i++) acc = op(acc, num(args, i, who, line));
  return acc;
}

function divide(x: number, y: number, line: number, float = false): number {
  if (y === 0) throw new LispError('/: division by zero', line, 'arith-error');
  return float || !Number.isInteger(x) || !Number.isInteger(y) ? x / y : Math.trunc(x / y);
}

function isFloatValue(v: Value): boolean {
  return v instanceof Float || (typeof v === 'number' && !Number.isInteger(v));
}

function anyFloat(args: Value[]): boolean {
  return args.some(isFloatValue);
}

function numberOut(n: number, float: boolean): Value {
  return float && Number.isInteger(n) ? new Float(n) : n;
}

function floorMod(x: number, y: number, who: string, line: number): number {
  if (y === 0) throw new LispError(`${who}: division by zero`, line, 'arith-error');
  return x - Math.floor(x / y) * y;
}

// ---- list helpers --------------------------------------------------------

function carOf(v: Value, who: string, line: number): Value {
  if (v === nil) return nil;
  if (!(v instanceof Cons)) {
    throw new LispError(`${who}: expected a list, got ${renderWrite(v)}`, line, 'wrong-type-argument');
  }
  return v.car;
}

function cdrOf(v: Value, who: string, line: number): Value {
  if (v === nil) return nil;
  if (!(v instanceof Cons)) {
    throw new LispError(`${who}: expected a list, got ${renderWrite(v)}`, line, 'wrong-type-argument');
  }
  return v.cdr;
}

function nthCdr(v: Value, n: number): Value {
  let cur = v;
  for (let i = 0; i < n && cur instanceof Cons; i++) cur = cur.cdr;
  return cur;
}

function listTail(v: Value, target: Value, who: string, line: number, same: (a: Value, b: Value) => boolean): Value {
  const seen = new Set<Cons>();
  let cur = v;
  while (cur instanceof Cons) {
    if (seen.has(cur)) throw new LispError(`${who}: circular list`, line, 'circular-list');
    seen.add(cur);
    if (same(cur.car, target)) return cur;
    cur = cur.cdr;
  }
  if (cur !== nil) {
    throw new LispError(`${who}: expected a proper list, got ${renderWrite(v)}`, line);
  }
  return nil;
}

function assocTail(v: Value, key: Value, who: string, line: number, same: (a: Value, b: Value) => boolean): Value {
  const seen = new Set<Cons>();
  let cur = v;
  while (cur instanceof Cons) {
    if (seen.has(cur)) throw new LispError(`${who}: circular list`, line, 'circular-list');
    seen.add(cur);
    const entry = cur.car;
    if (!(entry instanceof Cons)) {
      throw new LispError(`${who}: expected an alist entry, got ${renderWrite(entry)}`, line);
    }
    if (same(entry.car, key)) return entry;
    cur = cur.cdr;
  }
  if (cur !== nil) {
    throw new LispError(`${who}: expected a proper list, got ${renderWrite(v)}`, line);
  }
  return nil;
}


function arefValue(v: Value, i: number, line: number): Value {
  if (typeof v === 'string') {
    if (i < 0 || i >= v.length) throw new LispError(`aref: index ${i} out of range`, line, 'args-out-of-range');
    return v.charCodeAt(i);
  }
  if (v instanceof Vec) {
    if (i < 0 || i >= v.items.length) throw new LispError(`aref: index ${i} out of range`, line, 'args-out-of-range');
    return v.items[i]!;
  }
  throw new LispError(`aref: expected a string or vector, got ${renderWrite(v)}`, line, 'wrong-type-argument');
}

// ---- strings -------------------------------------------------------------

function caseTransform(v: Value, who: string, line: number, f: (s: string) => string): Value {
  if (typeof v === 'string') return f(v);
  if (v instanceof Sym) return Sym.intern(f(v.name));
  throw new LispError(`${who}: expected a string or symbol, got ${renderWrite(v)}`, line, 'wrong-type-argument');
}

function capitalizeWords(s: string): string {
  return s.toLowerCase().replace(/(^|[^0-9a-z])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
}

// ---- key sequences -------------------------------------------------------

const NAMED_KEYS: Record<string, string> = {
  ret: 'RET', return: 'RET', tab: 'TAB', esc: 'ESC', escape: 'ESC',
  spc: 'SPC', space: 'SPC', del: 'DEL', delete: 'DEL', bs: 'BS',
  backspace: 'BS', lfd: 'LFD', newline: 'LFD', nul: 'NUL', lf: 'LF', cr: 'CR',
  up: 'up', down: 'down', left: 'left', right: 'right',
  home: 'home', end: 'end', prior: 'prior', next: 'next',
};

const MAX_VECTOR = 1_000_000;
const MAX_STRING = 1_000_000;
const MAX_BUFFER = 1_000_000;
const MAX_KEY_CHARS = 512;
const MAX_BINDINGS = 512;

const MOD_RANK: Record<string, number> = { C: 0, M: 1, S: 2, s: 3, H: 4, A: 5 };

function modifier(part: string): string | null {
  switch (part) {
    case 'C': case 'c': return 'C';
    case 'M': case 'm': return 'M';
    case 'S': return 'S';
    case 's': return 's';
    case 'H': return 'H';
    case 'A': return 'A';
    default: return null;
  }
}

function namedKey(token: string): string | null {
  const known = NAMED_KEYS[token.toLowerCase()];
  if (known !== undefined) return known;
  // Bare function-key names (RET, F1, SPC, …) stay as typed.
  if (token.length > 1 && /^[A-Z][A-Z0-9]*$/.test(token)) return token;
  return null;
}

function expandKeyToken(token: string): string[] {
  const named = namedKey(token);
  if (named !== null) return [named];
  const parts = token.split('-');
  const mods: string[] = [];
  while (parts.length > 1) {
    const m = modifier(parts[0]!);
    if (m === null) break;
    mods.push(m);
    parts.shift();
  }
  const body = parts.join('-');
  if (body === '') return [mods.join('-')];
  const sorted = [...new Set(mods)].sort((a, b) => (MOD_RANK[a] ?? 99) - (MOD_RANK[b] ?? 99));
  const prefix = sorted.map((m) => `${m}-`).join('');
  if (body.length === 1) return [prefix + body];
  const namedBody = namedKey(body);
  if (namedBody !== null) return [prefix + namedBody];
  // A run like "C-ab" is two keys: C-a C-b.
  return [...body].map((ch) => prefix + ch);
}

/** Canonical, space-separated key sequence: "C-x C-f", "RET", "C-c a". */
export function kbdString(text: string): string {
  return text.trim().split(/\s+/).filter(Boolean).flatMap(expandKeyToken).join(' ');
}

function keyCodeText(code: number): string {
  if (code === 0) return 'C-@';
  if (code === 8) return 'BS';
  if (code === 9) return 'TAB';
  if (code === 13) return 'RET';
  if (code === 27) return 'ESC';
  if (code === 32) return 'SPC';
  if (code === 127) return 'DEL';
  if (code >= 1 && code <= 26) return `C-${String.fromCharCode(96 + code)}`;
  return String.fromCharCode(code);
}

function keyText(v: Value, who: string, line: number): string {
  if (typeof v === 'string') {
    if (v.length > MAX_KEY_CHARS) {
      throw new LispError(`${who}: key sequence is too long (max ${MAX_KEY_CHARS} characters)`, line);
    }
    return kbdString(v);
  }
  if (v instanceof Vec) {
    if (v.items.length > MAX_KEY_CHARS) {
      throw new LispError(`${who}: key sequence is too long (max ${MAX_KEY_CHARS} keys)`, line);
    }
    const parts: string[] = [];
    for (const item of v.items) {
      if (typeof item === 'number') parts.push(keyCodeText(item));
      else if (typeof item === 'string') parts.push(item);
      else if (item instanceof Sym) parts.push(/^f\d+$/.test(item.name) ? `<${item.name}>` : item.name);
      else throw new LispError(`${who}: invalid key element ${renderWrite(item)}`, line);
    }
    return kbdString(parts.join(' '));
  }
  if (v instanceof Sym) return v.name;
  throw new LispError(`${who}: expected a key sequence string, got ${renderWrite(v)}`, line);
}

// ---- buffers -------------------------------------------------------------

function insertText(buf: Buffer, text: string): void {
  if (buf.text.length + text.length > MAX_BUFFER) {
    throw new LispError(`buffer text limit exceeded (${MAX_BUFFER} characters)`);
  }
  const at = clampPos(buf, buf.point);
  buf.text = buf.text.slice(0, at - 1) + text + buf.text.slice(at - 1);
  if (buf.narrowStart !== null && buf.narrowEnd !== null &&
      at >= buf.narrowStart && at <= buf.narrowEnd) {
    buf.narrowEnd += text.length;
  }
  buf.point = at + text.length;
  if (buf.mark !== null && buf.mark > at) buf.mark += text.length;
  for (const marker of buf.markers) {
    if (marker.pos !== null && marker.pos > at) marker.pos += text.length;
  }
  buf.modified = true;
}

function charText(v: Value, who: string, line: number): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return String.fromCharCode(v);
  throw new LispError(`${who}: expected a character or string, got ${renderWrite(v)}`, line, 'wrong-type-argument');
}

// ---- the table -----------------------------------------------------------

/** Build the builtin table, install it in the Runtime's global function
 *  cells, and return it. The machine may use either view. */
export function makeBuiltins(runtime: Runtime): Map<string, Value> {
  const defs: [string, number, number, Fn][] = [
    // ---- arithmetic ----
    ['+', 0, Infinity, (a, c) => numberOut(fold(a, '+', c.line, 0, (x, y) => x + y), anyFloat(a))],
    ['-', 1, Infinity, (a, c) => numberOut(a.length === 1
      ? -num(a, 0, '-', c.line)
      : fold(a.slice(1), '-', c.line, num(a, 0, '-', c.line), (x, y) => x - y), anyFloat(a))],
    ['*', 0, Infinity, (a, c) => numberOut(fold(a, '*', c.line, 1, (x, y) => x * y), anyFloat(a))],
    ['/', 1, Infinity, (a, c) => {
      const float = anyFloat(a);
      const result = a.length === 1
        ? divide(1, num(a, 0, '/', c.line), c.line, float)
        : a.slice(1).reduce<number>((acc, _v, i) => divide(acc, num(a, i + 1, '/', c.line), c.line, float),
          num(a, 0, '/', c.line));
      return numberOut(result, float);
    }],
    ['%', 2, 2, (a, c) => {
      const y = int(a, 1, '%', c.line);
      if (y === 0) throw new LispError('%: division by zero', c.line, 'arith-error');
      return int(a, 0, '%', c.line) % y;
    }],
    ['mod', 2, 2, (a, c) => floorMod(int(a, 0, 'mod', c.line), int(a, 1, 'mod', c.line), 'mod', c.line)],
    ['1+', 1, 1, (a, c) => numberOut(num(a, 0, '1+', c.line) + 1, isFloatValue(a[0]!))],
    ['1-', 1, 1, (a, c) => numberOut(num(a, 0, '1-', c.line) - 1, isFloatValue(a[0]!))],
    ['=', 1, Infinity, (a, c) => chain(a, '=', c.line, (x, y) => x === y)],
    ['<', 1, Infinity, (a, c) => chain(a, '<', c.line, (x, y) => x < y)],
    ['>', 1, Infinity, (a, c) => chain(a, '>', c.line, (x, y) => x > y)],
    ['<=', 1, Infinity, (a, c) => chain(a, '<=', c.line, (x, y) => x <= y)],
    ['>=', 1, Infinity, (a, c) => chain(a, '>=', c.line, (x, y) => x >= y)],
    ['max', 1, Infinity, (a, c) => numberOut(Math.max(...a.map((_v, i) => num(a, i, 'max', c.line))), anyFloat(a))],
    ['min', 1, Infinity, (a, c) => numberOut(Math.min(...a.map((_v, i) => num(a, i, 'min', c.line))), anyFloat(a))],
    ['abs', 1, 1, (a, c) => numberOut(Math.abs(num(a, 0, 'abs', c.line)), isFloatValue(a[0]!))],

    // ---- predicates ----
    ['identity', 1, 1, (a) => a[0]!],
    ['eq', 2, 2, (a) => bool(eq(a[0]!, a[1]!))],
    ['eql', 2, 2, (a) => bool(eql(a[0]!, a[1]!))],
    ['equal', 2, 2, (a) => bool(equal(a[0]!, a[1]!))],
    ['null', 1, 1, (a) => bool(a[0] === nil)],
    ['not', 1, 1, (a) => bool(a[0] === nil)],
    ['consp', 1, 1, (a) => bool(a[0] instanceof Cons)],
    ['listp', 1, 1, (a) => bool(a[0] === nil || a[0] instanceof Cons)],
    ['atom', 1, 1, (a) => bool(!(a[0] instanceof Cons))],
    ['symbolp', 1, 1, (a) => bool(a[0] instanceof Sym)],
    ['stringp', 1, 1, (a) => bool(typeof a[0] === 'string')],
    ['numberp', 1, 1, (a) => bool(typeof a[0] === 'number' || a[0] instanceof Float)],
    ['integerp', 1, 1, (a) => bool(typeof a[0] === 'number' && Number.isInteger(a[0]))],
    ['floatp', 1, 1, (a) => bool(a[0] instanceof Float || (typeof a[0] === 'number' && !Number.isInteger(a[0])))],
    ['functionp', 1, 1, (a, c) => bool(isFunction(a[0]!, runtimeOf(c)))],
    ['commandp', 1, 1, (a, c) => bool(isCommand(a[0]!, runtimeOf(c)))],
    ['bufferp', 1, 1, (a) => bool(a[0] instanceof Buffer)],
    ['keymapp', 1, 1, (a) => bool(a[0] instanceof Keymap)],
    ['boundp', 1, 1, (a, c) => bool(runtimeOf(c).dynamicValue(sym(a, 0, 'boundp', c.line)) !== undefined)],
    ['fboundp', 1, 1, (a, c) => bool(runtimeOf(c).getFunction(sym(a, 0, 'fboundp', c.line)) !== undefined)],

    // ---- lists ----
    ['cons', 2, 2, (a) => new Cons(a[0]!, a[1]!)],
    ['car', 1, 1, (a, c) => carOf(a[0]!, 'car', c.line)],
    ['cdr', 1, 1, (a, c) => cdrOf(a[0]!, 'cdr', c.line)],
    ['cadr', 1, 1, (a, c) => carOf(cdrOf(a[0]!, 'cadr', c.line), 'cadr', c.line)],
    ['caddr', 1, 1, (a, c) => carOf(cdrOf(cdrOf(a[0]!, 'caddr', c.line), 'caddr', c.line), 'caddr', c.line)],
    ['cddr', 1, 1, (a, c) => cdrOf(cdrOf(a[0]!, 'cddr', c.line), 'cddr', c.line)],
    ['list', 0, Infinity, (a) => listOf(a)],
    ['append', 0, Infinity, (a, c) => {
      if (a.length === 0) return nil;
      if (a.length === 1) return a[0]!;
      const last = a[a.length - 1]!;
      const copied: Value[] = [];
      for (let i = 0; i + 1 < a.length; i++) {
        const v = a[i]!;
        if (v === nil) continue;
        if (typeof v === 'string') copied.push(...[...v].map((ch) => ch.codePointAt(0)!));
        else if (v instanceof Vec) copied.push(...v.items);
        else copied.push(...items(v, 'append', c.line));
      }
      let out = last;
      for (let i = copied.length - 1; i >= 0; i--) out = new Cons(copied[i]!, out);
      return out;
    }],
    ['length', 1, 1, (a, c) => {
      const v = a[0]!;
      if (typeof v === 'string') return v.length;
      if (v instanceof Vec) return v.items.length;
      if (v === nil) return 0;
      if (v instanceof Cons) {
        const n = listLength(v);
        if (n === 'circular') throw new LispError('length: circular list', c.line, 'circular-list');
        if (n === null) {
          throw new LispError(`length: expected a proper list, got ${renderWrite(v)}`, c.line, 'wrong-type-argument');
        }
        return n;
      }
      throw new LispError(`length: expected a sequence, got ${renderWrite(v)}`, c.line, 'wrong-type-argument');
    }],
    ['nth', 2, 2, (a, c) => {
      const n = Math.max(0, int(a, 0, 'nth', c.line));
      const tail = nthCdr(a[1]!, n);
      return tail instanceof Cons ? tail.car : nil;
    }],
    ['nthcdr', 2, 2, (a, c) => nthCdr(a[1]!, Math.max(0, int(a, 0, 'nthcdr', c.line)))],
    ['reverse', 1, 1, (a, c) => {
      const v = a[0]!;
      if (typeof v === 'string') return [...v].reverse().join('');
      if (v instanceof Vec) return new Vec([...v.items].reverse());
      const xs = items(v, 'reverse', c.line);
      let out: Value = nil;
      for (const x of xs) out = new Cons(x, out);
      return out;
    }],
    ['last', 1, 2, (a, c) => {
      const xs = items(a[0]!, 'last', c.line);
      const n = a.length > 1 ? Math.max(0, int(a, 1, 'last', c.line)) : 1;
      let out: Value = nil;
      for (let i = xs.length - 1; i >= 0 && i >= xs.length - n; i--) out = new Cons(xs[i]!, out);
      return out;
    }],
    ['plist-get', 2, 3, (a, c) => {
      const seen = new Set<Cons>();
      let cur: Value = a[0]!;
      while (cur instanceof Cons) {
        if (seen.has(cur)) throw new LispError('plist-get: circular list', c.line, 'circular-list');
        seen.add(cur);
        if (eq(cur.car, a[1]!)) return cur.cdr instanceof Cons ? cur.cdr.car : nil;
        cur = cur.cdr;
        if (cur instanceof Cons) cur = cur.cdr;
      }
      return a[2] ?? nil;
    }],
    ['plist-put', 3, 3, (a, c) => {
      const prop = a[1]!;
      const value = a[2]!;
      if (a[0] === nil) return listOf([prop, value]);
      const seen = new Set<Cons>();
      let cur: Value = a[0]!;
      let last: Cons | null = null;
      while (cur instanceof Cons) {
        if (seen.has(cur)) throw new LispError('plist-put: circular list', c.line, 'circular-list');
        seen.add(cur);
        if (eq(cur.car, prop)) {
          cur.cdr = new Cons(value, cur.cdr instanceof Cons ? cur.cdr.cdr : nil);
          return a[0]!;
        }
        last = cur;
        cur = cur.cdr;
        if (cur instanceof Cons) {
          last = cur;
          cur = cur.cdr;
        }
      }
      if (last !== null) last.cdr = listOf([prop, value]);
      return a[0]!;
    }],
    ['member', 2, 2, (a, c) => listTail(a[1]!, a[0]!, 'member', c.line, equal)],
    ['memq', 2, 2, (a, c) => listTail(a[1]!, a[0]!, 'memq', c.line, eq)],
    ['assoc', 2, 2, (a, c) => assocTail(a[1]!, a[0]!, 'assoc', c.line, equal)],
    ['assq', 2, 2, (a, c) => assocTail(a[1]!, a[0]!, 'assq', c.line, eq)],
    ['nreverse', 1, 1, (a, c) => {
      if (typeof a[0] === 'string') return [...a[0]].reverse().join('');
      if (a[0] instanceof Vec) {
        a[0].items.reverse();
        return a[0];
      }
      const len = listLength(a[0]!);
      if (len === 'circular') throw new LispError('nreverse: circular list', c.line, 'circular-list');
      if (len === null) {
        throw new LispError(`nreverse: expected a proper list, got ${renderWrite(a[0]!)}`, c.line, 'wrong-type-argument');
      }
      let prev: Value = nil;
      let cur: Value = a[0]!;
      while (cur instanceof Cons) {
        const next: Value = cur.cdr;
        cur.cdr = prev;
        prev = cur;
        cur = next;
      }
      return prev;
    }],
    ['setcar', 2, 2, (a, c) => { const cell = cons(a, 0, 'setcar', c.line); cell.car = a[1]!; return a[1]!; }],
    ['setcdr', 2, 2, (a, c) => { const cell = cons(a, 0, 'setcdr', c.line); cell.cdr = a[1]!; return a[1]!; }],
    ['rplaca', 2, 2, (a, c) => { const cell = cons(a, 0, 'rplaca', c.line); cell.car = a[1]!; return cell; }],
    ['rplacd', 2, 2, (a, c) => { const cell = cons(a, 0, 'rplacd', c.line); cell.cdr = a[1]!; return cell; }],

    // ---- strings and symbols ----
    ['concat', 0, Infinity, (a, c) => {
      let out = '';
      for (const v of a) {
        if (v === nil) continue;
        if (typeof v === 'string') {
          out += v;
          if (out.length > MAX_STRING) {
            throw new LispError(`concat: string limit exceeded (${MAX_STRING} characters)`, c.line);
          }
          continue;
        }
        if (v instanceof Vec) {
          for (const ch of v.items) {
            out += charText(ch, 'concat', c.line);
            if (out.length > MAX_STRING) {
              throw new LispError(`concat: string limit exceeded (${MAX_STRING} characters)`, c.line);
            }
          }
          continue;
        }
        if (v instanceof Cons) {
          for (const ch of items(v, 'concat', c.line)) {
            out += charText(ch, 'concat', c.line);
            if (out.length > MAX_STRING) {
              throw new LispError(`concat: string limit exceeded (${MAX_STRING} characters)`, c.line);
            }
          }
          continue;
        }
        throw new LispError(`concat: expected a sequence, got ${renderWrite(v)}`, c.line, 'wrong-type-argument');
      }
      if (out.length > MAX_STRING) {
        throw new LispError(`concat: string limit exceeded (${MAX_STRING} characters)`, c.line);
      }
      runtimeOf(c).chargeString(out.length);
      return out;
    }],
    ['substring-no-properties', 1, 3, (a, c) => {
      const s = str(a, 0, 'substring-no-properties', c.line);
      let start = a.length > 1 ? int(a, 1, 'substring-no-properties', c.line) : 0;
      let end = a.length > 2 ? int(a, 2, 'substring-no-properties', c.line) : s.length;
      if (start < 0) start = Math.max(0, s.length + start);
      if (end < 0) end = Math.max(0, s.length + end);
      const out = s.slice(Math.min(start, s.length), Math.min(end, s.length));
      runtimeOf(c).chargeString(out.length);
      return out;
    }],
    ['propertize', 1, Infinity, (a, c) => {
      const text = str(a, 0, 'propertize', c.line);
      if ((a.length - 1) % 2 !== 0) {
        throw new LispError('propertize: expected property/value pairs', c.line, 'wrong-number-of-arguments');
      }
      const props = new Map<string, Value>();
      for (let i = 1; i < a.length; i += 2) {
        props.set(sym(a, i, 'propertize', c.line).name, a[i + 1]!);
      }
      runtimeOf(c).textProperties.set(text, props);
      return text;
    }],
    ['get-text-property', 2, 3, (a, c) => {
      const rt = runtimeOf(c);
      const pos = int(a, 0, 'get-text-property', c.line);
      const prop = sym(a, 1, 'get-text-property', c.line).name;
      if (a.length > 2 && typeof a[2] === 'string') {
        return rt.textProperties.get(a[2])?.get(prop) ?? nil;
      }
      const buf = a.length > 2 ? asBuffer(a[2], rt, 'get-text-property', c.line) : rt.current;
      for (const run of buf.textProps) {
        if (pos >= run.start && pos < run.end) return run.props.get(prop) ?? nil;
      }
      return nil;
    }],
    ['substring', 2, 3, (a, c) => {
      const s = str(a, 0, 'substring', c.line);
      let start = int(a, 1, 'substring', c.line);
      let end = a.length > 2 ? int(a, 2, 'substring', c.line) : s.length;
      if (start < 0) start = Math.max(0, s.length + start);
      if (end < 0) end = Math.max(0, s.length + end);
      start = Math.min(start, s.length);
      end = Math.min(end, s.length);
      const out = start >= end ? '' : s.slice(start, end);
      runtimeOf(c).chargeString(out.length);
      return out;
    }],
    ['string-to-number', 1, 1, (a, c) => {
      const src = str(a, 0, 'string-to-number', c.line);
      const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src);
      if (m === null) return 0;
      const n = parseFloat(m[1]!);
      return /[.eE]/.test(m[1]!) && Number.isInteger(n) ? new Float(n) : n;
    }],
    ['number-to-string', 1, 1, (a, c) => {
      const v = a[0];
      if (v instanceof Float) return Number.isInteger(v.value) ? v.value.toFixed(1) : String(v.value);
      return String(num(a, 0, 'number-to-string', c.line));
    }],
    ['format', 1, Infinity, (a, c) => {
      const out = formatText(str(a, 0, 'format', c.line), a.slice(1), 'format', c.line);
      runtimeOf(c).chargeString(out.length);
      return out;
    }],
    ['upcase', 1, 1, (a, c) => {
      const out = caseTransform(a[0]!, 'upcase', c.line, (s) => s.toUpperCase());
      if (typeof out === 'string') runtimeOf(c).chargeString(out.length);
      return out;
    }],
    ['downcase', 1, 1, (a, c) => {
      const out = caseTransform(a[0]!, 'downcase', c.line, (s) => s.toLowerCase());
      if (typeof out === 'string') runtimeOf(c).chargeString(out.length);
      return out;
    }],
    ['capitalize', 1, 1, (a, c) => {
      const out = caseTransform(a[0]!, 'capitalize', c.line, capitalizeWords);
      if (typeof out === 'string') runtimeOf(c).chargeString(out.length);
      return out;
    }],
    ['string=', 2, Infinity, (a, c) => chainStr(a, 'string=', c.line, (x, y) => x === y)],
    ['string<', 2, Infinity, (a, c) => chainStr(a, 'string<', c.line, (x, y) => x < y)],
    ['string>', 2, Infinity, (a, c) => chainStr(a, 'string>', c.line, (x, y) => x > y)],
    ['intern', 1, 1, (a, c) => {
      const v = a[0]!;
      if (v instanceof Sym) return v;
      return Sym.intern(str(a, 0, 'intern', c.line));
    }],
    ['symbol-name', 1, 1, (a, c) => sym(a, 0, 'symbol-name', c.line).name],
    ['make-symbol', 1, 1, (a, c) => {
      const name = str(a, 0, 'make-symbol', c.line);
      if (name.length > 512) throw new LispError('make-symbol: name is too long (max 512 characters)', c.line);
      return new (Sym as unknown as new (n: string) => Sym)(name);
    }],
    ['symbol-value', 1, 1, (a, c) => {
      const s = sym(a, 0, 'symbol-value', c.line);
      const v = runtimeOf(c).dynamicValue(s);
      if (v === undefined) {
        throw new LispError(`symbol-value: ${s.name} is void`, c.line, 'void-variable');
      }
      return v;
    }],
    ['set', 2, 2, (a, c) => runtimeOf(c).setDynamicValue(sym(a, 0, 'set', c.line), a[1]!)],
    ['fset', 2, 2, (a, c) => runtimeOf(c).setFunction(sym(a, 0, 'fset', c.line), a[1]!)],
    ['symbol-function', 1, 1, (a, c) => {
      const s = sym(a, 0, 'symbol-function', c.line);
      const v = runtimeOf(c).getFunction(s);
      if (v === undefined) {
        throw new LispError(`symbol-function: ${s.name} is void`, c.line, 'void-function');
      }
      return v;
    }],
    ['aref', 2, 2, (a, c) => arefValue(a[0]!, int(a, 1, 'aref', c.line), c.line)],
    ['vector', 0, Infinity, (a, c) => {
      runtimeOf(c).chargeVector(a.length);
      return new Vec([...a]);
    }],
    ['make-hash-table', 0, Infinity, (a) => {
      let test = 'equal';
      for (let i = 0; i + 1 < a.length; i += 2) {
        const key = a[i];
        const value = a[i + 1];
        if (key instanceof Sym && key.name === ':test' && value instanceof Sym) {
          test = value.name;
        }
      }
      return new HashTable(test);
    }],
    ['hash-table-p', 1, 1, (a) => bool(a[0] instanceof HashTable)],
    ['puthash', 3, 3, (a, c) => {
      const table = a[2];
      if (!(table instanceof HashTable)) throw new LispError('puthash: expected a hash table', c.line, 'wrong-type-argument');
      table.table.set(a[0]!, a[1]!);
      return a[1]!;
    }],
    ['gethash', 2, 3, (a, c) => {
      const table = a[1];
      if (!(table instanceof HashTable)) throw new LispError('gethash: expected a hash table', c.line, 'wrong-type-argument');
      return table.table.get(a[0]!) ?? (a[2] ?? nil);
    }],
    ['remhash', 2, 2, (a, c) => {
      const table = a[1];
      if (!(table instanceof HashTable)) throw new LispError('remhash: expected a hash table', c.line, 'wrong-type-argument');
      table.table.delete(a[0]!);
      return nil;
    }],
    ['clrhash', 1, 1, (a, c) => {
      if (!(a[0] instanceof HashTable)) throw new LispError('clrhash: expected a hash table', c.line, 'wrong-type-argument');
      a[0].table.clear();
      return a[0];
    }],
    ['hash-table-count', 1, 1, (a, c) => {
      if (!(a[0] instanceof HashTable)) throw new LispError('hash-table-count: expected a hash table', c.line, 'wrong-type-argument');
      return a[0].table.size;
    }],
    ['make-vector', 1, 2, (a, c) => {
      const n = int(a, 0, 'make-vector', c.line);
      if (n < 0) throw new LispError(`make-vector: negative size ${n}`, c.line, 'error');
      if (n > MAX_VECTOR) {
        throw new LispError(`make-vector: size ${n} exceeds the ${MAX_VECTOR} element limit`, c.line, 'error');
      }
      runtimeOf(c).chargeVector(n);
      return new Vec(new Array(Math.max(0, n)).fill(a.length > 1 ? a[1]! : nil));
    }],

    ['require', 1, 3, (a, c) => {
      const feature = sym(a, 0, 'require', c.line);
      const rt = runtimeOf(c);
      if (rt.features.has(feature.name)) return feature;
      if (a.length > 2 && truthy(a[2]!)) return nil;
      throw new LispError(`require: cannot open load file: ${feature.name}`, c.line, 'file-missing');
    }],
    ['provide', 1, 1, (a, c) => {
      const feature = sym(a, 0, 'provide', c.line);
      runtimeOf(c).features.add(feature.name);
      return feature;
    }],
    ['featurep', 1, 1, (a, c) => bool(runtimeOf(c).features.has(sym(a, 0, 'featurep', c.line).name))],

    // ---- output and errors ----
    ['princ', 1, 2, (a, c) => {
      writeOut(renderDisplay(a[0]!), a[1], c, 'princ');
      return a[0]!;
    }],
    ['prin1', 1, 2, (a, c) => {
      writeOut(renderWrite(a[0]!), a[1], c, 'prin1');
      return a[0]!;
    }],
    ['print', 1, 2, (a, c) => {
      writeOut(`${renderWrite(a[0]!)}\n`, a[1], c, 'print');
      return a[0]!;
    }],
    ['terpri', 0, 1, (a, c) => { writeOut('\n', a[0], c, 'terpri'); return nil; }],
    ['message', 1, Infinity, (a, c) => {
      const text = typeof a[0] === 'string'
        ? formatText(a[0], a.slice(1), 'message', c.line)
        : a.map(renderDisplay).join(' ');
      runtimeOf(c).emit(`${text}\n`);
      return text;
    }],
    ['error', 1, Infinity, (a, c) => {
      const text = typeof a[0] === 'string'
        ? formatText(a[0], a.slice(1), 'error', c.line)
        : a.map(renderDisplay).join(' ');
      throw new LispError(text, c.line, 'error');
    }],
    ['user-error', 1, Infinity, (a, c) => {
      const text = typeof a[0] === 'string'
        ? formatText(a[0], a.slice(1), 'user-error', c.line)
        : a.map(renderDisplay).join(' ');
      throw new LispError(text, c.line, 'user-error');
    }],
    ['signal', 2, 2, (a, c) => {
      const condition = sym(a, 0, 'signal', c.line);
      const data = a[1]!;
      const message = data === nil ? condition.name : `${condition.name}: ${renderDisplay(data)}`;
      throw new LispError(message, c.line, condition.name);
    }],

    // ---- buffers ----
    ['current-buffer', 0, 0, (_a, c) => runtimeOf(c).current],
    ['set-buffer', 1, 1, (a, c) => {
      const rt = runtimeOf(c);
      const buf = asBuffer(a[0], rt, 'set-buffer', c.line);
      rt.setCurrent(buf);
      return buf;
    }],
    ['get-buffer', 1, 1, (a, c) => {
      const rt = runtimeOf(c);
      const name = typeof a[0] === 'string' ? a[0] : a[0] instanceof Buffer ? a[0].name : null;
      if (name === null) throw new LispError(`get-buffer: expected a string, got ${renderWrite(a[0]!)}`, c.line);
      return rt.getBuffer(name) ?? nil;
    }],
    ['get-buffer-create', 1, 1, (a, c) => {
      const rt = runtimeOf(c);
      if (a[0] instanceof Buffer) return a[0];
      return rt.createBuffer(str(a, 0, 'get-buffer-create', c.line));
    }],
    ['generate-new-buffer', 1, 1, (a, c) => runtimeOf(c).generateNewBuffer(str(a, 0, 'generate-new-buffer', c.line))],
    ['kill-buffer', 0, 1, (a, c) => {
      const rt = runtimeOf(c);
      const target = a.length === 0 ? rt.current : asBuffer(a[0], rt, 'kill-buffer', c.line);
      rt.killBuffer(target);
      return nil;
    }],
    ['buffer-name', 0, 1, (a, c) => optionalBuffer(a, runtimeOf(c), 'buffer-name', c.line).name],
    ['buffer-string', 0, 0, (_a, c) => {
      const out = runtimeOf(c).current.accessibleText();
      runtimeOf(c).chargeString(out.length);
      return out;
    }],
    ['buffer-substring-no-properties', 2, 2, (a, c) => {
      const buf = runtimeOf(c).current;
      let start = clampPos(buf, int(a, 0, 'buffer-substring-no-properties', c.line));
      let end = clampPos(buf, int(a, 1, 'buffer-substring-no-properties', c.line));
      if (start > end) [start, end] = [end, start];
      return buf.text.slice(start - 1, end - 1);
    }],
    ['line-beginning-position', 0, 1, (a, c) => {
      const buf = runtimeOf(c).current;
      const saved = buf.point;
      const n = a.length === 0 ? 1 : int(a, 0, 'line-beginning-position', c.line);
      if (n !== 1) forwardLine(buf, n - 1);
      const pos = lineStart(buf.text, buf.point);
      buf.point = saved;
      return pos;
    }],
    ['line-end-position', 0, 1, (a, c) => {
      const buf = runtimeOf(c).current;
      const saved = buf.point;
      const n = a.length === 0 ? 1 : int(a, 0, 'line-end-position', c.line);
      if (n !== 1) forwardLine(buf, n - 1);
      const i = buf.text.indexOf('\n', buf.point - 1);
      const pos = i < 0 ? buf.text.length + 1 : i + 1;
      buf.point = saved;
      return pos;
    }],
    ['buffer-substring', 2, 2, (a, c) => {
      const buf = runtimeOf(c).current;
      let start = clampPos(buf, int(a, 0, 'buffer-substring', c.line));
      let end = clampPos(buf, int(a, 1, 'buffer-substring', c.line));
      if (start > end) [start, end] = [end, start];
      const out = buf.text.slice(start - 1, end - 1);
      runtimeOf(c).chargeString(out.length);
      return out;
    }],
    ['point', 0, 0, (_a, c) => runtimeOf(c).current.point],
    ['point-min', 0, 0, (_a, c) => runtimeOf(c).current.pointMin],
    ['point-max', 0, 0, (_a, c) => runtimeOf(c).current.pointMax],
    ['goto-char', 1, 1, (a, c) => {
      const buf = runtimeOf(c).current;
      const requested = int(a, 0, 'goto-char', c.line);
      buf.point = clampPos(buf, requested);
      return requested;
    }],
    ['insert', 0, Infinity, (a, c) => {
      const rt = runtimeOf(c);
      const buf = rt.current;
      for (const v of a) {
        const start = buf.point;
        const text = charText(v, 'insert', c.line);
        insertText(buf, text);
        if (typeof v === 'string') {
          const props = rt.textProperties.get(v);
          if (props !== undefined) buf.textProps.push({ start, end: start + text.length, props });
        }
      }
      return nil;
    }],
    ['narrow-to-region', 2, 2, (a, c) => {
      const buf = runtimeOf(c).current;
      const start = Math.max(buf.pointMin, Math.min(buf.pointMax, int(a, 0, 'narrow-to-region', c.line)));
      const end = Math.max(buf.pointMin, Math.min(buf.pointMax, int(a, 1, 'narrow-to-region', c.line)));
      if (start > end) throw new LispError('narrow-to-region: start is after end', c.line, 'args-out-of-range');
      buf.narrowStart = start;
      buf.narrowEnd = end;
      buf.clampPoint();
      return nil;
    }],
    ['widen', 0, 0, (_a, c) => {
      const buf = runtimeOf(c).current;
      buf.narrowStart = null;
      buf.narrowEnd = null;
      return nil;
    }],
    ['search-forward', 1, 3, (a, c) => searchForward(a, c, false)],
    ['re-search-forward', 1, 3, (a, c) => searchForward(a, c, true)],
    ['match-beginning', 1, 1, (a, c) => matchEdge(a, c, 'beginning')],
    ['match-end', 1, 1, (a, c) => matchEdge(a, c, 'end')],
    ['match-string', 1, 2, (a, c) => matchString(a, c, false)],
    ['match-string-no-properties', 1, 2, (a, c) => matchString(a, c, false)],
    ['delete-region', 2, 2, (a, c) => {
      const buf = runtimeOf(c).current;
      let start = clampPos(buf, int(a, 0, 'delete-region', c.line));
      let end = clampPos(buf, int(a, 1, 'delete-region', c.line));
      if (start > end) [start, end] = [end, start];
      const count = end - start;
      if (count === 0) return nil;
      buf.text = buf.text.slice(0, start - 1) + buf.text.slice(end - 1);
      if (buf.narrowStart !== null && buf.narrowEnd !== null) {
        const map = (p: number): number => p > end ? p - count : p >= start ? start : p;
        buf.narrowStart = map(buf.narrowStart);
        buf.narrowEnd = map(buf.narrowEnd);
      }
      if (buf.point > end) buf.point -= count;
      else if (buf.point > start) buf.point = start;
      if (buf.mark !== null) {
        if (buf.mark > end) buf.mark -= count;
        else if (buf.mark > start) buf.mark = start;
      }
      for (const marker of buf.markers) {
        if (marker.pos === null) continue;
        if (marker.pos > end) marker.pos -= count;
        else if (marker.pos >= start) marker.pos = start;
      }
      buf.modified = true;
      return nil;
    }],
    ['erase-buffer', 0, 0, (_a, c) => {
      const buf = runtimeOf(c).current;
      buf.text = '';
      buf.narrowStart = null;
      buf.narrowEnd = null;
      buf.point = 1;
      if (buf.mark !== null) buf.mark = 1;
      for (const marker of buf.markers) marker.pos = 1;
      buf.modified = true;
      return nil;
    }],
    ['bolp', 0, 0, (_a, c) => {
      const buf = runtimeOf(c).current;
      return bool(buf.point <= 1 || buf.text[buf.point - 2] === '\n');
    }],
    ['eolp', 0, 0, (_a, c) => {
      const buf = runtimeOf(c).current;
      return bool(buf.point > buf.length || buf.text[buf.point - 1] === '\n');
    }],
    ['beginning-of-line', 0, 1, (a, c) => {
      const buf = runtimeOf(c).current;
      const n = a.length === 0 ? 1 : int(a, 0, 'beginning-of-line', c.line);
      if (n !== 1) forwardLine(buf, n - 1);
      buf.point = lineStart(buf.text, buf.point);
      return nil;
    }],
    ['end-of-line', 0, 1, (a, c) => {
      const buf = runtimeOf(c).current;
      const n = a.length === 0 ? 1 : int(a, 0, 'end-of-line', c.line);
      if (n !== 1) forwardLine(buf, n - 1);
      buf.point = lineEnd(buf.text, buf.point);
      return nil;
    }],
    ['forward-line', 0, 1, (a, c) => {
      const buf = runtimeOf(c).current;
      return forwardLine(buf, a.length === 0 ? 1 : int(a, 0, 'forward-line', c.line));
    }],
    ['forward-char', 0, 1, (a, c) => {
      const buf = runtimeOf(c).current;
      const n = a.length === 0 ? 1 : int(a, 0, 'forward-char', c.line);
      buf.point = clampPos(buf, buf.point + n);
      return nil;
    }],
    ['buffer-modified-p', 0, 1, (a, c) => bool(optionalBuffer(a, runtimeOf(c), 'buffer-modified-p', c.line).modified)],
    ['set-buffer-modified-p', 1, 2, (a, c) => {
      const rt = runtimeOf(c);
      const buf = a.length > 1 ? asBuffer(a[1], rt, 'set-buffer-modified-p', c.line) : rt.current;
      buf.modified = truthy(a[0]!);
      return a[0]!;
    }],
    ['buffer-size', 0, 1, (a, c) => optionalBuffer(a, runtimeOf(c), 'buffer-size', c.line).length],
    ['make-local-variable', 1, 1, (a, c) => {
      const rt = runtimeOf(c);
      const s = sym(a, 0, 'make-local-variable', c.line);
      rt.makeLocalVariable(rt.current, s.name);
      return s;
    }],
    ['make-variable-buffer-local', 1, 1, (a, c) => {
      const s = sym(a, 0, 'make-variable-buffer-local', c.line);
      runtimeOf(c).makeVariableBufferLocal(s.name);
      return s;
    }],
    ['setq-local', 2, 2, (a, c) => {
      const rt = runtimeOf(c);
      const s = sym(a, 0, 'setq-local', c.line);
      return rt.setLocalVariable(rt.current, s.name, a[1]!);
    }],
    ['buffer-local-value', 2, 2, (a, c) => {
      const rt = runtimeOf(c);
      const s = sym(a, 0, 'buffer-local-value', c.line);
      const buf = asBuffer(a[1], rt, 'buffer-local-value', c.line);
      const local = rt.localVariable(buf, s.name);
      if (local !== undefined) return local;
      const global = rt.globalValues.get(s.name);
      if (global !== undefined) return global;
      throw new LispError(`buffer-local-value: ${s.name} is void`, c.line, 'void-variable');
    }],
    ['kill-local-variable', 1, 1, (a, c) => {
      const rt = runtimeOf(c);
      const s = sym(a, 0, 'kill-local-variable', c.line);
      rt.killLocalVariable(rt.current, s.name);
      return s;
    }],

    // ---- hooks ----
    ['add-hook', 2, 4, (a, c) => {
      const hook = sym(a, 0, 'add-hook', c.line);
      const fn = a[1]!;
      const local = hookLocal(a);
      const rt = runtimeOf(c);
      const state = hookState(rt, hook, local, c.line);
      if (!state.fns.some((f) => equal(f, fn))) {
        if (state.fns.length >= 512) {
          throw new LispError('add-hook: too many functions on hook (max 512)', c.line, 'error');
        }
        state.fns.unshift(fn);
      }
      state.commit(state.fns);
      return nil;
    }],
    ['remove-hook', 2, 3, (a, c) => {
      const hook = sym(a, 0, 'remove-hook', c.line);
      const fn = a[1]!;
      const local = hookLocal(a);
      const rt = runtimeOf(c);
      if (local && rt.localVariable(rt.current, hook.name) === undefined) return nil;
      const state = hookState(rt, hook, local, c.line);
      state.commit(state.fns.filter((f) => !equal(f, fn)));
      return nil;
    }],

    // ---- keymaps ----
    ['make-sparse-keymap', 0, 0, (_a, c) => runtimeOf(c).newKeymap()],
    ['define-key', 3, 3, (a, c) => {
      const map = a[0];
      if (!(map instanceof Keymap)) {
        throw new LispError(`define-key: expected a keymap, got ${renderWrite(map ?? nil)}`, c.line);
      }
      const key = keyText(a[1]!, 'define-key', c.line);
      const def = a[2]!;
      if (map.prefixes.has(key) && !(def instanceof Keymap)) {
        throw new LispError(`define-key: ${key} starts with non-prefix key`, c.line, 'error');
      }
      const parts = key.split(' ');
      for (let i = 1; i < parts.length; i++) {
        const prefix = parts.slice(0, i).join(' ');
        const value = map.bindings.get(prefix);
        if (value !== undefined && !(value instanceof Keymap)) {
          throw new LispError(`define-key: ${key} starts with non-prefix key ${prefix}`, c.line, 'error');
        }
      }
      if (def === nil) {
        map.bindings.delete(key);
        map.children.delete(key);
        map.prefixes.clear();
        for (const existing of map.bindings.keys()) {
          const ks = existing.split(' ');
          for (let i = 1; i < ks.length; i++) map.prefixes.add(ks.slice(0, i).join(' '));
        }
        return nil;
      }
      if (map.bindings.size >= MAX_BINDINGS && !map.bindings.has(key)) {
        throw new LispError(`define-key: keymap limit exceeded (${MAX_BINDINGS} bindings)`, c.line, 'error');
      }
      map.bindings.set(key, def);
      for (let i = 1; i < parts.length; i++) map.prefixes.add(parts.slice(0, i).join(' '));
      return def;
    }],
    ['lookup-key', 2, 3, (a, c) => {
      if (!(a[0] instanceof Keymap)) {
        throw new LispError(`lookup-key: expected a keymap, got ${renderWrite(a[0] ?? nil)}`, c.line);
      }
      return lookup(a[0], keyText(a[1]!, 'lookup-key', c.line));
    }],
    ['kbd', 1, 1, (a, c) => keyText(a[0]!, 'kbd', c.line)],
    ['current-local-map', 0, 0, (_a, c) => runtimeOf(c).localMap(runtimeOf(c).current)],
    ['use-local-map', 1, 1, (a, c) => {
      const rt = runtimeOf(c);
      const map = a[0]!;
      if (map === nil) rt.setLocalMap(null);
      else if (map instanceof Keymap) rt.setLocalMap(map);
      else throw new LispError(`use-local-map: expected a keymap, got ${renderWrite(map)}`, c.line);
      return nil;
    }],

    // ---- predicates and buffer positions added for the teaching surface ----
    ['keywordp', 1, 1, (a) => bool(a[0] instanceof Sym && a[0].name.startsWith(':'))],
    ['vectorp', 1, 1, (a) => bool(a[0] instanceof Vec)],
    ['char-to-string', 1, 1, (a, c) => {
      const code = int(a, 0, 'char-to-string', c.line);
      if (code < 0 || code > 0x10ffff) {
        throw new LispError(`char-to-string: invalid character ${code}`, c.line, 'wrong-type-argument');
      }
      return String.fromCodePoint(code);
    }],
    ['string-to-char', 1, 1, (a, c) => {
      const s = str(a, 0, 'string-to-char', c.line);
      return s.length === 0 ? 0 : s.codePointAt(0)!;
    }],
    ['mark', 0, 0, (_a, c) => {
      const m = runtimeOf(c).current.mark;
      return m === null ? nil : m;
    }],
    ['point-marker', 0, 0, (_a, c) => {
      const buf = runtimeOf(c).current;
      const marker = new Marker(buf, buf.point);
      buf.markers.add(marker);
      return marker;
    }],
    ['markerp', 1, 1, (a) => bool(a[0] instanceof Marker)],
    ['marker-position', 1, 1, (a, c) => {
      const marker = a[0];
      if (!(marker instanceof Marker)) {
        throw new LispError('marker-position: expected a marker', c.line, 'wrong-type-argument');
      }
      return marker.pos === null ? nil : marker.pos;
    }],
    ['set-marker', 2, 3, (a, c) => {
      const marker = a[0];
      if (!(marker instanceof Marker)) {
        throw new LispError('set-marker: expected a marker', c.line, 'wrong-type-argument');
      }
      marker.pos = a[1] === nil ? null : clampPos(marker.buffer, int(a, 1, 'set-marker', c.line));
      return marker;
    }],
    ['make-overlay', 2, 3, (a, c) => {
      const rt = runtimeOf(c);
      const buf = a.length > 2 ? asBuffer(a[2], rt, 'make-overlay', c.line) : rt.current;
      const start = clampPos(buf, int(a, 0, 'make-overlay', c.line));
      const end = clampPos(buf, int(a, 1, 'make-overlay', c.line));
      return new Overlay(buf, Math.min(start, end), Math.max(start, end));
    }],
    ['overlayp', 1, 1, (a) => bool(a[0] instanceof Overlay)],
    ['overlay-put', 3, 3, (a, c) => {
      const ov = a[0];
      if (!(ov instanceof Overlay)) throw new LispError('overlay-put: expected an overlay', c.line, 'wrong-type-argument');
      ov.props.set(sym(a, 1, 'overlay-put', c.line).name, a[2]!);
      return a[2]!;
    }],
    ['overlay-get', 2, 2, (a, c) => {
      const ov = a[0];
      if (!(ov instanceof Overlay)) throw new LispError('overlay-get: expected an overlay', c.line, 'wrong-type-argument');
      return ov.deleted ? nil : ov.props.get(sym(a, 1, 'overlay-get', c.line).name) ?? nil;
    }],
    ['delete-overlay', 1, 1, (a, c) => {
      const ov = a[0];
      if (!(ov instanceof Overlay)) throw new LispError('delete-overlay: expected an overlay', c.line, 'wrong-type-argument');
      ov.deleted = true;
      return nil;
    }],
    ['set-mark', 1, 1, (a, c) => {
      const buf = runtimeOf(c).current;
      buf.mark = clampPos(buf, int(a, 0, 'set-mark', c.line));
      return buf.mark;
    }],
    ['char-after', 0, 1, (a, c) => {
      const buf = runtimeOf(c).current;
      const pos = a.length === 0 ? buf.point
        : a[0] instanceof Marker ? (a[0].pos ?? 0)
          : int(a, 0, 'char-after', c.line);
      if (pos < 1 || pos > buf.length + 1) {
        throw new LispError(`char-after: position ${pos} out of range`, c.line, 'args-out-of-range');
      }
      return pos >= buf.length + 1 ? nil : buf.text.codePointAt(pos - 1)!;
    }],
    ['char-before', 0, 1, (a, c) => {
      const buf = runtimeOf(c).current;
      const pos = a.length === 0 ? buf.point
        : a[0] instanceof Marker ? (a[0].pos ?? 0)
          : int(a, 0, 'char-before', c.line);
      if (pos < 1 || pos > buf.length + 1) {
        throw new LispError(`char-before: position ${pos} out of range`, c.line, 'args-out-of-range');
      }
      return pos <= 1 ? nil : buf.text.codePointAt(pos - 2)!;
    }],
    ['default-value', 1, 1, (a, c) => {
      const s = sym(a, 0, 'default-value', c.line);
      if (s.name.startsWith(':')) return s;
      const v = runtimeOf(c).globalValues.get(s.name);
      if (v === undefined) throw new LispError(`void-variable ${s.name}`, c.line, 'void-variable');
      return v;
    }],
  ];

  const table = new Map<string, Value>();
  for (const [name, minArity, maxArity, fn] of defs) {
    const builtin = new Builtin(name, minArity, maxArity, fn);
    table.set(name, builtin);
    runtime.globalFunctions.set(name, builtin);
  }
  return table;
}

// ---- small shared helpers used by the table ------------------------------

function chainStr(a: Value[], who: string, line: number, ok: (x: string, y: string) => boolean): Value {
  for (let i = 0; i + 1 < a.length; i++) {
    if (!ok(str(a, i, who, line), str(a, i + 1, who, line))) return nil;
  }
  return t;
}

function lookup(map: Keymap, key: string): Value {
  let cur: Keymap | null = map;
  while (cur !== null) {
    const found = cur.bindings.get(key);
    if (found !== undefined) return found;
    for (const [k, v] of cur.bindings) {
      if (v instanceof Keymap && key.startsWith(`${k} `)) {
        return lookup(v, key.slice(k.length + 1));
      }
    }
    const cached = cur.children.get(key);
    if (cached !== undefined) return cached;
    for (const [prefix, child] of cur.children) {
      if (key.startsWith(`${prefix} `)) return lookup(child, key.slice(prefix.length + 1));
    }
    const prefix = key + ' ';
    const child = new Keymap(`${cur.name} ${key}`, cur);
    for (const [k, v] of cur.bindings) {
      if (k.startsWith(prefix)) child.bindings.set(k.slice(prefix.length), v);
    }
    if (child.bindings.size > 0) {
      cur.children.set(key, child);
      return child;
    }
    cur = cur.parent;
  }
  return nil;
}

function isFunction(v: Value, rt: Runtime): boolean {
  if (v instanceof Closure || v instanceof Builtin || v instanceof Macro) return true;
  if (v instanceof Sym) return rt.getFunction(v) !== undefined;
  return false;
}

function isCommand(v: Value, rt: Runtime): boolean {
  if (v instanceof Closure) return v.command;
  if (v instanceof Sym) {
    const fn = rt.getFunction(v);
    return fn instanceof Closure && fn.command;
  }
  return false;
}

/** add-hook's third argument is LOCAL in this kernel; a four-argument call is
 *  (HOOK FUNCTION DEPTH LOCAL), accepted for source compatibility. */
function hookLocal(a: Value[]): boolean {
  if (a.length >= 4) return truthy(a[3]!);
  if (a.length === 3) return typeof a[2] === 'number' ? false : truthy(a[2]!);
  return false;
}

interface HookState {
  fns: Value[];
  commit(fns: Value[]): void;
}

function hookArray(v: Value | undefined, name: string, line: number): Value[] {
  if (v === undefined || v === nil) return [];
  if (v instanceof Cons) return items(v, name, line);
  return [v]; // legacy single-function value
}

function hookState(rt: Runtime, hook: Sym, local: boolean, line: number): HookState {
  if (local) {
    const existing = rt.localVariable(rt.current, hook.name);
    const fns = existing === undefined ? rt.hookFunctions(hook) : hookArray(existing, hook.name, line);
    return {
      fns,
      commit: (next) => rt.setLocalVariable(rt.current, hook.name, listOf(next)),
    };
  }
  const fns = hookArray(rt.dynamicValue(hook), hook.name, line);
  return {
    fns,
    commit: (next) => rt.setDynamicValue(hook, listOf(next)),
  };
}
