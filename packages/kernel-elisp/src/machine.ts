// The Emacs Lisp machine: a small-step evaluator built on generators.
//
// One `step()` resumes the generator to its next `yield`, which represents
// the form that is *about to* be reduced. Evaluation of subforms nests with
// `yield*`, so a single step is one eval/apply entry while the JS stack is
// suspended — good enough for breakpoints and a control-stack panel without
// an explicit continuation union for every special form.
//
// Binding model:
//   * `let`/`let*`/function arguments are DYNAMIC when `lexical-binding` is
//     nil, and LEXICAL when it is non-nil.
//   * `defvar`/`defconst` mark a name special: it is always dynamically
//     bound, even under lexical-binding (as in Emacs).
//   * Function names live in a separate namespace (Lisp-2): `(f x)` uses
//     f's function cell, `(funcall 'f x)` (or a lambda value) does not.

import {
  Builtin, Closure, Cons, DynFrame, Env, FormArray, FormVector, LispError,
  Macro, ThrowSignal, Buffer, Sym, Vec, Struct, arrayOf, eq, equal, listOf,
  nil, renderForm, renderWrite, t, truthy, type BuiltinCtx,
  type Form, type Params, type Value,
} from './value';
import { makeBuiltins } from './builtins';
import { callBuiltin, type Runtime } from './runtime';

const BUDGET = 250_000;
const MAX_DEPTH = 400;
const MAX_MACRO_EXPANSIONS = 100;

const SPECIAL = new Set([
  'quote', 'function', 'quasiquote', 'if', 'cond', 'when', 'unless', 'and', 'or',
  'progn', 'prog1', 'prog2', 'setq', 'setq-default', 'let', 'let*',
  'while', 'dolist', 'dotimes', 'defun', 'defvar', 'defconst', 'defmacro',
  'setq-local',
  'lambda', 'fset', 'defalias', 'catch', 'throw', 'unwind-protect',
  'condition-case', 'ignore-errors', 'save-excursion', 'with-current-buffer',
  'with-temp-buffer', 'defvar-local', 'push', 'when-let*', 'pcase',
  'save-restriction', 'save-match-data', 'rx', 'cl-defun', 'cl-defstruct', 'setf',
  'interactive',
]);

/** Machine-level functions: their arguments are evaluated, then the machine
 *  itself applies user functions (so hooks/commands stay steppable). */
const INTERCEPTED = new Set([
  'funcall', 'apply', 'mapcar', 'mapc', 'run-hooks', 'run-hook-with-args',
  'call-interactively', 'macroexpand', 'macroexpand-1',
  'seq-filter', 'seq-map', 'seq-reduce', 'alist-get',
  'symbol-value', 'boundp', 'set',
]);

export interface Step {
  form: Form | null;
  line: number;
  env: Env | null;
  label: string;
  stack: string[];
  kind: 'eval' | 'apply';
}

export interface LoadedSource {
  forms: Form[];
  lines?: number[];
  lexicalBinding: boolean;
}

export interface SharedState {
  special: Set<string>;
  touched: Set<string>;
}

export class ElispMachine {
  readonly runtime: Runtime;
  /** Innermost dynamic frame last. */
  readonly dynamic: DynFrame[] = [];
  /** Names marked special by defvar/defconst (this session only). */
  readonly special: Set<string>;
  /** Symbols the program defined/assigned (drives the Symbols panel). */
  readonly touched: Set<string>;
  /** Names changed by the step that just ran (cleared by `step`). */
  readonly changed = new Set<string>();

  steps = 0;
  error: string | null = null;
  finished = false;
  lastValue: Value = nil;
  current: Step | null = null;

  private readonly labels: string[] = [];
  private reductions = 0;
  private depth = 0;
  private gen: Generator<Step, void, unknown>;

  constructor(readonly source: LoadedSource, runtime: Runtime, shared?: SharedState) {
    this.runtime = runtime;
    this.special = shared?.special ?? new Set();
    this.touched = shared?.touched ?? new Set();
    runtime.dynamicFrames = this.dynamic;
    runtime.output = '';
    runtime.clearChanged();
    for (const [name, fn] of makeBuiltins(runtime)) {
      if (!runtime.globalFunctions.has(name)) runtime.globalFunctions.set(name, fn);
    }
    // Placeholders so `#'funcall` is a function value; calls are intercepted.
    for (const name of INTERCEPTED) {
      if (!runtime.globalFunctions.has(name)) {
        runtime.globalFunctions.set(name, new Builtin(name, 0, Infinity, () => {
          throw new LispError(`internal: ${name} must be intercepted`);
        }));
      }
    }
    if (shared === undefined || source.lexicalBinding) {
      runtime.globalValues.set('lexical-binding', source.lexicalBinding ? t : nil);
    }
    this.gen = this.runProgram(source.forms);
    this.pull();
  }

  // ---- driver ------------------------------------------------------------

  /** Execute the pending step and stop before the next one. */
  step(): void {
    if (this.error !== null || this.finished || this.current === null) return;
    this.changed.clear();
    this.runtime.clearChanged();
    try {
      const r = this.gen.next();
      this.steps++;
      if (r.done) { this.current = null; this.finished = true; }
      else this.current = r.value;
    } catch (e) {
      this.steps++;
      this.fail(e);
    }
  }

  /** 1-based line the machine is paused before. */
  currentLine(): number | null {
    return this.current?.line ?? null;
  }

  /** Run to completion or stop before a breakpoint line. */
  run(breakpoints?: number[]): void {
    const bps = breakpoints !== undefined ? new Set(breakpoints) : null;
    while (!this.finished && this.error === null) {
      const line = this.currentLine();
      if (bps !== null && line !== null && bps.has(line)) return;
      this.step();
    }
  }

  private pull(): void {
    try {
      const r = this.gen.next();
      if (r.done) { this.current = null; this.finished = true; }
      else this.current = r.value;
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    const at = this.currentLine() ?? undefined;
    if (e instanceof ThrowSignal) {
      this.error = `no catch for tag: ${renderWrite(e.tag)}${at !== undefined ? ` (line ${at})` : ''}`;
      return;
    }
    if (e instanceof LispError) {
      const line = e.line ?? at;
      this.error = line !== undefined ? `${e.message} (line ${line})` : e.message;
      return;
    }
    if (e instanceof RangeError) {
      const msg = e.message;
      if (/Invalid (array|string) length|allocation failed/i.test(msg)) {
        this.error = `range error: ${msg}${at !== undefined ? ` (line ${at})` : ''}`;
      } else {
        this.error = `max-lisp-eval-depth exceeded (line ${at ?? 1})`;
      }
      return;
    }
    this.error = `internal error: ${e instanceof Error ? e.message : String(e)}`;
  }

  // ---- generator core ----------------------------------------------------

  /** Charge work that happens inside one generator step (loop iterations,
   *  sequence walks) so builtins cannot run unbounded synchronously. */
  private tick(n = 1, line?: number): void {
    this.reductions += n;
    if (this.reductions > BUDGET) {
      throw new LispError(`run budget exceeded (${BUDGET} reductions)`, line, 'overflow');
    }
  }

  private *runProgram(forms: Form[]): Generator<Step, void, unknown> {
    for (let i = 0; i < forms.length; i++) {
      const form = forms[i]!;
      this.lastValue = yield* this.eval(form, null, this.source.lines?.[i] ?? lineOf(form, 1));
    }
  }

  private *eval(form: Form, env: Env | null, line: number): Generator<Step, Value> {
    if (++this.depth > MAX_DEPTH) {
      this.depth--;
      throw new LispError('max-lisp-eval-depth exceeded', line, 'overflow');
    }
    if (++this.reductions > BUDGET) {
      this.depth--;
      throw new LispError(`run budget exceeded (${BUDGET} reductions)`, line, 'overflow');
    }
    const label = `eval ${renderForm(form)}`;
    this.labels.push(label);
    try {
      yield { form, line, env, label, stack: this.labels.slice(0, -1), kind: 'eval' };
      return yield* this.evalInner(form, env, line);
    } finally {
      this.labels.pop();
      this.depth--;
    }
  }

  private *evalInner(form: Form, env: Env | null, line: number): Generator<Step, Value> {
    if (form instanceof FormVector) {
      return new Vec(form.items.map((f) => this.formToValue(f)));
    }
    if (!Array.isArray(form)) {
      if (form instanceof Sym) {
        if (form === nil || form === t || form.name.startsWith(':')) return form;
        return this.lookupVar(form.name, env, line);
      }
      return form;
    }
    if (form.length === 0) return nil;
    if (form.dot !== undefined) {
      throw new LispError(`invalid-function ${renderForm(form)}`, line, 'invalid-function');
    }

    const head = form[0]!;
    const args = form.slice(1) as Form[];
    if (head instanceof Sym) {
      const name = head.name;
      if (SPECIAL.has(name)) return yield* this.evalSpecial(name, args, env, line);
      if (INTERCEPTED.has(name)) return yield* this.intercepted(name, args, env, line);
      const cell = this.resolveFunction(name, line);
      if (cell instanceof Macro) return yield* this.expandMacro(cell, args, env, line);
      const vals = yield* this.evalArgs(args, env, line);
      return yield* this.applyFn(cell, vals, line);
    }
    const fn = yield* this.eval(head, env, lineOf(head, line));
    const vals = yield* this.evalArgs(args, env, line);
    return yield* this.applyFn(fn, vals, line);
  }

  private *evalArgs(forms: Form[], env: Env | null, line: number): Generator<Step, Value[]> {
    const out: Value[] = [];
    for (const f of forms) out.push(yield* this.eval(f, env, lineOf(f, line)));
    return out;
  }

  private *evalSeq(forms: Form[], env: Env | null, line: number): Generator<Step, Value> {
    let v: Value = nil;
    for (const f of forms) v = yield* this.eval(f, env, lineOf(f, line));
    return v;
  }

  get output(): string { return this.runtime.output; }

  // ---- calls -------------------------------------------------------------

  private *applyFn(fn0: Value, args: Value[], line: number): Generator<Step, Value> {
    const fn = this.resolveValue(fn0, line);
    if (fn instanceof Builtin && INTERCEPTED.has(fn.name)) {
      return yield* this.applyIntercepted(fn.name, args, line);
    }
    if (fn instanceof Builtin) {
      this.labels.push(`apply ${fn.name}`);
      try {
        yield this.applyStep(fn.name, line, null);
        const ctx: BuiltinCtx = {
          runtime: this.runtime,
          out: (text) => this.runtime.emit(text),
          line,
        };
        return callBuiltin(fn, args, ctx);
      } finally {
        this.labels.pop();
      }
    }
    if (fn instanceof Closure) {
      const who = fn.name ?? 'lambda';
      bindArity(fn.params, args.length, who, line);
      if (++this.depth > MAX_DEPTH) {
        this.depth--;
        throw new LispError('max-lisp-eval-depth exceeded', line, 'overflow');
      }
      this.labels.push(`apply ${who}`);
      try {
        yield this.applyStep(who, line, fn.env);
        if (fn.lexical) {
          const frame = new Env(`${who} args (line ${fn.line})`, fn.env);
          this.bindParams(frame.vars, fn.params, args, who, line);
          return yield* this.evalSeq(fn.body, frame, line);
        }
        const frame = new DynFrame(`${who} args (line ${fn.line})`);
        this.bindParams(frame.vars, fn.params, args, who, line);
        this.dynamic.push(frame);
        try {
          return yield* this.evalSeq(fn.body, null, line);
        } finally {
          this.dynamic.pop();
        }
      } finally {
        this.labels.pop();
        this.depth--;
      }
    }
    if (fn instanceof Macro) {
      throw new LispError(`invalid-function ${fn.name}`, line, 'invalid-function');
    }
    throw new LispError(`invalid-function ${renderWrite(fn)}`, line, 'invalid-function');
  }

  private applyStep(who: string, line: number, env: Env | null): Step {
    return {
      form: null,
      line,
      env,
      label: `apply ${who}`,
      stack: this.labels.slice(0, -1),
      kind: 'apply',
    };
  }

  private bindParams(
    vars: Map<string, Value>,
    params: Params,
    args: Value[],
    who: string,
    line: number,
  ): void {
    bindArity(params, args.length, who, line);
    for (const name of [...params.required, ...params.optional,
      ...(params.rest === null ? [] : [params.rest]), ...params.keys.map((k) => k.name)]) {
      assertSettable(name, line);
    }
    params.required.forEach((name, i) => vars.set(name, args[i]!));
    params.optional.forEach((name, i) => vars.set(name, args[params.required.length + i] ?? nil));
    const base = params.required.length + params.optional.length;
    if (params.keys.length > 0) {
      const rest = args.slice(base);
      const supplied = new Map<string, Value>();
      for (let i = 0; i < rest.length; i += 2) {
        const key = rest[i];
        if (!(key instanceof Sym) || !key.name.startsWith(':')) {
          throw new LispError(`${who}: expected a keyword argument, got ${renderWrite(key ?? nil)}`, line, 'wrong-type-argument');
        }
        if (i + 1 >= rest.length) {
          throw new LispError(`${who}: missing value for ${key.name}`, line, 'wrong-number-of-arguments');
        }
        supplied.set(key.name.slice(1), rest[i + 1]!);
      }
      for (const key of params.keys) {
        const v = supplied.get(key.name);
        vars.set(key.name, v ?? (key.default === null ? nil : this.formToValue(key.default)));
      }
      return;
    }
    if (params.rest !== null) vars.set(params.rest, listOf(args.slice(base)));
  }

  /** Resolve a function designator: symbols go through the function cell. */
  private resolveValue(v: Value, line: number): Value {
    let cur = v;
    for (let guard = 0; guard < 100; guard++) {
      if (!(cur instanceof Sym)) return cur;
      cur = this.resolveFunction(cur.name, line);
    }
    throw new LispError('function alias loop', line, 'error');
  }

  private resolveFunction(name: string, line: number): Value {
    let cur: Value | undefined = this.runtime.globalFunctions.get(name);
    let current = name;
    for (let guard = 0; guard < 100; guard++) {
      if (cur === undefined) throw new LispError(`void-function ${current}`, line, 'void-function');
      if (!(cur instanceof Sym)) return cur;
      current = cur.name;
      cur = this.runtime.globalFunctions.get(current);
    }
    throw new LispError('function alias loop', line, 'error');
  }

  // ---- macro expansion ---------------------------------------------------

  private *expandMacro(macro: Macro, argForms: Form[], env: Env | null, line: number): Generator<Step, Value> {
    const args = argForms.map((f) => this.formToValue(f));
    const expansion = yield* this.applyFn(macro.transformer, args, line);
    const form = this.valueToForm(expansion, line);
    return yield* this.eval(form, env, line);
  }

  private *macroexpandOnce(formValue: Value, line: number, full: boolean): Generator<Step, Value> {
    let cur = formValue;
    for (let i = 0; i < (full ? MAX_MACRO_EXPANSIONS : 1); i++) {
      if (!(cur instanceof Cons)) return cur;
      const head = cur.car;
      if (!(head instanceof Sym)) return cur;
      const cell = this.runtime.globalFunctions.get(head.name);
      if (!(cell instanceof Macro)) return cur;
      cur = yield* this.applyFn(cell.transformer, arrayOf(cur.cdr, 'macroexpand'), line);
    }
    return cur;
  }

  // ---- special forms -----------------------------------------------------

  private *evalSpecial(
    name: string,
    args: Form[],
    env: Env | null,
    line: number,
  ): Generator<Step, Value> {
    switch (name) {
      case 'quote': {
        if (args.length !== 1) throw new LispError(`quote: expected 1 argument, got ${args.length}`, line);
        return this.formToValue(args[0]!);
      }
      case 'function': {
        if (args.length !== 1) throw new LispError(`function: expected 1 argument, got ${args.length}`, line);
        const target = args[0]!;
        if (target instanceof Sym) return target;
        if (Array.isArray(target)) return yield* this.makeLambda(target, env, line);
        throw new LispError('function: expected a symbol or lambda', line, 'wrong-type-argument');
      }
      case 'quasiquote': {
        if (args.length !== 1) throw new LispError('quasiquote: expected 1 template', line);
        return yield* this.eval(qqExpand(args[0]!, 1, line), env, line);
      }
      case 'lambda':
        return yield* this.makeLambdaFromArgs(args, env, line);
      case 'if': {
        if (args.length < 2) {
          throw new LispError(`if: expected at least 2 arguments, got ${args.length}`, line);
        }
        const test = yield* this.eval(args[0]!, env, lineOf(args[0]!, line));
        if (truthy(test)) return yield* this.eval(args[1]!, env, lineOf(args[1]!, line));
        // Emacs allows any number of ELSE forms; the last one wins
        return yield* this.evalSeq(args.slice(2), env, line);
      }
      case 'cond': return yield* this.doCond(args, env, line);
      case 'when':
      case 'unless': {
        if (args.length === 0) throw new LispError(`${name}: expected a test`, line);
        const test = yield* this.eval(args[0]!, env, lineOf(args[0]!, line));
        const run = name === 'when' ? truthy(test) : !truthy(test);
        return run ? yield* this.evalSeq(args.slice(1), env, line) : nil;
      }
      case 'and': {
        let v: Value = t;
        for (const f of args) {
          v = yield* this.eval(f, env, lineOf(f, line));
          if (!truthy(v)) return nil;
        }
        return v;
      }
      case 'or': {
        for (const f of args) {
          const v = yield* this.eval(f, env, lineOf(f, line));
          if (truthy(v)) return v;
        }
        return nil;
      }
      case 'progn': return yield* this.evalSeq(args, env, line);
      case 'prog1': {
        if (args.length === 0) return nil;
        const first = yield* this.eval(args[0]!, env, lineOf(args[0]!, line));
        yield* this.evalSeq(args.slice(1), env, line);
        return first;
      }
      case 'prog2': {
        if (args.length < 2) throw new LispError('prog2: expected at least 2 arguments', line);
        yield* this.eval(args[0]!, env, lineOf(args[0]!, line));
        const second = yield* this.eval(args[1]!, env, lineOf(args[1]!, line));
        yield* this.evalSeq(args.slice(2), env, line);
        return second;
      }
      case 'setq':
      case 'setq-default': {
        if (args.length % 2 !== 0) {
          throw new LispError(`${name}: expected an even number of arguments`, line, 'wrong-number-of-arguments');
        }
        let v: Value = nil;
        for (let i = 0; i < args.length; i += 2) {
          const target = args[i]!;
          if (!(target instanceof Sym)) throw new LispError(`${name}: variable name must be a symbol`, line, 'wrong-type-argument');
          assertSettable(target.name, line);
          v = yield* this.eval(args[i + 1]!, env, lineOf(args[i + 1]!, line));
          if (name === 'setq') this.assignVar(target.name, v, env);
          else this.setGlobal(target.name, v);
          this.touch(target.name, true);
        }
        return v;
      }
      case 'setq-local': {
        if (args.length === 0 || args.length % 2 !== 0) {
          throw new LispError('setq-local: expected SYMBOL VALUE pairs', line, 'wrong-number-of-arguments');
        }
        let v: Value = nil;
        for (let i = 0; i < args.length; i += 2) {
          const target = args[i]!;
          if (!(target instanceof Sym)) {
            throw new LispError('setq-local: variable name must be a symbol', line, 'wrong-type-argument');
          }
          assertSettable(target.name, line);
          v = yield* this.eval(args[i + 1]!, env, lineOf(args[i + 1]!, line));
          this.runtime.setLocalVariable(this.runtime.current, target.name, v);
          this.changed.add(target.name);
        }
        return v;
      }
      case 'let':
      case 'let*': return yield* this.doLet(name, args, env, line);
      case 'while': {
        if (args.length === 0) return nil;
        while (truthy(yield* this.eval(args[0]!, env, lineOf(args[0]!, line)))) {
          yield* this.evalSeq(args.slice(1), env, line);
        }
        return nil;
      }
      case 'dolist': return yield* this.doDolist(args, env, line);
      case 'dotimes': return yield* this.doDotimes(args, env, line);
      case 'defun':
      case 'defmacro':
      case 'cl-defun': return yield* this.doDefun(name as 'defun' | 'defmacro' | 'cl-defun', args, env, line);
      case 'cl-defstruct': return this.doClDefstruct(args, line);
      case 'setf': return yield* this.doSetf(args, env, line);
      case 'defvar':
      case 'defconst': return yield* this.doDefvar(name, args, env, line);
      case 'fset':
      case 'defalias': {
        if (args.length !== 2) throw new LispError(`${name}: expected 2 arguments, got ${args.length}`, line);
        const target = yield* this.eval(args[0]!, env, lineOf(args[0]!, line));
        if (!(target instanceof Sym)) throw new LispError(`${name}: expected a symbol`, line, 'wrong-type-argument');
        const fn = yield* this.eval(args[1]!, env, lineOf(args[1]!, line));
        this.runtime.globalFunctions.set(target.name, fn);
        this.touch(target.name, true);
        return fn;
      }
      case 'catch': {
        if (args.length === 0) throw new LispError('catch: expected a tag', line);
        const tag = yield* this.eval(args[0]!, env, lineOf(args[0]!, line));
        try {
          return yield* this.evalSeq(args.slice(1), env, line);
        } catch (e) {
          if (e instanceof ThrowSignal && eq(e.tag, tag)) return e.value;
          throw e;
        }
      }
      case 'throw': {
        if (args.length !== 2) throw new LispError(`throw: expected 2 arguments, got ${args.length}`, line);
        const tag = yield* this.eval(args[0]!, env, lineOf(args[0]!, line));
        const value = yield* this.eval(args[1]!, env, lineOf(args[1]!, line));
        throw new ThrowSignal(tag, value);
      }
      case 'unwind-protect': {
        if (args.length === 0) throw new LispError('unwind-protect: expected a body form', line);
        let result: Value = nil;
        try {
          result = yield* this.eval(args[0]!, env, lineOf(args[0]!, line));
        } finally {
          yield* this.evalSeq(args.slice(1), env, line);
        }
        return result;
      }
      case 'condition-case': return yield* this.doConditionCase(args, env, line);
      case 'ignore-errors': {
        try {
          return yield* this.evalSeq(args, env, line);
        } catch (e) {
          if (e instanceof LispError) return nil;
          throw e;
        }
      }
      case 'save-excursion': {
        const buf = this.runtime.current;
        const marker = buf.addMarker(buf.point);
        try {
          return yield* this.evalSeq(args, env, line);
        } finally {
          if (this.runtime.isLive(buf)) {
            this.runtime.setCurrent(buf);
            buf.point = marker.pos ?? buf.point;
          }
          buf.removeMarker(marker);
        }
      }
      case 'with-current-buffer': {
        if (args.length === 0) throw new LispError('with-current-buffer: expected a buffer', line);
        const target = yield* this.eval(args[0]!, env, lineOf(args[0]!, line));
        const buf = this.bufferOf(target, line);
        const previous = this.runtime.current;
        this.runtime.setCurrent(buf);
        try {
          return yield* this.evalSeq(args.slice(1), env, line);
        } finally {
          if (this.runtime.isLive(previous)) this.runtime.setCurrent(previous);
        }
      }
      case 'save-restriction': {
        const buf = this.runtime.current;
        const start = buf.narrowStart;
        const end = buf.narrowEnd;
        try {
          return yield* this.evalSeq(args, env, line);
        } finally {
          if (this.runtime.isLive(buf)) {
            this.runtime.setCurrent(buf);
            buf.narrowStart = start;
            buf.narrowEnd = end;
          }
        }
      }
      case 'save-match-data': {
        const saved = this.runtime.matchData;
        try {
          return yield* this.evalSeq(args, env, line);
        } finally {
          this.runtime.matchData = saved;
        }
      }
      case 'rx':
        return rxExpand(args, line);
      case 'with-temp-buffer': {
        const temp = this.runtime.generateNewBuffer('*temp*');
        const previous = this.runtime.current;
        this.runtime.setCurrent(temp);
        try {
          return yield* this.evalSeq(args, env, line);
        } finally {
          this.runtime.killBuffer(temp);
          if (this.runtime.isLive(previous)) this.runtime.setCurrent(previous);
        }
      }
      case 'defvar-local': {
        const target = args[0];
        if (!(target instanceof Sym)) {
          throw new LispError('defvar-local: name must be a symbol', line, 'wrong-type-argument');
        }
        assertSettable(target.name, line);
        this.special.add(target.name);
        this.runtime.bufferLocalVariables.add(target.name);
        if (args.length > 1 && !this.runtime.globalValues.has(target.name)) {
          const v = yield* this.eval(args[1]!, env, lineOf(args[1]!, line));
          this.setGlobal(target.name, v);
        }
        this.touch(target.name, true);
        return target;
      }
      case 'push': {
        if (args.length !== 2) {
          throw new LispError('push: expected an expression and a place', line, 'wrong-number-of-arguments');
        }
        const value = yield* this.eval(args[0]!, env, lineOf(args[0]!, line));
        const place = args[1]!;
        if (!(place instanceof Sym)) {
          throw new LispError('push: place must be a symbol', line, 'wrong-type-argument');
        }
        assertSettable(place.name, line);
        const old = this.lookupVar(place.name, env, line);
        this.assignVar(place.name, new Cons(value, old), env);
        this.touch(place.name, true);
        return this.lookupVar(place.name, env, line);
      }
      case 'when-let*': {
        const specs = args[0];
        if (specs === undefined || !Array.isArray(specs)) {
          throw new LispError('when-let*: expected a binding list', line);
        }
        const lexical = this.bindingMode(env);
        const frame = lexical ? new Env(`when-let* (line ${line})`, env) : new DynFrame(`when-let* (line ${line})`);
        if (!lexical) this.dynamic.push(frame);
        try {
          for (const spec of specs) {
            let name: string;
            let valueForm: Form;
            if (spec instanceof Sym) {
              name = spec.name;
              valueForm = spec;
            } else if (Array.isArray(spec) && spec.length === 2 && spec[0] instanceof Sym) {
              name = spec[0].name;
              valueForm = spec[1]!;
            } else {
              throw new LispError('when-let*: each binding must be a symbol or (name value)', line, 'wrong-type-argument');
            }
            const v = yield* this.eval(valueForm, frame instanceof Env ? frame : env, lineOf(valueForm, line));
            if (!truthy(v)) return nil;
            frame.vars.set(name, v);
          }
          return yield* this.evalSeq(args.slice(1), frame instanceof Env ? frame : env, line);
        } finally {
          if (!lexical) this.dynamic.pop();
        }
      }
      case 'pcase': return yield* this.doPcase(args, env, line);
      case 'interactive':
        return nil;
      default:
        throw new LispError(`internal: unhandled special form ${name}`, line);
    }
  }

  private *doPcase(args: Form[], env: Env | null, line: number): Generator<Step, Value> {
    if (args.length === 0) throw new LispError('pcase: expected a value', line);
    const value = yield* this.eval(args[0]!, env, lineOf(args[0]!, line));
    for (const clause of args.slice(1)) {
      if (!Array.isArray(clause) || clause.length === 0) {
        throw new LispError('pcase: malformed clause', line);
      }
      const binds = new Map<string, Value>();
      if (!pcaseMatch(clause[0]!, value, binds)) continue;
      const frame = new Env(`pcase (line ${line})`, env);
      for (const [name, v] of binds) frame.vars.set(name, v);
      return yield* this.evalSeq(clause.slice(1), frame, line);
    }
    return nil;
  }

  private *doCond(args: Form[], env: Env | null, line: number): Generator<Step, Value> {
    for (const clause of args) {
      if (!Array.isArray(clause) || clause.length === 0) {
        throw new LispError('cond: empty clause', line);
      }
      const first = clause[0]!;
      const isElse = first instanceof Sym && first.name === 't';
      const test = isElse ? t : yield* this.eval(first, env, lineOf(first, line));
      if (truthy(test)) {
        if (clause.length === 1) return test;
        return yield* this.evalSeq(clause.slice(1), env, line);
      }
    }
    return nil;
  }

  private *doLet(
    kind: 'let' | 'let*',
    args: Form[],
    env: Env | null,
    line: number,
  ): Generator<Step, Value> {
    const bindings = args[0];
    if (bindings !== undefined && !Array.isArray(bindings)) {
      throw new LispError(`${kind}: expected a binding list`, line);
    }
    const pairs = this.bindingPairs((bindings ?? []) as FormArray, kind, line);
    for (const p of pairs) assertSettable(p.name, line);
    const body = args.slice(1);
    const lexical = this.bindingMode(env);
    const lexFrame = lexical ? new Env(`${kind} (line ${line})`, env) : null;
    const dynFrame = new DynFrame(`${kind} (line ${line})`);
    let dynUsed = false;
    const bind = (name: string, value: Value): void => {
      if (lexical && !this.special.has(name)) lexFrame!.vars.set(name, value);
      else { dynFrame.vars.set(name, value); dynUsed = true; }
    };
    if (kind === 'let') {
      const vals: Value[] = [];
      for (const p of pairs) {
        vals.push(p.value === null ? nil : yield* this.eval(p.value, env, lineOf(p.value, line)));
      }
      pairs.forEach((p, i) => bind(p.name, vals[i]!));
    } else {
      // special variables may switch a binding to the dynamic frame even
      // when lexical-binding is on, so keep the frame live while later
      // initialisers and the body run; pop even if it stayed empty
      this.dynamic.push(dynFrame);
      try {
        for (const p of pairs) {
          const evalEnv = lexFrame ?? env;
          const v = p.value === null ? nil : yield* this.eval(p.value, evalEnv, lineOf(p.value, line));
          bind(p.name, v);
        }
        return yield* this.evalSeq(body, lexFrame ?? env, line);
      } finally {
        this.dynamic.pop();
      }
    }
    if (dynUsed) this.dynamic.push(dynFrame);
    try {
      return yield* this.evalSeq(body, lexFrame ?? env, line);
    } finally {
      if (dynUsed) this.dynamic.pop();
    }
  }

  private bindingPairs(bindings: FormArray, who: string, line: number): { name: string; value: Form | null }[] {
    const out: { name: string; value: Form | null }[] = [];
    for (const b of bindings) {
      if (b instanceof Sym) { out.push({ name: b.name, value: null }); continue; }
      if (!Array.isArray(b) || b.length === 0 || b.length > 2 || !(b[0] instanceof Sym)) {
        throw new LispError(`${who}: each binding must be (name value)`, line, 'wrong-type-argument');
      }
      out.push({ name: b[0].name, value: b[1] ?? null });
    }
    return out;
  }

  private *doDolist(args: Form[], env: Env | null, line: number): Generator<Step, Value> {
    const spec = args[0];
    if (!Array.isArray(spec) || spec.length < 2 || !(spec[0] instanceof Sym)) {
      throw new LispError('dolist: expected (VAR LIST [RESULT])', line, 'wrong-type-argument');
    }
    const name = spec[0].name;
    const listValue = yield* this.eval(spec[1]!, env, lineOf(spec[1]!, line));
    const items = arrayOf(listValue, 'dolist');
    const lexical = this.bindingMode(env);
    const lexFrame = lexical ? new Env(`dolist ${name} (line ${line})`, env) : null;
    const dynFrame = lexical ? null : new DynFrame(`dolist ${name} (line ${line})`);
    const bind = (v: Value): void => {
      if (lexFrame) lexFrame.vars.set(name, v);
      else dynFrame!.vars.set(name, v);
    };
    if (dynFrame) this.dynamic.push(dynFrame);
    try {
      for (const item of items) {
        this.tick(1, line);
        bind(item);
        yield* this.evalSeq(args.slice(1), lexFrame ?? env, line);
      }
    } finally {
      if (dynFrame) this.dynamic.pop();
    }
    // RESULT is evaluated outside the hidden per-element binding
    return spec[2] !== undefined
      ? yield* this.eval(spec[2], env, lineOf(spec[2], line))
      : nil;
  }

  private *doDotimes(args: Form[], env: Env | null, line: number): Generator<Step, Value> {
    const spec = args[0];
    if (!Array.isArray(spec) || spec.length < 2 || !(spec[0] instanceof Sym)) {
      throw new LispError('dotimes: expected (VAR COUNT [RESULT])', line, 'wrong-type-argument');
    }
    const name = spec[0].name;
    const countValue = yield* this.eval(spec[1]!, env, lineOf(spec[1]!, line));
    if (typeof countValue !== 'number' || !Number.isInteger(countValue)) {
      throw new LispError(`dotimes: count must be an integer, got ${renderWrite(countValue)}`, line, 'wrong-type-argument');
    }
    const lexical = this.bindingMode(env);
    const lexFrame = lexical ? new Env(`dotimes ${name} (line ${line})`, env) : null;
    const dynFrame = lexical ? null : new DynFrame(`dotimes ${name} (line ${line})`);
    const bind = (v: Value): void => {
      if (lexFrame) lexFrame.vars.set(name, v);
      else dynFrame!.vars.set(name, v);
    };
    if (dynFrame) this.dynamic.push(dynFrame);
    try {
      for (let i = 0; i < Math.max(0, countValue); i++) {
        this.tick(1, line);
        bind(i);
        yield* this.evalSeq(args.slice(1), lexFrame ?? env, line);
      }
      bind(Math.max(0, countValue));
      return spec[2] !== undefined
        ? yield* this.eval(spec[2], lexFrame ?? env, lineOf(spec[2], line))
        : nil;
    } finally {
      if (dynFrame) this.dynamic.pop();
    }
  }

  private doClDefstruct(args: Form[], line: number): Value {
    const target = args[0];
    if (!(target instanceof Sym)) {
      throw new LispError('cl-defstruct: name must be a symbol', line, 'wrong-type-argument');
    }
    const slots: { name: string; def: Value }[] = [];
    for (const s of args.slice(1)) {
      if (s instanceof Sym) {
        slots.push({ name: s.name, def: nil });
      } else if (Array.isArray(s) && s.length <= 2 && s[0] instanceof Sym) {
        slots.push({ name: s[0].name, def: s[1] !== undefined ? this.formToValue(s[1]) : nil });
      } else {
        throw new LispError('cl-defstruct: bad slot specification', line, 'wrong-type-argument');
      }
    }
    const ctor = new Builtin(`make-${target.name}`, 0, Infinity, (argv, ctx) => {
      const st = new Struct(target.name, new Map(slots.map((s) => [s.name, s.def])));
      for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i];
        if (!(key instanceof Sym) || !key.name.startsWith(':')) {
          throw new LispError(`make-${target.name}: expected keyword arguments`, ctx.line, 'wrong-type-argument');
        }
        st.slots.set(key.name.slice(1), argv[i + 1] ?? nil);
      }
      return st;
    });
    this.runtime.globalFunctions.set(`make-${target.name}`, ctor);
    this.touch(`make-${target.name}`, true);
    for (const slot of slots) {
      const accessor = new Builtin(`${target.name}-${slot.name}`, 1, 1, (argv, ctx) => {
        const st = argv[0];
        if (!(st instanceof Struct)) {
          throw new LispError(`${target.name}-${slot.name}: expected a ${target.name}`, ctx.line, 'wrong-type-argument');
        }
        return st.slots.get(slot.name) ?? nil;
      });
      const setter = new Builtin(`setf-${target.name}-${slot.name}`, 2, 2, (argv, ctx) => {
        const st = argv[0];
        if (!(st instanceof Struct)) {
          throw new LispError(`setf-${target.name}-${slot.name}: expected a ${target.name}`, ctx.line, 'wrong-type-argument');
        }
        st.slots.set(slot.name, argv[1] ?? nil);
        return argv[1] ?? nil;
      });
      this.runtime.globalFunctions.set(`${target.name}-${slot.name}`, accessor);
      this.runtime.globalFunctions.set(`setf-${target.name}-${slot.name}`, setter);
      this.touch(`${target.name}-${slot.name}`, true);
    }
    return target;
  }

  private *doSetf(args: Form[], env: Env | null, line: number): Generator<Step, Value> {
    if (args.length === 0 || args.length % 2 !== 0) {
      throw new LispError('setf: expected PLACE VALUE pairs', line, 'wrong-number-of-arguments');
    }
    let last: Value = nil;
    for (let i = 0; i < args.length; i += 2) {
      const place = args[i]!;
      if (!Array.isArray(place) || place.length < 2 || !(place[0] instanceof Sym)) {
        throw new LispError('setf: unsupported place', line, 'wrong-type-argument');
      }
      const obj = yield* this.eval(place[1]!, env, lineOf(place[1]!, line));
      const value = yield* this.eval(args[i + 1]!, env, lineOf(args[i + 1]!, line));
      const setter = this.runtime.globalFunctions.get(`setf-${place[0].name}`);
      if (setter === undefined) {
        throw new LispError(`setf: no setter for ${place[0].name}`, line, 'void-function');
      }
      last = yield* this.applyFn(setter, [obj, value], line);
    }
    return last;
  }

  private *doDefun(
    kind: 'defun' | 'defmacro' | 'cl-defun',
    args: Form[],
    env: Env | null,
    line: number,
  ): Generator<Step, Value> {
    const target = args[0];
    if (!(target instanceof Sym)) throw new LispError(`${kind}: name must be a symbol`, line, 'wrong-type-argument');
    const arglist = args[1];
    if (arglist === undefined || !Array.isArray(arglist)) {
      throw new LispError(`${kind}: expected a parameter list`, line, 'wrong-type-argument');
    }
    const params = parseParams(arglist, kind, line);
    let body = args.slice(2);
    let doc: string | undefined;
    if (typeof body[0] === 'string') { doc = body[0]; if (body.length > 1) body = body.slice(1); }
    const lexical = this.bindingMode(env);
    const fn = new Closure(params, body, lexical ? env : null, lexical, line, target.name);
    fn.doc = doc;
    fn.command = body.some((f) => isForm(f, 'interactive'));
    if (kind === 'defmacro') this.runtime.globalFunctions.set(target.name, new Macro(target.name, fn));
    else this.runtime.globalFunctions.set(target.name, fn);
    this.touch(target.name, true);
    return target;
  }

  private *doDefvar(kind: 'defvar' | 'defconst', args: Form[], env: Env | null, line: number): Generator<Step, Value> {
    const target = args[0];
    if (!(target instanceof Sym)) throw new LispError(`${kind}: name must be a symbol`, line, 'wrong-type-argument');
    assertSettable(target.name, line);
    if (kind === 'defconst' && args.length < 2) {
      throw new LispError('defconst: expected a value', line, 'wrong-number-of-arguments');
    }
    this.special.add(target.name);
    if (kind === 'defconst') {
      const v = args.length > 1 ? yield* this.eval(args[1]!, env, lineOf(args[1]!, line)) : nil;
      this.setGlobal(target.name, v);
      this.touch(target.name, true);
      return target;
    }
    if (args.length > 1 && !this.runtime.globalValues.has(target.name)) {
      const v = yield* this.eval(args[1]!, env, lineOf(args[1]!, line));
      this.setGlobal(target.name, v);
    }
    this.touch(target.name, true);
    return target;
  }

  private *makeLambda(form: FormArray, env: Env | null, line: number): Generator<Step, Value> {
    const head = form[0];
    if (!(head instanceof Sym) || head.name !== 'lambda') {
      throw new LispError('function: expected a lambda', line, 'wrong-type-argument');
    }
    return yield* this.makeLambdaFromArgs(form.slice(1) as Form[], env, line);
  }

  private *makeLambdaFromArgs(args: Form[], env: Env | null, line: number): Generator<Step, Value> {
    const arglist = args[0];
    if (arglist === undefined || !Array.isArray(arglist)) {
      throw new LispError('lambda: expected a parameter list', line, 'wrong-type-argument');
    }
    const params = parseParams(arglist, 'lambda', line);
    let body = args.slice(1);
    let doc: string | undefined;
    if (typeof body[0] === 'string') { doc = body[0]; if (body.length > 1) body = body.slice(1); }
    const lexical = this.bindingMode(env);
    const fn = new Closure(params, body, lexical ? env : null, lexical, line);
    fn.doc = doc;
    fn.command = body.some((f) => isForm(f, 'interactive'));
    return fn;
  }

  private *doConditionCase(args: Form[], env: Env | null, line: number): Generator<Step, Value> {
    if (args.length < 2) throw new LispError('condition-case: expected a variable and a body', line);
    const varForm = args[0]!;
    const varName = varForm === nil ? null : varForm instanceof Sym ? varForm.name : null;
    if (varName === null && varForm !== nil) {
      throw new LispError('condition-case: variable must be a symbol or nil', line, 'wrong-type-argument');
    }
    try {
      return yield* this.eval(args[1]!, env, lineOf(args[1]!, line));
    } catch (e) {
      if (!(e instanceof LispError)) throw e;
      const condition = e.data;
      for (const handler of args.slice(2)) {
        if (!Array.isArray(handler) || handler.length === 0) continue;
        const names = handler[0];
        const list = Array.isArray(names) ? names : [names];
        const matches = list.some((n) =>
          n instanceof Sym && (n.name === condition || n.name === 'error' || n.name === 't'));
        if (!matches) continue;
        let handlerEnv = env;
        if (varName !== null) {
          const errValue = new Cons(Sym.intern(condition), listOf([e.message]));
          if (this.bindingMode(env)) {
            handlerEnv = new Env('condition-case', env);
            handlerEnv.vars.set(varName, errValue);
          } else {
            const frame = new DynFrame('condition-case');
            frame.vars.set(varName, errValue);
            this.dynamic.push(frame);
            try {
              return yield* this.evalSeq(handler.slice(1), env, line);
            } finally {
              this.dynamic.pop();
            }
          }
        }
        return yield* this.evalSeq(handler.slice(1), handlerEnv, line);
      }
      throw e;
    }
  }

  // ---- intercepted functions ---------------------------------------------

  private *intercepted(name: string, args: Form[], env: Env | null, line: number): Generator<Step, Value> {
    const vals = yield* this.evalArgs(args, env, line);
    return yield* this.applyIntercepted(name, vals, line);
  }

  private *applyIntercepted(name: string, vals: Value[], line: number): Generator<Step, Value> {
    switch (name) {
      case 'funcall': {
        if (vals.length === 0) throw new LispError('funcall: expected a function', line);
        return yield* this.applyFn(vals[0]!, vals.slice(1), line);
      }
      case 'apply': {
        if (vals.length < 2) throw new LispError('apply: expected a function and an argument list', line);
        const tail = arrayOf(vals[vals.length - 1]!, 'apply');
        return yield* this.applyFn(vals[0]!, [...vals.slice(1, -1), ...tail], line);
      }
      case 'mapcar':
      case 'mapc': {
        if (vals.length !== 2) throw new LispError(`${name}: expected a function and a list`, line);
        const seq = vals[1]!;
        const items = typeof seq === 'string'
          ? [...seq].map((ch) => ch.codePointAt(0)!)
          : seq instanceof Vec
            ? seq.items
            : arrayOf(seq, name);
        const out: Value[] = [];
        for (const item of items) {
          this.tick(1, line);
          out.push(yield* this.applyFn(vals[0]!, [item], line));
        }
        return name === 'mapcar' ? listOf(out) : seq;
      }
      case 'seq-filter':
      case 'seq-map':
      case 'seq-reduce': {
        if (vals.length !== (name === 'seq-reduce' ? 3 : 2)) {
          throw new LispError(`${name}: wrong number of arguments`, line, 'wrong-number-of-arguments');
        }
        const seq = sequenceValues(vals[name === 'seq-reduce' ? 1 : 1]!, name);
        if (name === 'seq-reduce') {
          let acc = vals[2]!;
          for (const item of seq) {
            this.tick(1, line);
            acc = yield* this.applyFn(vals[0]!, [acc, item], line);
          }
          return acc;
        }
        const out: Value[] = [];
        for (const item of seq) {
          this.tick(1, line);
          const r = yield* this.applyFn(vals[0]!, [item], line);
          if (name === 'seq-map') out.push(r);
          else if (truthy(r)) out.push(item);
        }
        return listOf(out);
      }
      case 'alist-get': {
        if (vals.length < 2) throw new LispError('alist-get: expected a key and an alist', line);
        const key = vals[0]!;
        const alist = vals[1]!;
        const fallback = vals[2] ?? nil;
        const test = vals[4];
        const same = test === undefined || test === nil ? eq
          : test instanceof Sym && test.name === 'eq' ? eq
            : test instanceof Sym && test.name === 'string=' ? (a: Value, b: Value) => a === b
              : equal;
        let cur: Value = alist;
        const seen = new Set<Cons>();
        while (cur instanceof Cons) {
          if (seen.has(cur)) throw new LispError('alist-get: circular list', line, 'circular-list');
          seen.add(cur);
          const entry = cur.car;
          if (entry instanceof Cons && same(entry.car, key)) return entry.cdr;
          cur = cur.cdr;
        }
        return fallback;
      }
      case 'run-hooks':
      case 'run-hook-with-args': {
        const hookArgs = name === 'run-hooks' ? [] : vals.slice(1);
        for (const hook of vals.slice(0, name === 'run-hooks' ? vals.length : 1)) {
          if (!(hook instanceof Sym)) {
            throw new LispError(`${name}: hook name must be a symbol`, line, 'wrong-type-argument');
          }
          const value = this.lookupOptional(hook.name, null) ?? nil;
          const fns = value instanceof Cons || value === nil
            ? arrayOf(value, name)
            : [value];
          for (const fn of fns) {
            this.tick(1, line);
            if (fn === nil) continue;
            yield* this.applyFn(fn, hookArgs, line);
          }
        }
        return nil;
      }
      case 'call-interactively': {
        if (vals.length === 0) throw new LispError('call-interactively: expected a command', line);
        const fn = this.resolveValue(vals[0]!, line);
        if (!(fn instanceof Closure) && !(fn instanceof Builtin)) {
          throw new LispError(`call-interactively: not a command: ${renderWrite(vals[0]!)}`, line, 'invalid-function');
        }
        if (fn instanceof Closure && !fn.command) {
          throw new LispError(`call-interactively: not a command: ${fn.name ?? 'lambda'}`, line, 'invalid-function');
        }
        return yield* this.applyFn(fn, [], line);
      }
      case 'macroexpand':
      case 'macroexpand-1': {
        if (vals.length !== 1) throw new LispError(`${name}: expected 1 argument`, line);
        return yield* this.macroexpandOnce(vals[0]!, line, name === 'macroexpand');
      }
      case 'symbol-value': {
        if (vals.length !== 1 || !(vals[0] instanceof Sym)) {
          throw new LispError('symbol-value: expected a symbol', line, 'wrong-type-argument');
        }
        return this.lookupVar(vals[0].name, null, line);
      }
      case 'boundp': {
        if (vals.length !== 1 || !(vals[0] instanceof Sym)) {
          throw new LispError('boundp: expected a symbol', line, 'wrong-type-argument');
        }
        return this.lookupOptional(vals[0].name, null) === undefined ? nil : t;
      }
      case 'set': {
        if (vals.length !== 2 || !(vals[0] instanceof Sym)) {
          throw new LispError('set: expected a symbol and a value', line, 'wrong-type-argument');
        }
        assertSettable(vals[0].name, line);
        this.assignDynamic(vals[0].name, vals[1]!);
        return vals[1]!;
      }
      default:
        throw new LispError(`internal: unhandled intercepted function ${name}`, line);
    }
  }

  // ---- variables ---------------------------------------------------------

  /** `lexical-binding` as seen at this point (dynamic lets can rebind it). */
  bindingMode(_env: Env | null): boolean {
    const v = this.lookupOptional('lexical-binding', null);
    return v !== undefined && truthy(v);
  }

  private lookupOptional(name: string, env: Env | null): Value | undefined {
    if (name.startsWith(':')) return Sym.intern(name);
    if (env !== null) {
      const local = env.lookup(name);
      if (local !== undefined) return local;
    }
    for (let i = this.dynamic.length - 1; i >= 0; i--) {
      const v = this.dynamic[i]!.vars.get(name);
      if (v !== undefined) return v;
    }
    const buf = this.runtime.current;
    if (buf.locals.has(name)) return buf.locals.get(name);
    return this.runtime.globalValues.get(name);
  }

  private lookupVar(name: string, env: Env | null, line: number): Value {
    const v = this.lookupOptional(name, env);
    if (v === undefined) {
      throw new LispError(`void-variable ${name}`, line, 'void-variable');
    }
    return v;
  }

  /** `setq`: nearest lexical, then dynamic, then buffer-local, then global. */
  private assignVar(name: string, value: Value, env: Env | null): void {
    if (env !== null) {
      const owner = env.owner(name);
      if (owner !== null) { owner.vars.set(name, value); this.changed.add(name); return; }
    }
    for (let i = this.dynamic.length - 1; i >= 0; i--) {
      if (this.dynamic[i]!.vars.has(name)) {
        this.dynamic[i]!.vars.set(name, value);
        this.changed.add(name);
        return;
      }
    }
    const buf = this.runtime.current;
    if (buf.locals.has(name)) {
      buf.locals.set(name, value);
      this.changed.add(name);
      return;
    }
    if (this.runtime.bufferLocalVariables.has(name)) {
      buf.locals.set(name, value);
      this.changed.add(name);
      return;
    }
    this.setGlobal(name, value);
  }

  /** `set` writes the dynamic/default cell only, never a lexical binding. */
  private assignDynamic(name: string, value: Value): void {
    for (let i = this.dynamic.length - 1; i >= 0; i--) {
      if (this.dynamic[i]!.vars.has(name)) {
        this.dynamic[i]!.vars.set(name, value);
        this.changed.add(name);
        return;
      }
    }
    const buf = this.runtime.current;
    if (buf.locals.has(name)) {
      buf.locals.set(name, value);
      this.changed.add(name);
      return;
    }
    if (this.runtime.bufferLocalVariables.has(name)) {
      buf.locals.set(name, value);
      this.changed.add(name);
      return;
    }
    this.setGlobal(name, value);
  }

  private setGlobal(name: string, value: Value): void {
    this.runtime.globalValues.set(name, value);
    this.changed.add(name);
  }

  private touch(name: string, changed = false): void {
    this.touched.add(name);
    if (changed) this.changed.add(name);
  }

  /** Panels read names in a stable order. */
  touchedNames(): string[] {
    return [...this.touched].sort();
  }

  // ---- forms ↔ values ----------------------------------------------------

  formToValue(f: Form): Value {
    if (f instanceof FormVector) return new Vec(f.items.map((x) => this.formToValue(x)));
    if (Array.isArray(f)) {
      let tail: Value = f.dot !== undefined ? this.formToValue(f.dot) : nil;
      for (let i = f.length - 1; i >= 0; i--) tail = new Cons(this.formToValue(f[i]!), tail);
      return tail;
    }
    return f;
  }

  valueToForm(v: Value, line: number): Form {
    if (v instanceof Cons) {
      const items: Form[] = [];
      const seen = new Set<Cons>();
      let cur: Value = v;
      while (cur instanceof Cons) {
        if (seen.has(cur)) throw new LispError('macro expansion is a circular list', line, 'circular-list');
        seen.add(cur);
        items.push(this.valueToForm(cur.car, line));
        cur = cur.cdr;
      }
      const f = items as FormArray;
      f.line = line;
      if (cur !== nil) f.dot = this.valueToForm(cur, line);
      return f;
    }
    if (v === nil) {
      const f = [] as unknown as FormArray;
      f.line = line;
      return f;
    }
    if (v instanceof Vec) return new FormVector(v.items.map((x) => this.valueToForm(x, line)), line);
    if (v instanceof Sym || typeof v === 'number' || typeof v === 'string') return v;
    throw new LispError(`macro expansion produced non-code: ${renderWrite(v)}`, line, 'invalid-function');
  }

  /** Bullet the buffer designator: a Buffer or a buffer name string. */
  bufferOf(v: Value, line: number): Buffer {
    if (v instanceof Buffer) {
      if (!this.runtime.isLive(v)) throw new LispError(`Selecting deleted buffer: ${v.name}`, line, 'error');
      return v;
    }
    if (typeof v === 'string') {
      const buf = this.runtime.getBuffer(v);
      if (buf !== undefined) return buf;
      throw new LispError(`No such buffer: ${v}`, line, 'error');
    }
    throw new LispError('expected a buffer or buffer name', line, 'wrong-type-argument');
  }
}

// ---- quasiquote → cons/append/quote code ---------------------------------

function mkForm(items: Form[], line: number): FormArray {
  const f = items as FormArray;
  f.line = line;
  return f;
}

const S = (name: string): Sym => Sym.intern(name);

/**
 * Desugar a quasiquote template into ordinary code. The expansion is real
 * code, so it steps and line-maps like any other form:
 *   `x            → (quote x)
 *   `(a ,b ,@c)   → (cons 'a (cons b (append c '())))
 * Nested quasiquotes track depth, as in the manual.
 */
export function qqExpand(t: Form, depth: number, line: number): Form {
  if (t instanceof FormVector) {
    const segments: Form[] = [];
    let spliced = false;
    for (const el of t.items) {
      if (depth === 1 && Array.isArray(el) && el[0] instanceof Sym &&
          el[0].name === 'unquote-splicing' && el.length === 2 && el.dot === undefined) {
        segments.push(el[1]!);
        spliced = true;
      } else {
        segments.push(mkForm([S('list'), qqExpand(el, depth, line)], line));
      }
    }
    if (!spliced) {
      return mkForm([S('vector'), ...t.items.map((el) => qqExpand(el, depth, line))], line);
    }
    return mkForm([S('apply'), mkForm([S('function'), S('vector')], line),
      mkForm([S('append'), ...segments, mkForm([S('quote'), mkForm([], line)], line)], line)], line);
  }
  if (!Array.isArray(t)) return mkForm([S('quote'), t], line);
  if (t.length === 0 && t.dot === undefined) {
    return mkForm([S('quote'), mkForm([], t.line)], t.line);
  }
  const head = t[0]!;
  if (head instanceof Sym && head.name === 'unquote') {
    if (t.length !== 2 || t.dot !== undefined) {
      throw new LispError('unquote: expected exactly 1 expression', t.line);
    }
    if (depth === 1) return t[1]!;
    return mkForm([S('list'), mkForm([S('quote'), S('unquote')], t.line), qqExpand(t[1]!, depth - 1, t.line)], t.line);
  }
  if (head instanceof Sym && head.name === 'quasiquote') {
    if (t.length !== 2 || t.dot !== undefined) {
      throw new LispError('quasiquote: expected exactly 1 template', t.line);
    }
    return mkForm([S('list'), mkForm([S('quote'), S('quasiquote')], t.line), qqExpand(t[1]!, depth + 1, t.line)], t.line);
  }
  let acc: Form = t.dot !== undefined
    ? qqExpand(t.dot, depth, t.line)
    : mkForm([S('quote'), mkForm([], t.line)], t.line);
  for (let i = t.length - 1; i >= 0; i--) {
    const el = t[i]!;
    if (Array.isArray(el) && el[0] instanceof Sym &&
        el[0].name === 'unquote-splicing' && el.length === 2 && el.dot === undefined) {
      if (depth === 1) {
        acc = mkForm([S('append'), el[1]!, acc], el.line);
      } else {
        const rebuilt = mkForm([S('list'), mkForm([S('quote'), S('unquote-splicing')], el.line),
          qqExpand(el[1]!, depth - 1, el.line)], el.line);
        acc = mkForm([S('cons'), rebuilt, acc], el.line);
      }
    } else {
      acc = mkForm([S('cons'), qqExpand(el, depth, t.line), acc], t.line);
    }
  }
  return acc;
}

// ---- helpers --------------------------------------------------------------

function lineOf(f: Form | undefined, fallback: number): number {
  if (f === undefined) return fallback;
  if (Array.isArray(f)) return f.line;
  if (f instanceof FormVector) return f.line;
  return fallback;
}

function assertSettable(name: string, line: number): void {
  if (name === 'nil' || name === 't' || name.startsWith(':')) {
    throw new LispError(`Attempt to set a constant symbol: ${name}`, line, 'setting-constant');
  }
}

function rxEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rxExpand(forms: Form[], line: number): string {
  return forms.map((f) => rxOne(f, line)).join('');
}

function rxOne(form: Form, line: number): string {
  if (typeof form === 'string') return rxEscape(form);
  if (form instanceof Sym) {
    switch (form.name) {
      case 'bol': return '^';
      case 'eol': return '$';
      case 'nonl': return '[^\n]';
      case 'blank': return '[ \t]';
      case 'space': return '[ \t\n]';
      case 'digit': return '[0-9]';
      case 'alpha': return '[A-Za-z]';
      case 'alnum': return '[A-Za-z0-9]';
      case 'word': return '[A-Za-z0-9_]';
      default: throw new LispError(`rx: unsupported form ${form.name}`, line);
    }
  }
  if (form instanceof FormVector) return rxExpand(form.items, line);
  if (Array.isArray(form)) {
    const head = form[0];
    if (!(head instanceof Sym)) return rxExpand(form, line);
    const args = form.slice(1) as Form[];
    switch (head.name) {
      case 'group':
        if (args.length !== 1) throw new LispError('rx: group expects one form', line);
        return `(${rxOne(args[0]!, line)})`;
      case '+':
      case '1+':
        return `(?:${rxExpand(args, line)})+`;
      case '*':
      case '0+':
        return `(?:${rxExpand(args, line)})*`;
      case '?':
        return `(?:${rxExpand(args, line)})?`;
      case 'seq':
      case 'and':
        return rxExpand(args, line);
      case 'or':
        return `(?:${args.map((f) => rxOne(f, line)).join('|')})`;
      case 'any': {
        const chars = args.map((f) => typeof f === 'string' ? f : rxOne(f, line)).join('');
        return `[${chars.replace(/[\]\\^]/g, '\\$&')}]`;
      }
      case 'not': {
        const chars = args.map((f) => typeof f === 'string' ? f : rxOne(f, line)).join('');
        return `[^${chars.replace(/[\]\\^]/g, '\\$&')}]`;
      }
      default:
        throw new LispError(`rx: unsupported form ${head.name}`, line);
    }
  }
  throw new LispError('rx: unsupported form', line);
}

function sequenceValues(v: Value, who: string): Value[] {
  if (typeof v === 'string') return [...v].map((ch) => ch.codePointAt(0)!);
  if (v instanceof Vec) return v.items;
  return arrayOf(v, who);
}

function pcaseMatch(pattern: Form, value: Value, binds: Map<string, Value>): boolean {
  if (pattern instanceof Sym) {
    if (pattern.name === '_') return true;
    if (pattern === nil) return value === nil;
    if (pattern === t) return value === t;
    const prior = binds.get(pattern.name);
    if (prior !== undefined) return equal(prior, value);
    binds.set(pattern.name, value);
    return true;
  }
  if (typeof pattern === 'number' || typeof pattern === 'string') return pattern === value;
  if (Array.isArray(pattern)) {
    if (pattern.length === 2 && pattern[0] instanceof Sym &&
        (pattern[0].name === 'quote' || pattern[0].name === 'quasiquote')) {
      return pcasePatternValue(pattern[1]!, value, binds, pattern[0].name === 'quasiquote');
    }
    if (pattern.length === 2 && pattern[0] instanceof Sym && pattern[0].name === 'pred') {
      return false; // pred patterns are not modelled
    }
  }
  return false;
}

function pcasePatternValue(pattern: Form, value: Value, binds: Map<string, Value>, quasi: boolean): boolean {
  if (pattern instanceof Sym) {
    if (pattern.name === '_') return true;
    const prior = binds.get(pattern.name);
    if (prior !== undefined) return equal(prior, value);
    binds.set(pattern.name, value);
    return true;
  }
  if (typeof pattern === 'number' || typeof pattern === 'string') return pattern === value;
  if (!Array.isArray(pattern)) return false;
  if (pattern.length === 2 && pattern[0] instanceof Sym && pattern[0].name === 'unquote') {
    return pcaseMatch(pattern[1]!, value, binds);
  }
  if (!(value instanceof Cons)) return false;
  let cur: Value = value;
  for (const el of pattern) {
    if (!(cur instanceof Cons)) return false;
    if (Array.isArray(el) && el.length === 2 && el[0] instanceof Sym && el[0].name === 'unquote') {
      if (!pcaseMatch(el[1]!, cur.car, binds)) return false;
    } else if (!pcasePatternValue(el, cur.car, binds, quasi)) {
      return false;
    }
    cur = cur.cdr;
  }
  if (pattern.dot !== undefined) {
    const tail = pattern.dot;
    if (Array.isArray(tail) && tail.length === 2 && tail[0] instanceof Sym && tail[0].name === 'unquote') {
      return pcaseMatch(tail[1]!, cur, binds);
    }
    return pcasePatternValue(tail, cur, binds, quasi);
  }
  return cur === nil;
}

function isForm(f: Form, name: string): boolean {
  return Array.isArray(f) && f[0] instanceof Sym && f[0].name === name;
}

export function parseParams(arglist: FormArray, who: string, line: number): Params {
  const required: string[] = [];
  const optional: string[] = [];
  const keys: { name: string; default: Form | null }[] = [];
  let rest: string | null = null;
  let mode: 'required' | 'optional' | 'rest' | 'key' = 'required';
  for (const p of arglist) {
    if (p instanceof Sym) {
      if (p.name === '&optional') { mode = 'optional'; continue; }
      if (p.name === '&rest') { mode = 'rest'; continue; }
      if (p.name === '&key') { mode = 'key'; continue; }
      if (p.name === '&allow-other-keys') continue;
      if (p.name.startsWith('&')) {
        throw new LispError(`${who}: unsupported argument keyword ${p.name}`, line);
      }
    }
    if (mode === 'key') {
      if (p instanceof Sym) keys.push({ name: p.name, default: null });
      else if (Array.isArray(p) && p.length <= 2 && p[0] instanceof Sym) {
        keys.push({ name: p[0].name, default: p[1] ?? null });
      } else {
        throw new LispError(`${who}: bad &key parameter`, line, 'wrong-type-argument');
      }
      continue;
    }
    if (!(p instanceof Sym)) {
      throw new LispError(`${who}: parameter names must be symbols`, line, 'wrong-type-argument');
    }
    if (mode === 'required') required.push(p.name);
    else if (mode === 'optional') optional.push(p.name);
    else {
      if (rest !== null) throw new LispError(`${who}: only one &rest parameter`, line);
      rest = p.name;
    }
  }
  return { required, optional, rest, keys };
}

function bindArity(params: Params, got: number, who: string, line: number): void {
  const min = params.required.length;
  const max = params.rest === null && params.keys.length === 0 ? params.required.length + params.optional.length : Infinity;
  if (got < min || got > max) {
    const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}–${max}`;
    throw new LispError(`${who}: wrong number of arguments (${got}), expected ${want}`, line, 'wrong-number-of-arguments');
  }
}


