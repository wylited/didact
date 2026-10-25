// The Lisp machine: a small-step evaluator over an explicit frame stack.
//
// One `step()` is one eval/apply reduction. Evaluation never recurses in
// JS — continuations live in `stack` (the Control-stack panel shows exactly
// those frames), so tail calls run in constant JS stack: a tail call simply
// never pushes a return frame (see `applyFocus` and `focusInto`, which
// focus the *last* subform of a body without wrapping it). The run budget
// counts compound-form reductions and applications (atom evaluation and
// variable lookup are free), so a 100 000-iteration tail loop — about six
// counted reductions per iteration — fits inside the 1e6 budget.

import { Builtin, BuiltinCtx, Closure, Env, Form, FormArray, Heap, LispError, Macro, Ref, Sym, Value, VOID, renderWrite, withHeap } from './value';

const BUDGET = 1_000_000;

type Focus =
  | { t: 'eval'; form: Form; env: Env; line: number }
  | { t: 'value'; value: Value }
  | { t: 'apply'; fn: Value; args: Value[]; line: number }
  | { t: 'halt' };

type Frame =
  | { t: 'opwait'; argForms: Form[]; env: Env; line: number }
  | { t: 'args'; op: Value; done: Value[]; rest: Form[]; env: Env; line: number }
  | { t: 'if'; conseq: Form; alt: Form | null; env: Env; line: number }
  | { t: 'cond'; clause: FormArray; rest: FormArray[]; env: Env }
  | { t: 'seq'; rest: Form[]; env: Env; line: number }
  | { t: 'let'; kind: 'let' | 'let*' | 'letrec'; vars: string[]; vals: Value[]; current: FormArray; rest: FormArray[]; body: Form[]; env: Env; line: number }
  | { t: 'define'; name: string; env: Env; line: number }
  | { t: 'defmacro'; name: string; env: Env; line: number }
  | { t: 'set'; name: string; env: Env; line: number }
  | { t: 'and'; rest: Form[]; env: Env; line: number }
  | { t: 'or'; rest: Form[]; env: Env; line: number }
  | { t: 'expand'; env: Env; line: number };

const S = (n: string) => Sym.intern(n);


export class Machine {
  readonly heap = new Heap();
  readonly global = new Env('global', null);
  readonly stack: Frame[] = [];
  focus: Focus;
  steps = 0;
  counted = 0;          // budgeted reductions so far
  error: string | null = null;
  /** Value of the last completed top-level form (tests and panels). */
  lastValue: Value = VOID;
  output = '';

  constructor(program: Form[], builtins: Map<string, Value>) {
    for (const [name, v] of builtins) this.global.vars.set(name, v);
    if (program.length === 0) { this.focus = { t: 'halt' }; return; }
    this.focus = { t: 'eval', form: program[0]!, env: this.global, line: lineOf(program[0]!, 1) };
    if (program.length > 1) this.stack.push({ t: 'seq', rest: program.slice(1), env: this.global, line: 1 });
  }

  get finished(): boolean {
    return this.focus.t === 'halt' && this.error === null;
  }

  /** 1-based line of the form the machine is about to reduce. */
  currentLine(): number | null {
    if (this.focus.t === 'eval' || this.focus.t === 'apply') return this.focus.line;
    const top = this.stack[this.stack.length - 1];
    return top !== undefined && 'line' in top ? top.line : null;
  }

  /** Perform one reduction. No-op once halted or in error. */
  step(): void {
    this.heap.fresh.clear();
    const counts = this.focus.t === 'apply'
      || (this.focus.t === 'eval' && Array.isArray(this.focus.form));
    if (counts) {
      if (this.counted >= BUDGET) {
        this.error = `run budget exceeded (${BUDGET} reductions) (line ${this.currentLine() ?? 1})`;
        return;
      }
      this.counted++;
    }
    try {
      this.reduce();
      this.steps++;
    } catch (e) {
      if (e instanceof LispError) {
        // Errors raised below a reduction (heap allocation, builtins) carry
        // no line of their own — attach the focus line we still hold,
        // because nothing was pushed before the throw.
        const line = e.line ?? this.currentLine() ?? undefined;
        this.error = line !== undefined ? `${e.message} (line ${line})` : e.message;
      } else {
        this.error = `internal error: ${(e as Error).message}`;
      }
    }
  }

  private reduce(): void {
    const f = this.focus;
    if (f.t === 'eval') this.evalFocus(f);
    else if (f.t === 'apply') this.applyFocus(f);
    else if (f.t === 'value') this.valueFocus(f);
  }

  // ---- eval: reduce one form focus ---------------------------------------

  /** True once the (sub)machine halts or faults; reads focus un-narrowed. */
  private stopped(): boolean {
    return this.error !== null || this.focus.t === 'halt';
  }

  private evalFocus(f: { t: 'eval'; form: Form; env: Env; line: number }): void {
    const { form, env, line } = f;
    if (!Array.isArray(form)) {
      if (form instanceof Sym) {
        const v = env.lookup(form.name);
        if (v === undefined) throw new LispError(`unbound variable: ${form.name}`, line);
        this.focus = { t: 'value', value: v };
        return;
      }
      // numbers, strings, booleans, and the empty-list literal self-evaluate
      this.focus = { t: 'value', value: form };
      return;
    }
    if (form.length === 0) throw new LispError('cannot evaluate ()', line);
    const head = form[0]!;
    const args = form.slice(1);
    if (head instanceof Sym) {
      switch (head.name) {
        case 'quote':
          expectArity(args, 1, 'quote', line);
          this.focus = { t: 'value', value: this.formToValue(args[0]!) };
          return;
        case 'quasiquote':
          expectArity(args, 1, 'quasiquote', line);
          this.focus = { t: 'eval', form: qqExpand(args[0]!, 1), env, line };
          return;
        case 'if':
          if (args.length < 2 || args.length > 3) {
            throw new LispError(`if: expected 2 or 3 arguments, got ${args.length}`, line);
          }
          this.stack.push({ t: 'if', conseq: args[1]!, alt: args[2] ?? null, env, line });
          this.focus = { t: 'eval', form: args[0]!, env, line: lineOf(args[0]!, line) };
          return;
        case 'cond':
          if (args.length === 0) { this.focus = { t: 'value', value: VOID }; return; }
          this.dispatchCondClause(args as FormArray[], env);
          return;
        case 'define':
          this.evalDefine(args, env, line);
          return;
        case 'define-macro':
          this.evalDefineMacro(args, env, line);
          return;
        case 'lambda': {
          const params = parseParams(args[0] ?? null, 'lambda', line);
          if (args.length < 2) throw new LispError('lambda: body is empty', line);
          this.focus = { t: 'value', value: new Closure(params, args.slice(1), env, line) };
          return;
        }
        case 'begin':
          this.focusInto(args, env, line);
          return;
        case 'and':
          if (args.length === 0) { this.focus = { t: 'value', value: true }; return; }
          this.focusOperandwise(args, env, 'and', line);
          return;
        case 'or':
          if (args.length === 0) { this.focus = { t: 'value', value: false }; return; }
          this.focusOperandwise(args, env, 'or', line);
          return;
        case 'set!': {
          expectArity(args, 2, 'set!', line);
          const name = bindingName(args[0]!, 'set!', line);
          this.stack.push({ t: 'set', name, env, line });
          this.focus = { t: 'eval', form: args[1]!, env, line: lineOf(args[1]!, line) };
          return;
        }
        case 'let': case 'let*': case 'letrec':
          this.evalLet(head.name, args, env, line);
          return;
      }
    }
    // application — but a macro expands before any operand is evaluated
    if (head instanceof Sym) {
      const op = env.lookup(head.name);
      if (op instanceof Macro) {
        const argVals = args.map((a) => this.formToValue(a));
        this.stack.push({ t: 'expand', env, line });
        this.focus = { t: 'apply', fn: op.transformer, args: argVals, line };
        return;
      }
    }
    this.stack.push({ t: 'opwait', argForms: args, env, line });
    this.focus = { t: 'eval', form: head, env, line: lineOf(head, line) };
  }

  /** Evaluate `forms` as a sequence: the last form's value is the value,
   *  which is why the last form is focused without a wrapper frame. */
  private focusInto(forms: Form[], env: Env, line: number): void {
    if (forms.length === 0) { this.focus = { t: 'value', value: VOID }; return; }
    if (forms.length > 1) this.stack.push({ t: 'seq', rest: forms.slice(1), env, line });
    this.focus = { t: 'eval', form: forms[0]!, env, line: lineOf(forms[0]!, line) };
  }

  /** Shared operand iteration for `and`/`or` (tail position on the last).
   *  `line` is the enclosing form's line — the fallback for atom operands,
   *  which carry no line of their own. */
  private focusOperandwise(args: Form[], env: Env, which: 'and' | 'or', line: number): void {
    const first = lineOf(args[0]!, line);
    if (args.length > 1) this.stack.push({ t: which, rest: args.slice(1), env, line: first });
    this.focus = { t: 'eval', form: args[0]!, env, line: first };
  }

  private dispatchCondClause(clauses: FormArray[], env: Env): void {
    const clause = clauses[0]!;
    const rest = clauses.slice(1);
    if (clause.length === 0) throw new LispError('cond: empty clause', clause.line);
    const first = clause[0]!;
    if (first instanceof Sym && first.name === 'else') {
      if (rest.length > 0) throw new LispError('cond: else clause must be last', clause.line);
      this.focusInto(clause.slice(1), env, clause.line);
      return;
    }
    this.stack.push({ t: 'cond', clause, rest, env });
    this.focus = { t: 'eval', form: first, env, line: lineOf(first, clause.line) };
  }

  private evalDefine(args: Form[], env: Env, line: number): void {
    if (args.length === 0) throw new LispError('define: missing name', line);
    const target = args[0]!;
    if (Array.isArray(target)) {
      // (define (f a b) body…) — sugar for define + lambda, one reduction.
      const nameSym = target[0];
      if (!(nameSym instanceof Sym)) throw new LispError('define: function name must be a symbol', line);
      const params = parseParams(formSlice(target), 'define', line);
      if (args.length < 2) throw new LispError(`define: body of ${nameSym.name} is empty`, line);
      env.define(nameSym.name, new Closure(params, args.slice(1), env, line, nameSym.name));
      this.focus = { t: 'value', value: VOID };
      return;
    }
    const name = bindingName(target, 'define', line);
    if (args.length !== 2) throw new LispError(`define: expected 1 value for ${name}`, line);
    this.stack.push({ t: 'define', name, env, line });
    this.focus = { t: 'eval', form: args[1]!, env, line: lineOf(args[1]!, line) };
  }

  private evalDefineMacro(args: Form[], env: Env, line: number): void {
    if (args.length === 0) throw new LispError('define-macro: missing name', line);
    const target = args[0]!;
    if (Array.isArray(target)) {
      // (define-macro (my-if c t e) body…): the transformer is a lambda
      // whose "arguments" are the caller's unevaluated forms.
      const nameSym = target[0];
      if (!(nameSym instanceof Sym)) throw new LispError('define-macro: macro name must be a symbol', line);
      const params = parseParams(formSlice(target), 'define-macro', line);
      if (args.length < 2) throw new LispError(`define-macro: body of ${nameSym.name} is empty`, line);
      const transformer = new Closure(params, args.slice(1), env, line, nameSym.name);
      env.define(nameSym.name, new Macro(nameSym.name, transformer));
      this.focus = { t: 'value', value: VOID };
      return;
    }
    const name = bindingName(target, 'define-macro', line);
    if (args.length !== 2) throw new LispError(`define-macro: expected 1 transformer for ${name}`, line);
    this.stack.push({ t: 'defmacro', name, env, line });
    this.focus = { t: 'eval', form: args[1]!, env, line: lineOf(args[1]!, line) };
  }

  private evalLet(kind: 'let' | 'let*' | 'letrec', args: Form[], env: Env, line: number): void {
    if (args.length < 1 || !Array.isArray(args[0])) {
      throw new LispError(`${kind}: expected a binding list like ((x 1) (y 2))`, line);
    }
    const bindings = args[0] as FormArray[];
    for (const b of bindings) {
      if (!Array.isArray(b) || b.length !== 2 || !(b[0] instanceof Sym)) {
        throw new LispError(`${kind}: each binding must be (name value)`, (b as FormArray).line ?? line);
      }
    }
    const body = args.slice(1);
    if (body.length === 0) throw new LispError(`${kind}: body is empty`, line);
    if (bindings.length === 0) {
      this.focusInto(body, new Env(`${kind} (line ${line})`, env), line);
      return;
    }
    if (kind === 'letrec') {
      // Pre-bind every name so recursive right-hand sides can see them.
      const recEnv = new Env(`${kind} (line ${line})`, env);
      for (const b of bindings) recEnv.vars.set((b[0]! as Sym).name, VOID);
      this.stack.push({ t: 'let', kind, vars: [], vals: [], current: bindings[0]!, rest: bindings.slice(1), body, env: recEnv, line });
      this.focus = { t: 'eval', form: bindings[0]![1]!, env: recEnv, line: lineOf(bindings[0]![1]!, line) };
      return;
    }
    this.stack.push({ t: 'let', kind, vars: [], vals: [], current: bindings[0]!, rest: bindings.slice(1), body, env, line });
    this.focus = { t: 'eval', form: bindings[0]![1]!, env, line: lineOf(bindings[0]![1]!, line) };
  }

  private applyFocus(f: { t: 'apply'; fn: Value; args: Value[]; line: number }): void {
    const { fn, args, line } = f;
    if (fn instanceof Builtin) {
      checkArity(fn.name, fn.minArity, fn.maxArity, args.length, line);
      const ctx: BuiltinCtx = {
        out: (text) => { this.output += text; },
        heap: this.heap,
        env: this.envInnermost(),
        line,
      };
      this.focus = { t: 'value', value: fn.fn(args, ctx) };
      return;
    }
    if (fn instanceof Closure) {
      checkArity(fn.name ?? 'lambda', fn.params.length, fn.params.length, args.length, line);
      const frame = new Env(`${fn.name ?? 'lambda'} (line ${fn.line})`, fn.env);
      fn.params.forEach((p, i) => frame.vars.set(p, args[i]!));
      // Tail call: no continuation is pushed for the call itself — the
      // body's value flows straight to whoever was waiting on this call.
      this.focusInto(fn.body, frame, line);
      return;
    }
    throw new LispError(`not a procedure: ${withHeap(this.heap, () => renderWrite(fn))}`, line);
  }

  /** Innermost live environment: the focus's, else the top frame's. */
  envInnermost(): Env {
    const f = this.focus;
    if (f.t === 'eval') return f.env;
    const top = this.stack[this.stack.length - 1];
    return top !== undefined && 'env' in top ? top.env : this.global;
  }

  // ---- value: feed a produced value to the waiting continuation ----------

  private valueFocus(f: { t: 'value'; value: Value }): void {
    const frame = this.stack.pop();
    if (frame === undefined) { this.lastValue = f.value; this.focus = { t: 'halt' }; return; }
    const v = f.value;
    switch (frame.t) {
      case 'seq': {
        // A subform finished: continue the sequence. When the rest is empty
        // the value bubbles up (the last form was focused frame-free).
        const rest = frame.rest;
        if (rest.length === 0) { this.focus = { t: 'value', value: v }; return; }
        if (rest.length > 1) this.stack.push({ t: 'seq', rest: rest.slice(1), env: frame.env, line: frame.line });
        this.focus = { t: 'eval', form: rest[0]!, env: frame.env, line: lineOf(rest[0]!, frame.line) };
        return;
      }
      case 'opwait': {
        if (frame.argForms.length === 0) {
          this.focus = { t: 'apply', fn: v, args: [], line: frame.line };
          return;
        }
        this.stack.push({ t: 'args', op: v, done: [], rest: frame.argForms.slice(1), env: frame.env, line: frame.line });
        this.focus = { t: 'eval', form: frame.argForms[0]!, env: frame.env, line: lineOf(frame.argForms[0]!, frame.line) };
        return;
      }
      case 'args': {
        const done: Value[] = [...frame.done, v];
        if (frame.rest.length === 0) {
          this.focus = { t: 'apply', fn: frame.op, args: done, line: frame.line };
          return;
        }
        this.stack.push({ t: 'args', op: frame.op, done, rest: frame.rest.slice(1), env: frame.env, line: frame.line });
        this.focus = { t: 'eval', form: frame.rest[0]!, env: frame.env, line: lineOf(frame.rest[0]!, frame.line) };
        return;
      }
      case 'if': {
        const next = v === false ? frame.alt : frame.conseq;
        if (next === null) { this.focus = { t: 'value', value: VOID }; return; }
        this.focus = { t: 'eval', form: next, env: frame.env, line: lineOf(next, frame.line) };
        return;
      }
      case 'cond': {
        if (v !== false) {
          const body = frame.clause.slice(1);
          if (body.length === 0) { this.focus = { t: 'value', value: v }; return; }
          this.focusInto(body, frame.env, frame.clause.line);
          return;
        }
        if (frame.rest.length === 0) { this.focus = { t: 'value', value: VOID }; return; }
        this.dispatchCondClause(frame.rest, frame.env);
        return;
      }
      case 'let': {
        // v is the value of `current`'s initializer; fold it in, then ask
        // for the next binding (or run the body).
        const name = (frame.current[0]! as Sym).name;
        const vars = [...frame.vars, name];
        const vals: Value[] = [...frame.vals, v];
        let env = frame.env;
        if (frame.kind === 'let*') {
          env = new Env(`let* (line ${frame.line})`, frame.env);
          vars.forEach((n, i) => env.vars.set(n, vals[i]!));
        } else if (frame.kind === 'letrec') {
          env.vars.set(name, v);
        }
        if (frame.rest.length === 0) {
          const bodyEnv = frame.kind === 'let'
            ? new Env(`let (line ${frame.line})`, frame.env)
            : env;
          if (frame.kind === 'let') vars.forEach((n, i) => bodyEnv.vars.set(n, vals[i]!));
          this.focusInto(frame.body, bodyEnv, frame.line);
          return;
        }
        const next = frame.rest[0]!;
        this.stack.push({ t: 'let', kind: frame.kind, vars, vals, current: next, rest: frame.rest.slice(1), body: frame.body, env, line: frame.line });
        this.focus = { t: 'eval', form: next[1]!, env: frame.kind === 'let' ? frame.env : env, line: lineOf(next[1]!, frame.line) };
        return;
      }
      case 'define': {
        if (v instanceof Closure && v.name === undefined) v.name = frame.name;
        frame.env.define(frame.name, v);
        this.focus = { t: 'value', value: VOID };
        return;
      }
      case 'defmacro': {
        if (!(v instanceof Closure)) {
          throw new LispError(`define-macro: transformer must be a lambda, got ${withHeap(this.heap, () => renderWrite(v))}`, frame.line);
        }
        frame.env.define(frame.name, new Macro(frame.name, v));
        this.focus = { t: 'value', value: VOID };
        return;
      }
      case 'set': {
        const owner = frame.env.owner(frame.name);
        if (owner === null) throw new LispError(`set!: unbound variable: ${frame.name}`, frame.line);
        owner.vars.set(frame.name, v);
        this.focus = { t: 'value', value: VOID };
        return;
      }
      case 'and': {
        if (v === false) { this.focus = { t: 'value', value: false }; return; }
        if (frame.rest.length === 0) { this.focus = { t: 'value', value: v }; return; }
        if (frame.rest.length > 1) this.stack.push({ t: 'and', rest: frame.rest.slice(1), env: frame.env, line: frame.line });
        this.focus = { t: 'eval', form: frame.rest[0]!, env: frame.env, line: lineOf(frame.rest[0]!, frame.line) };
        return;
      }
      case 'or': {
        if (v !== false) { this.focus = { t: 'value', value: v }; return; }
        if (frame.rest.length === 0) { this.focus = { t: 'value', value: false }; return; }
        if (frame.rest.length > 1) this.stack.push({ t: 'or', rest: frame.rest.slice(1), env: frame.env, line: frame.line });
        this.focus = { t: 'eval', form: frame.rest[0]!, env: frame.env, line: lineOf(frame.rest[0]!, frame.line) };
        return;
      }
      case 'expand': {
        // The transformer produced the expansion as a list value; run it as
        // code in the caller's environment (unhygienic by design). The
        // expansion has no source lines of its own, so every form in it —
        // nested ones included — maps to the macro call's line.
        this.focus = { t: 'eval', form: this.valueToForm(v, frame.line), env: frame.env, line: frame.line };
        return;
      }
    }
  }

  // ---- forms ↔ values ------------------------------------------------------

  /** Quoted data becomes real cons cells on the heap (fresh each evaluation). */
  formToValue(f: Form): Value {
    if (Array.isArray(f)) {
      const tail = (f as FormArray & { dot?: Form }).dot;
      let acc: Value = tail !== undefined ? this.formToValue(tail) : null;
      for (let i = f.length - 1; i >= 0; i--) {
        acc = this.heap.alloc(this.formToValue(f[i]!), acc);
      }
      return acc;
    }
    return f;
  }

  /** Macro-expansion output (a list value) back to an executable form.
   *  The expansion has no source lines of its own — every form, nested
   *  ones included, is stamped with the macro call's `line`. */
  valueToForm(v: Value, line = 1): Form {
    if (v instanceof Ref) {
      const elems: Form[] = [];
      let cur: Value = v;
      while (cur instanceof Ref) {
        const cell = this.heap.get(cur.addr);
        elems.push(this.valueToForm(cell.car, line));
        cur = cell.cdr;
      }
      const f = elems as FormArray;
      f.line = line;
      if (cur !== null) (f as FormArray & { dot?: Form }).dot = this.valueToForm(cur, line);
      return f;
    }
    if (v === null) return mkForm([], line); // () as code — errors only if evaluated
    // VOID cannot appear in macro output; anything else is an atom form.
    return v as Form;
  }

  /** `(macroexpand-1 '(f x))`: expand one macro call, for teaching. */
  macroExpandOnce(formValue: Value, env: Env): Value {
    if (!(formValue instanceof Ref)) throw new LispError('macroexpand-1: expected a form (a list)');
    const head = this.heap.car(formValue);
    if (!(head instanceof Sym)) throw new LispError('macroexpand-1: head of the form is not a symbol');
    const op = env.lookup(head.name);
    if (!(op instanceof Macro)) throw new LispError(`macroexpand-1: ${head.name} is not a macro`);
    const argVals: Value[] = [];
    let cur = this.heap.cdr(formValue);
    while (cur instanceof Ref) {
      argVals.push(this.heap.car(cur));
      cur = this.heap.cdr(cur);
    }
    const frame = new Env(`${fnName(op.transformer)} (line ${op.transformer.line})`, op.transformer.env);
    op.transformer.params.forEach((p, i) => frame.vars.set(p, argVals[i]!));
    let result: Value = VOID;
    for (const form of op.transformer.body) result = this.evalImmediately(form, frame);
    return result;
  }

  /** Immediate recursive evaluation — only for macro transformers whose
   *  bodies are small templates; never on the main evaluation path. */
  private evalImmediately(form: Form, env: Env): Value {
    const savedStack = this.stack.splice(0, this.stack.length);
    const savedFocus = this.focus;
    const savedError = this.error;
    this.focus = { t: 'eval', form, env, line: lineOf(form, 1) };
    let guard = 0;
    let last: Value = VOID;
    while (!this.stopped() && guard++ < 10_000) {
      // Consume the value *before* the next reduce bubbles it into `halt`.
      const peeked = this.peekValue();
      if (peeked !== null) last = peeked.value;
      this.reduce();
    }
    // The guard tripped: the transformer never finished. Drop whatever
    // half-reduced state the sub-run left behind (frames it pushed, a
    // partial `last` value) before restoring the caller's machine.
    const ranOut = !this.stopped();
    this.stack.splice(0, this.stack.length);
    this.stack.push(...savedStack);
    this.focus = savedFocus;
    if (this.error !== null) {
      const e = this.error;
      this.error = savedError;
      throw new LispError(e);
    }
    if (ranOut) throw new LispError('macro transformer too long (over 10 000 reductions)');
    if (this.focus.t === 'value') return this.focus.value;
    if (last !== VOID) return last;
    throw new LispError('macro transformer did not produce a value');
  }

  /** Read the focus as a value without control-flow narrowing. */
  private peekValue(): { value: Value } | null {
    const f: Focus = this.focus;
    return f.t === 'value' ? { value: f.value } : null;
  }
}

function fnName(c: Closure): string {
  return c.name ?? 'lambda';
}

// ---- helpers ---------------------------------------------------------------

function expectArity(args: Form[], n: number, who: string, line: number): void {
  if (args.length !== n) throw new LispError(`${who}: expected ${n} argument${n === 1 ? '' : 's'}, got ${args.length}`, line);
}

function checkArity(who: string, min: number, max: number, got: number, line: number): void {
  if (got < min || got > max) {
    const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}–${max}`;
    const plural = min === 1 && max === 1 ? '' : 's';
    throw new LispError(`${who}: expected ${want} argument${plural}, got ${got}`, line);
  }
}

function bindingName(f: Form, who: string, line: number): string {
  if (!(f instanceof Sym)) throw new LispError(`${who}: name must be a symbol`, line);
  return f.name;
}

/** Params of a lambda/define: a flat list of symbols (no variadic sugar). */
function parseParams(f: Form | null, who: string, line: number): string[] {
  if (f === null || !Array.isArray(f)) throw new LispError(`${who}: expected a parameter list`, line);
  const params: string[] = [];
  for (const p of f) {
    if (!(p instanceof Sym)) throw new LispError(`${who}: parameter names must be symbols`, line);
    params.push(p.name);
  }
  return params;
}

/** (f a b) definition head → the parameter list [a, b] = head minus its car. */
function formSlice(target: FormArray): Form {
  const f = target.slice(1) as FormArray;
  f.line = target.line;
  return f;
}

// ---- quasiquote → cons/append/quote code ------------------------------------

function mkForm(elems: Form[], line = 1): FormArray {
  const f = elems as FormArray;
  f.line = line;
  return f;
}

/**
 * Desugar a quasiquote template into ordinary code — the classic textbook
 * expansion: `` `x `` → (quote x); `` `(a ,b ,@c d) `` →
 * (cons b (append c (quote (d)))). Nested quasiquotes track depth. The
 * expansion is ordinary code, so it steps and line-maps like any form.
 */
export function qqExpand(t: Form, depth: number): Form {
  if (!Array.isArray(t)) return mkForm([S('quote'), t]);
  if (t.length === 0) return mkForm([S('quote'), mkForm([])]);
  const head = t[0]!;
  const dotted = (t as FormArray & { dot?: Form }).dot;
  const tailForm: Form = dotted !== undefined
    ? qqExpand(dotted, depth)
    : qqExpand(t.slice(1) as FormArray, depth);

  if (head instanceof Sym && head.name === 'unquote') {
    if (t.length !== 2) throw new LispError('unquote: expected exactly 1 expression', t.line);
    if (depth === 1) return t[1]!;
    return mkForm([S('list'), mkForm([S('quote'), S('unquote')]), qqExpand(t[1]!, depth - 1)], t.line);
  }
  if (head instanceof Sym && head.name === 'quasiquote') {
    if (t.length !== 2) throw new LispError('quasiquote: expected exactly 1 template', t.line);
    return mkForm([S('list'), mkForm([S('quote'), S('quasiquote')]), qqExpand(t[1]!, depth + 1)], t.line);
  }
  if (Array.isArray(head) && head[0] instanceof Sym && head[0].name === 'unquote-splicing' && head.length === 2) {
    if (depth === 1) return mkForm([S('append'), head[1]!, tailForm], t.line);
    const rebuilt = mkForm([S('list'), mkForm([S('quote'), S('unquote-splicing')]), qqExpand(head[1]!, depth - 1)], head.line);
    return mkForm([S('cons'), rebuilt, tailForm], t.line);
  }
  return mkForm([S('cons'), qqExpand(head, depth), tailForm], t.line);
}

const lineOf = (f: Form, fallback: number): number => (Array.isArray(f) ? f.line : fallback);
