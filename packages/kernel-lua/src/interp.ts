// interp.ts — generator-based evaluator. The main generator yields before
// every statement (anywhere in the call tree), which gives step(),
// breakpoints and line-mapped errors without unwinding on pause.
//
// The two teaching invariants live here:
//   • integer/float distinction: LuaInt and LuaFloat flow through every
//     arithmetic op; + - * // % keep integers, / and ^ always produce
//     floats, % is defined as a - b*floor(a/b) (divisor sign wins);
//   • multiple returns: only a call in the LAST position of a list
//     (assignment RHS, return, argument list) expands; anywhere else,
//     including inside parentheses, it truncates to its first value.

import {
  Builtin, Closure, Env, ExpNode, LuaError, LuaFloat, LuaInt, LuaValue,
  Program, StatNode, Table, isNum, luaEq, luaLt, numOf, toStr, truthy,
  typeName,
} from './value';
import { makeBuiltins } from './builtins';

export const BUDGET = 1_000_000;

export interface YieldInfo { line: number }

type BlockResult =
  | { kind: 'normal' }
  | { kind: 'break' }
  | { kind: 'return'; values: LuaValue[] };

export interface Frame {
  closure: Closure | null;   // null for the top-level chunk
  env: Env;
  line: number;
}

export class RuntimeErr extends LuaError {}

export class Interpreter {
  readonly globals: Table;
  /** Every table ever allocated (no GC — the heap panel is cumulative). */
  readonly tables: Table[] = [];
  readonly frames: Frame[] = [];
  out = '';
  steps = 0;
  private ops = 0;
  private builtins: Record<string, Builtin>;

  constructor(readonly program: Program) {
    this.globals = new Table();
    this.globals.internal = true;
    this.tables.push(this.globals);
    this.builtins = makeBuiltins();
    this.installGlobals();
  }

  private installGlobals(): void {
    const G = this.globals;
    G.rawSet('_G', G);
    G.rawSet('coroutine', 'poison');
    G.rawSet('print', new Builtin('print', (args) => { this.print(args); return []; }));
    for (const [name, b] of Object.entries(this.builtins)) G.rawSet(name, b);
    this.installLib('string', ['upper', 'lower', 'rep']);
    this.installLib('math', ['floor', 'abs', 'max', 'min']);
  }

  private installLib(libName: string, names: string[]): void {
    const t = new Table();
    t.internal = true;
    this.tables.push(t);
    for (const n of names) {
      const b = this.builtins[`${libName}.${n}`];
      if (b !== undefined) t.rawSet(n, b);
    }
    this.globals.rawSet(libName, t);
  }

  isDone(): boolean { return this.done; }
  private done = false;

  // ─── statements ──────────────────────────────────────────────────────────

  *runAll(): Generator<YieldInfo, void> {
    const env = new Env(null);
    this.frames.push({ closure: null, env, line: 0 });
    // the chunk frame stays on (panels keep showing top-level locals after
    // the program finishes; reset() tears everything down anyway)
    yield* this.execBlock(this.program.body, env);
    this.done = true;
  }

  private *execBlock(body: StatNode[], env: Env): Generator<YieldInfo, BlockResult> {
    for (const st of body) {
      const r = yield* this.execStat(st, env);
      if (r.kind !== 'normal') return r;
    }
    return { kind: 'normal' };
  }

  private tick(line: number): void {
    this.ops++;
    if (this.ops > BUDGET) {
      throw new RuntimeErr(`budget exceeded: more than ${BUDGET} operations`, line);
    }
  }

  private *execStat(st: StatNode, env: Env): Generator<YieldInfo, BlockResult> {
    const top = this.frames[this.frames.length - 1]!;
    top.line = st.line;
    this.steps++;
    this.tick(st.line);
    yield { line: st.line };

    switch (st.kind) {
      case 'local': {
        const vals = yield* this.evalList(st.exps, env);
        st.names.forEach((n, i) => { env.vars.set(n, vals[i] ?? null); });
        return { kind: 'normal' };
      }
      case 'assign': {
        const vals = yield* this.evalList(st.exps, env);
        // targets are evaluated after the RHS, left to right (Lua's order)
        for (let i = 0; i < st.targets.length; i++) {
          const tg = st.targets[i]!;
          const v = vals[i] ?? null;
          if (tg.kind === 'name') {
            this.assignName(tg.name, v, env);
          } else {
            const obj = yield* this.eval(tg.obj, env);
            const key = yield* this.eval(tg.key, env);
            this.setIndex(obj, key, v, tg.line);
          }
        }
        return { kind: 'normal' };
      }
      case 'exprstat':
        yield* this.evalMulti(st.call, env);
        return { kind: 'normal' };
      case 'if': {
        for (const cl of st.clauses) {
          if (truthy(yield* this.eval(cl.cond, env))) {
            return yield* this.execBlock(cl.body, new Env(env));
          }
        }
        if (st.elseBody !== null) return yield* this.execBlock(st.elseBody, new Env(env));
        return { kind: 'normal' };
      }
      case 'while': {
        for (;;) {
          this.tick(st.line);
          const c = yield* this.eval(st.cond, env);
          if (!truthy(c)) break;
          const r = yield* this.execBlock(st.body, new Env(env));
          if (r.kind === 'break') break;
          if (r.kind === 'return') return r;
        }
        return { kind: 'normal' };
      }
      case 'repeat': {
        for (;;) {
          this.tick(st.line);
          const iterEnv = new Env(env);
          const r = yield* this.execBlock(st.body, iterEnv);
          if (r.kind === 'break') break;
          if (r.kind === 'return') return r;
          // the until condition sees the body's locals (Lua's rule)
          if (truthy(yield* this.eval(st.cond, iterEnv))) break;
        }
        return { kind: 'normal' };
      }
      case 'fornum': {
        const startV = yield* this.eval(st.start, env);
        const limitV = yield* this.eval(st.limit, env);
        const stepV = st.step === null ? new LuaInt(1) : yield* this.eval(st.step, env);
        if (!isNum(startV) || !isNum(limitV) || !isNum(stepV)) {
          throw new RuntimeErr("'for' initial value must be a number", st.line);
        }
        if (numOf(stepV) === 0) throw new RuntimeErr("'for' step is zero", st.line);
        let v: LuaValue = startV;
        for (;;) {
          this.tick(st.line);
          const up = numOf(stepV) > 0;
          const past = up ? numOf(v) > numOf(limitV) : numOf(v) < numOf(limitV);
          if (past) break;
          const iterEnv = new Env(env);
          iterEnv.vars.set(st.name, v);
          const r = yield* this.execBlock(st.body, iterEnv);
          if (r.kind === 'break') break;
          if (r.kind === 'return') return r;
          v = this.arith('+', v, stepV, st.line);
        }
        return { kind: 'normal' };
      }
      case 'forin': {
        const t = yield* this.eval(st.iterArg, env);
        if (!(t instanceof Table)) {
          throw new RuntimeErr(`${st.iter} expects a table, got ${typeName(t)}`, st.line);
        }
        if (st.iter === 'ipairs') {
          for (let i = 1; ; i++) {
            this.tick(st.line);
            const v = this.getIndex(t, new LuaInt(i), st.line);
            if (v === null) break;
            const iterEnv = new Env(env);
            iterEnv.vars.set(st.names[0] ?? 'k', new LuaInt(i));
            if (st.names[1] !== undefined) iterEnv.vars.set(st.names[1], v);
            const r = yield* this.execBlock(st.body, iterEnv);
            if (r.kind === 'break') break;
            if (r.kind === 'return') return r;
          }
          return { kind: 'normal' };
        }
        // pairs(): array part in order, then remaining keys in insertion order
        const len = t.length();
        const keys: LuaValue[] = [];
        for (let i = 1; i <= len; i++) keys.push(new LuaInt(i));
        for (const e of t.entries.values()) {
          const k = e.key;
          if (k instanceof LuaInt && k.v >= 1 && k.v <= len) continue;
          keys.push(k);
        }
        for (const k of keys) {
          this.tick(st.line);
          const v = t.rawGet(k);
          const iterEnv = new Env(env);
          iterEnv.vars.set(st.names[0] ?? 'k', k);
          if (st.names[1] !== undefined) iterEnv.vars.set(st.names[1], v);
          const r = yield* this.execBlock(st.body, iterEnv);
          if (r.kind === 'break') break;
          if (r.kind === 'return') return r;
        }
        return { kind: 'normal' };
      }
      case 'do':
        return yield* this.execBlock(st.body, new Env(env));
      case 'break':
        return { kind: 'break' };
      case 'return': {
        const values = yield* this.evalList(st.exps, env);
        return { kind: 'return', values };
      }
    }
  }

  private assignName(name: string, v: LuaValue, env: Env): void {
    const hit = env.frameOf(name);
    if (hit !== null) hit.vars.set(name, v);
    else this.globals.rawSet(name, v);
  }

  // ─── expressions ─────────────────────────────────────────────────────────

  /** Evaluate an expression list with THE rule: only the last item expands. */
  private *evalList(exps: ExpNode[], env: Env): Generator<YieldInfo, LuaValue[]> {
    const out: LuaValue[] = [];
    for (let i = 0; i < exps.length; i++) {
      const e = exps[i]!;
      if (i === exps.length - 1 && (e.kind === 'call' || e.kind === 'method')) {
        out.push(...(yield* this.evalMulti(e, env)));
      } else {
        out.push(yield* this.eval(e, env));
      }
    }
    return out;
  }

  /** Single value: a call anywhere but the last slot truncates to one. */
  private *eval(e: ExpNode, env: Env): Generator<YieldInfo, LuaValue> {
    switch (e.kind) {
      case 'nil': return null;
      case 'bool': return e.value;
      case 'num': return e.value;
      case 'str': return e.value;
      case 'var': return this.readName(e.name, env, e.line);
      case 'paren': return yield* this.eval(e.e, env); // wrapper: single value
      case 'index': {
        const obj = yield* this.eval(e.obj, env);
        const key = yield* this.eval(e.key, env);
        return this.getIndex(obj, key, e.line);
      }
      case 'call':
      case 'method': {
        const vs = yield* this.evalMulti(e, env);
        return vs[0] ?? null;
      }
      case 'function':
        return new Closure(e.name, e.params, e.body, env, e.line);
      case 'tablector':
        return yield* this.evalTable(e, env);
      case 'and': {
        const l = yield* this.eval(e.l, env);
        return truthy(l) ? yield* this.eval(e.r, env) : l;
      }
      case 'or': {
        const l = yield* this.eval(e.l, env);
        return truthy(l) ? l : yield* this.eval(e.r, env);
      }
      case 'unop': {
        const v = yield* this.eval(e.e, env);
        return this.unop(e.op, v, e.line);
      }
      case 'binop': {
        if (e.op === '..') {
          const l = yield* this.eval(e.l, env);
          const r = yield* this.eval(e.r, env);
          return this.concat(l, r, e.line);
        }
        const l = yield* this.eval(e.l, env);
        const r = yield* this.eval(e.r, env);
        return this.binop(e.op, l, r, e.line);
      }
    }
  }

  /** Multi value: only calls/methods can produce more than one. */
  private *evalMulti(e: ExpNode, env: Env): Generator<YieldInfo, LuaValue[]> {
    if (e.kind === 'call') {
      const fn = yield* this.eval(e.fn, env);
      const args: LuaValue[] = [];
      for (let i = 0; i < e.args.length; i++) {
        const a = e.args[i]!;
        if (i === e.args.length - 1 && (a.kind === 'call' || a.kind === 'method')) {
          args.push(...(yield* this.evalMulti(a, env)));
        } else {
          args.push(yield* this.eval(a, env));
        }
      }
      return yield* this.callFunction(fn, args, e.line);
    }
    if (e.kind === 'method') {
      const self = yield* this.eval(e.self, env);
      const fn = this.getIndex(self, e.name, e.line);
      const args: LuaValue[] = [self];
      for (let i = 0; i < e.args.length; i++) {
        const a = e.args[i]!;
        if (i === e.args.length - 1 && (a.kind === 'call' || a.kind === 'method')) {
          args.push(...(yield* this.evalMulti(a, env)));
        } else {
          args.push(yield* this.eval(a, env));
        }
      }
      return yield* this.callFunction(fn, args, e.line);
    }
    return [yield* this.eval(e, env)];
  }

  private *evalTable(
    e: Extract<ExpNode, { kind: 'tablector' }>,
    env: Env,
  ): Generator<YieldInfo, LuaValue> {
    const t = new Table();
    this.tables.push(t);
    let idx = 1;
    for (const f of e.fields) {
      if (f.name !== null) {
        t.rawSet(f.name, yield* this.eval(f.value, env));
      } else if (f.key !== null) {
        const k = yield* this.eval(f.key, env);
        t.rawSet(k, yield* this.eval(f.value, env));
      } else {
        // positional: the next free 1-based slot ([k]=/name= skip slots)
        while (t.rawGet(new LuaInt(idx)) !== null) idx++;
        t.rawSet(new LuaInt(idx), yield* this.eval(f.value, env));
      }
    }
    return t;
  }

  // ─── calls ───────────────────────────────────────────────────────────────

  private *callFunction(fn: LuaValue, args: LuaValue[], line: number): Generator<YieldInfo, LuaValue[]> {
    if (fn instanceof Closure) {
      if (this.frames.length >= 200) {
        throw new RuntimeErr('stack overflow: call depth exceeds 200 frames', line);
      }
      const env = new Env(fn.env);
      fn.params.forEach((p, i) => { env.vars.set(p, args[i] ?? null); });
      this.frames.push({ closure: fn, env, line });
      try {
        const r = yield* this.execBlock(fn.body, env);
        return r.kind === 'return' ? r.values : [];
      } finally {
        this.frames.pop();
      }
    }
    if (fn === null || fn === 'poison' || typeof fn === 'boolean' ||
        typeof fn === 'string' || isNum(fn)) {
      if (fn === 'poison') throw new RuntimeErr('coroutine is not in the Lua subset', line);
      throw new RuntimeErr(`attempt to call a ${typeName(fn)} value`, line);
    }
    if (fn instanceof Table) {
      // __call lives on the metatable itself, not an inherited __index chain
      const h = fn.metatable?.rawGet('__call') ?? null;
      if (h !== null) return yield* this.callFunction(h, [fn, ...args], line);
      throw new RuntimeErr('attempt to call a table value', line);
    }
    // Builtin
    try {
      return fn.call(args);
    } catch (err) {
      if (err instanceof LuaError && err.line === null) err.line = line;
      throw err;
    }
  }

  // ─── variables and tables ────────────────────────────────────────────────

  private readName(name: string, env: Env, line: number): LuaValue {
    const hit = env.frameOf(name);
    if (hit !== null) return hit.vars.get(name) ?? null;
    const v = this.globals.rawGet(name);
    if (v === 'poison') {
      throw new RuntimeErr(`${name} is not in the Lua subset`, line);
    }
    return v; // undefined global reads as nil
  }

  /** t[k] with the __index chain: tables first, then one function. */
  getIndex(obj: LuaValue, key: LuaValue, line: number): LuaValue {
    if (key === null) throw new RuntimeErr('table index is nil', line);
    if (obj === 'poison') throw new RuntimeErr('coroutine is not in the Lua subset', line);
    if (!(obj instanceof Table)) {
      // string indexing for the string library: s:upper()
      if (typeof obj === 'string') {
        const strlib = this.globals.rawGet('string');
        if (strlib instanceof Table) {
          const m = strlib.rawGet(key);
          if (m !== null) return m;
        }
        return null; // string values have no fields of their own
      }
      throw new RuntimeErr(`attempt to index a ${typeName(obj)} value`, line);
    }
    let cur: Table = obj;
    for (let depth = 0; ; depth++) {
      const direct = cur.rawGet(key);
      if (direct !== null) return direct;
      if (depth > 100) throw new RuntimeErr("'__index' chain too deep; possible loop", line);
      const mt = cur.metatable;
      if (mt === null) return null;
      const h = mt.rawGet('__index');
      if (h === null) return null;
      if (h instanceof Table) { cur = h; continue; }
      if (h instanceof Closure || h instanceof Builtin) {
        const vs = this.callBuiltinish(h, [obj, key], line);
        return vs[0] ?? null;
      }
      return null;
    }
  }

  /** t[k] = v with optional __newindex (table or function, else raw set). */
  setIndex(obj: LuaValue, key: LuaValue, v: LuaValue, line: number): void {
    if (key === null) throw new RuntimeErr('table index is nil', line);
    if (!(obj instanceof Table)) {
      throw new RuntimeErr(`attempt to index a ${typeName(obj)} value`, line);
    }
    let cur: Table = obj;
    for (let depth = 0; ; depth++) {
      if (cur.rawGet(key) !== null) { cur.rawSet(key, v); return; }
      if (depth > 100) throw new RuntimeErr("'__newindex' chain too deep; possible loop", line);
      const mt = cur.metatable;
      if (mt === null) { cur.rawSet(key, v); return; }
      const h = mt.rawGet('__newindex');
      if (h === null) { cur.rawSet(key, v); return; }
      if (h instanceof Table) { cur = h; continue; }
      if (h instanceof Closure || h instanceof Builtin) {
        this.callBuiltinish(h, [obj, key, v], line);
        return;
      }
      cur.rawSet(key, v);
      return;
    }
  }

  /** Call a Closure/Builtin from a non-generator context (metamethods). */
  private callBuiltinish(fn: Closure | Builtin, args: LuaValue[], line: number): LuaValue[] {
    if (fn instanceof Builtin) {
      try {
        return fn.call(args);
      } catch (err) {
        if (err instanceof LuaError && err.line === null) err.line = line;
        throw err;
      }
    }
    // Closure metamethods run synchronously via a private driver; their
    // statements do not yield into the user's step stream.
    const env = new Env(fn.env);
    fn.params.forEach((p, i) => { env.vars.set(p, args[i] ?? null); });
    this.frames.push({ closure: fn, env, line });
    const gen = this.execBlock(fn.body, env);
    try {
      let r = gen.next();
      while (!r.done) r = gen.next();
      const b = r.value;
      return b.kind === 'return' ? b.values : [];
    } finally {
      this.frames.pop();
    }
  }

  // ─── operators ───────────────────────────────────────────────────────────

  private arith(op: string, a: LuaValue, b: LuaValue, line: number): LuaValue {
    const bothInt = a instanceof LuaInt && b instanceof LuaInt;
    const x = numOf(a);
    const y = numOf(b);
    switch (op) {
      case '+': case '-': case '*': {
        const r = op === '+' ? x + y : op === '-' ? x - y : x * y;
        if (bothInt && Number.isSafeInteger(r)) return new LuaInt(r);
        return new LuaFloat(r);
      }
      case '/':
        return new LuaFloat(x / y);
      case '//': {
        const r = Math.floor(x / y);
        if (bothInt && Number.isSafeInteger(r)) return new LuaInt(r);
        return new LuaFloat(r);
      }
      case '%': {
        // Lua: a % b == a - floor(a/b)*b — the DIVISOR's sign wins.
        const r = x - Math.floor(x / y) * y;
        if (bothInt && Number.isSafeInteger(r)) return new LuaInt(r);
        return new LuaFloat(r);
      }
      case '^':
        return new LuaFloat(x ** y);
    }
    throw new RuntimeErr(`bad arithmetic op '${op}'`, line);
  }

  private binop(op: string, l: LuaValue, r: LuaValue, line: number): LuaValue {
    if (op === '+' || op === '-' || op === '*' || op === '/' || op === '//' || op === '%' || op === '^') {
      return this.arith(op, l, r, line);
    }
    if (op === '==') return luaEq(l, r);
    if (op === '~=') return !luaEq(l, r);
    if (op === '<') return luaLt(l, r, line);
    if (op === '<=') return !luaLt(r, l, line);
    if (op === '>') return luaLt(r, l, line);
    if (op === '>=') return !luaLt(l, r, line);
    throw new RuntimeErr(`bad operator '${op}'`, line);
  }

  private concat(l: LuaValue, r: LuaValue, line: number): string {
    const a = isNum(l) ? toStr(l) : l;
    const b = isNum(r) ? toStr(r) : r;
    if (typeof a === 'string' && typeof b === 'string') {
      if (a.length + b.length > 1_000_000) throw new RuntimeErr('string too large', line);
      return a + b;
    }
    throw new RuntimeErr(`attempt to concatenate a ${typeName(typeof a === 'string' ? b : a)} value`, line);
  }

  private unop(op: string, v: LuaValue, line: number): LuaValue {
    if (op === 'not') return !truthy(v);
    if (op === '-') {
      if (v instanceof LuaInt) return new LuaInt(-v.v);
      if (v instanceof LuaFloat) return new LuaFloat(-v.v);
      if (typeof v === 'string') return this.arith('-', new LuaInt(0), v, line);
      throw new RuntimeErr(`attempt to perform arithmetic on a ${typeName(v)} value`, line);
    }
    // '#'
    if (typeof v === 'string') return new LuaInt(v.length);
    if (v instanceof Table) return new LuaInt(v.length());
    throw new RuntimeErr(`attempt to get length of a ${typeName(v)} value`, line);
  }

  print(args: LuaValue[]): void {
    this.out += args.map((v) => toStr(v)).join('\t') + '\n';
  }
}
