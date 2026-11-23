// Values, environments, buffers, keymaps, and the printer for the Emacs
// Lisp teaching kernel.
//
// The model is deliberately small and observable:
//   number | string | Sym | Cons | Vec | Buffer | Keymap
//   | Closure | Macro  (Builtin lives in runtime.ts with its context)
//
// Emacs Lisp has no booleans: `nil` (also the empty list) is false and
// every other value is true. Symbols are interned and carry TWO global
// cells — a value cell and a function cell — which is what Lisp-2 means.
// `let` bindings never mutate those cells; they live in dynamic frames or
// lexical environments (see machine.ts).

/** Sentinel for an unbound value/function cell (never user-visible). */
export const UNBOUND = Symbol.for('elisp.unbound');

/** A Lisp symbol, interned: same name means the same object (`eq`).
 *  Global value/function cells are NOT stored here: they live in the
 *  per-session Runtime, so two blocks (and two tests) never share state. */
export class Sym {
  readonly name: string;
  private constructor(name: string) { this.name = name; }
  private static table = new Map<string, Sym>();
  static intern(name: string): Sym {
    let s = Sym.table.get(name);
    if (s === undefined) {
      if (name.length > 512) throw new LispError('symbol name is too long (max 512 characters)');
      if (Sym.table.size >= 100_000) throw new LispError('intern table limit exceeded (100000 symbols)');
      s = new Sym(name);
      Sym.table.set(name, s);
    }
    return s;
  }
}

export const nil = Sym.intern('nil');
export const t = Sym.intern('t');

/** An integral float literal (1.0, 1e3); non-integral floats are JS numbers. */
export class Float {
  constructor(readonly value: number) {}
}

/** A cons cell. `eq` on two pairs is object identity. */
export class Cons {
  constructor(public car: Value, public cdr: Value) {}
}

/** A buffer marker. `pos` is 1-based, or null when detached. */
export class Marker {
  constructor(readonly buffer: Buffer, public pos: number | null) {}
}

/** A simple hash table keyed by Lisp values. */
export class HashTable {
  readonly table = new Map<Value, Value>();
  constructor(readonly test = 'equal') {}
}

/** A cl-defstruct instance: named type plus slot values. */
export class Struct {
  constructor(readonly type: string, readonly slots: Map<string, Value>) {}
}

/** A pseudo-overlay: a range plus properties (display is not simulated). */
export class Overlay {
  deleted = false;
  readonly props = new Map<string, Value>();
  constructor(readonly buffer: Buffer, public start: number, public end: number) {}
}

/** A vector value (`[a b c]`); vectors self-evaluate. */
export class Vec {
  constructor(public items: Value[]) {}
}

/** A simulated Emacs buffer: text plus a 1-based point and mark. */
export class Buffer {
  readonly locals = new Map<string, Value>();
  /** Internal markers used by save-excursion (insertion-type nil). */
  readonly markers = new Set<{ pos: number | null }>();
  /** Text-property runs (1-based, half-open) for the teaching buffer. */
  readonly textProps: { start: number; end: number; props: Map<string, Value> }[] = [];
  /** Accessible region (1-based, inclusive start / exclusive end), or null. */
  narrowStart: number | null = null;
  narrowEnd: number | null = null;
  mark: number | null = null;
  modified = false;
  majorMode = 'fundamental-mode';
  constructor(
    readonly name: string,
    public text = '',
    point = 1,
  ) {
    this.point = point;
  }
  /** 1-based insertion point, clamped to [1, len + 1]. */
  point: number;
  get length(): number { return this.text.length; }
  addMarker(pos: number): { pos: number | null } {
    const marker = { pos };
    this.markers.add(marker);
    return marker;
  }
  removeMarker(marker: { pos: number | null }): void {
    this.markers.delete(marker);
  }
  get pointMin(): number { return this.narrowStart ?? 1; }
  get pointMax(): number { return this.narrowEnd ?? this.text.length + 1; }
  accessibleText(): string { return this.text.slice(this.pointMin - 1, this.pointMax - 1); }
  clampPoint(): void {
    if (this.point < this.pointMin) this.point = this.pointMin;
    if (this.point > this.pointMax) this.point = this.pointMax;
  }
}

/** A simulated keymap: key sequence → command (a function or symbol). */
export class Keymap {
  /** Canonical key strings, e.g. "C-c a" and "RET". */
  readonly bindings = new Map<string, Value>();
  /** Prefixes of stored keys, e.g. "C-c" for "C-c a". */
  readonly prefixes = new Set<string>();
  /** Cached prefix maps returned by lookup-key, so define-key can extend them. */
  readonly children = new Map<string, Keymap>();
  constructor(readonly name = 'keymap', readonly parent: Keymap | null = null) {}
}

export type Params = {
  required: string[];
  optional: string[];
  rest: string | null;
  /** `&key` parameters (cl-defun); defaults are evaluated at call time. */
  keys: { name: string; default: Form | null }[];
};

/** A lambda / defun body. `lexical` records the binding discipline at the
 *  moment the closure was created, so a later flag flip cannot rewrite it. */
export class Closure {
  readonly params: Params;
  readonly body: Form[];
  readonly env: Env | null;
  readonly lexical: boolean;
  readonly line: number;
  name?: string;
  doc?: string;
  /** True for a closure whose body contains `(interactive …)`. */
  command = false;
  constructor(
    params: Params,
    body: Form[],
    env: Env | null,
    lexical: boolean,
    line: number,
    name?: string,
  ) {
    this.params = params;
    this.body = body;
    this.env = env;
    this.lexical = lexical;
    this.line = line;
    this.name = name;
  }
}

export class Macro {
  constructor(readonly name: string, readonly transformer: Closure) {}
}

/** What a builtin may touch. `runtime` is the Runtime class from runtime.ts
 *  (typed unknown here to keep value.ts free of a runtime import); builtins
 *  cast it to Runtime. */
export interface BuiltinCtx {
  runtime: unknown;
  out(text: string): void;
  line: number;
}

/** A native function. Installed in a symbol's function cell. */
export class Builtin {
  constructor(
    readonly name: string,
    readonly minArity: number,
    readonly maxArity: number, // Infinity for variadic
    readonly fn: (args: Value[], ctx: BuiltinCtx) => Value,
  ) {}
}

export type Value =
  | number | string
  | Sym | Cons | Vec | Buffer | Keymap | Closure | Macro | Builtin | Marker | Overlay
  | HashTable | Struct | Float;

/** One lexical frame (arguments of a lexical closure, or a lexical `let`). */
export class Env {
  readonly vars = new Map<string, Value>();
  constructor(readonly label: string, readonly parent: Env | null) {}
  lookup(name: string): Value | undefined {
    const v = this.vars.get(name);
    if (v !== undefined) return v;
    return this.parent === null ? undefined : this.parent.lookup(name);
  }
  owner(name: string): Env | null {
    if (this.vars.has(name)) return this;
    return this.parent === null ? null : this.parent.owner(name);
  }
  chain(): string {
    return this.parent === null ? this.label : `${this.label} → ${this.parent.chain()}`;
  }
}

/** One dynamic binding frame (a `let`, or a dynamic function's arguments). */
export class DynFrame {
  readonly vars = new Map<string, Value>();
  constructor(readonly label: string) {}
}

// ---- Forms (reader output; parenthesised forms carry a 1-based line) ----

export type AtomForm = number | string | Sym | Float;
export interface FormArray extends Array<Form> {
  line: number;
  /** The form after a dotted tail: `(a . b)`. */
  dot?: Form;
}
/** A `[ … ]` literal; elements are data, never evaluated. */
export class FormVector {
  constructor(readonly items: Form[], readonly line: number) {}
}
export type Form = AtomForm | FormArray | FormVector;

// ---- Errors -------------------------------------------------------------

/** Reader/runtime error; `data` carries the Emacs condition symbol. */
export class LispError extends Error {
  constructor(
    message: string,
    readonly line?: number,
    readonly data: string = 'error',
  ) {
    super(message);
  }
}

/** `(throw TAG VALUE)` — caught by `catch`; not a user-visible error. */
export class ThrowSignal {
  constructor(readonly tag: Value, readonly value: Value) {}
}

// ---- List helpers -------------------------------------------------------

/** Array → proper list ending in nil. */
export function listOf(items: Value[]): Value {
  let out: Value = nil;
  for (let i = items.length - 1; i >= 0; i--) out = new Cons(items[i]!, out);
  return out;
}

/** Walk a proper list; throws a LispError on a dotted/imporper tail. */
export function arrayOf(v: Value, who: string): Value[] {
  const out: Value[] = [];
  const seen = new Set<Cons>();
  let cur = v;
  while (cur instanceof Cons) {
    if (seen.has(cur)) throw new LispError(`${who}: circular list`, undefined, 'circular-list');
    seen.add(cur);
    out.push(cur.car);
    cur = cur.cdr;
  }
  if (cur !== nil) throw new LispError(`${who}: expected a proper list`, undefined, 'wrong-type-argument');
  return out;
}

/** Length of a proper list, or null when improper. */
export function listLength(v: Value): number | null | 'circular' {
  let n = 0;
  const seen = new Set<Cons>();
  let cur = v;
  while (cur instanceof Cons) {
    if (seen.has(cur)) return 'circular';
    seen.add(cur);
    n++;
    cur = cur.cdr;
  }
  return cur === nil ? n : null;
}

export const truthy = (v: Value): boolean => v !== nil;

// ---- Rendering ----------------------------------------------------------

const DEPTH = 5;
const LEN = 12;

/** `prin1`-style rendering: strings quoted, symbols bare. `maxString` is
 *  used by panel/status summaries so a huge string cannot blow up the DOM. */
export function renderWrite(v: Value, depth = 0, maxString = Infinity): string {
  if (v === nil) return 'nil';
  if (v instanceof Float) return Number.isInteger(v.value) ? v.value.toFixed(1) : String(v.value);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (v.length <= maxString) return JSON.stringify(v);
    return `${JSON.stringify(v.slice(0, maxString))}…(${v.length} chars)`;
  }
  if (v instanceof Sym) return v.name;
  if (v instanceof Cons) return renderList(v, depth, 'write', maxString);
  if (v instanceof Vec) {
    if (depth >= DEPTH) return '[…]';
    const limit = LEN;
    const shown = v.items.slice(0, limit).map((x) => renderWrite(x, depth + 1, maxString));
    if (v.items.length > limit) shown.push('…');
    return `[${shown.join(' ')}]`;
  }
  if (v instanceof Buffer) return `#<buffer ${v.name}>`;
  if (v instanceof Marker) return v.pos === null ? '#<marker (detached)>' : `#<marker ${v.pos}>`;
  if (v instanceof Overlay) return '#<overlay>';
  if (v instanceof HashTable) return `#<hash-table ${v.table.size}/${v.test}>`;
  if (v instanceof Struct) {
    const parts = [...v.slots].map(([k, x]) => `:${k} ${renderWrite(x, depth + 1, maxString)}`);
    return `#s(${v.type} ${parts.join(' ')})`;
  }
  if (v instanceof Keymap) return v.name;
  if (v instanceof Macro) return `#<macro ${v.name}>`;
  if (v instanceof Closure) return `#<${v.command ? 'command' : 'lambda'} ${v.name ?? 'anonymous'}>`;
  if (v instanceof Builtin) return `#<subr ${v.name}>`;
  return '#<subr>';
}

/** `princ`/`message` rendering: strings print raw. */
export function renderDisplay(v: Value, depth = 0): string {
  if (typeof v === 'string') return v;
  if (v instanceof Cons) return renderList(v, depth, 'display');
  return renderWrite(v, depth);
}

/** A bounded rendering for status lines and panel rows. */
export function renderSummary(v: Value): string {
  return renderWrite(v, 0, 200);
}

function renderList(v: Cons, depth: number, mode: 'write' | 'display', maxString = Infinity): string {
  if (depth >= DEPTH) return '…';
  const parts: string[] = [];
  let cur: Value = v;
  let n = 0;
  while (cur instanceof Cons) {
    if (n >= LEN) { parts.push('…'); return `(${parts.join(' ')})`; }
    parts.push(mode === 'write' ? renderWrite(cur.car, depth + 1, maxString) : renderDisplay(cur.car, depth + 1));
    cur = cur.cdr;
    n++;
  }
  if (cur === nil) return `(${parts.join(' ')})`;
  const tail = mode === 'write' ? renderWrite(cur, depth + 1) : renderDisplay(cur, depth + 1);
  return `(${parts.join(' ')} . ${tail})`;
}

/** Render a form for the control-stack panel (no quoting surprises). */
export function renderForm(f: Form): string {
  if (f instanceof FormVector) {
    const parts = f.items.slice(0, 6).map(renderForm);
    if (f.items.length > 6) parts.push('…');
    return `[${parts.join(' ')}]`;
  }
  if (Array.isArray(f)) {
    const parts = f.slice(0, 6).map(renderForm);
    if (f.dot !== undefined) {
      parts.push('.'); parts.push(renderForm(f.dot));
    }
    if (f.length > 6) parts.push('…');
    return `(${parts.join(' ')})`;
  }
  if (f instanceof Sym) return f.name;
  if (f instanceof Float) return renderWrite(f);
  if (typeof f === 'string') return JSON.stringify(f);
  return String(f);
}

/** Structural equality (Emacs `equal`). Cycles compare coinductively. */
export function equal(
  a: Value,
  b: Value,
  seen = new WeakMap<Cons, Set<Cons>>(),
): boolean {
  while (a instanceof Cons && b instanceof Cons) {
    if (a === b) return true;
    let pairs = seen.get(a);
    if (pairs?.has(b) === true) return true;
    if (pairs === undefined) {
      pairs = new Set();
      seen.set(a, pairs);
    }
    pairs.add(b);
    if (!equal(a.car, b.car, seen)) return false;
    a = a.cdr;
    b = b.cdr;
  }
  if (a === b) return true;
  if (a instanceof Vec && b instanceof Vec) {
    return a.items.length === b.items.length &&
      a.items.every((x, i) => equal(x, b.items[i]!, seen));
  }
  if (a instanceof Float && b instanceof Float) return a.value === b.value;
  if (a instanceof Closure && b instanceof Closure) {
    return a.lexical === b.lexical &&
      a.env === b.env &&
      a.params.required.join(' ') === b.params.required.join(' ') &&
      a.params.optional.join(' ') === b.params.optional.join(' ') &&
      a.params.rest === b.params.rest &&
      a.body.length === b.body.length &&
      a.body.every((f, i) => renderForm(f) === renderForm(b.body[i]!));
  }
  return false;
}

/** Identity (Emacs `eq`) with the small-integer exception. */
export function eq(a: Value, b: Value): boolean {
  if (typeof a === 'string' || typeof b === 'string') return false;
  if (a === b) {
    if (typeof a === 'number') return Number.isInteger(a);
    return true;
  }
  if (a instanceof Float || b instanceof Float) return false;
  return typeof a === 'number' && typeof b === 'number' && Number.isInteger(a) && a === b;
}

/** Emacs `eql`: fixnums by value, floats by type and value. */
export function eql(a: Value, b: Value): boolean {
  if (a instanceof Float || b instanceof Float) {
    return a instanceof Float && b instanceof Float && a.value === b.value;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isInteger(a) === Number.isInteger(b) && a === b;
  }
  return eq(a, b);
}
