// The per-block Emacs Lisp runtime.
//
// Everything mutable lives here, never in the shared value module: global
// value/function cells, buffers, output, changed-binding marks, and the
// keymap registry. Two sessions therefore share symbol *identity* (which is
// what `eq` needs) but never state.
//
// Builtins are leaf functions: they receive plain values plus this small
// context and never call back into the machine or a user function.

import {
  Buffer,
  Builtin,
  BuiltinCtx,
  Cons,
  DynFrame,
  Keymap,
  LispError,
  Sym,
  Value,
  arrayOf,
  listOf,
  nil,
  t,
} from './value';

/** Check arity and invoke a builtin. The machine and tests share this so
 *  the error wording is identical everywhere. */
export function callBuiltin(b: Builtin, args: Value[], ctx: BuiltinCtx): Value {
  if (args.length < b.minArity || args.length > b.maxArity) {
    const wanted = b.minArity === b.maxArity
      ? `${b.minArity}`
      : `${b.minArity}..${b.maxArity === Infinity ? '∞' : b.maxArity}`;
    throw new LispError(
      `${b.name}: wrong number of arguments (${args.length}; expected ${wanted})`,
      ctx.line,
      'wrong-number-of-arguments',
    );
  }
  return b.fn(args, ctx);
}

export type SymOrName = Sym | string;

// The machine imports these from either module; keep one definition only.
export { Builtin };
export type { BuiltinCtx };

const MAX_OUTPUT = 1_000_000;
const MAX_BUFFERS = 64;
const MAX_VECTOR_SLOTS = 2_000_000;
const MAX_STRING_CHARS = 8_000_000;

export class Runtime {
  /** All live buffers, keyed by name. The first one is `*scratch*`. */
  readonly buffers = new Map<string, Buffer>();
  current: Buffer;
  /** Text accumulated by `message`, `princ`, `print`, … */
  output = '';
  /** Aggregate allocation guards for a teaching session. */
  vectorSlots = 0;
  stringChars = 0;

  /** The machine's live dynamic frames (same array; newest last). */
  dynamicFrames: DynFrame[] = [];

  /** Per-session global value cells (`setq-default`, `defvar`, `set`). */
  readonly globalValues = new Map<string, Value>();
  /** Per-session global function cells (`defun`, `fset`, builtins). */
  readonly globalFunctions = new Map<string, Value>();

  /** Names whose binding changed in the latest step (for the UI panels). */
  readonly changed = new Set<string>();

  /** Text properties attached to string values (keyed by their text). */
  readonly textProperties = new Map<string, Map<string, Value>>();

  /** Last search match, for match-string/match-beginning. */
  matchData: { text: string; start: number; end: number; groups: (string | undefined)[]; indices: [number, number][] } | null = null;

  /** Features provided/required in this session. */
  readonly features = new Set<string>(['emacs', 'seq', 'cl-lib', 'subr-x', 'rx']);

  /** Every keymap ever made, in creation order (including `global-map`). */
  readonly keymaps: Keymap[] = [];
  readonly globalMap: Keymap;

  /** Variables made automatically buffer-local by `make-variable-buffer-local`. */
  readonly bufferLocalVariables = new Set<string>();

  /** Lazily created per-buffer local keymaps, kept off the locals map until
   *  `use-local-map` explicitly installs one. */
  private readonly lazyLocalMaps = new WeakMap<Buffer, Keymap>();

  constructor() {
    const scratch = new Buffer('*scratch*');
    this.buffers.set(scratch.name, scratch);
    this.current = scratch;
    this.globalMap = new Keymap('global-map');
    this.keymaps.push(this.globalMap);
    // Self-evaluating constants and the global map are ordinary value cells.
    this.globalValues.set('nil', nil);
    this.globalValues.set('t', t);
    this.globalValues.set('global-map', this.globalMap);
  }

  // ---- output -------------------------------------------------------------

  emit(text: string): void {
    if (this.output.length + text.length > MAX_OUTPUT) {
      throw new LispError(`output limit exceeded (${MAX_OUTPUT} characters)`);
    }
    this.output += text;
  }

  // ---- global cells -------------------------------------------------------

  /** Current value of `name`: a buffer-local binding wins over the global
   *  cell, mirroring how `setq`/`symbol-value` see the current buffer. */
  getVariable(symOrName: SymOrName): Value | undefined {
    const name = symOrName instanceof Sym ? symOrName.name : symOrName;
    if (name.startsWith(':')) return Sym.intern(name);
    const local = this.current.locals.get(name);
    if (local !== undefined) return local;
    return this.globalValues.get(name);
  }

  /** Value-cell lookup for indirect calls: dynamic bindings first, then the
   *  buffer-local/default cells. Lexical bindings are deliberately invisible. */
  dynamicValue(symOrName: SymOrName): Value | undefined {
    const name = symOrName instanceof Sym ? symOrName.name : symOrName;
    for (let i = this.dynamicFrames.length - 1; i >= 0; i--) {
      const v = this.dynamicFrames[i]!.vars.get(name);
      if (v !== undefined) return v;
    }
    return this.getVariable(name);
  }

  /** `set` semantics for indirect calls: nearest dynamic binding, then a
   *  buffer-local/default cell; auto-localizes when requested. */
  setDynamicValue(symOrName: SymOrName, value: Value): Value {
    const name = symOrName instanceof Sym ? symOrName.name : symOrName;
    if (name === 'nil' || name === 't' || name.startsWith(':')) {
      throw new LispError(`Attempt to set a constant symbol: ${name}`, undefined, 'setting-constant');
    }
    for (let i = this.dynamicFrames.length - 1; i >= 0; i--) {
      if (this.dynamicFrames[i]!.vars.has(name)) {
        this.dynamicFrames[i]!.vars.set(name, value);
        this.markChanged(name);
        return value;
      }
    }
    const buf = this.current;
    if (buf.locals.has(name) || this.bufferLocalVariables.has(name)) {
      buf.locals.set(name, value);
      this.markChanged(name);
      return value;
    }
    return this.setVariable(name, value);
  }

  /** Write the global value cell (buffer-local bindings stay untouched). */
  setVariable(symOrName: SymOrName, value: Value): Value {
    const name = symOrName instanceof Sym ? symOrName.name : symOrName;
    this.globalValues.set(name, value);
    this.markChanged(name);
    return value;
  }

  getFunction(symOrName: SymOrName): Value | undefined {
    return this.globalFunctions.get(symOrName instanceof Sym ? symOrName.name : symOrName);
  }

  setFunction(symOrName: SymOrName, value: Value): Value {
    const name = symOrName instanceof Sym ? symOrName.name : symOrName;
    this.globalFunctions.set(name, value);
    this.markChanged(name);
    return value;
  }

  markChanged(name: string): void {
    this.changed.add(name);
  }

  clearChanged(): void {
    this.changed.clear();
  }

  // ---- buffers ------------------------------------------------------------

  getBuffer(name: string): Buffer | undefined {
    return this.buffers.get(name);
  }

  /** A buffer object is live only while it is still registered. */
  isLive(buf: Buffer): boolean {
    return this.buffers.get(buf.name) === buf;
  }

  chargeVector(n: number): void {
    this.vectorSlots += n;
    if (this.vectorSlots > MAX_VECTOR_SLOTS) {
      throw new LispError(`vector allocation limit exceeded (${MAX_VECTOR_SLOTS} slots)`);
    }
  }

  chargeString(n: number): void {
    this.stringChars += n;
    if (this.stringChars > MAX_STRING_CHARS) {
      throw new LispError(`string allocation limit exceeded (${MAX_STRING_CHARS} characters)`);
    }
  }

  /** Get-or-create, the way `get-buffer-create` behaves. */
  createBuffer(name: string): Buffer {
    const existing = this.buffers.get(name);
    if (existing !== undefined) return existing;
    if (this.buffers.size >= MAX_BUFFERS) {
      throw new LispError(`buffer limit exceeded (${MAX_BUFFERS})`);
    }
    const buf = new Buffer(name);
    this.buffers.set(name, buf);
    return buf;
  }

  /** A guaranteed-fresh name: `foo`, `foo<2>`, `foo<3>`, … */
  generateNewBuffer(name: string): Buffer {
    let candidate = name;
    for (let n = 2; this.buffers.has(candidate); n++) candidate = `${name}<${n}>`;
    return this.createBuffer(candidate);
  }

  killBuffer(target: string | Buffer): boolean {
    const buf = typeof target === 'string' ? this.buffers.get(target) : target;
    if (buf === undefined || this.buffers.get(buf.name) !== buf) return false;
    this.buffers.delete(buf.name);
    if (this.current === buf) {
      const next = this.buffers.values().next();
      this.current = next.done === true ? this.createBuffer('*scratch*') : next.value;
    }
    return true;
  }

  setCurrent(buf: Buffer): void {
    this.current = buf;
  }

  // ---- buffer-local variables --------------------------------------------

  localVariable(buf: Buffer, name: string): Value | undefined {
    return buf.locals.get(name);
  }

  setLocalVariable(buf: Buffer, name: string, value: Value): Value {
    buf.locals.set(name, value);
    this.markChanged(name);
    return value;
  }

  makeLocalVariable(buf: Buffer, name: string): void {
    if (buf.locals.has(name)) return;
    // Emacs seeds the new local binding from the current default value.
    buf.locals.set(name, this.globalValues.get(name) ?? nil);
  }

  makeVariableBufferLocal(name: string): void {
    this.bufferLocalVariables.add(name);
  }

  isBufferLocalVariable(name: string): boolean {
    return this.bufferLocalVariables.has(name);
  }

  killLocalVariable(buf: Buffer, name: string): void {
    buf.locals.delete(name);
  }

  // ---- hooks --------------------------------------------------------------

  /** The effective hook list: buffer-local when set, else the global cell.
   *  A legacy single-function value is normalized to a one-element array. */
  hookFunctions(sym: Sym): Value[] {
    const v = this.getVariable(sym);
    if (v === undefined || v === nil) return [];
    if (v instanceof Cons) return arrayOf(v, sym.name);
    return [v];
  }

  setHookFunctions(sym: Sym, fns: Value[], local: boolean): void {
    const list = listOf(fns);
    if (local) this.setLocalVariable(this.current, sym.name, list);
    else this.setVariable(sym, list);
  }

  // ---- keymaps ------------------------------------------------------------

  newKeymap(name = 'keymap', parent: Keymap | null = null): Keymap {
    const map = new Keymap(name, parent);
    this.keymaps.push(map);
    return map;
  }

  /** The buffer's local map: an explicitly installed one, or a lazy per-buffer
   *  map that is not visible through `locals` until `use-local-map` sets it. */
  localMap(buf: Buffer = this.current): Keymap {
    const stored = buf.locals.get('local-map');
    if (stored instanceof Keymap) return stored;
    let map = this.lazyLocalMaps.get(buf);
    if (map === undefined) {
      map = this.newKeymap(`local-map:${buf.name}`);
      this.lazyLocalMaps.set(buf, map);
    }
    return map;
  }

  setLocalMap(map: Keymap | null, buf: Buffer = this.current): void {
    if (map === null) buf.locals.delete('local-map');
    else buf.locals.set('local-map', map);
  }
}
