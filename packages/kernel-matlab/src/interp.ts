// interp.ts — tree-walking evaluator for the MATLAB-flavored teaching
// subset, written as generator functions: every statement yields *before*
// it executes, so the Session driver can step one statement at a time and
// stop at breakpoints without unwinding loop/call state (the generator IS
// the resumption point).
//
// Semantics implemented on purpose, because they are the lesson:
//   * matrices are the ONLY data structure, stored column-major in one
//     flat array — A(3) is the third element counting down the columns;
//   * `for` iterates the COLUMNS of a matrix (MATLAB truth);
//   * scripts run in the base workspace, functions get a fresh one — a
//     function cannot see or touch the script's variables;
//   * `\` and `/` solve by Gaussian elimination with partial pivoting,
//     the same elimination idea MATLAB dispatches to for square systems;
//   * no rand anywhere: identical source runs identically, forever.

import type { Expr, FunctionDecl, Program, Stmt } from './parser';
import {
  Mat, MatErr, checkElems, col, eye, filled, gather, gaussSolve,
  inv as matInv, det as matDet, fmtRows, fmtNum, row, scalar, transpose,
} from './matrix';

export const RUN_BUDGET = 1_000_000;
export const MAX_DEPTH = 4096;

// ─── values ────────────────────────────────────────────────────────────────

/** A single-quoted string. Strings exist only as display text: they may be
 *  passed to disp/fprintf/error and nothing else — assigning, comparing or
 *  indexing one is refused with a line-mapped error. */
export interface StrVal {
  kind: 'str';
  text: string;
}

export type Value = Mat | StrVal;

export function isStr(v: Value): v is StrVal {
  return typeof v === 'object' && v !== null && 'kind' in v;
}

const stringsRefusal =
  "not in the teaching subset: strings are display text only — pass them to disp(), fprintf() or error()";

// ─── control-flow signals & errors ─────────────────────────────────────────

class BreakSignal {
  constructor(public line: number) {}
}
class ReturnSignal {
  constructor(public line: number) {}
}

export class RuntimeErr extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

export class BudgetErr extends Error {
  constructor(public line: number) {
    super(
      `run budget exceeded (${RUN_BUDGET.toLocaleString('en-US')} evaluation units) — the program never finished`,
    );
  }
}

/** What a statement yields to the driver before it executes. */
export interface YieldInfo {
  line: number;
}

/** One workspace: the script frame owns the BASE workspace, every function
 *  call pushes a frame with a private one — that boundary is the lesson. */
export interface Frame {
  name: string;
  ws: Map<string, Mat>;
  line: number;
}

/** The most recent base-workspace write, for the Matrices panel. */
export interface WriteMark {
  name: string;
  /** Column-major addresses the LAST statement touched; null = all. */
  addrs: number[] | null;
  line: number;
}

const BUILTIN_NAMES = [
  'zeros', 'ones', 'eye', 'diag', 'size', 'length', 'numel', 'sum', 'mean',
  'max', 'min', 'abs', 'floor', 'ceil', 'round', 'sqrt', 'exp', 'sin', 'cos',
  'sort', 'fliplr', 'flipud', 'det', 'inv', 'linspace',
  'disp', 'fprintf', 'error', 'rand',
];

// ─── interpreter ───────────────────────────────────────────────────────────

export class Interpreter {
  /** Call stack: frame 0 is the script (base workspace); each function
   *  call pushes a frame with a private workspace. */
  frames: Frame[] = [];
  steps = 0;
  output = '';
  /** Which base-workspace matrix the Matrices panel dissects. */
  lastWrite: WriteMark | null = null;

  private program: Program;
  private funcs = new Map<string, FunctionDecl>();
  private done = false;
  /** Set when the LAST executed statement was a base-workspace write. */
  private touch: WriteMark | null = null;

  constructor(program: Program) {
    this.program = program;
    for (const f of program.functions) this.funcs.set(f.name, f);
    this.frames.push({ name: 'script', ws: new Map(), line: 1 });
  }

  *runAll(): Generator<YieldInfo, void> {
    try {
      yield* this.execStmts(this.program.body);
    } catch (e) {
      if (e instanceof BreakSignal) {
        throw new RuntimeErr("'break' must be inside a for or while loop", e.line);
      }
      if (e instanceof ReturnSignal) {
        throw new RuntimeErr("'return' must be inside a function", e.line);
      }
      throw e;
    }
    this.done = true;
  }

  isDone(): boolean {
    return this.done;
  }

  /** The write the LAST statement performed (panel current marks); null
   *  when the last statement was not a base-workspace write. */
  currentWrite(): WriteMark | null {
    return this.touch;
  }

  private tick(line: number): void {
    if (++this.steps > RUN_BUDGET) throw new BudgetErr(line);
    this.frames[this.frames.length - 1]!.line = line;
  }

  private frame(): Frame {
    return this.frames[this.frames.length - 1]!;
  }

  private atBase(): boolean {
    return this.frames.length === 1;
  }

  // -- statements ------------------------------------------------------

  *execStmts(stmts: Stmt[]): Generator<YieldInfo, void> {
    for (const s of stmts) yield* this.execStmt(s);
  }

  *execStmt(s: Stmt): Generator<YieldInfo, void> {
    this.tick(s.line);
    yield { line: s.line };
    this.touch = null;
    switch (s.type) {
      case 'Expr': {
        const v = yield* this.evalExpr(s.expr);
        if (v === undefined) return; // disp/fprintf: display only, no ans
        if (isStr(v)) throw new RuntimeErr(stringsRefusal, s.line);
        this.frame().ws.set('ans', v.clone()); // a bare expression names its result
        if (!s.quiet) this.echo('ans', v);
        return;
      }
      case 'Assign': {
        const v = requireMat(
          yield* this.evalExpr(s.expr),
          'as the right side of an assignment',
          s.line,
        );
        if (s.target.kind === 'name') {
          this.frame().ws.set(s.target.name, v.clone());
          this.markWrite(s.target.name, null, s.line);
        } else {
          const addrs = yield* this.evalIndexWrite(s.target, v, s.line);
          this.markWrite(s.target.name, addrs, s.line);
        }
        if (!s.quiet) this.echo(s.target.name, this.frame().ws.get(s.target.name)!);
        return;
      }
      case 'MultiAssign': {
        const outs = yield* this.callUser(s.call, s.line);
        if (outs.length !== s.names.length) {
          throw new RuntimeErr(
            `function '${s.call.name}' returns ${outs.length} output${outs.length === 1 ? '' : 's'} — cannot fill [${s.names.join(', ')}]`,
            s.line,
          );
        }
        s.names.forEach((n, i) => {
          this.frame().ws.set(n, outs[i]!);
          this.markWrite(n, null, s.line);
        });
        if (!s.quiet) {
          for (const n of s.names) this.echo(n, this.frame().ws.get(n)!);
        }
        return;
      }
      case 'If': {
        for (const arm of s.arms) {
          if (condTruthy(yield* this.evalExpr(arm.cond), arm.cond.line)) {
            yield* this.execStmts(arm.body);
            return;
          }
        }
        if (s.elseBody !== null) yield* this.execStmts(s.elseBody);
        return;
      }
      case 'While': {
        for (;;) {
          this.tick(s.line);
          if (!condTruthy(yield* this.evalExpr(s.cond), s.line)) break;
          try {
            yield* this.execStmts(s.body);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            throw e;
          }
        }
        return;
      }
      case 'For': {
        const over = requireMat(
          yield* this.evalExpr(s.expr),
          'as the thing a for loop walks',
          s.line,
        );
        // MATLAB truth: `for` walks the COLUMNS of the matrix.
        for (let j = 1; j <= over.cols; j++) {
          this.tick(s.line);
          const column = new Mat(over.rows, 1, over.data.slice((j - 1) * over.rows, j * over.rows));
          this.frame().ws.set(s.v, column);
          try {
            yield* this.execStmts(s.body);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            throw e;
          }
        }
        return;
      }
      case 'Break':
        throw new BreakSignal(s.line);
      case 'Return':
        throw new ReturnSignal(s.line);
    }
  }

  /** Record a base-workspace write for the Matrices panel (ans never
   *  steals the panel; function locals stay invisible to the base). */
  private markWrite(name: string, addrs: number[] | null, line: number): void {
    if (!this.atBase() || name === 'ans') return;
    const mark = { name, addrs, line };
    this.lastWrite = mark;
    this.touch = mark;
  }

  // -- display ---------------------------------------------------------

  /** MATLAB's assignment echo: "name =", a blank line, then the matrix. */
  echo(name: string, m: Mat): void {
    this.output += `${name} =\n\n${fmtRows(m).join('\n')}\n`;
  }

  // -- expressions -----------------------------------------------------
  // undefined result = "produced no value" (disp/fprintf); every consumer
  // that needs a value routes through requireMat / num1 / condTruthy.

  *evalExpr(e: Expr, endVal?: number): Generator<YieldInfo, Value | undefined> {
    switch (e.type) {
      case 'Num':
        return scalar(e.value);
      case 'Str':
        return { kind: 'str', text: e.text };
      case 'Name': {
        const v = this.frame().ws.get(e.name);
        if (v !== undefined) return v;
        if (this.funcs.has(e.name) || BUILTIN_NAMES.includes(e.name)) {
          throw new RuntimeErr(`'${e.name}' is a function — write ${e.name}(…) to call it`, e.line);
        }
        throw new RuntimeErr(`undefined variable '${e.name}' — matrices come from assignments`, e.line);
      }
      case 'End':
        if (endVal === undefined) {
          throw new RuntimeErr("'end' is only valid inside an index like A(1:end) or A(2:end, :)", e.line);
        }
        return scalar(endVal);
      case 'Colon':
        throw new RuntimeErr("':' can only appear inside an index like A(:,2)", e.line);
      case 'Matrix':
        return this.evalMatrixLit(e.rows, e.line);
      case 'Range': {
        const start = num1(yield* this.evalExpr(e.start, endVal), 'a range start', e.line);
        const step = e.step === null ? 1 : num1(yield* this.evalExpr(e.step, endVal), 'a range step', e.line);
        const stop = num1(yield* this.evalExpr(e.stop, endVal), 'a range stop', e.line);
        return buildRange(start, step, stop, e.line);
      }
      case 'Unary': {
        const v = requireMat(yield* this.evalExpr(e.arg, endVal), 'after a unary operator', e.line);
        if (e.op === '-') {
          return new Mat(v.rows, v.cols, v.data.map((x) => -x));
        }
        return new Mat(v.rows, v.cols, v.data.map((x) => (x === 0 ? 1 : 0)));
      }
      case 'Binary': {
        const l = requireMat(yield* this.evalExpr(e.left, endVal), `as the left side of '${e.op}'`, e.line);
        const r = requireMat(yield* this.evalExpr(e.right, endVal), `as the right side of '${e.op}'`, e.line);
        return binop(e.op, l, r, e.line);
      }
      case 'Logic': {
        const lv = scalarBool(yield* this.evalExpr(e.left, endVal), e.line, e.op);
        if (e.op === '&&' && !lv) return scalar(0); // short-circuit, as in MATLAB
        if (e.op === '||' && lv) return scalar(1);
        return scalar(scalarBool(yield* this.evalExpr(e.right, endVal), e.line, e.op) ? 1 : 0);
      }
      case 'Transpose': {
        const v = requireMat(yield* this.evalExpr(e.arg, endVal), "under transpose (')", e.line);
        return transpose(v);
      }
      case 'Call': {
        // MATLAB resolves `name(…)` at runtime: a variable in the
        // workspace shadows the function and turns (…) into indexing.
        const v = this.frame().ws.get(e.name);
        if (v !== undefined) return this.indexRead(v, e);
        if (this.funcs.has(e.name)) {
          const outs = yield* this.callUser(e, e.line);
          // A function with no declared output runs for side effects; a
          // consumer that needs a value gets the void error instead.
          if (outs.length === 0) return undefined;
          return outs[0]!;
        }
        return this.callBuiltin(e);
      }
    }
  }

  /** [ ] literal: horizontal concatenation within a row (rows must
   *  match), vertical concatenation across rows (columns must match). */
  private evalMatrixLit(rows: Expr[][], line: number): Mat {
    if (rows.length === 0) return new Mat(0, 0, []);
    const rowMats: Mat[] = [];
    for (const items of rows) {
      let acc: Mat | null = null;
      for (const item of items) {
        const v = requireMat(this.evalSync(item), 'inside a [ ] literal', item.line);
        if (acc === null) {
          acc = v;
          continue;
        }
        if (acc.rows !== v.rows) {
          throw new RuntimeErr(
            `cannot place a ${v.rows}x${v.cols} next to a ${acc.rows}x${acc.cols} — rows must match inside [ a b ]`,
            line,
          );
        }
        acc = new Mat(acc.rows, acc.cols + v.cols, [...acc.data, ...v.data]);
      }
      rowMats.push(acc!);
    }
    let out = rowMats[0]!;
    for (const m of rowMats.slice(1)) {
      if (out.cols !== m.cols) {
        throw new RuntimeErr(
          `cannot stack a ${m.rows}x${m.cols} under a ${out.rows}x${out.cols} — columns must match across ';'`,
          line,
        );
      }
      // Vertical stacking interleaves column blocks: in column-major
      // storage, column j of [top; bottom] is column j of top followed
      // by column j of bottom.
      const data: number[] = [];
      for (let j = 0; j < out.cols; j++) {
        data.push(...out.data.slice(j * out.rows, (j + 1) * out.rows));
        data.push(...m.data.slice(j * m.rows, (j + 1) * m.rows));
      }
      out = new Mat(out.rows + m.rows, out.cols, data);
    }
    try {
      checkElems(out.rows, out.cols, line);
    } catch (e) {
      if (e instanceof MatErr) throw new RuntimeErr(e.message, line);
      throw e;
    }
    return out;
  }

  /** Synchronous expression evaluation: matrix-literal items, index
   *  arguments and builtin arguments are values — no statement boundary
   *  can fall inside them, so the statement generator is drained without
   *  ever pausing (calls inside still tick the budget). */
  private evalSync(e: Expr, endVal?: number): Value | undefined {
    const gen = this.evalExpr(e, endVal);
    let r = gen.next();
    while (!r.done) r = gen.next();
    return r.value;
  }

  // -- indexing --------------------------------------------------------

  /** Validate one index value: positive integers inside bounds only. */
  private expandIndex(
    v: Value | undefined,
    name: string,
    kind: 'row' | 'col' | 'linear',
    m: Mat,
    line: number,
  ): number[] {
    const x = requireMat(v, 'as an index', line);
    if (!isVector(x)) {
      throw new RuntimeErr(`an index must be a scalar or a vector (got ${x.rows}x${x.cols})`, line);
    }
    const limit = kind === 'linear' ? m.numel() : kind === 'row' ? m.rows : m.cols;
    const out: number[] = [];
    for (const raw of x.data) {
      const k = Math.round(raw);
      if (!Number.isInteger(raw) || k < 1) {
        throw new RuntimeErr(`an index must be a positive integer (got ${fmtNum(raw)})`, line);
      }
      if (k > limit) {
        const where = kind === 'linear'
          ? `linear index ${k} (${name} has ${limit} elements)`
          : kind === 'row'
            ? `row index ${k} (${name} has ${limit} rows)`
            : `column index ${k} (${name} has ${limit} columns)`;
        throw new RuntimeErr(`${where} is out of bounds`, line);
      }
      out.push(k);
    }
    return out;
  }

  /** Read A(i,j) / A(i) / A(i,:) / A(:,j) / A(1:2, 2:end) / A(:). */
  private indexRead(m: Mat, e: Extract<Expr, { type: 'Call' }>): Mat {
    const line = e.line;
    // `end` inside argument k means: size of that dimension (numel for
    // the single-argument linear form).
    const arg = (k: number, kind: 'row' | 'col' | 'linear'): number[] => {
      const a = e.args[k]!;
      const endValue = kind === 'linear' ? m.numel() : kind === 'row' ? m.rows : m.cols;
      if (a.type === 'Colon') return allIdx(endValue);
      return this.expandIndex(this.evalSync(a, endValue), e.name, kind, m, a.line);
    };
    if (e.args.length === 1) {
      const idx = arg(0, 'linear');
      if (idx.length === 0) return new Mat(0, 1, []);
      if (idx.length === 1) return scalar(m.lin(idx[0]!));
      // A([1 3]) gathers column-major into a column vector.
      return new Mat(idx.length, 1, idx.map((k) => m.lin(k)));
    }
    if (e.args.length === 2) {
      return gather(m, arg(0, 'row'), arg(1, 'col'));
    }
    throw new RuntimeErr('this interpreter is 2D — at most two index arguments, A(i,j)', line);
  }

  /** Assignment through an index: scalar/submatrix/row/column writes and
   *  the row/column deletions. Returns the touched column-major addresses
   *  (null when every element counts as touched). */
  private *evalIndexWrite(
    target: { name: string; args: Expr[] },
    rhs: Mat,
    line: number,
  ): Generator<YieldInfo, number[] | null> {
    const m = this.frame().ws.get(target.name);
    if (m === undefined) {
      throw new RuntimeErr(`undefined variable '${target.name}' — matrices come from assignments`, line);
    }

    // Expand each target dimension; `end` inside argument k is the size
    // of that dimension, exactly as in a read.
    const dims: { list: number[]; all: boolean }[] = target.args.map((a, k) => {
      if (a.type === 'Colon') return { list: [], all: true };
      const kind = target.args.length === 1 ? 'linear' : k === 0 ? 'row' : 'col';
      const endValue = kind === 'linear' ? m.numel() : kind === 'row' ? m.rows : m.cols;
      return { list: this.expandIndex(this.evalSync(a, endValue), target.name, kind, m, a.line), all: false };
    });

    // Deletion: A(i,:) = [] / A(:,j) = [] drop whole rows/columns.
    if (rhs.numel() === 0) {
      // Exactly one ':' — it spans the dimension that SURVIVES; the
      // explicit list names the rows (or columns) being dropped.
      if (target.args.length === 2 && dims[0]!.all !== dims[1]!.all) {
        const keepR = dims[0]!.all ? allIdx(m.rows) : allIdx(m.rows).filter((i) => !dims[0]!.list.includes(i));
        const keepC = dims[1]!.all ? allIdx(m.cols) : allIdx(m.cols).filter((j) => !dims[1]!.list.includes(j));
        this.frame().ws.set(target.name, gather(m, keepR, keepC));
        return null;
      }
      throw new RuntimeErr(
        "deleting with [] works on whole rows or columns only — write A(i,:) = [] or A(:,j) = []",
        line,
      );
    }

    if (dims.length === 1) {
      const idx = dims[0]!.all ? allIdx(m.numel()) : dims[0]!.list;
      if (idx.length !== rhs.numel() && rhs.numel() !== 1) {
        throw new RuntimeErr(
          `cannot assign ${rhs.numel()} element${rhs.numel() === 1 ? '' : 's'} to ${idx.length} target element${idx.length === 1 ? '' : 's'} of ${target.name}`,
          line,
        );
      }
      const addrs: number[] = [];
      idx.forEach((k, i) => {
        m.data[k - 1] = rhs.data[rhs.numel() === 1 ? 0 : i]!;
        addrs.push(k - 1);
      });
      return addrs;
    }

    const rs = dims[0]!.all ? allIdx(m.rows) : dims[0]!.list;
    const cs = dims[1]!.all ? allIdx(m.cols) : dims[1]!.list;
    if (rs.length * cs.length !== rhs.numel() && rhs.numel() !== 1) {
      throw new RuntimeErr(
        `cannot assign a ${rhs.rows}x${rhs.cols} matrix to the ${rs.length}x${cs.length} target of ${target.name}`,
        line,
      );
    }
    const addrs: number[] = [];
    for (let b = 0; b < cs.length; b++) {
      for (let a = 0; a < rs.length; a++) {
        m.set(rs[a]!, cs[b]!, rhs.data[rhs.numel() === 1 ? 0 : b * rs.length + a]!);
        addrs.push(m.addr(rs[a]!, cs[b]!));
      }
    }
    return addrs;
  }

  // -- functions & builtins ---------------------------------------------

  *callUser(e: Extract<Expr, { type: 'Call' }>, line: number): Generator<YieldInfo, Mat[]> {
    const decl = this.funcs.get(e.name);
    if (decl === undefined) {
      throw new RuntimeErr(`undefined function '${e.name}'`, line);
    }
    const args: Mat[] = [];
    for (const a of e.args) {
      if (a.type === 'Colon') {
        throw new RuntimeErr("':' is not a function argument", a.line);
      }
      args.push(requireMat(yield* this.evalExpr(a), 'as a function argument', a.line));
    }
    if (args.length !== decl.params.length) {
      throw new RuntimeErr(
        `function '${decl.name}' expects ${decl.params.length} argument${decl.params.length === 1 ? '' : 's'}, got ${args.length}`,
        line,
      );
    }
    if (this.frames.length >= MAX_DEPTH) {
      throw new RuntimeErr(
        `call stack too deep (over ${MAX_DEPTH.toLocaleString('en-US')} nested calls) — recursion needs a base case`,
        line,
      );
    }
    const ws = new Map<string, Mat>();
    decl.params.forEach((p, i) => ws.set(p, args[i]!.clone()));
    this.frames.push({ name: decl.name, ws, line: decl.line });
    try {
      yield* this.execStmts(decl.body);
    } catch (err) {
      if (!(err instanceof ReturnSignal)) throw err;
    } finally {
      this.frames.pop();
    }
    if (decl.outputs === null) return [];
    return decl.outputs.map((name) => {
      const v = ws.get(name);
      if (v === undefined) {
        throw new RuntimeErr(`function '${decl.name}' never assigned output '${name}'`, decl.line);
      }
      return v;
    });
  }

  callBuiltin(e: Extract<Expr, { type: 'Call' }>): Value | undefined {
    const line = e.line;
    const fn = BUILTINS[e.name];
    if (fn === undefined) {
      throw new RuntimeErr(`undefined function '${e.name}'`, line);
    }
    // Strings are legal only where display text is expected.
    const displayOnly = e.name === 'disp' || e.name === 'fprintf' || e.name === 'error';
    const args: Value[] = [];
    for (const a of e.args) {
      if (a.type === 'Colon') {
        throw new RuntimeErr("':' is not a function argument", a.line);
      }
      const v = this.evalSync(a);
      if (v === undefined) {
        throw new RuntimeErr('a call that returns nothing (disp/fprintf) cannot be used as an argument', a.line);
      }
      if (isStr(v) && !displayOnly) {
        throw new RuntimeErr(stringsRefusal, a.line);
      }
      args.push(v);
    }
    return fn(this, args, line);
  }
}

// ─── value helpers ─────────────────────────────────────────────────────────

function requireMat(v: Value | undefined, where: string, line: number): Mat {
  if (v === undefined) {
    throw new RuntimeErr(`a call that returns nothing (disp/fprintf) cannot be used ${where}`, line);
  }
  if (isStr(v)) throw new RuntimeErr(stringsRefusal, line);
  return v;
}

function num1(v: Value | undefined, what: string, line: number): number {
  const m = requireMat(v, `as ${what}`, line);
  if (m.rows !== 1 || m.cols !== 1) {
    throw new RuntimeErr(`${what} must be a scalar (got ${m.rows}x${m.cols})`, line);
  }
  return m.get(1, 1);
}

/** if/while condition: a scalar is true when nonzero; a matrix is true
 *  when EVERY element is nonzero (the Octave rule — the lesson says so). */
function condTruthy(v: Value | undefined, line: number): boolean {
  const m = requireMat(v, 'as a condition', line);
  if (m.numel() === 1) return m.get(1, 1) !== 0;
  if (m.numel() === 0) return false;
  return m.data.every((x) => x !== 0);
}

/** && and || operands must be scalars, as in MATLAB. */
function scalarBool(v: Value | undefined, line: number, op: string): boolean {
  const m = requireMat(v, `as an operand of '${op}'`, line);
  if (m.numel() !== 1) {
    throw new RuntimeErr(`'${op}' needs scalar operands in this subset (got ${m.rows}x${m.cols})`, line);
  }
  return m.get(1, 1) !== 0;
}

function isVector(m: Mat): boolean {
  return m.rows === 1 || m.cols === 1;
}

function allIdx(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

function buildRange(start: number, step: number, stop: number, line: number): Mat {
  if (step === 0) throw new RuntimeErr('range step cannot be 0', line);
  const n = Math.floor((stop - start) / step + 1e-9) + 1;
  if (n <= 0) return new Mat(1, 0, []);
  try {
    checkElems(1, n, line);
  } catch (e) {
    if (e instanceof MatErr) throw new RuntimeErr(e.message, line);
    throw e;
  }
  const data = new Array<number>(n);
  for (let k = 0; k < n; k++) data[k] = start + k * step;
  return new Mat(1, n, data);
}

// ─── matrix arithmetic ─────────────────────────────────────────────────────

/** Binary matrix arithmetic; scalars (1x1) broadcast like MATLAB. */
function binop(op: string, a: Mat, b: Mat, line: number): Mat {
  if (op === '+') return elementwise(a, b, line, (x, y) => x + y, op);
  if (op === '-') return elementwise(a, b, line, (x, y) => x - y, op);
  if (op === '.*') return elementwise(a, b, line, (x, y) => x * y, op);
  if (op === './') return elementwise(a, b, line, (x, y) => x / y, op);
  if (op === '.^') return elementwise(a, b, line, (x, y) => x ** y, op);
  if (op === '<') return elementwise(a, b, line, (x, y) => (x < y ? 1 : 0), op);
  if (op === '<=') return elementwise(a, b, line, (x, y) => (x <= y ? 1 : 0), op);
  if (op === '>') return elementwise(a, b, line, (x, y) => (x > y ? 1 : 0), op);
  if (op === '>=') return elementwise(a, b, line, (x, y) => (x >= y ? 1 : 0), op);
  if (op === '==') return elementwise(a, b, line, (x, y) => (x === y ? 1 : 0), op);
  if (op === '~=') return elementwise(a, b, line, (x, y) => (x !== y ? 1 : 0), op);
  if (op === '*') {
    if (a.numel() === 1) return elementwise(scalar(1), b, line, (_one, y) => a.get(1, 1) * y, op);
    if (b.numel() === 1) return elementwise(a, scalar(1), line, (x, _one) => x * b.get(1, 1), op);
    if (a.cols !== b.rows) {
      throw new RuntimeErr(
        `inner dimensions must agree for '*' (${a.rows}x${a.cols} * ${b.rows}x${b.cols})`,
        line,
      );
    }
    const out = new Mat(a.rows, b.cols, new Array<number>(a.rows * b.cols).fill(0));
    for (let j = 1; j <= b.cols; j++) {
      for (let i = 1; i <= a.rows; i++) {
        let s = 0;
        for (let k = 1; k <= a.cols; k++) s += a.get(i, k) * b.get(k, j);
        out.set(i, j, s);
      }
    }
    return out;
  }
  if (op === '\\') {
    if (a.numel() === 1) {
      return elementwise(b, scalar(1), line, (x, _one) => x / a.get(1, 1), op);
    }
    if (a.rows !== a.cols || b.rows !== a.rows) {
      throw new RuntimeErr(
        `not in the teaching subset: A\\b solves square systems only — A is ${a.rows}x${a.cols}, b is ${b.rows}x${b.cols}`,
        line,
      );
    }
    return solve(a, b, line);
  }
  if (op === '/') {
    if (b.numel() === 1) {
      return elementwise(a, scalar(1), line, (x, _one) => x / b.get(1, 1), op);
    }
    if (b.rows !== b.cols || a.cols !== b.cols) {
      throw new RuntimeErr(
        `not in the teaching subset: A/B solves x*B = A with B square — A is ${a.rows}x${a.cols}, B is ${b.rows}x${b.cols}`,
        line,
      );
    }
    // A/B solves x*B = A. Transposing both sides gives B'x' = A', so
    // solve B'X' = A' by elimination and transpose back.
    return transpose(solve(transpose(b), transpose(a), line));
  }
  if (op === '^') {
    const n = num1(b, "the '^' exponent", line);
    if (a.rows !== a.cols || !Number.isInteger(n) || n < 0) {
      throw new RuntimeErr(
        "not in the teaching subset: '^' needs a square matrix and a non-negative integer exponent (use .^ for elementwise power)",
        line,
      );
    }
    // binary exponentiation: A^13 = A·A²·A⁴·A⁸
    let result = eye(a.rows, a.rows, line);
    let base = a;
    let k = n;
    while (k > 0) {
      if (k % 2 === 1) result = binop('*', result, base, line);
      base = k > 1 ? binop('*', base, base, line) : base;
      k = Math.floor(k / 2);
    }
    return result;
  }
  throw new RuntimeErr(`unknown operator '${op}'`, line);
}

function solve(a: Mat, b: Mat, line: number): Mat {
  try {
    return gaussSolve(a, b, line);
  } catch (e) {
    if (e instanceof MatErr) {
      throw new RuntimeErr(`${e.message} — cannot solve A\\b`, line);
    }
    throw e;
  }
}

/** Elementwise op over broadcast-compatible matrices (a 1x1 on either
 *  side fills, like MATLAB's scalar expansion). */
function elementwise(
  a: Mat,
  b: Mat,
  line: number,
  f: (x: number, y: number) => number,
  op: string,
): Mat {
  const shape = broadcastShape(a, b, op, line);
  const out = new Mat(shape[0], shape[1], new Array<number>(shape[0] * shape[1]));
  for (let j = 1; j <= shape[1]; j++) {
    for (let i = 1; i <= shape[0]; i++) {
      const x = a.get(Math.min(i, a.rows), Math.min(j, a.cols));
      const y = b.get(Math.min(i, b.rows), Math.min(j, b.cols));
      out.set(i, j, f(x, y));
    }
  }
  return out;
}

function broadcastShape(a: Mat, b: Mat, op: string, line: number): [number, number] {
  if (a.rows === b.rows && a.cols === b.cols) return [a.rows, a.cols];
  if (a.numel() === 1) return [b.rows, b.cols];
  if (b.numel() === 1) return [a.rows, a.cols];
  throw new RuntimeErr(
    `matrix dimensions must agree for '${op}' (${a.rows}x${a.cols} vs ${b.rows}x${b.cols}); a 1x1 broadcasts`,
    line,
  );
}

// ─── builtins ──────────────────────────────────────────────────────────────

type Builtin = (interp: Interpreter, args: Value[], line: number) => Mat | undefined;

function dims2(args: Value[], line: number, what: string): [number, number] {
  const ds = args.map((a, i) => num1(a, `${what} argument ${i + 1}`, line));
  if (ds.some((d) => !Number.isInteger(d) || d < 0)) {
    throw new RuntimeErr(`${what} must be non-negative integers`, line);
  }
  return ds.length === 1 ? [ds[0]!, ds[0]!] : [ds[0]!, ds[1]!];
}

function argMat(args: Value[], k: number, what: string, line: number): Mat {
  if (args.length <= k) throw new RuntimeErr(`${what} needs a matrix argument`, line);
  return requireMat(args[k], `as ${what}'s argument`, line);
}

/** sum/mean/max/min share one reduction rule: over a vector they collapse
 *  to one value; over a matrix dim 1 collapses columns (→ a row), dim 2
 *  collapses rows (→ a column). */
function reduceDim(
  m: Mat,
  dim: number | null,
  line: number,
  f: (xs: number[]) => number,
  name: string,
): Mat {
  if (m.numel() === 0) throw new RuntimeErr(`${name} of an empty matrix is undefined here`, line);
  if (dim === null && isVector(m)) return scalar(f(m.data));
  const d = dim ?? 1;
  if (d === 1) {
    const out: number[] = [];
    for (let j = 1; j <= m.cols; j++) {
      out.push(f(m.data.slice((j - 1) * m.rows, j * m.rows)));
    }
    return row(out);
  }
  if (d === 2) {
    const out: number[] = [];
    for (let i = 1; i <= m.rows; i++) {
      out.push(f(Array.from({ length: m.cols }, (_, j) => m.get(i, j + 1))));
    }
    return col(out);
  }
  throw new RuntimeErr(`${name}(A, dim) needs dim 1 or 2`, line);
}

function applyElem(m: Mat, f: (x: number) => number): Mat {
  return new Mat(m.rows, m.cols, m.data.map(f));
}

const BUILTINS: Record<string, Builtin> = {
  zeros: (_i, args, line) => {
    const [r, c] = dims2(args, line, 'zeros dimensions');
    return filled(r, c, 0, line);
  },
  ones: (_i, args, line) => {
    const [r, c] = dims2(args, line, 'ones dimensions');
    return filled(r, c, 1, line);
  },
  eye: (_i, args, line) => {
    const [r, c] = dims2(args, line, 'eye dimensions');
    return eye(r, c, line);
  },
  diag: (_i, args, line) => {
    const v = argMat(args, 0, 'diag', line);
    if (isVector(v)) {
      const n = v.numel();
      const out = filled(n, n, 0, line);
      for (let k = 1; k <= n; k++) out.set(k, k, v.lin(k));
      return out;
    }
    const n = Math.min(v.rows, v.cols);
    return col(Array.from({ length: n }, (_, k) => v.get(k + 1, k + 1)));
  },
  size: (_i, args, line) => {
    const m = argMat(args, 0, 'size', line);
    if (args.length === 2) {
      const d = num1(args[1], 'the size dim', line);
      if (d !== 1 && d !== 2) throw new RuntimeErr('size(A, dim) needs dim 1 (rows) or 2 (columns)', line);
      return scalar(d === 1 ? m.rows : m.cols);
    }
    return row([m.rows, m.cols]);
  },
  length: (_i, args, line) => {
    const m = argMat(args, 0, 'length', line);
    return scalar(Math.max(m.rows, m.cols));
  },
  numel: (_i, args, line) => scalar(argMat(args, 0, 'numel', line).numel()),
  sum: (_i, args, line) => {
    const m = argMat(args, 0, 'sum', line);
    const f = (xs: number[]) => xs.reduce((p, c) => p + c, 0);
    return reduceDim(m, args.length > 1 ? num1(args[1], 'the sum dim', line) : null, line, f, 'sum');
  },
  mean: (_i, args, line) => {
    const m = argMat(args, 0, 'mean', line);
    const f = (xs: number[]) => xs.reduce((p, c) => p + c, 0) / xs.length;
    return reduceDim(m, args.length > 1 ? num1(args[1], 'the mean dim', line) : null, line, f, 'mean');
  },
  max: (_i, args, line) => {
    if (args.length === 2 && !isStr(args[1]!)) {
      return elementwise(argMat(args, 0, 'max', line), argMat(args, 1, 'max', line), line, Math.max, 'max');
    }
    if (args.length === 3) {
      if (isStr(args[1]!) || argMat(args, 1, 'max', line).numel() !== 0) {
        throw new RuntimeErr('max(A, [], dim) — the second argument must be []', line);
      }
      return reduceDim(argMat(args, 0, 'max', line), num1(args[2], 'the max dim', line), line, (xs) => Math.max(...xs), 'max');
    }
    return reduceDim(argMat(args, 0, 'max', line), null, line, (xs) => Math.max(...xs), 'max');
  },
  min: (_i, args, line) => {
    if (args.length === 2 && !isStr(args[1]!)) {
      return elementwise(argMat(args, 0, 'min', line), argMat(args, 1, 'min', line), line, Math.min, 'min');
    }
    if (args.length === 3) {
      if (isStr(args[1]!) || argMat(args, 1, 'min', line).numel() !== 0) {
        throw new RuntimeErr('min(A, [], dim) — the second argument must be []', line);
      }
      return reduceDim(argMat(args, 0, 'min', line), num1(args[2], 'the min dim', line), line, (xs) => Math.min(...xs), 'min');
    }
    return reduceDim(argMat(args, 0, 'min', line), null, line, (xs) => Math.min(...xs), 'min');
  },
  abs: (_i, args, line) => applyElem(argMat(args, 0, 'abs', line), Math.abs),
  floor: (_i, args, line) => applyElem(argMat(args, 0, 'floor', line), Math.floor),
  ceil: (_i, args, line) => applyElem(argMat(args, 0, 'ceil', line), Math.ceil),
  round: (_i, args, line) => applyElem(argMat(args, 0, 'round', line), Math.round),
  sqrt: (_i, args, line) => applyElem(argMat(args, 0, 'sqrt', line), Math.sqrt),
  exp: (_i, args, line) => applyElem(argMat(args, 0, 'exp', line), Math.exp),
  sin: (_i, args, line) => applyElem(argMat(args, 0, 'sin', line), Math.sin),
  cos: (_i, args, line) => applyElem(argMat(args, 0, 'cos', line), Math.cos),
  sort: (_i, args, line) => {
    const m = argMat(args, 0, 'sort', line);
    const dim = args.length > 1 ? num1(args[1], 'the sort dim', line) : 1;
    if (dim !== 1 && dim !== 2) throw new RuntimeErr('sort(A, dim) needs dim 1 or 2', line);
    const asc = (xs: number[]) => [...xs].sort((p, q) => p - q);
    if (isVector(m) && args.length === 1) return new Mat(m.rows, m.cols, asc(m.data));
    const out = new Mat(m.rows, m.cols, new Array<number>(m.numel()));
    if (dim === 2) {
      for (let i = 1; i <= m.rows; i++) {
        const srt = asc(Array.from({ length: m.cols }, (_, j) => m.get(i, j + 1)));
        for (let j = 1; j <= m.cols; j++) out.set(i, j, srt[j - 1]!);
      }
      return out;
    }
    for (let j = 1; j <= m.cols; j++) {
      const srt = asc(m.data.slice((j - 1) * m.rows, j * m.rows));
      for (let i = 1; i <= m.rows; i++) out.set(i, j, srt[i - 1]!);
    }
    return out;
  },
  fliplr: (_i, args, line) => {
    const m = argMat(args, 0, 'fliplr', line);
    const out = new Mat(m.rows, m.cols, new Array<number>(m.numel()));
    for (let j = 1; j <= m.cols; j++) {
      for (let i = 1; i <= m.rows; i++) out.set(i, j, m.get(i, m.cols - j + 1));
    }
    return out;
  },
  flipud: (_i, args, line) => {
    const m = argMat(args, 0, 'flipud', line);
    const out = new Mat(m.rows, m.cols, new Array<number>(m.numel()));
    for (let j = 1; j <= m.cols; j++) {
      for (let i = 1; i <= m.rows; i++) out.set(i, j, m.get(m.rows - i + 1, j));
    }
    return out;
  },
  det: (_i, args, line) => {
    const m = argMat(args, 0, 'det', line);
    if (m.rows !== m.cols) throw new RuntimeErr('det needs a square matrix', line);
    return scalar(matDet(m));
  },
  inv: (_i, args, line) => {
    const m = argMat(args, 0, 'inv', line);
    if (m.rows !== m.cols) throw new RuntimeErr('inv needs a square matrix', line);
    try {
      return matInv(m, line);
    } catch (e) {
      if (e instanceof MatErr) throw new RuntimeErr(e.message, line);
      throw e;
    }
  },
  linspace: (_i, args, line) => {
    const a = num1(args[0], 'the linspace start', line);
    const b = num1(args[1] ?? scalar(a), 'the linspace stop', line);
    const n = args.length > 2 ? num1(args[2], 'the linspace count', line) : 100;
    if (!Number.isInteger(n) || n < 1) throw new RuntimeErr('linspace n must be a positive integer', line);
    if (n === 1) return row([b]);
    return row(Array.from({ length: n }, (_, k) => a + ((b - a) * k) / (n - 1)));
  },
  disp: (interp, args, line) => {
    const v = args[0];
    if (v === undefined) throw new RuntimeErr('disp needs one argument', line);
    if (isStr(v)) {
      interp.output += `${v.text}\n`;
      return undefined;
    }
    interp.output += `${fmtRows(v).join('\n')}\n`;
    return undefined;
  },
  fprintf: (interp, args, line) => {
    const fmt = args[0];
    if (!isStr(fmt)) {
      throw new RuntimeErr("fprintf needs a format string first: fprintf('… %d\\n', x)", line);
    }
    interp.output += sprintf(fmt.text, args.slice(1), line);
    return undefined;
  },
  error: (_i, args, line) => {
    const fmt = args[0];
    if (!isStr(fmt)) {
      throw new RuntimeErr("error needs a message string: error('something went wrong')", line);
    }
    throw new RuntimeErr(sprintf(fmt.text, args.slice(1), line), line);
  },
  rand: (_i, _args, line) => {
    throw new RuntimeErr("not in the teaching subset: 'rand' — the interpreter is deterministic on purpose", line);
  },
};


/** The fprintf subset: %d, %.Nf, %%, and the \n escape. One scalar
 *  argument per conversion; too few arguments is an error. */
function sprintf(fmt: string, args: Value[], line: number): string {
  let out = '';
  let next = 0;
  const nextScalar = (): number => {
    const v = args[next++];
    if (v === undefined) throw new RuntimeErr('not enough arguments for the format string', line);
    return num1(v, 'a fprintf argument', line);
  };
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i]!;
    if (c === '\\' && fmt[i + 1] === 'n') {
      out += '\n';
      i++;
      continue;
    }
    if (c !== '%') {
      out += c;
      continue;
    }
    const d = fmt[i + 1];
    if (d === '%') {
      out += '%';
      i++;
      continue;
    }
    if (d === 'd') {
      out += String(Math.round(nextScalar()));
      i++;
      continue;
    }
    const m = /^\.(\d+)f/.exec(fmt.slice(i + 1));
    if (m !== null) {
      out += nextScalar().toFixed(Number(m[1]));
      i += m[0].length;
      continue;
    }
    throw new RuntimeErr(
      `not in the teaching subset: fprintf conversion '${fmt.slice(i, i + 3)}' — the subset has %d, %.Nf and %%`,
      line,
    );
  }
  return out;
}

/** The names a bare Name lookup treats as functions (tests pin this list
 *  to the builtin table). */
export function isBuiltinName(name: string): boolean {
  return BUILTIN_NAMES.includes(name);
}

