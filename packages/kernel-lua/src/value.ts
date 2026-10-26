// value.ts — the runtime ontology. Lua's integer/float distinction is a
// first-class citizen: LuaInt and LuaFloat are different values that print
// differently (1 vs 1.0) but compare numerically equal.

/** An integer-valued Lua number (subtype of `number` in real Lua). */
export class LuaInt {
  constructor(readonly v: number) {}
}

/** A float-valued Lua number; prints with a decimal point. */
export class LuaFloat {
  constructor(readonly v: number) {}
}

export type LuaValue =
  | null                        // nil
  | boolean
  | LuaInt
  | LuaFloat
  | string
  | Table
  | Closure
  | Builtin
  | 'poison';                   // denied globals (coroutine)

let nextTableId = 1;

/** Normalized table key: integer-valued numbers collapse onto int keys. */
export type Key = string;

export function keyOf(k: LuaValue): Key {
  if (typeof k === 'string') return `s${JSON.stringify(k)}`;
  if (k instanceof LuaInt) return `i${k.v}`;
  if (k instanceof LuaFloat) {
    return Number.isInteger(k.v) ? `i${k.v}` : `f${k.v}`;
  }
  if (typeof k === 'boolean') return k ? 'b1' : 'b0';
  if (k instanceof Table) return `t${k.id}`;
  throw new LuaError('table index is nil');
}

/** The one data structure: a 1-based array part plus arbitrary keys. */
export class Table {
  readonly id: number = nextTableId++;
  /** String-array part records insertion order for pairs(). */
  readonly entries = new Map<Key, { key: LuaValue; value: LuaValue }>();
  metatable: Table | null = null;
  /** _G and the library tables: shown elsewhere, hidden from the heap. */
  internal = false;

  rawGet(k: LuaValue): LuaValue {
    const e = this.entries.get(keyOf(k));
    return e === undefined ? null : e.value;
  }

  rawSet(k: LuaValue, v: LuaValue): void {
    const key = keyOf(k);
    if (v === null) this.entries.delete(key);
    else this.entries.set(key, { key: normalizeKey(k), value: v });
  }

  /** 1-based border: how many consecutive integer keys from 1 exist. */
  length(): number {
    let n = 0;
    while (this.entries.has(`i${n + 1}`)) n++;
    return n;
  }
}

function normalizeKey(k: LuaValue): LuaValue {
  // A float key with integer value becomes the integer key (Lua 5.4 rule).
  if (k instanceof LuaFloat && Number.isInteger(k.v)) return new LuaInt(k.v);
  return k;
}

export class Closure {
  readonly id: number = nextTableId++;
  constructor(
    readonly name: string,
    readonly params: string[],
    readonly body: StatNode[],
    readonly env: Env,
    readonly line: number,
  ) {}
}

export class Builtin {
  constructor(
    readonly name: string,
    readonly call: (args: LuaValue[]) => LuaValue[],
  ) {}
}

export class Env {
  readonly vars = new Map<string, LuaValue>();
  constructor(readonly parent: Env | null) {}

  /** Walk the parent chain; the frame holding `name`, or null. */
  frameOf(name: string): Env | null {
    if (this.vars.has(name)) return this;
    return this.parent === null ? null : this.parent.frameOf(name);
  }
}

export class LuaError extends Error {
  line: number | null = null;
  constructor(message: string, line?: number) {
    super(message);
    this.name = 'LuaError';
    if (line !== undefined) this.line = line;
  }
}

// ─── numbers ───────────────────────────────────────────────────────────────

export function isNum(v: LuaValue): v is LuaInt | LuaFloat {
  return v instanceof LuaInt || v instanceof LuaFloat;
}

export function numOf(v: LuaValue): number {
  if (v instanceof LuaInt || v instanceof LuaFloat) return v.v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^-?0[xX][0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
    if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  }
  throw new LuaError(`attempt to perform arithmetic on a ${typeName(v)} value`);
}


// ─── AST (shared by parser and interpreter) ────────────────────────────────

export type ExpNode =
  | { kind: 'nil' }
  | { kind: 'bool'; value: boolean }
  | { kind: 'var'; name: string; line: number }
  | { kind: 'num'; value: LuaInt | LuaFloat }
  | { kind: 'str'; value: string }
  | { kind: 'index'; obj: ExpNode; key: ExpNode; line: number }
  | { kind: 'call'; fn: ExpNode; args: ExpNode[]; line: number }
  | { kind: 'method'; self: ExpNode; name: string; args: ExpNode[]; line: number }
  | { kind: 'function'; params: string[]; body: StatNode[]; name: string; line: number }
  | { kind: 'tablector'; fields: { key: ExpNode | null; name: string | null; value: ExpNode }[]; line: number }
  | { kind: 'paren'; e: ExpNode; line: number }
  | { kind: 'binop'; op: string; l: ExpNode; r: ExpNode; line: number }
  | { kind: 'unop'; op: string; e: ExpNode; line: number }
  | { kind: 'and'; l: ExpNode; r: ExpNode }
  | { kind: 'or'; l: ExpNode; r: ExpNode };

export type StatNode =
  | { kind: 'local'; names: string[]; exps: ExpNode[]; line: number }
  | { kind: 'assign';
      targets: ({ kind: 'name'; name: string; line: number }
              | { kind: 'index'; obj: ExpNode; key: ExpNode; line: number })[];
      exps: ExpNode[]; line: number }
  | { kind: 'exprstat'; call: ExpNode; line: number }
  | { kind: 'if'; clauses: { cond: ExpNode; body: StatNode[] }[]; elseBody: StatNode[] | null; line: number }
  | { kind: 'while'; cond: ExpNode; body: StatNode[]; line: number }
  | { kind: 'repeat'; body: StatNode[]; cond: ExpNode; line: number }
  | { kind: 'fornum'; name: string; start: ExpNode; limit: ExpNode; step: ExpNode | null; body: StatNode[]; line: number }
  | { kind: 'forin'; names: string[]; iter: 'pairs' | 'ipairs'; iterArg: ExpNode; body: StatNode[]; line: number }
  | { kind: 'do'; body: StatNode[]; line: number }
  | { kind: 'break'; line: number }
  | { kind: 'return'; exps: ExpNode[]; line: number };

export interface Program { body: StatNode[] }

/** Lua's tostring: the int/float distinction shows up in the text. */
export function toStr(v: LuaValue): string {
  if (v === null) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof LuaInt) return String(v.v);
  if (v instanceof LuaFloat) return formatFloat(v.v);
  if (v instanceof Table) return `table: 0x${hex(v.id)}`;
  if (v instanceof Closure) return `function: 0x${hex(v.id)}`;
  if (v instanceof Builtin) return `function: builtin('${v.name}')`;
  return v; // string (or the internal 'poison' marker)
}

export function formatFloat(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return `${v}.0`;
  return String(v);
}

function hex(n: number): string {
  return n.toString(16).padStart(4, '0');
}

export function typeName(v: LuaValue): string {
  if (v === null) return 'nil';
  if (typeof v === 'boolean') return 'boolean';
  if (isNum(v)) return 'number';
  if (typeof v === 'string') return v === 'poison' ? 'poison' : 'string';
  if (v instanceof Table) return 'table';
  return 'function';
}

/** nil and false are falsy; 0 and '' ARE truthy — the habit to unlearn. */
export function truthy(v: LuaValue): boolean {
  return v !== null && v !== false;
}

export function luaEq(a: LuaValue, b: LuaValue): boolean {
  if (isNum(a) && isNum(b)) return numOf(a) === numOf(b);
  return a === b;
}

export function luaLt(a: LuaValue, b: LuaValue, line: number): boolean {
  if (isNum(a) && isNum(b)) return numOf(a) < numOf(b);
  if (typeof a === 'string' && typeof b === 'string') return a < b;
  throw new LuaError(`attempt to compare ${typeName(a)} with ${typeName(b)}`, line);
}

