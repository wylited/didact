// Values, the cons-cell heap, and environments.
//
// A runtime value is one of:
//   number | boolean | string | null (the empty list) | Sym | Ref
//   | Closure | Builtin | Macro | VOID
// Pairs are NOT direct objects: every cons cell lives in the shared heap
// (`Heap.cells`), and a pair value is a `Ref` — the cell's stable address.
// That address is what the Heap panel shows and what `eq?` compares, so
// "(eq? xs xs)" is literally "same cell address".

/** A Lisp symbol; interned so identical names are `===` (that is `eq?`). */
export class Sym {
  readonly name: string;
  private constructor(name: string) { this.name = name; }
  private static table = new Map<string, Sym>();
  static intern(name: string): Sym {
    let s = Sym.table.get(name);
    if (s === undefined) { s = new Sym(name); Sym.table.set(name, s); }
    return s;
  }
}

/** Reference to cons cell #addr in the heap. */
export class Ref {
  constructor(readonly addr: number) {}
}

/** The value of a `define`/`set!`/dead `if` branch — never user-visible. */
export const VOID = Symbol.for('lisp.void');

export class Closure {
  constructor(
    readonly params: string[],
    readonly body: Form[],
    readonly env: Env,
    readonly line: number,
    name?: string,
  ) { this.name = name; }
  name?: string;
}

export class Builtin {
  constructor(
    readonly name: string,
    readonly minArity: number,
    readonly maxArity: number, // Infinity for variadic
    readonly fn: (args: Value[], ctx: BuiltinCtx) => Value,
  ) {}
}

/** What builtins may touch: output, the heap, and the calling line/env. */
export interface BuiltinCtx {
  out(text: string): void;
  heap: Heap;
  env: Env;        // environment of the application form (for macroexpand-1)
  line: number;    // 1-based source line of the application form
}

export class Macro {
  constructor(readonly name: string, readonly transformer: Closure) {}
}

export type Value =
  | number | boolean | string | null | typeof VOID
  | Sym | Ref | Closure | Builtin | Macro;

// ---- Forms (reader output; syntax trees carrying 1-based lines) ---------

/** An atom in a syntax tree: symbols/numbers/strings/booleans/empty list. */
export type Atom = number | boolean | string | Sym | null;
/** A parenthesised form: elements plus the line of its opening token. */
export interface FormArray extends Array<Form> { line: number }
export type Form = Atom | FormArray;

// ---- Errors ---------------------------------------------------------------

/** Runtime/reader error carrying a 1-based source line when known. */
export class LispError extends Error {
  constructor(message: string, readonly line?: number) {
    super(message);
  }
}

/** Internal only: heap capacity exceeded; the machine attaches the line. */
export class HeapOverflow extends LispError {
  constructor(limit: number) { super(`heap overflow: ${limit} cells`); }
}

// ---- The cons-cell heap ---------------------------------------------------

export interface Cell { car: Value; cdr: Value }

/**
 * Flat cons-cell heap. Cells are appended forever (no GC — the lesson says
 * so), so a cell's index — its address — is stable for the whole run.
 * Addresses are shown as `index * 16` (one cell = one car word + one cdr
 * word, 16 bytes in the teaching fiction) so the panel reads like memory.
 */
export class Heap {
  readonly cells: Cell[] = [];
  /** Cells allocated during the current reduction (drives highlighting). */
  readonly fresh: Set<number> = new Set();
  constructor(readonly limit = 4096) {}

  alloc(car: Value, cdr: Value): Ref {
    if (this.cells.length >= this.limit) throw new HeapOverflow(this.limit);
    const addr = this.cells.length;
    this.cells.push({ car, cdr });
    this.fresh.add(addr);
    return new Ref(addr);
  }

  get(addr: number): Cell {
    const c = this.cells[addr];
    if (c === undefined) throw new LispError(`invalid heap address 0x${addr.toString(16)}`);
    return c;
  }

  car(v: Value): Value {
    if (v instanceof Ref) return this.get(v.addr).car;
    throw new LispError(`car: expected a pair, got ${renderWrite(v)}`);
  }

  cdr(v: Value): Value {
    if (v instanceof Ref) return this.get(v.addr).cdr;
    throw new LispError(`cdr: expected a pair, got ${renderWrite(v)}`);
  }
}

// ---- Environments ---------------------------------------------------------

/** One frame of bindings: a name → value map plus a parent pointer. */
export class Env {
  readonly vars = new Map<string, Value>();

  constructor(
    readonly name: string,   // 'global' | 'let (line 4)' | 'loop (line 3)' …
    readonly parent: Env | null,
  ) {}

  lookup(name: string): Value | undefined {
    let e: Env | null = this;
    while (e !== null) {
      const v = e.vars.get(name);
      if (v !== undefined) return v;
      e = e.parent;
    }
    return undefined;
  }

  /** Find the frame that owns `name`, or null if unbound anywhere. */
  owner(name: string): Env | null {
    let e: Env | null = this;
    while (e !== null) {
      if (e.vars.has(name)) return e;
      e = e.parent;
    }
    return null;
  }

  define(name: string, value: Value): void {
    this.vars.set(name, value);
  }

  /** Chain from this frame out to global, e.g. "let (line 4) → global". */
  chain(): string {
    const names: string[] = [];
    let e: Env | null = this;
    while (e !== null) { names.push(e.name); e = e.parent; }
    return names.join(' → ');
  }
}

// ---- Rendering ------------------------------------------------------------

const DEPTH_LIMIT = 4;
const LEN_LIMIT = 8;
const ELLIPSIS = '…';

/** Machine-style rendering (strings quoted) — panels and REPL-style truth. */
export function renderWrite(v: Value, depth = 0): string {
  if (v === null) return '()';
  if (v === VOID) return '#<void>';
  if (v === true) return '#t';
  if (v === false) return '#f';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof Sym) return v.name;
  if (v instanceof Ref) return renderList(v, depth, 'write');
  if (v instanceof Closure) return `#<procedure ${v.name ?? 'anonymous'}>`;
  if (v instanceof Builtin) return `#<builtin ${v.name}>`;
  return `#<macro ${(v as Macro).name}>`;
}

/** What `display` shows: identical, except strings print without quotes. */
export function renderDisplay(v: Value, depth = 0): string {
  if (typeof v === 'string') return v;
  if (v instanceof Ref) return renderList(v, depth, 'display');
  return renderWrite(v, depth);
}

function renderList(ref: Ref, depth: number, mode: 'write' | 'display'): string {
  // Rendering walks the heap, so it must be depth/length limited even
  // though the language itself cannot build cycles (no set-car!/set-cdr!).
  if (depth >= DEPTH_LIMIT) return ELLIPSIS;
  const heap = CURRENT_HEAP;
  if (heap === null) return '(…)';
  const parts: string[] = [];
  let cur: Value = ref;
  let n = 0;
  while (cur instanceof Ref) {
    if (n >= LEN_LIMIT) { parts.push(ELLIPSIS); cur = null; break; }
    const cell = heap.get(cur.addr);
    const r = mode === 'write' ? renderWrite(cell.car, depth + 1) : renderDisplay(cell.car, depth + 1);
    parts.push(r);
    cur = cell.cdr;
    n++;
  }
  if (cur === null) return `(${parts.join(' ')})`;              // (a b c)
  const tail = mode === 'write' ? renderWrite(cur, depth + 1)   // (a b . c)
    : renderDisplay(cur, depth + 1);
  return `(${parts.join(' ')} . ${tail})`;
}

// renderList needs the heap to walk Refs; the machine installs its heap
// for the duration of a render. Single machine per session, so a module
// level pointer is safe and keeps render signatures small.
export let CURRENT_HEAP: Heap | null = null;
export function withHeap<T>(heap: Heap, fn: () => T): T {
  CURRENT_HEAP = heap;
  try { return fn(); } finally { CURRENT_HEAP = null; }
}

/** Structural equality over the heap (`eq?` is address identity). */
export function lispEqual(a: Value, b: Value, heap: Heap): boolean {
  if (a === b) return true;
  if (a instanceof Ref && b instanceof Ref) {
    return lispEqual(heap.car(a), heap.car(b), heap)
      && lispEqual(heap.cdr(a), heap.cdr(b), heap);
  }
  return false;
}
