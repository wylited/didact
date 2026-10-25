// interp.ts — tree-walking evaluator for the teaching subset, written as
// generator functions: every statement yields *before* it executes, so the
// Session driver can step one statement at a time and stop at breakpoints
// without unwinding loop/call state (the generator IS the resumption point).
//
// Semantics implemented on purpose, because they are the lesson:
//   * var/function hoisting to function scope, let/const TDZ per block;
//   * real ECMAScript abstract equality (==) coercion, incl. ToPrimitive
//     for arrays/objects, vs. reference-typed strict equality (===);
//   * closures capture environments, and `for (let …)` clones its binding
//     per iteration (so closures made in iteration k see k);
//   * an event loop: the body runs to completion, then all microtasks
//     (Promise.resolve().then) drain, then ONE macrotask (setTimeout),
//     microtasks again, repeat — FIFO inside each queue.

import type { Expression, Program, Statement } from './parser';

export const RUN_BUDGET = 1_000_000;

// ─── values ────────────────────────────────────────────────────────────────

export interface ClosureValue {
  kind: 'closure';
  name: string | null;
  params: string[];
  body: Statement[];
  expression: Expression | null;
  env: Env;
  line: number;
}
export interface NativeValue {
  kind: 'native';
  name: string;
  // Synchronous natives return a value; generator natives (map/filter, the
  // task callbacks) may call back into the interpreter.
  fn: (args: Value[]) => Value | Generator<YieldInfo, Value>;
}
export interface PromiseValue {
  kind: 'promise';
  settled: boolean;
  value: Value;
  waiting: ((v: Value) => void)[];
}
export type Value =
  | undefined | null | boolean | number | string
  | ClosureValue | NativeValue | PromiseValue
  | Value[] | ObjValue;

export interface ObjValue {
  kind: 'object';
  props: Record<string, Value>;
}

export function isCallable(v: Value): v is ClosureValue | NativeValue {
  return (typeof v === 'object' && v !== null && !Array.isArray(v))
    && (v.kind === 'closure' || v.kind === 'native');
}
export function isPromise(v: Value): v is PromiseValue {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'promise';
}

// ─── environments ──────────────────────────────────────────────────────────

interface Binding {
  value: Value;
  kind: 'var' | 'let' | 'const' | 'fn' | 'param';
  initialized: boolean; // false until the let/const declarator runs (TDZ)
  builtin?: boolean;    // globals installed by the harness, hidden in panels
}

export class Env {
  vars = new Map<string, Binding>();
  constructor(public parent: Env | null) {}

  /** Nearest binding for `name`, or undefined (=> ReferenceError upstream). */
  lookup(name: string): Binding | undefined {
    const b = this.vars.get(name);
    if (b !== undefined) return b;
    return this.parent === null ? undefined : this.parent.lookup(name);
  }
}

// ─── control-flow signals & errors ─────────────────────────────────────────

class BreakSignal { }
class ContinueSignal { }
class ReturnSignal { constructor(public value: Value) { } }

export class RuntimeErr extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}
export class BudgetErr extends Error {
  constructor() {
    super(`run budget exceeded (${RUN_BUDGET.toLocaleString('en-US')} evaluation steps) — the program never finished`);
  }
}

/** What a statement/task yields to the driver before it executes. */
export interface YieldInfo {
  line: number;
  /** Set when the next unit is an event-loop task rather than a statement. */
  task?: 'micro' | 'macro';
}

export interface Frame {
  name: string;
  env: Env;
  line: number;
}

interface MacroTask { fn: Value; line: number }
interface MicroTask { gen: Generator<YieldInfo, void>; line: number; label: string }

// ─── conversions (the ECMAScript abstract operations we teach) ─────────────

export function toNumber(v: Value): number {
  if (typeof v === 'number') return v;
  if (v === null) return 0;
  if (v === undefined) return NaN;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return 0;
    // Radix integer literals (0x1F, 0b101, 0o17; case-insensitive, no sign —
    // the StringToNumber grammar allows '+'/'-' only on decimal forms).
    if (/^0[xX][0-9a-fA-F]+$/.test(t) || /^0[bB][01]+$/.test(t) || /^0[oO][0-7]+$/.test(t)) {
      return Number(t);
    }
    if (!/^[+-]?(Infinity|\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)$/.test(t)) return NaN;
    return Number(t);
  }
  if (Array.isArray(v)) return toNumber(valueToString(v)); // [] -> 0, [7] -> 7, [1,2] -> NaN
  return NaN; // objects, functions, promises
}

export function truthy(v: Value): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v !== '';
  return true; // arrays, objects, functions, promises are always truthy
}

/** ToPrimitive for our value space: no valueOf/toString overrides exist. */
function toPrimitive(v: Value): Value {
  // In this subset no object has valueOf/toString overrides, so ToPrimitive
  // of any object (array, object, function, promise) is its string form.
  if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return valueToString(v);
  return v;
}

/** Abstract equality (==), following ES SameValueNonGeneric steps closely. */
export function looseEquals(a: Value, b: Value): boolean {
  const ta = typeof a, tb = typeof b;
  const aObj = a !== null && ta === 'object';
  const bObj = b !== null && tb === 'object';
  if (!aObj && !bObj) {
    if (ta !== tb) {
      if (a === null && b === undefined) return true;   // null == undefined
      if (a === undefined && b === null) return true;
      if (ta === 'boolean') return looseEquals(a === true ? 1 : 0, b);
      if (tb === 'boolean') return looseEquals(a, b === true ? 1 : 0);
      if (ta === 'number' && tb === 'string') return a === toNumber(b);
      if (ta === 'string' && tb === 'number') return toNumber(a) === b;
      return false;
    }
    return a === b; // same type: NaN !== NaN, +0 === -0, strings by value
  }
  if (aObj && bObj) return a === b; // references
  if (aObj !== bObj) {
    const obj = aObj ? a : b;
    const prim = aObj ? b : a;
    if (prim === null || prim === undefined) return false;
    return looseEquals(toPrimitive(obj), prim);
  }
  return false;
}

/** Strict equality (===): same type, value equality, references for objects. */
export function strictEquals(a: Value, b: Value): boolean {
  const ta = typeof a, tb = typeof b;
  if (ta !== tb) return false;
  if (ta === 'number') return a === b; // covers NaN !== NaN
  if (ta === 'string' || ta === 'boolean' || a === null || a === undefined) return a === b;
  return a === b; // arrays, objects, functions, promises: identity
}

export function typeName(v: Value): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'object';
  if (typeof v === 'object') {
    if (v.kind === 'closure' || v.kind === 'native') return 'function';
    return 'object';
  }
  return typeof v;
}

/** Human display used by console.log and the Scopes panel (Node-flavoured). */
export function displayValue(v: Value, quote = false, depth = 0): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return quote ? JSON.stringify(v) : v;
  if (Array.isArray(v)) {
    if (depth >= 3) return '[Array]';
    if (v.length === 0) return '[]';
    return `[ ${v.map((x) => displayValue(x, true, depth + 1)).join(', ')} ]`;
  }
  switch (v.kind) {
    case 'closure': return `[Function: ${v.name ?? '(anonymous)'}]`;
    case 'native': return `[Function: ${v.name}]`;
    case 'promise': return v.settled ? `Promise { ${displayValue(v.value, true, depth + 1)} }` : 'Promise { <pending> }';
    case 'object': {
      if (depth >= 3) return '[Object]';
      const keys = Object.keys(v.props);
      if (keys.length === 0) return '{}';
      return `{ ${keys.map((k) => `${k}: ${displayValue(v.props[k]!, true, depth + 1)}`).join(', ')} }`;
    }
  }
}

/**
 * ECMAScript ToString — the *coercion* the abstract operations use, which
 * differs from the console display form: String([]) is '' (not '[]') and
 * String([1,2]) is '1,2', which is exactly why [] == 0 and [1] == 1.
 */
export function valueToString(v: Value): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === undefined || v === null) return String(v);
  // Array.prototype.join: null/undefined elements become '' (so [null] is '').
  if (Array.isArray(v)) return v.map((x) => (x === null || x === undefined ? '' : valueToString(x))).join(',');
  if (v.kind === 'object' || v.kind === 'promise') return '[object Object]';
  if (v.kind === 'closure' || v.kind === 'native') return `function ${v.name ?? ''}() { … }`;
  return '[object Object]'; // host objects smuggled in by tests
}

// ─── the interpreter ───────────────────────────────────────────────────────

export class Interpreter {
  readonly global = new Env(null);
  /** Call stack: one entry per live function frame (+ the script frame). */
  frames: Frame[] = [];
  /** Microtasks (Promise.then callbacks) and macrotasks (setTimeout). */
  micro: MicroTask[] = [];
  macro: MacroTask[] = [];
  steps = 0;
  output = '';
  error: RuntimeErr | null = null;

  private program: Program;

  constructor(program: Program) {
    this.program = program;
    this.frames.push({ name: 'global', env: this.global, line: 1 });
    installGlobals(this);
  }

  /** True when the program body, microtasks and macrotasks are all done. */
  private done = false;

  /** Main generator: body → drain microtasks → one macrotask → repeat. */
  *runAll(): Generator<YieldInfo, void> {
    // Top-level declarations hoist into the global scope before line 1 runs.
    this.hoistDeclares(this.program.body, this.global, this.global);
    yield* this.execStmts(this.program.body, this.global, this.global);
    // Tasks are shifted only *after* their marker yield is consumed, so a
    // paused driver still shows the pending task at the head of its queue.
    while (this.micro.length > 0 || this.macro.length > 0) {
      while (this.micro.length > 0) {
        const job = this.micro[0]!;
        yield { line: job.line, task: 'micro' };
        this.micro.shift();
        yield* job.gen;
      }
      if (this.macro.length > 0) {
        const task = this.macro[0]!;
        yield { line: task.line, task: 'macro' };
        this.macro.shift();
        yield* this.callValue(task.fn, [], task.line);
      }
    }
    this.done = true;
  }

  isDone(): boolean {
    return this.done;
  }

  // -- budget --------------------------------------------------------

  private tick(line: number): void {
    if (++this.steps > RUN_BUDGET) {
      throw new BudgetErr();
    }
    const top = this.frames[this.frames.length - 1];
    if (top !== undefined) top.line = line;
  }

  // -- statements ------------------------------------------------------

  *execStmts(stmts: Statement[], blockEnv: Env, fnEnv: Env): Generator<YieldInfo, void> {
    for (const s of stmts) yield* this.execStmt(s, blockEnv, fnEnv);
  }

  *execStmt(s: Statement, blockEnv: Env, fnEnv: Env): Generator<YieldInfo, void> {
    if (s.type === 'Empty') return;
    this.tick(s.line);
    yield { line: s.line };
    switch (s.type) {
      case 'ExprStmt':
        yield* this.evalExpr(s.expr, blockEnv);
        return;
      case 'VarDecl': {
        const value = s.init === null ? undefined : yield* this.evalExpr(s.init, blockEnv);
        if (s.kind === 'var') {
          // The binding was hoisted to function scope at entry; just write.
          const b = fnEnv.vars.get(s.name);
          if (b === undefined) {
            // Unreachable: hoistDeclares always creates var bindings first.
            fnEnv.vars.set(s.name, { value, kind: 'var', initialized: true });
          } else {
            b.value = value;
            b.initialized = true;
          }
        } else {
          const b = blockEnv.vars.get(s.name);
          if (b === undefined) {
            throw new RuntimeErr(`Cannot access '${s.name}' before initialization`, s.line);
          }
          b.value = value;
          b.initialized = true;
        }
        return;
      }
      case 'FuncDecl':
        return; // hoisted whole at scope entry
      case 'Block': {
        const inner = new Env(blockEnv);
        this.hoistDeclares(s.body, inner, fnEnv);
        yield* this.execStmts(s.body, inner, fnEnv);
        return;
      }
      case 'If': {
        const test = yield* this.evalExpr(s.test, blockEnv);
        if (truthy(test)) yield* this.execStmt(s.consequent, blockEnv, fnEnv);
        else if (s.alternate !== null) yield* this.execStmt(s.alternate, blockEnv, fnEnv);
        return;
      }
      case 'While': {
        for (;;) {
          const test = yield* this.evalExpr(s.test, blockEnv);
          if (!truthy(test)) return;
          try {
            yield* this.execStmt(s.body, blockEnv, fnEnv);
          } catch (e) {
            if (e instanceof BreakSignal) return;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
      }
      case 'For': {
        yield* this.execFor(s, blockEnv, fnEnv);
        return;
      }
      case 'Return': {
        if (this.frames.length <= 1) {
          throw new RuntimeErr("'return' outside of a function", s.line);
        }
        const value = s.value === null ? undefined : yield* this.evalExpr(s.value, blockEnv);
        throw new ReturnSignal(value);
      }
      case 'Break': throw new BreakSignal();
      case 'Continue': throw new ContinueSignal();
    }
  }

  /**
   * `for` with a `let` head clones the loop binding each iteration, so a
   * closure created in iteration k captures k (the var-vs-let lesson).
   */
  *execFor(s: Extract<Statement, { type: 'For' }>, outer: Env, fnEnv: Env): Generator<YieldInfo, void> {
    let loopNames: string[] = [];
    const perIteration =
      s.init !== null && s.init.type === 'VarDecl' && s.init.kind !== 'var';
    let scope = new Env(outer);
    if (s.init !== null) {
      if (s.init.type === 'VarDecl') {
        this.hoistDeclares([s.init], scope, s.init.kind === 'var' ? fnEnv : scope);
        loopNames = [s.init.name];
      }
      yield* this.execStmt(s.init, scope, fnEnv);
    }
    for (;;) {
      if (s.test !== null) {
        const test = yield* this.evalExpr(s.test, scope);
        if (!truthy(test)) return;
      }
      try {
        const bodyEnv = new Env(scope);
        this.hoistDeclares(stmtsOf(s.body), bodyEnv, fnEnv);
        yield* this.execStmt(s.body, bodyEnv, fnEnv);
      } catch (e) {
        if (e instanceof BreakSignal) return;
        if (!(e instanceof ContinueSignal)) throw e;
      }
      // `for (let …)`: after the body, move to a fresh copy of the loop
      // bindings for the update — the body's closures keep the iteration
      // value they were created with (var heads share one mutable binding).
      if (perIteration && loopNames.length > 0) {
        const fresh = new Env(outer);
        for (const n of loopNames) {
          const b = scope.vars.get(n)!;
          fresh.vars.set(n, { value: b.value, kind: b.kind, initialized: b.initialized });
        }
        scope = fresh;
      }
      if (s.update !== null) yield* this.evalExpr(s.update, scope);
    }
  }

  // -- hoisting ---------------------------------------------------------

  /**
   * At scope entry: `var`s and function declarations bind in the function
   * scope (functions fully initialized — callable before their line); the
   * block's let/const bind here but stay uninitialized (the TDZ) until
   * their declarator executes.
   */
  hoistDeclares(stmts: Statement[], blockEnv: Env, fnEnv: Env): void {
    for (const s of stmts) {
      switch (s.type) {
        case 'VarDecl':
          if (s.kind === 'var') {
            if (!fnEnv.vars.has(s.name)) fnEnv.vars.set(s.name, { value: undefined, kind: 'var', initialized: true });
          } else if (!blockEnv.vars.has(s.name)) {
            blockEnv.vars.set(s.name, { value: undefined, kind: s.kind, initialized: false });
          }
          break;
        case 'FuncDecl':
          fnEnv.vars.set(s.name, {
            value: { kind: 'closure', name: s.name, params: s.params, body: s.body, expression: null, env: fnEnv, line: s.line },
            kind: 'fn',
            initialized: true,
          });
          break;
        case 'Block': this.hoistDeclares(s.body, new Env(blockEnv), fnEnv); break;
        case 'If':
          this.hoistDeclares(stmtsOf(s.consequent), new Env(blockEnv), fnEnv);
          if (s.alternate !== null) this.hoistDeclares(stmtsOf(s.alternate), new Env(blockEnv), fnEnv);
          break;
        case 'While': case 'For':
          this.hoistDeclares(stmtsOf(s.body), new Env(blockEnv), fnEnv);
          if (s.type === 'For' && s.init !== null && s.init.type === 'VarDecl' && s.init.kind === 'var') {
            if (!fnEnv.vars.has(s.init.name)) fnEnv.vars.set(s.init.name, { value: undefined, kind: 'var', initialized: true });
          }
          break;
        default: break;
      }
    }
  }

  // -- expressions ------------------------------------------------------

  *evalExpr(e: Expression, env: Env): Generator<YieldInfo, Value> {
    this.tick(e.line);
    switch (e.type) {
      case 'Num': return e.value;
      case 'Str': return e.value;
      case 'Bool': return e.value;
      case 'Null': return null;
      case 'Undefined': return undefined;
      case 'Ident': {
        const b = env.lookup(e.name);
        if (b === undefined) throw new RuntimeErr(`${e.name} is not defined`, e.line);
        if (!b.initialized) throw new RuntimeErr(`Cannot access '${e.name}' before initialization`, e.line);
        return b.value;
      }
      case 'Tpl': {
        let out = '';
        for (const part of e.parts) {
          out += typeof part === 'string' ? part : valueToString(yield* this.evalExpr(part, env));
        }
        return out;
      }
      case 'ArrayLit': {
        const arr: Value[] = [];
        for (const el of e.elements) arr.push(yield* this.evalExpr(el, env));
        return arr;
      }
      case 'ObjectLit': {
        const props: Record<string, Value> = {};
        for (const entry of e.entries) props[entry.key] = yield* this.evalExpr(entry.value, env);
        return { kind: 'object', props };
      }
      case 'Func':
        return {
          kind: 'closure', name: e.name, params: e.params, body: e.body,
          expression: e.expression ?? null, env, line: e.line,
        };
      case 'Unary': {
        if (e.op === 'typeof') {
          // typeof never throws on an undeclared binding (ES quirk we keep).
          if (e.arg.type === 'Ident') {
            const b = env.lookup(e.arg.name);
            if (b === undefined) return 'undefined';
            if (!b.initialized) throw new RuntimeErr(`Cannot access '${e.arg.name}' before initialization`, e.line);
            return typeName(b.value);
          }
          return typeName(yield* this.evalExpr(e.arg, env));
        }
        const v = yield* this.evalExpr(e.arg, env);
        if (e.op === '!') return !truthy(v);
        if (e.op === '-') return -toNumber(v);
        return toNumber(v); // unary +
      }
      case 'Binary': {
        const l = yield* this.evalExpr(e.left, env);
        const r = yield* this.evalExpr(e.right, env);
        return this.binary(e.op, l, r, e.line);
      }
      case 'Logical': {
        const l = yield* this.evalExpr(e.left, env);
        if (e.op === '&&') return truthy(l) ? yield* this.evalExpr(e.right, env) : l;
        return truthy(l) ? l : yield* this.evalExpr(e.right, env); // '||'
      }
      case 'Member': {
        const obj = yield* this.evalExpr(e.object, env);
        const key = e.name ?? valueToString(yield* this.evalExpr(e.property!, env));
        return this.getProperty(obj, key, e.line);
      }
      case 'Assign': {
        let value: Value;
        if (e.op === '=') {
          value = yield* this.evalExpr(e.value, env);
        } else {
          const op = e.op.slice(0, -1); // '+=' -> '+'
          const current = yield* this.evalExpr(e.target, env);
          value = this.binary(op, current, yield* this.evalExpr(e.value, env), e.line);
        }
        if (e.target.type === 'Ident') {
          const b = env.lookup(e.target.name);
          if (b === undefined) throw new RuntimeErr(`${e.target.name} is not defined`, e.target.line);
          if (b.kind === 'const') throw new RuntimeErr('Assignment to constant variable.', e.line);
          if (!b.initialized) throw new RuntimeErr(`Cannot access '${e.target.name}' before initialization`, e.line);
          b.value = value;
        } else if (e.target.type === 'Member') {
          const obj = yield* this.evalExpr(e.target.object, env);
          const key = e.target.name ?? valueToString(yield* this.evalExpr(e.target.property!, env));
          this.setProperty(obj, key, value, e.line);
        }
        return value;
      }
      case 'Call': {
        // Member callees are evaluated exactly once — here, not twice (the
        // receiver expression can itself be a call with side effects).
        if (e.callee.type === 'Member') {
          const obj = yield* this.evalExpr(e.callee.object, env);
          const key = e.callee.name ?? valueToString(yield* this.evalExpr(e.callee.property!, env));
          return yield* this.callMethod(obj, key, e, env);
        }
        const callee = yield* this.evalExpr(e.callee, env);
        const args: Value[] = [];
        for (const a of e.args) args.push(yield* this.evalExpr(a, env));
        return yield* this.callValue(callee, args, e.line);
      }
    }
  }

  /** Pure (non-yielding) binary operator semantics. */
  binary(op: string, l: Value, r: Value, line: number): Value {
    switch (op) {
      case '==': return looseEquals(l, r);
      case '!=': return !looseEquals(l, r);
      case '===': return strictEquals(l, r);
      case '!==': return !strictEquals(l, r);
      case '+': {
        const lp = toPrimitive(l), rp = toPrimitive(r);
        if (typeof lp === 'string' || typeof rp === 'string') return valueToString(lp) + valueToString(rp);
        return toNumber(lp) + toNumber(rp);
      }
      case '-': return toNumber(l) - toNumber(r);
      case '*': return toNumber(l) * toNumber(r);
      case '/': return toNumber(l) / toNumber(r);
      case '%': return toNumber(l) % toNumber(r);
      case '**': return toNumber(l) ** toNumber(r);
      case '<': case '>': case '<=': case '>=': {
        const lp = toPrimitive(l), rp = toPrimitive(r);
        if (typeof lp === 'string' && typeof rp === 'string') {
          if (op === '<') return lp < rp;
          if (op === '>') return lp > rp;
          if (op === '<=') return lp <= rp;
          return lp >= rp;
        }
        const ln = toNumber(lp), rn = toNumber(rp);
        if (Number.isNaN(ln) || Number.isNaN(rn)) return false;
        if (op === '<') return ln < rn;
        if (op === '>') return ln > rn;
        if (op === '<=') return ln <= rn;
        return ln >= rn;
      }
      default:
        throw new RuntimeErr(`operator '${op}' ${'is not in the teaching subset'}`, line);
    }
  }

  // -- calls --------------------------------------------------------------

  *callValue(fn: Value, args: Value[], line: number): Generator<YieldInfo, Value> {
    if (fn === null || fn === undefined || !isCallable(fn)) {
      throw new RuntimeErr(`${valueToString(fn)} is not a function`, line);
    }
    if (fn.kind === 'native') {
      // Generator natives (promise .then) re-enter the interpreter.
      const out = fn.fn(args);
      if (out !== null && typeof out === 'object' && typeof (out as Generator).next === 'function') {
        return yield* (out as Generator<YieldInfo, Value>);
      }
      try {
        return out as Value;
      } catch (e) {
        if (e instanceof RuntimeErr && e.line === 0) e.line = line;
        throw e;
      }
    }
    const env = new Env(fn.env);
    fn.params.forEach((p, i) => env.vars.set(p, { value: args[i] ?? undefined, kind: 'param', initialized: true }));
    this.frames.push({ name: fn.name ?? '(anonymous)', env, line });
    try {
      this.hoistDeclares(fn.body, env, env);
      yield* this.execStmts(fn.body, env, env);
      // Arrow functions with expression bodies return that expression.
      if (fn.expression !== null) return yield* this.evalExpr(fn.expression, env);
      return undefined;
    } catch (sig) {
      if (sig instanceof ReturnSignal) return sig.value;
      throw sig;
    } finally {
      this.frames.pop();
    }
  }

  /** Method call: array/string methods resolve against the receiver. */
  *callMethod(obj: Value, key: string, call: Extract<Expression, { type: 'Call' }>, env: Env): Generator<YieldInfo, Value> {
    const args: Value[] = [];
    for (const a of call.args) args.push(yield* this.evalExpr(a, env));
    const method = this.getProperty(obj, key, call.line);
    if (key === 'map' && Array.isArray(obj)) return yield* this.arrayMap(obj, args, call.line);
    if (key === 'filter' && Array.isArray(obj)) return yield* this.arrayFilter(obj, args, call.line);
    return yield* this.callValue(method, args, call.line);
  }

  private *arrayMap(arr: Value[], args: Value[], line: number): Generator<YieldInfo, Value> {
    const out: Value[] = [];
    for (let i = 0; i < arr.length; i++) {
      out.push(yield* this.callValue(args[0] ?? undefined, [arr[i]!, i, arr], line));
    }
    return out;
  }

  private *arrayFilter(arr: Value[], args: Value[], line: number): Generator<YieldInfo, Value> {
    const out: Value[] = [];
    for (let i = 0; i < arr.length; i++) {
      const keep = yield* this.callValue(args[0] ?? undefined, [arr[i]!, i, arr], line);
      if (truthy(keep)) out.push(arr[i]!);
    }
    return out;
  }

  /**
   * `promise.then(f)`: returns a new promise; `f` runs later as a
   * MICROTASK (before any pending setTimeout macrotask). Already-settled
   * promises enqueue immediately; unsettled ones wait for settle().
   */
  promiseThen(p: PromiseValue): NativeValue {
    return native('then', (args): Value => {
      const onFulfilled = isCallable(args[0] ?? undefined) ? (args[0] as ClosureValue | NativeValue) : undefined;
      const result: PromiseValue = { kind: 'promise', settled: false, value: undefined, waiting: [] };
      const line = this.frames[this.frames.length - 1]?.line ?? 1;
      // The arrow closes over `this` (the interpreter), not an alias.
      const schedule = (v: Value): void => {
        this.micro.push({ line, label: describeCallable(onFulfilled), gen: this.thenJob(onFulfilled, result, v, line) });
      };
      if (p.settled) schedule(p.value);
      else p.waiting.push(schedule);
      return result;
    });
  }

  /** The microtask body behind one `.then` callback invocation. */
  private *thenJob(
    onFulfilled: ClosureValue | NativeValue | undefined,
    result: PromiseValue,
    v: Value,
    line: number,
  ): Generator<YieldInfo, void> {
    let r: Value = v;
    if (onFulfilled !== undefined) r = yield* this.callValue(onFulfilled, [v], line);
    if (isPromise(r)) {
      // Assimilation: the outer promise settles with r's eventual value, not
      // r's current (unsettled ⇒ undefined) one. An already-settled r settles
      // now; a pending one forwards through its own waiting queue.
      if (r.settled) settlePromise(result, r.value);
      else r.waiting.push((w) => settlePromise(result, w));
      return;
    }
    settlePromise(result, r);
  }
  // -- properties -----------------------------------------------------

  getProperty(obj: Value, key: string, line: number): Value {
    if (obj === null || obj === undefined) {
      throw new RuntimeErr(`Cannot read property '${key}' of ${valueToString(obj)}`, line);
    }
    if (typeof obj === 'string') {
      if (key === 'length') return obj.length;
      const m = stringMethod(obj, key);
      if (m !== undefined) return m;
    } else if (Array.isArray(obj)) {
      if (key === 'length') return obj.length;
      const m = arrayMethod(this, obj, key);
      if (m !== undefined) return m;
      if (/^\d+$/.test(key)) return obj[Number(key)] ?? undefined;
    } else if (typeof obj === 'object') {
      if (obj.kind === 'promise' && key === 'then') return this.promiseThen(obj);
      if (obj.kind === 'object') return obj.props[key] ?? undefined;
    }
    return undefined;
  }

  setProperty(obj: Value, key: string, value: Value, line: number): void {
    if (Array.isArray(obj)) {
      if (key === 'length') {
        const n = toNumber(value);
        if (!Number.isInteger(n) || n < 0 || n > 1e9) {
          throw new RuntimeErr('invalid array length', line);
        }
        obj.length = n;
        return;
      }
      if (/^\d+$/.test(key)) {
        obj[Number(key)] = value;
        return;
      }
    }
    if (typeof obj === 'object' && obj !== null && !Array.isArray(obj) && obj.kind === 'object') {
      obj.props[key] = value;
      return;
    }
    throw new RuntimeErr(`Cannot set property '${key}' on ${typeName(obj)}`, line);
  }

  // -- console ----------------------------------------------------------

  log(text: string): void {
    this.output += text + '\n';
  }

  /** console.log/error argument formatting (space-separated, Node-style). */
  formatArgs(args: Value[]): string {
    return args.map((a) => displayValue(a, false, 0)).join(' ');
  }
}

/** Statements of `s` for hoisting walks; non-block statements count as one. */
function stmtsOf(s: Statement): Statement[] {
  return s.type === 'Block' ? s.body : [s];
}

// ─── builtins ──────────────────────────────────────────────────────────────

/** Native with no interpreter callback needs (arithmetic, string, …). */
function native(name: string, fn: (args: Value[]) => Value): NativeValue {
  return { kind: 'native', name, fn };
}

/** Array methods whose result is a plain value (map/filter live in interp). */
function arrayMethod(interp: Interpreter, arr: Value[], key: string): NativeValue | undefined {
  const num = (v: Value, fallback: number): number => {
    const n = toNumber(v);
    return Number.isNaN(n) ? fallback : n;
  };
  const table: Record<string, () => NativeValue> = {
    push: () => native('push', (args) => {
      arr.push(...args);
      return arr.length;
    }),
    pop: () => native('pop', () => (arr.length === 0 ? undefined : arr.pop())),
    join: () => native('join', (args) => {
      const sep = args.length > 0 && args[0] !== undefined ? valueToString(args[0]) : ',';
      return arr.map((v) => valueToString(v)).join(sep);
    }),
    indexOf: () => native('indexOf', (args) => {
      const needle = args[0] ?? undefined;
      for (let i = 0; i < arr.length; i++) {
        if (strictEquals(arr[i]!, needle)) return i;
      }
      return -1;
    }),
    slice: () => native('slice', (args) => {
      const len = arr.length;
      let start = args.length > 0 && args[0] !== undefined ? num(args[0], 0) : 0;
      let end = args.length > 1 && args[1] !== undefined ? num(args[1], len) : len;
      start = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
      end = end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
      return arr.slice(start, end);
    }),
  };
  const make = table[key];
  return make === undefined ? undefined : make();
}

function stringMethod(str: string, key: string): NativeValue | undefined {
  const table: Record<string, () => NativeValue> = {
    toUpperCase: () => native('toUpperCase', () => str.toUpperCase()),
    toLowerCase: () => native('toLowerCase', () => str.toLowerCase()),
    indexOf: () => native('indexOf', (args) => str.indexOf(valueToString(args[0] ?? undefined))),
    slice: () => native('slice', (args) => {
      const len = str.length;
      let start = args.length > 0 && args[0] !== undefined ? toNumber(args[0]) : 0;
      let end = args.length > 1 && args[1] !== undefined ? toNumber(args[1]) : len;
      start = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
      end = end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
      return str.slice(start, end);
    }),
    split: () => native('split', (args) => {
      const sep = args[0];
      if (sep === undefined) return [str];
      return str.split(valueToString(sep));
    }),
  };
  const make = table[key];
  return make === undefined ? undefined : make();
}
/** Short human label for a queued callback (event-loop panel rows). */
export function describeCallable(v: Value): string {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    if (v.kind === 'closure') return v.name === null ? 'anonymous function' : v.name;
    if (v.kind === 'native') return v.name;
  }
  return 'callback';
}

/** Fulfil a promise created by .then and release anything waiting on it. */
function settlePromise(p: PromiseValue, v: Value): void {
  p.settled = true;
  p.value = v;
  const waiting = p.waiting;
  p.waiting = [];
  for (const w of waiting) w(v);
}

function installGlobals(interp: Interpreter): void {
  const g = interp.global;
  g.vars.set('undefined', { value: undefined, kind: 'const', initialized: true, builtin: true });
  g.vars.set('NaN', { value: NaN, kind: 'const', initialized: true, builtin: true });
  g.vars.set('Infinity', { value: Infinity, kind: 'const', initialized: true, builtin: true });

  const consoleObj: ObjValue = {
    kind: 'object',
    props: {
      log: native('log', (args) => {
        interp.log(interp.formatArgs(args));
        return undefined;
      }),
      error: native('error', (args) => {
        interp.log(interp.formatArgs(args));
        return undefined;
      }),
    },
  };

  const math: Record<string, (xs: number[]) => number> = {
    floor: (xs) => Math.floor(xs[0] ?? NaN),
    ceil: (xs) => Math.ceil(xs[0] ?? NaN),
    abs: (xs) => Math.abs(xs[0] ?? NaN),
    max: (xs) => (xs.length === 0 ? -Infinity : Math.max(...xs)),
    min: (xs) => (xs.length === 0 ? Infinity : Math.min(...xs)),
    sqrt: (xs) => Math.sqrt(xs[0] ?? NaN),
    pow: (xs) => (xs[0] ?? NaN) ** (xs[1] ?? NaN),
  };
  const mathProps: Record<string, Value> = {};
  for (const name of Object.keys(math)) {
    mathProps[name] = native(name, (args) => math[name]!(args.map(toNumber)));
  }

  g.vars.set('console', { value: consoleObj, kind: 'const', initialized: true, builtin: true });
  g.vars.set('Math', { value: { kind: 'object', props: mathProps }, kind: 'const', initialized: true, builtin: true });
  g.vars.set('Number', {
    value: {
      kind: 'object',
      props: {
        isInteger: native('isInteger', (args) => typeof args[0] === 'number' && Number.isInteger(args[0])),
      },
    },
    kind: 'const',
    initialized: true,
    builtin: true,
  });

  // setTimeout: queue a MACROTASK; the delay is clamped away, queue is FIFO.
  g.vars.set('setTimeout', {
    value: native('setTimeout', (args) => {
      const fn = args[0];
      if (!isCallable(fn)) {
        throw new RuntimeErr('setTimeout expects a function as its first argument', 0);
      }
      interp.macro.push({ fn, line: interp.frames[interp.frames.length - 1]?.line ?? 1 });
      return interp.macro.length; // timer id (nothing in the subset can clear it)
    }),
    kind: 'const',
    initialized: true,
    builtin: true,
  });

  g.vars.set('Promise', {
    value: {
      kind: 'object',
      props: {
        resolve: native('resolve', (args) => {
          const v = args[0] ?? undefined;
          if (isPromise(v)) return v;
          return { kind: 'promise', settled: true, value: v, waiting: [] };
        }),
      },
    },
    kind: 'const',
    initialized: true,
    builtin: true,
  });
}
