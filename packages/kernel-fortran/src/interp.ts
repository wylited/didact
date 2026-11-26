// interp.ts — tree-walking Fortran interpreter, written as generator
// functions so the Session driver can step one statement at a time and
// pause before breakpoint lines without unwinding loops or calls.
//
// Semantics implemented on purpose, because they are the HPC lessons:
//   * arrays live column-major in one flat buffer with explicit lower
//     bounds; A(3,2) is addressed (3-lo1) + (2-lo2)*extent1;
//   * array assignment is value semantics; procedure arguments share the
//     caller's variable (intent(in) is enforced read-only);
//   * whole-array arithmetic is elemental, sections keep rank, and the
//     reduction intrinsics (sum/matmul/dot_product/…) are the real thing;
//   * modules own persistent data, internal procedures see their host's
//     variables, and derived types copy on assignment;
//   * INTEGER kinds wrap, REAL(4) rounds through float32, REAL(8) is
//     float64 — the kind is visible in the workspace panel.
//
// Procedure bodies run synchronously inside the caller's statement (one
// step at the call site), matching the MATLAB kernel's convention; the
// statement budget still counts their statements.

import type {
  Actual, BinOp, Decl, DerivedDef, DimSpec, Expr, Part, ProcDecl,
  Program, ProgramUnit, Stmt, TypeSpec, UseStmt,
} from './parser';
import {
  asComplex, asInt, asLogical, asReal, asString, BudgetErr, charVal,
  complexVal, convertElem, copyElem, copyValue, defaultScalar, describeScalar,
  extent, filledArray, fmtScalar, intVal, isArray, isNumeric, logicalVal,
  makeArray, MAX_CHAR_LEN, MAX_ELEMENTS, MAX_FRAME_ELEMENTS, offsetOf, padChar,
  rankOf, realVal, RuntimeErr,
  strides, subsAt, type ArrayV, type DerivedV, type Dim, type Elem,
  type ScalarBase, type Value, valueSize,
} from './value';
import { formatOutput, listDirected } from './io';

export const RUN_BUDGET = 500_000;
export const MAX_DEPTH = 256;

export interface YieldInfo { line: number }

export interface WriteMark {
  name: string;
  /** Flat offsets the last array write touched; null = every element. */
  addrs: number[] | null;
  line: number;
}

export interface LoopState {
  kind: 'do' | 'while';
  varName: string | null;
  iter: number;
  total: number | null;
  start: number | null;
  end: number | null;
  step: number | null;
  line: number;
}

export interface Frame {
  name: string;
  scope: Scope;
  line: number;
}

export interface Cell { value: Value }

export interface VarInfo {
  type: ResolvedType;
  array: boolean;
  allocatable: boolean;
  parameter: boolean;
  intent: 'in' | 'out' | 'inout' | null;
  implicit: boolean;
  /** Declared bounds for fixed-shape arrays (null for assumed shape). */
  declaredDims: Dim[] | null;
  /** Dummy-argument bounds, kept unevaluated until the actual is bound. */
  dummyDims?: DimSpec[];
  /** Deferred CHARACTER length for a dummy (may name another dummy). */
  dummyCharLenExpr?: Expr;
}

export interface ResolvedType {
  base: ScalarBase;
  kind: number;
  charLen?: number;
  typeName?: string;
}

export class Scope {
  readonly vars = new Map<string, Cell>();
  readonly infos = new Map<string, VarInfo>();
  readonly procs = new Map<string, ProcEntry>();

  constructor(
    readonly name: string,
    readonly parent: Scope | null,
    public implicitNone: boolean,
    readonly kind: 'main' | 'procedure' | 'module',
  ) {}
}

export interface ProcEntry { decl: ProcDecl; host: Scope | null }

export interface ModuleState {
  unit: ProgramUnit;
  scope: Scope;
  ready: boolean;
}

export interface SharedState {
  main: Scope | null;
  modules: Map<string, ModuleState>;
  procs: Map<string, ProcEntry>;
  types: Map<string, DerivedDef>;
  /** Procedure locals declared SAVE, keyed `proc:name`. */
  saved: Map<string, Cell>;
  rng: number;
}

class LoopSignal {
  constructor(
    public kind: 'exit' | 'cycle',
    public construct: string | null,
    public line: number,
  ) {}
}

class ReturnSignal {
  constructor(public line: number) {}
}

class StopSignal {
  constructor(public message: string | null, public isError: boolean, public line: number) {}
}

interface Mask {
  /** null = a scalar mask: every element of the target is selected. */
  data: boolean[] | null;
  dims: Dim[] | null;
  value: boolean;
}

interface SubSpec {
  kind: 'index';
  index: number;
}

interface RangeSpec {
  kind: 'range';
  lo: number;
  hi: number;
  step: number;
}

type Selection = SubSpec | RangeSpec;

interface Ref {
  get(): Value;
  set(v: Value, line: number): void;
  addrs?: number[] | null;
}

const DEFAULT_KIND: Record<string, number> = {
  integer: 4, real: 4, complex: 4, logical: 4, character: 1,
};

const ISO_FORTRAN_ENV: Record<string, number> = {
  int8: 1, int16: 2, int32: 4, int64: 8,
  real32: 4, real64: 8, real128: 16,
  input_unit: 5, output_unit: 6, error_unit: 0,
  iostat_end: -1, iostat_eor: -2,
};

const ISO_C_BINDING: Record<string, number> = {
  c_signed_char: 1, c_short: 2, c_int: 4, c_long: 8, c_long_long: 8,
  c_float: 4, c_double: 8, c_bool: 1, c_char: 1,
  c_int8_t: 1, c_int16_t: 2, c_int32_t: 4, c_int64_t: 8,
  c_double_complex: 8, c_float_complex: 4,
};

function maxKind(a: number, b: number): number {
  return Math.max(a, b);
}

function sameExtents(a: ArrayV, b: ArrayV): boolean {
  if (a.dims.length !== b.dims.length) return false;
  for (let i = 0; i < a.dims.length; i++) {
    if (extent(a.dims[i]!) !== extent(b.dims[i]!)) return false;
  }
  return true;
}

function describe(value: Value): string {
  if (value.k === 'array') {
    return value.allocated ? `array ${value.dims.map(extent).join('x')}` : 'unallocated array';
  }
  return describeScalar(value);
}

export class Interpreter {
  readonly shared: SharedState;
  private readonly program: Program;
  private readonly mainScope: Scope;

  output = '';
  steps = 0;
  done = false;
  exitText = 'exit(0)';
  lastWrite: WriteMark | null = null;
  loop: LoopState | null = null;
  frames: Frame[] = [];
  private readonly masks: Mask[] = [];
  private readonly activeProcs: Map<string, ProcEntry>[] = [];
  private callDepth = 0;
  private readonly resumed: boolean;

  constructor(program: Program, shared?: SharedState) {
    this.program = program;
    this.resumed = shared !== undefined && shared.main !== null;
    this.shared = shared ?? {
      main: null,
      modules: new Map(),
      procs: new Map(),
      types: new Map(),
      saved: new Map(),
      rng: 0x9e3779b9,
    };

    for (const mod of program.modules) {
      if (!this.shared.modules.has(mod.name)) {
        this.shared.modules.set(mod.name, {
          unit: mod, scope: new Scope(mod.name, null, mod.implicitNone, 'module'), ready: false,
        });
      }
    }
    for (const mod of program.modules) this.ensureModule(mod.name);
    for (const proc of program.externals) this.registerProc(proc, null);

    if (this.shared.main === null) {
      const unit = program.main;
      if (unit !== null) {
        this.registerTypes(unit.types);
        const scope = new Scope(unit.name, null, unit.implicitNone, 'main');
        this.aliasUses(scope, unit.uses);
        this.applyDecls(scope, unit.decls);
        for (const proc of unit.internal) this.registerProc(proc, scope);
        this.shared.main = scope;
      } else {
        this.shared.main = new Scope('main', null, false, 'main');
      }
      this.mainScope = this.shared.main;
    } else {
      this.mainScope = this.shared.main;
      const unit = program.main;
      if (unit !== null) {
        this.mainScope.implicitNone = unit.implicitNone;
        this.registerTypes(unit.types);
        this.aliasUses(this.mainScope, unit.uses);
        this.applyDecls(this.mainScope, unit.decls);
        for (const proc of unit.internal) this.registerProc(proc, this.mainScope);
      }
    }

    this.frames.push({ name: 'program', scope: this.mainScope, line: program.main?.line ?? 1 });
  }

  // ─── setup ────────────────────────────────────────────────────────────

  private ensureModule(name: string): ModuleState {
    const existing = this.shared.modules.get(name);
    if (existing !== undefined) {
      if (existing.ready) return existing;
      if (existing.unit === undefined) throw new RuntimeErr(`module '${name}' was not found`, 1);
    }
    const unit = existing?.unit ?? this.program.modules.find((m) => m.name === name);
    if (unit === undefined) {
      if (name === 'iso_fortran_env' || name === 'iso_c_binding') {
        throw new RuntimeErr(`'${name}' is built in and needs no module definition`, 1);
      }
      throw new RuntimeErr(`module '${name}' is not defined in this block`, 1);
    }
    const state: ModuleState = existing ?? {
      unit, scope: new Scope(name, null, unit.implicitNone, 'module'), ready: false,
    };
    this.shared.modules.set(name, state);
    if (state.ready) return state;

    this.registerTypes(unit.types);
    this.aliasUses(state.scope, unit.uses);
    this.applyDecls(state.scope, unit.decls);
    for (const proc of unit.internal) this.registerProc(proc, state.scope);
    state.ready = true;
    return state;
  }

  private registerTypes(types: DerivedDef[]): void {
    for (const def of types) {
      const existing = this.shared.types.get(def.name);
      if (existing !== undefined) {
        if (existing === def || this.resumed) {
          this.shared.types.set(def.name, def);
          continue;
        }
        throw new RuntimeErr(`derived type '${def.name}' is defined twice`, def.line);
      }
      this.shared.types.set(def.name, def);
    }
  }

  private registerProc(decl: ProcDecl, host: Scope | null): void {
    const table = host === null ? this.shared.procs : host.procs;
    if (table.has(decl.name) && !this.resumed) {
      throw new RuntimeErr(`procedure '${decl.name}' is defined twice`, decl.line);
    }
    table.set(decl.name, { decl, host });
  }

  private aliasUses(scope: Scope, uses: UseStmt[]): void {
    for (const use of uses) {
      if (use.module === 'iso_fortran_env' || use.module === 'iso_c_binding') {
        const table = use.module === 'iso_fortran_env' ? ISO_FORTRAN_ENV : ISO_C_BINDING;
        const names = use.only ?? Object.keys(table);
        for (const name of names) {
          if (!Object.prototype.hasOwnProperty.call(table, name)) {
            throw new RuntimeErr(`'${name}' is not in ${use.module}`, use.line);
          }
          const value = table[name]!;
          const cell: Cell = { value: intVal(value) };
          scope.vars.set(name, cell);
          scope.infos.set(name, {
            type: { base: 'integer', kind: 4 }, array: false, allocatable: false,
            parameter: true, intent: null, implicit: false, declaredDims: null,
          });
        }
        continue;
      }
      const mod = this.ensureModule(use.module);
      const names = use.only ?? [...mod.scope.vars.keys(), ...mod.unit.internal.map((p) => p.name)];
      for (const name of names) {
        const cell = mod.scope.vars.get(name);
        if (cell === undefined) {
          const proc = mod.unit.internal.find((p) => p.name === name);
          if (proc !== undefined) {
            scope.procs.set(name, { decl: proc, host: mod.scope });
            continue;
          }
          if (mod.unit.types.some((t) => t.name === name)) continue;
          throw new RuntimeErr(`'${name}' is not in module '${use.module}'`, use.line);
        }
        scope.vars.set(name, cell);
        const info = mod.scope.infos.get(name);
        if (info !== undefined) scope.infos.set(name, info);
      }
    }
  }

  private applyDecls(
    scope: Scope,
    decls: Decl[],
    dummies?: Set<string>,
    saveAll = false,
    phase: 'all' | 'params' | 'dummies' | 'locals' = 'all',
  ): void {
    for (const decl of decls) {
      if (decl.type.base === 'auto' && phase !== 'all' && phase !== 'params') continue;
      if (decl.type.base === 'auto') {
        for (const entity of decl.entities) {
          if (entity.init === null) throw new RuntimeErr(`parameter '${entity.name}' needs a value`, entity.line);
          const value = this.evalExpr(entity.init, scope);
          const cell: Cell = { value: copyValue(value) };
          scope.vars.set(entity.name, cell);
          scope.infos.set(entity.name, {
            type: this.typeOfValue(value), array: isArray(value), allocatable: false,
            parameter: true, intent: null, implicit: false,
            declaredDims: isArray(value) ? value.dims : null,
          });
        }
        continue;
      }
      const relevant = decl.entities.some((entity) => {
        const isDummy = dummies?.has(entity.name) === true;
        if (phase === 'params') return decl.attrs.parameter;
        if (phase === 'dummies') return isDummy;
        if (phase === 'locals') return !isDummy && !decl.attrs.parameter;
        return true;
      });
      if (!relevant) continue;
      const type = decl.type.base === 'character' && phase === 'dummies' && decl.type.charLenExpr !== undefined
        ? this.resolveType({ ...decl.type, charLenExpr: undefined, charLen: undefined }, scope, decl.line)
        : this.resolveType(decl.type, scope, decl.line);
      for (const entity of decl.entities) {
        const isDummy = dummies?.has(entity.name) === true;
        const isParam = decl.attrs.parameter;
        if (phase === 'params' && !isParam) continue;
        if (phase === 'dummies' && !isDummy) continue;
        if (phase === 'locals' && (isDummy || isParam)) continue;
        const dims = entity.dims ?? decl.attrs.dimension;
        const charLen = isDummy && entity.charLenExpr !== null
          ? undefined
          : entity.charLenExpr !== null
            ? asInt(this.scalarOf(this.evalExpr(entity.charLenExpr, scope), entity.line), entity.line)
            : type.charLen;
        const resolved: ResolvedType = { ...type, ...(charLen === undefined ? {} : { charLen }) };
        let deferredCharLen: Expr | undefined;
        if (isDummy && resolved.base === 'character' && decl.type.charLenAssumed !== true) {
          const expr = entity.charLenExpr ?? decl.type.charLenExpr ?? null;
          if (expr !== null) {
            deferredCharLen = expr;
            delete resolved.charLen;
          }
        }

        if (isDummy) {
          scope.infos.set(entity.name, {
            type: resolved,
            array: dims !== null,
            allocatable: decl.attrs.allocatable,
            parameter: false,
            intent: decl.attrs.intent,
            implicit: false,
            declaredDims: null,
            ...(dims === null ? {} : { dummyDims: dims }),
            ...(deferredCharLen === undefined ? {} : { dummyCharLenExpr: deferredCharLen }),
          });
          if (!scope.vars.has(entity.name)) {
            scope.vars.set(entity.name, { value: this.defaultFor(resolved, scope, entity.line, 0) });
          }
          continue;
        }

        const info: VarInfo = {
          type: resolved,
          array: dims !== null,
          allocatable: decl.attrs.allocatable,
          parameter: decl.attrs.parameter,
          intent: null,
          implicit: false,
          declaredDims: null,
        };

        let saveKey: string | null = null;
        if ((decl.attrs.save || saveAll || entity.init !== null) && scope.kind === 'procedure') {
          saveKey = `${scope.name}:${entity.name}`;
          const saved = this.shared.saved.get(saveKey);
          if (saved !== undefined) {
            scope.vars.set(entity.name, saved);
            scope.infos.set(entity.name, info);
            continue;
          }
        }

        const existing = scope.vars.get(entity.name);
        if (existing !== undefined) {
          scope.infos.set(entity.name, info);
          if (entity.init !== null) {
            existing.value = this.coerce(this.evalExpr(entity.init, scope), resolved, entity.line);
          }
          continue;
        }

        let value: Value;
        if (decl.attrs.parameter) {
          if (entity.init === null) throw new RuntimeErr(`parameter '${entity.name}' needs a value`, entity.line);
          value = this.coerce(this.evalExpr(entity.init, scope), resolved, entity.line);
          if (isArray(value)) info.declaredDims = value.dims;
        } else if (dims !== null) {
          if (dims.some((d) => d.deferred)) {
            value = makeArray(resolved.base, [], [], {
              kind: resolved.kind,
              typeName: resolved.typeName,
              charLen: resolved.charLen,
              allocated: false,
            });
          } else {
            const shape = this.evalDims(dims, scope, entity.line);
            info.declaredDims = shape;
            value = this.withLine(() => {
              const fill = this.defaultFor(resolved, scope, entity.line, 0);
              return filledArray(resolved.base, shape, fill, {
                kind: resolved.kind, typeName: resolved.typeName, charLen: resolved.charLen,
              });
            }, entity.line);
            if (entity.init !== null) {
              this.assignInto(value as ArrayV, this.evalExpr(entity.init, scope), entity.line);
            }
          }
        } else {
          value = this.defaultFor(resolved, scope, entity.line, 0);
          if (entity.init !== null) {
            value = this.coerce(this.evalExpr(entity.init, scope), resolved, entity.line);
          }
        }
        const cell: Cell = { value };
        scope.vars.set(entity.name, cell);
        if (saveKey !== null) this.shared.saved.set(saveKey, cell);
        scope.infos.set(entity.name, info);
      }
    }
  }

  private resolveType(spec: TypeSpec, scope: Scope, line: number): ResolvedType {
    let kind = spec.kind;
    if (kind === undefined && spec.kindExpr !== undefined) {
      kind = asInt(this.scalarOf(this.evalExpr(spec.kindExpr, scope), line), line);
    }
    let charLen = spec.charLen;
    if (charLen === undefined && spec.charLenExpr !== undefined) {
      charLen = asInt(this.scalarOf(this.evalExpr(spec.charLenExpr, scope), line), line);
    }
    const base = spec.base === 'auto' ? 'real' : spec.base;
    const k = kind ?? DEFAULT_KIND[base] ?? 4;
    if (base !== 'character' && base !== 'derived' && k !== 1 && k !== 2 && k !== 4 && k !== 8) {
      throw new RuntimeErr(`kind ${k} is not supported — use 1, 2, 4 or 8`, line);
    }
    const resolved: ResolvedType = { base, kind: k };
    if (base === 'character' && spec.charLenAssumed !== true) {
      resolved.charLen = charLen ?? 1;
      if (!Number.isSafeInteger(resolved.charLen) || resolved.charLen < 0 || resolved.charLen > MAX_CHAR_LEN) {
        throw new RuntimeErr(
          `CHARACTER length ${resolved.charLen} exceeds the teaching limit of ${MAX_CHAR_LEN.toLocaleString('en-US')}`,
          line,
        );
      }
    }
    if (spec.derived !== undefined) resolved.typeName = spec.derived;
    return resolved;
  }

  private intBound(v: number, line: number, what: string): number {
    const n = Math.trunc(v);
    if (!Number.isFinite(v) || !Number.isSafeInteger(n)) {
      throw new RuntimeErr(`${what} must be a finite integer`, line);
    }
    return n;
  }

  private withLine<T>(fn: () => T, line: number): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof RangeError) throw new RuntimeErr(e.message, line);
      throw e;
    }
  }

  private dimArg(v: Elem, line: number): number {
    if (v.k !== 'integer') throw new RuntimeErr('DIM must be INTEGER', line);
    return v.v;
  }

  private evalDims(dims: DimSpec[], scope: Scope, line: number): Dim[] {
    const out = dims.map((d) => {
      const lo = d.lo === null
        ? 1
        : this.intBound(asInt(this.scalarOf(this.evalExpr(d.lo, scope), line), line), line, 'lower bound');
      if (d.hi === null) throw new RuntimeErr('a dimension needs an upper bound here', line);
      const hi = this.intBound(asInt(this.scalarOf(this.evalExpr(d.hi, scope), line), line), line, 'upper bound');
      if (hi < lo - 1) throw new RuntimeErr(`invalid bounds ${lo}:${hi}`, line);
      return { lo, hi };
    });
    const n = out.reduce((a, d) => a * extent(d), 1);
    if (!Number.isSafeInteger(n) || n > MAX_ELEMENTS) {
      throw new RuntimeErr(`array size ${n} exceeds the teaching limit of ${MAX_ELEMENTS.toLocaleString('en-US')} elements`, line);
    }
    return out;
  }

  private typeOfValue(v: Value): ResolvedType {
    if (v.k === 'array') {
      return {
        base: v.base, kind: v.kind,
        ...(v.charLen === undefined ? {} : { charLen: v.charLen }),
        ...(v.typeName === undefined ? {} : { typeName: v.typeName }),
      };
    }
    switch (v.k) {
      case 'integer': return { base: 'integer', kind: v.kind };
      case 'real': return { base: 'real', kind: v.kind };
      case 'logical': return { base: 'logical', kind: 4 };
      case 'character': return { base: 'character', kind: 1, charLen: v.v.length };
      case 'complex': return { base: 'complex', kind: v.kind };
      case 'derived': return { base: 'derived', kind: 4, typeName: v.typeName };
    }
  }

  private defaultFor(type: ResolvedType, scope: Scope, line: number, depth: number): Elem {
    if (depth > 32) throw new RuntimeErr('derived type nesting is too deep', line);
    if (type.base !== 'derived') {
      return defaultScalar(type.base, type.kind, type.charLen);
    }
    const def = this.shared.types.get(type.typeName ?? '');
    if (def === undefined) throw new RuntimeErr(`derived type '${type.typeName}' is not defined`, line);
    const comps = new Map<string, Value>();
    for (const decl of def.components) {
      const compType = this.resolveType(decl.type, scope, decl.line);
      for (const entity of decl.entities) {
        const dims = entity.dims ?? decl.attrs.dimension;
        if (dims !== null) {
          if (dims.some((d) => d.deferred)) {
            comps.set(entity.name, makeArray(compType.base, [], [], {
              kind: compType.kind, typeName: compType.typeName, charLen: compType.charLen, allocated: false,
            }));
          } else {
            const shape = this.evalDims(dims, scope, entity.line);
            const fill = this.defaultFor(compType, scope, entity.line, depth + 1);
            const arr = filledArray(compType.base, shape, fill, {
              kind: compType.kind, typeName: compType.typeName, charLen: compType.charLen,
            });
            if (entity.init !== null) this.assignInto(arr, this.evalExpr(entity.init, scope), entity.line);
            comps.set(entity.name, arr);
          }
        } else if (entity.init !== null) {
          comps.set(entity.name, this.coerce(this.evalExpr(entity.init, scope), compType, entity.line));
        } else {
          comps.set(entity.name, this.defaultFor(compType, scope, entity.line, depth + 1));
        }
      }
    }
    return { k: 'derived', typeName: def.name, comps };
  }

  private coerce(v: Value, type: ResolvedType, line: number): Value {
    if (v.k === 'array') {
      return {
        ...v,
        base: type.base,
        kind: type.kind,
        ...(type.charLen === undefined ? {} : { charLen: type.charLen }),
        ...(type.typeName === undefined ? {} : { typeName: type.typeName }),
        data: v.data.map((e) => this.coerceElem(e, type, line)),
      };
    }
    return this.coerceElem(v, type, line);
  }

  private coerceElem(v: Elem, type: ResolvedType, line: number): Elem {
    if (type.base === 'derived') {
      if (v.k !== 'derived' || v.typeName !== type.typeName) {
        throw new RuntimeErr(`expected TYPE(${type.typeName ?? '?'}), found ${describeScalar(v)}`, line);
      }
      return copyElem(v);
    }
    return convertElem(v, type.base, type.kind, type.charLen, line);
  }

  // ─── driver ───────────────────────────────────────────────────────────

  *runAll(): Generator<YieldInfo, void> {
    const body = this.program.main?.body ?? [];
    try {
      yield* this.execBlock(body, this.mainScope);
      this.done = true;
    } catch (e) {
      if (e instanceof ReturnSignal) {
        this.done = true;
        return;
      }
      if (e instanceof LoopSignal) {
        throw new RuntimeErr(`'${e.kind.toUpperCase()}' outside a matching DO loop`, e.line);
      }
      if (e instanceof StopSignal) {
        if (e.isError) {
          throw new RuntimeErr(e.message === null ? 'error stop' : `error stop: ${e.message}`, e.line);
        }
        this.done = true;
        this.exitText = e.message === null ? 'stop' : `stop: ${e.message}`;
        return;
      }
      throw e;
    }
  }

  private *execBlock(stmts: Stmt[], scope: Scope): Generator<YieldInfo, void> {
    for (const stmt of stmts) {
      this.steps++;
      if (this.steps > RUN_BUDGET) throw new BudgetErr(stmt.line, RUN_BUDGET);
      const frame = this.frames[this.frames.length - 1];
      if (frame !== undefined) frame.line = stmt.line;
      yield { line: stmt.line };
      yield* this.execStmt(stmt, scope);
    }
  }

  private *execStmt(stmt: Stmt, scope: Scope): Generator<YieldInfo, void> {
    switch (stmt.t) {
      case 'assign': {
        const value = this.evalExpr(stmt.expr, scope);
        this.assign(stmt.target, value, scope, stmt.line);
        break;
      }
      case 'call':
        this.callSubroutine(stmt.name, stmt.args, scope, stmt.line);
        break;
      case 'if': {
        for (const arm of stmt.arms) {
          if (asLogical(this.scalarOf(this.evalExpr(arm.cond, scope), arm.cond.line), arm.cond.line)) {
            yield* this.execBlock(arm.body, scope);
            return;
          }
        }
        if (stmt.elseBody !== null) yield* this.execBlock(stmt.elseBody, scope);
        break;
      }
      case 'do':
        yield* this.execDo(stmt, scope);
        break;
      case 'select':
        yield* this.execSelect(stmt, scope);
        break;
      case 'where':
        yield* this.execWhere(stmt, scope);
        break;
      case 'print':
        this.writeValues(null, stmt.fmt, null, stmt.items, scope, stmt.line);
        break;
      case 'write':
        this.writeValues(stmt.unit, stmt.fmt, stmt.advance, stmt.items, scope, stmt.line);
        break;
      case 'allocate':
        this.allocate(stmt, scope);
        break;
      case 'deallocate':
        this.deallocate(stmt, scope);
        break;
      case 'stop': {
        const message = stmt.message === null ? null : fmtScalar(this.scalarOf(this.evalExpr(stmt.message, scope), stmt.line));
        throw new StopSignal(message, stmt.isError, stmt.line);
      }
      case 'return':
        throw new ReturnSignal(stmt.line);
      case 'continue':
        break;
      case 'exit':
      case 'cycle':
        throw new LoopSignal(stmt.t, stmt.construct, stmt.line);
    }
  }

  private tickLoop(line: number): void {
    this.steps++;
    if (this.steps > RUN_BUDGET) throw new BudgetErr(line, RUN_BUDGET);
  }

  private *execDo(stmt: Extract<Stmt, { t: 'do' }>, scope: Scope): Generator<YieldInfo, void> {
    const previous = this.loop;
    let iter = 0;
    try {
      if (stmt.whileCond !== null) {
        for (;;) {
          const cond = asLogical(this.scalarOf(this.evalExpr(stmt.whileCond, scope), stmt.line), stmt.line);
          if (!cond) break;
          iter++;
          this.tickLoop(stmt.line);
          this.loop = {
            kind: 'while', varName: null, iter, total: null,
            start: null, end: null, step: null, line: stmt.line,
          };
          try {
            yield* this.execBlock(stmt.body, scope);
          } catch (e) {
            if (e instanceof LoopSignal && (e.construct === null || e.construct === stmt.construct)) {
              if (e.kind === 'exit') break;
              continue;
            }
            throw e;
          }
        }
      } else if (stmt.varName !== null && stmt.start !== null && stmt.end !== null) {
        const start = asInt(this.scalarOf(this.evalExpr(stmt.start, scope), stmt.line), stmt.line);
        const end = asInt(this.scalarOf(this.evalExpr(stmt.end, scope), stmt.line), stmt.line);
        const step = stmt.step === null ? 1 : asInt(this.scalarOf(this.evalExpr(stmt.step, scope), stmt.line), stmt.line);
        if (step === 0) throw new RuntimeErr('a DO loop step cannot be zero', stmt.line);
        const total = step > 0
          ? (end < start ? 0 : Math.floor((end - start) / step) + 1)
          : (end > start ? 0 : Math.floor((start - end) / -step) + 1);
        this.bindName(scope, stmt.varName, intVal(start), stmt.line);
        let exited = false;
        for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
          iter++;
          this.tickLoop(stmt.line);
          this.bindName(scope, stmt.varName, intVal(i), stmt.line);
          this.loop = {
            kind: 'do', varName: stmt.varName, iter, total,
            start, end, step, line: stmt.line,
          };
          try {
            yield* this.execBlock(stmt.body, scope);
          } catch (e) {
            if (e instanceof LoopSignal && (e.construct === null || e.construct === stmt.construct)) {
              if (e.kind === 'exit') {
                exited = true;
                break;
              }
              continue;
            }
            throw e;
          }
        }
        if (!exited) this.bindName(scope, stmt.varName, intVal(start + total * step), stmt.line);
      } else {
        for (;;) {
          iter++;
          this.tickLoop(stmt.line);
          this.loop = {
            kind: 'while', varName: null, iter, total: null,
            start: null, end: null, step: null, line: stmt.line,
          };
          try {
            yield* this.execBlock(stmt.body, scope);
          } catch (e) {
            if (e instanceof LoopSignal && (e.construct === null || e.construct === stmt.construct)) {
              if (e.kind === 'exit') break;
              continue;
            }
            throw e;
          }
        }
      }
    } finally {
      this.loop = previous;
    }
  }

  private *execSelect(stmt: Extract<Stmt, { t: 'select' }>, scope: Scope): Generator<YieldInfo, void> {
    const subject = this.scalarOf(this.evalExpr(stmt.expr, scope), stmt.line);
    for (const c of stmt.cases) {
      for (const sel of c.selectors) {
        const lo = sel.lo === null ? null : this.scalarOf(this.evalExpr(sel.lo, scope), stmt.line);
        const hi = sel.hi === null ? null : this.scalarOf(this.evalExpr(sel.hi, scope), stmt.line);
        if (this.caseMatches(subject, lo, hi, stmt.line)) {
          yield* this.execBlock(c.body, scope);
          return;
        }
      }
    }
    if (stmt.defaultBody !== null) yield* this.execBlock(stmt.defaultBody, scope);
  }

  private caseMatches(subject: Elem, lo: Elem | null, hi: Elem | null, line: number): boolean {
    if (lo === null && hi === null) return true;
    if (subject.k === 'logical') {
      const matches = (e: Elem | null): boolean => e === null || (e.k === 'logical' && e.v === subject.v);
      return matches(lo) && matches(hi);
    }
    if (lo === null) return this.compareScalar('<=', subject, hi!, line);
    if (hi === null) return this.compareScalar('>=', subject, lo, line);
    return this.compareScalar('>=', subject, lo, line) && this.compareScalar('<=', subject, hi, line);
  }

  private *execWhere(stmt: Extract<Stmt, { t: 'where' }>, scope: Scope): Generator<YieldInfo, void> {
    const parent = this.masks.length > 0 ? this.masks[this.masks.length - 1]! : null;
    const own = this.maskOf(this.evalExpr(stmt.mask, scope), stmt.line);
    const mask = parent === null ? own : this.combineMasks(parent, own, stmt.line);
    let handled = mask;
    this.masks.push(mask);
    try {
      yield* this.execBlock(stmt.body, scope);
    } finally {
      this.masks.pop();
    }
    for (const clause of stmt.elsewhere) {
      const cond: Mask = clause.mask === null
        ? { data: null, dims: null, value: true }
        : this.maskOf(this.evalExpr(clause.mask, scope), stmt.line);
      const remaining = this.combineMasks(this.notMask(handled), cond, stmt.line);
      const effective = parent === null ? remaining : this.combineMasks(parent, remaining, stmt.line);
      this.masks.push(effective);
      try {
        yield* this.execBlock(clause.body, scope);
      } finally {
        this.masks.pop();
      }
      handled = this.orMasks(handled, cond, stmt.line);
    }
  }

  private notMask(mask: Mask): Mask {
    if (mask.data === null) return { data: null, dims: null, value: !mask.value };
    return { data: mask.data.map((b) => !b), dims: mask.dims, value: false };
  }

  private orMasks(first: Mask, second: Mask, line: number): Mask {
    if (first.data === null && second.data === null) {
      return { data: null, dims: null, value: first.value || second.value };
    }
    if (first.data !== null && second.data !== null) {
      if (!this.sameShape(first.dims!, second.dims!)) throw new RuntimeErr('WHERE masks do not conform', line);
      return { data: first.data.map((b, i) => b || second.data![i]!), dims: first.dims, value: false };
    }
    const arr = first.data !== null ? first : second;
    const scalar = first.data === null ? first.value : second.value;
    return { data: arr.data!.map((b) => b || scalar), dims: arr.dims, value: false };
  }

  private maskOf(v: Value, line: number): Mask {
    if (v.k === 'array') {
      if (v.base !== 'logical') throw new RuntimeErr(`a WHERE mask must be LOGICAL, found ${describe(v)}`, line);
      return { data: v.data.map((e) => asLogical(e, line)), dims: v.dims, value: false };
    }
    return { data: null, dims: null, value: asLogical(v, line) };
  }

  private maskAllows(mask: Mask | null | undefined, index: number): boolean {
    if (mask === undefined || mask === null) return true;
    return mask.data === null ? mask.value : mask.data[index]!;
  }

  private combineMasks(first: Mask, second: Mask, line: number): Mask {
    if (first.data === null && second.data === null) {
      return { data: null, dims: null, value: first.value && second.value };
    }
    if (first.data !== null && second.data !== null) {
      if (!this.sameShape(first.dims!, second.dims!)) throw new RuntimeErr('WHERE masks do not conform', line);
      return { data: first.data.map((b, i) => b && second.data![i]!), dims: first.dims, value: false };
    }
    const arr = first.data !== null ? first : second;
    const scalar = first.data === null ? first.value : second.value;
    return { data: arr.data!.map((b) => b && scalar), dims: arr.dims, value: false };
  }

  private sameShape(a: Dim[], b: Dim[]): boolean {
    return a.length === b.length && a.every((d, i) => extent(d) === extent(b[i]!));
  }

  // ─── statements: I/O, allocation ──────────────────────────────────────

  private writeValues(
    unit: Expr | null,
    fmt: Expr | null,
    advance: Expr | null,
    items: Expr[],
    scope: Scope,
    line: number,
  ): void {
    if (unit !== null) {
      // File units are not implemented; every WRITE goes to the console so
      // that OPEN/WRITE/CLOSE programs from I/O chapters still run.
      this.scalarOf(this.evalExpr(unit, scope), line);
    }
    const values = items.map((e) => this.evalExpr(e, scope));
    let text: string;
    if (fmt === null) {
      text = listDirected(values, line);
    } else {
      const f = asString(this.scalarOf(this.evalExpr(fmt, scope), line), line);
      text = formatOutput(f, values, line);
    }
    let newline = true;
    if (advance !== null) {
      const a = asString(this.scalarOf(this.evalExpr(advance, scope), line), line).trim().toLowerCase();
      if (a === 'no') newline = false;
      else if (a !== 'yes') throw new RuntimeErr(`ADVANCE must be 'yes' or 'no', found '${a}'`, line);
    }
    this.output += text + (newline ? '\n' : '');
  }

  private allocate(stmt: Extract<Stmt, { t: 'allocate' }>, scope: Scope): void {
    let status = 0;
    for (const item of stmt.items) {
      try {
        const cell = this.lookup(scope, item.name);
        const info = this.lookupInfo(scope, item.name);
        if (cell === undefined || info === undefined) {
          throw new RuntimeErr(`ALLOCATE target '${item.name}' is not declared`, stmt.line);
        }
        if (!info.allocatable) throw new RuntimeErr(`'${item.name}' is not ALLOCATABLE`, stmt.line);
        const shape = this.evalDims(item.dims, scope, stmt.line);
        const fill = this.defaultFor(info.type, scope, stmt.line, 0);
        cell.value = filledArray(info.type.base, shape, fill, {
          kind: info.type.kind, typeName: info.type.typeName, charLen: info.type.charLen,
        });
      } catch (e) {
        if (stmt.stat === null) throw e;
        status = 1;
      }
    }
    if (stmt.stat !== null) this.bindName(scope, stmt.stat, intVal(status), stmt.line);
  }

  private deallocate(stmt: Extract<Stmt, { t: 'deallocate' }>, scope: Scope): void {
    let status = 0;
    for (const name of stmt.names) {
      try {
        const cell = this.lookup(scope, name);
        const info = this.lookupInfo(scope, name);
        if (cell === undefined || info === undefined) {
          throw new RuntimeErr(`DEALLOCATE target '${name}' is not declared`, stmt.line);
        }
        if (!info.allocatable) throw new RuntimeErr(`'${name}' is not ALLOCATABLE`, stmt.line);
        const value = cell.value;
        if (value.k !== 'array' || !value.allocated) {
          throw new RuntimeErr(`'${name}' is not allocated`, stmt.line);
        }
        cell.value = makeArray(value.base, [], [], {
          kind: value.kind, typeName: value.typeName, charLen: value.charLen, allocated: false,
        });
      } catch (e) {
        if (stmt.stat === null) throw e;
        status = 1;
      }
    }
    if (stmt.stat !== null) this.bindName(scope, stmt.stat, intVal(status), stmt.line);
  }

  // ─── assignment ───────────────────────────────────────────────────────

  private assign(target: Extract<Stmt, { t: 'assign' }>['target'], rhs: Value, scope: Scope, line: number): void {
    const cell = this.ensureCell(scope, target.base, line);
    const info = this.lookupInfo(scope, target.base);
    if (info !== undefined && info.parameter) {
      throw new RuntimeErr(`cannot assign to parameter '${target.base}'`, line);
    }
    if (info !== undefined && info.intent === 'in') {
      throw new RuntimeErr(`cannot assign to '${target.base}' — it is INTENT(IN)`, line);
    }

    if (target.parts.length === 0) {
      if (info !== undefined && info.array) {
        if (rhs.k !== 'array') {
          const arr = this.requireAllocated(cell.value, target.base, line);
          const value = this.coerceElem(rhs, info.type, line);
          this.writeArrayMasked(arr, null, value, line);
        } else if (info.allocatable && (!isArray(cell.value) || !(cell.value as ArrayV).allocated || !sameExtents(cell.value as ArrayV, rhs))) {
          const arr = this.coerce(rhs, info.type, line) as ArrayV;
          cell.value = makeArray(arr.base, arr.dims, arr.data.map(copyElem), {
            kind: arr.kind, typeName: arr.typeName, charLen: arr.charLen,
          });
        } else {
          const arr = this.requireAllocated(cell.value, target.base, line);
          if (!sameExtents(arr, rhs)) {
            throw new RuntimeErr(
              `shapes do not conform: '${target.base}' is ${arr.dims.map(extent).join('x')}, right side is ${rhs.dims.map(extent).join('x')}`,
              line,
            );
          }
          const data = rhs.data.map((e) => this.coerceElem(e, info.type, line));
          this.writeArrayMasked(arr, data, null, line);
        }
        this.lastWrite = { name: target.base, addrs: null, line };
      } else {
        if (rhs.k === 'array') throw new RuntimeErr(`cannot assign an array to scalar '${target.base}'`, line);
        const value = info === undefined
          ? copyElem(rhs)
          : this.coerceElem(rhs, info.type, line);
        cell.value = value;
        if (info === undefined) {
          scope.infos.set(target.base, {
            type: this.typeOfValue(value), array: false, allocatable: false,
            parameter: false, intent: null, implicit: true, declaredDims: null,
          });
        }
      }
      return;
    }

    const ref = this.refForDesignator(target, scope, line);
    ref.set(rhs, line);
    const base = this.lookup(scope, target.base);
    if (base !== undefined && isArray(base.value)) {
      this.lastWrite = { name: target.base, addrs: ref.addrs ?? null, line };
    }
  }

  private requireAllocated(v: Value, name: string, line: number): ArrayV {
    if (v.k !== 'array') throw new RuntimeErr(`'${name}' is not an array`, line);
    if (!v.allocated) throw new RuntimeErr(`'${name}' is not allocated`, line);
    return v;
  }

  private writeArrayMasked(arr: ArrayV, data: Elem[] | null, scalar: Elem | null, line: number): void {
    const mask = this.masks[this.masks.length - 1];
    const n = arr.data.length;
    if (mask === undefined || (mask.data === null && mask.value)) {
      for (let i = 0; i < n; i++) arr.data[i] = data === null ? copyElem(scalar!) : copyElem(data[i]!);
      return;
    }
    if (mask.data === null && !mask.value) return;
    if (mask.data !== null && !this.sameShape(mask.dims!, arr.dims)) {
      throw new RuntimeErr('the WHERE mask does not conform to the assignment target', line);
    }
    for (let i = 0; i < n; i++) {
      const take = mask.data === null ? mask.value : mask.data[i]!;
      if (take) arr.data[i] = data === null ? copyElem(scalar!) : copyElem(data[i]!);
    }
  }

  private assignInto(target: ArrayV, rhs: Value, line: number): void {
    if (rhs.k === 'array') {
      if (!sameExtents(target, rhs)) {
        throw new RuntimeErr(
          `initializer shape ${rhs.dims.map(extent).join('x')} does not match ${target.dims.map(extent).join('x')}`,
          line,
        );
      }
      for (let i = 0; i < target.data.length; i++) {
        target.data[i] = this.coerceElem(rhs.data[i]!, {
          base: target.base, kind: target.kind, charLen: target.charLen, typeName: target.typeName,
        }, line);
      }
    } else {
      for (let i = 0; i < target.data.length; i++) {
        target.data[i] = this.coerceElem(rhs, {
          base: target.base, kind: target.kind, charLen: target.charLen, typeName: target.typeName,
        }, line);
      }
    }
  }

  private refForDesignator(target: { base: string; parts: Part[] }, scope: Scope, line: number): Ref {
    const cell = this.ensureCell(scope, target.base, line);
    let ref: Ref = {
      get: () => cell.value,
      set: (v) => { cell.value = v; },
      addrs: null,
    };
    for (const part of target.parts) ref = this.wrapPart(ref, part, scope, line);
    return ref;
  }

  private refForExpr(expr: Expr, scope: Scope, line: number): Ref {
    if (expr.t === 'name') {
      const cell = this.ensureCell(scope, expr.name, line);
      return { get: () => cell.value, set: (v) => { cell.value = v; }, addrs: null };
    }
    if (expr.t === 'apply') {
      const base = this.refForExpr(expr.base, scope, line);
      return this.wrapPart(base, { kind: 'subs', args: expr.args }, scope, line);
    }
    if (expr.t === 'component') {
      const base = this.refForExpr(expr.base, scope, line);
      return this.wrapPart(base, { kind: 'component', name: expr.name }, scope, line);
    }
    let temp = this.evalExpr(expr, scope);
    return { get: () => temp, set: (v) => { temp = v; }, addrs: null };
  }

  private wrapPart(base: Ref, part: Part, scope: Scope, line: number): Ref {
    if (part.kind === 'component') {
      const name = part.name;
      return {
        get: () => this.readComponent(base.get(), name, line),
        set: (v) => this.writeComponent(base.get(), name, v, line),
      };
    }
    const value = base.get();
    if (value.k === 'array') {
      const specs = this.evalSubscripts(part.args, value.dims, scope, line);
      const selection = this.selectionShape(value.dims, specs, line);
      return {
        get: () => this.readSelection(value, specs, line),
        set: (v) => this.writeSelection(value, specs, v, line),
        addrs: selection.offsets,
      };
    }
    if (value.k === 'character') {
      const { lo, hi } = this.substringBounds(part.args, value.v.length, scope, line);
      return {
        get: () => charVal(value.v.slice(lo - 1, hi)),
        set: (v) => {
          const text = asString(this.scalarOf(v, line), line);
          value.v = value.v.slice(0, lo - 1) + padChar(text, hi - lo + 1) + value.v.slice(hi);
        },
      };
    }
    throw new RuntimeErr(`cannot subscript ${describe(value)} — it is not an array or character`, line);
  }

  private readComponent(value: Value, name: string, line: number): Value {
    if (value.k === 'derived') {
      const comp = value.comps.get(name);
      if (comp === undefined) throw new RuntimeErr(`TYPE(${value.typeName}) has no component '${name}'`, line);
      return comp;
    }
    if (value.k === 'array' && value.base === 'derived') {
      const data = value.data.map((e) => {
        if (e.k !== 'derived') throw new RuntimeErr(`expected a derived value, found ${describeScalar(e)}`, line);
        const comp = e.comps.get(name);
        if (comp === undefined) throw new RuntimeErr(`TYPE(${e.typeName}) has no component '${name}'`, line);
        if (comp.k === 'array') throw new RuntimeErr(`component '${name}' is an array — index the element first`, line);
        return copyElem(comp);
      });
      const first = data[0];
      if (first === undefined) {
        return makeArray('derived', value.dims, [], { typeName: value.typeName });
      }
      return makeArray(first.k, value.dims, data, {
        kind: 'kind' in first ? first.kind : 4,
        ...(first.k === 'character' ? { charLen: first.v.length } : {}),
        ...(first.k === 'derived' ? { typeName: first.typeName } : {}),
      });
    }
    throw new RuntimeErr(`cannot select component '${name}' of ${describe(value)}`, line);
  }

  private writeComponent(value: Value, name: string, rhs: Value, line: number): void {
    if (value.k === 'derived') {
      const current = value.comps.get(name);
      if (current === undefined) throw new RuntimeErr(`TYPE(${value.typeName}) has no component '${name}'`, line);
      this.setComponentValue(value.comps, name, current, rhs, this.typeOfValue(current), line);
      return;
    }
    if (value.k === 'array' && value.base === 'derived') {
      if (rhs.k === 'array' && !sameExtents(value, rhs)) {
        throw new RuntimeErr('component assignment shapes do not conform', line);
      }
      for (let i = 0; i < value.data.length; i++) {
        const e = value.data[i]!;
        if (e.k !== 'derived') throw new RuntimeErr(`expected a derived value`, line);
        const current = e.comps.get(name);
        if (current === undefined) throw new RuntimeErr(`TYPE(${e.typeName}) has no component '${name}'`, line);
        if (current.k === 'array') {
          throw new RuntimeErr(`component '${name}' is an array — index the element first`, line);
        }
        const item = rhs.k === 'array' ? rhs.data[i]! : rhs;
        e.comps.set(name, this.coerce(item, this.typeOfValue(current), line));
      }
      return;
    }
    throw new RuntimeErr(`cannot select component '${name}' of ${describe(value)}`, line);
  }

  private setComponentValue(
    comps: Map<string, Value>,
    name: string,
    current: Value,
    rhs: Value,
    type: ResolvedType,
    line: number,
  ): void {
    if (current.k === 'array') {
      if (current.allocated === false) {
        if (rhs.k !== 'array') {
          throw new RuntimeErr(`allocatable component '${name}' needs an array value`, line);
        }
        comps.set(name, this.coerce(rhs, type, line));
        return;
      }
      if (rhs.k === 'array') {
        if (!sameExtents(current, rhs)) {
          throw new RuntimeErr(
            `component '${name}' shape ${current.dims.map(extent).join('x')} does not match ${rhs.dims.map(extent).join('x')}`,
            line,
          );
        }
        comps.set(name, makeArray(current.base, current.dims, rhs.data.map((e) => this.coerceElem(e, type, line)), {
          kind: current.kind, typeName: current.typeName, charLen: current.charLen, allocated: true,
        }));
        return;
      }
      const fill = this.coerceElem(rhs, type, line);
      comps.set(name, filledArray(current.base, current.dims, fill, {
        kind: current.kind, typeName: current.typeName, charLen: current.charLen,
      }));
      return;
    }
    if (rhs.k === 'array') {
      throw new RuntimeErr(`component '${name}' is scalar but was given an array`, line);
    }
    comps.set(name, this.coerce(rhs, type, line));
  }

  // ─── array selection ─────────────────────────────────────────────────

  private evalSubscripts(args: Actual[], dims: Dim[], scope: Scope, line: number): Selection[] {
    if (args.length > dims.length) {
      throw new RuntimeErr(`too many subscripts: array has rank ${dims.length}`, line);
    }
    const specs: Selection[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg.name !== undefined) throw new RuntimeErr('keyword arguments are not array subscripts', line);
      const dim = dims[i]!;
      if (arg.sub !== undefined) {
        const lo = arg.sub.lo === null
          ? dim.lo
          : this.intBound(asInt(this.scalarOf(this.evalExpr(arg.sub.lo, scope), line), line), line, 'section lower bound');
        const hi = arg.sub.hi === null
          ? dim.hi
          : this.intBound(asInt(this.scalarOf(this.evalExpr(arg.sub.hi, scope), line), line), line, 'section upper bound');
        const step = arg.sub.step === null
          ? 1
          : this.intBound(asInt(this.scalarOf(this.evalExpr(arg.sub.step, scope), line), line), line, 'section stride');
        if (step === 0) throw new RuntimeErr('an array section stride cannot be zero', line);
        if (lo < dim.lo || lo > dim.hi || hi < dim.lo || hi > dim.hi) {
          throw new RuntimeErr(`section ${lo}:${hi} is outside bounds ${dim.lo}:${dim.hi}`, line);
        }
        specs.push({ kind: 'range', lo, hi, step });
      } else {
        if (arg.expr === undefined) throw new RuntimeErr('empty subscript', line);
        const index = this.intBound(
          asInt(this.scalarOf(this.evalExpr(arg.expr, scope), line), line), line, 'subscript',
        );
        if (index < dim.lo || index > dim.hi) {
          throw new RuntimeErr(`subscript ${index} is out of bounds ${dim.lo}:${dim.hi}`, line);
        }
        specs.push({ kind: 'index', index });
      }
    }
    for (let i = args.length; i < dims.length; i++) {
      specs.push({ kind: 'range', lo: dims[i]!.lo, hi: dims[i]!.hi, step: 1 });
    }
    return specs;
  }

  private rangeLength(s: Selection): number {
    if (s.kind === 'index') return 1;
    if (s.step > 0) return s.hi < s.lo ? 0 : Math.floor((s.hi - s.lo) / s.step) + 1;
    return s.lo < s.hi ? 0 : Math.floor((s.lo - s.hi) / -s.step) + 1;
  }

  private rangeIndices(s: Selection): number[] {
    if (s.kind === 'index') return [s.index];
    const out: number[] = [];
    if (s.step > 0) {
      for (let i = s.lo; i <= s.hi; i += s.step) out.push(i);
    } else {
      for (let i = s.lo; i >= s.hi; i += s.step) out.push(i);
    }
    return out;
  }

  private selectionShape(dims: Dim[], specs: Selection[], line: number): {
    offsets: number[];
    resultDims: Dim[];
    scalar: boolean;
  } {
    const st = strides(dims);
    const lengths = specs.map((s) => this.rangeLength(s));
    const total = lengths.reduce((n, len) => n * len, 1);
    if (!Number.isSafeInteger(total) || total > MAX_ELEMENTS) {
      throw new RuntimeErr(`array section has ${total} elements — the teaching limit is ${MAX_ELEMENTS.toLocaleString('en-US')}`, line);
    }
    const lists = specs.map((s) => this.rangeIndices(s));
    const scalar = specs.every((s) => s.kind === 'index');
    const resultDims = lists
      .filter((_, i) => specs[i]!.kind === 'range')
      .map((l) => ({ lo: 1, hi: l.length }));
    const offsets: number[] = [];
    for (let flat = 0; flat < total; flat++) {
      let rem = flat;
      let off = 0;
      for (let d = 0; d < lists.length; d++) {
        const len = lists[d]!.length;
        const pos = len === 0 ? 0 : rem % len;
        rem = len === 0 ? 0 : Math.floor(rem / len);
        const sub = lists[d]![pos] ?? dims[d]!.lo;
        off += (sub - dims[d]!.lo) * st[d]!;
      }
      offsets.push(off);
    }
    return { offsets, resultDims, scalar };
  }

  private readSelection(arr: ArrayV, specs: Selection[], line: number): Value {
    const { offsets, resultDims, scalar } = this.selectionShape(arr.dims, specs, line);
    if (scalar) return arr.data[offsets[0]!]!;
    const data = offsets.map((o) => (arr.base === 'derived' ? arr.data[o]! : copyElem(arr.data[o]!)));
    return makeArray(arr.base, resultDims, data, {
      kind: arr.kind, typeName: arr.typeName, charLen: arr.charLen,
    });
  }

  private writeSelection(arr: ArrayV, specs: Selection[], rhs: Value, line: number): void {
    const { offsets, resultDims, scalar } = this.selectionShape(arr.dims, specs, line);
    const targetType: ResolvedType = {
      base: arr.base, kind: arr.kind, charLen: arr.charLen, typeName: arr.typeName,
    };
    const mask = this.masks[this.masks.length - 1];
    if (scalar) {
      if (rhs.k === 'array') throw new RuntimeErr('cannot assign an array to one element', line);
      arr.data[offsets[0]!] = this.coerceElem(rhs, targetType, line);
      return;
    }
    if (mask !== undefined && mask.data !== null && !this.sameShape(mask.dims!, resultDims)) {
      throw new RuntimeErr('the WHERE mask does not conform to the assignment target', line);
    }
    if (rhs.k === 'array') {
      if (!this.sameShape(resultDims, rhs.dims)) {
        throw new RuntimeErr(
          `section shape ${resultDims.map(extent).join('x')} does not match ${rhs.dims.map(extent).join('x')}`,
          line,
        );
      }
      for (let i = 0; i < offsets.length; i++) {
        const take = mask === undefined ? true : mask.data === null ? mask.value : mask.data[i]!;
        if (take) arr.data[offsets[i]!] = this.coerceElem(rhs.data[i]!, targetType, line);
      }
    } else {
      for (let i = 0; i < offsets.length; i++) {
        const take = mask === undefined ? true : mask.data === null ? mask.value : mask.data[i]!;
        if (take) arr.data[offsets[i]!] = this.coerceElem(rhs, targetType, line);
      }
    }
  }

  private substringBounds(args: Actual[], len: number, scope: Scope, line: number): { lo: number; hi: number } {
    if (args.length !== 1 || args[0]!.sub === undefined) {
      throw new RuntimeErr('a substring needs one (lo:hi) range', line);
    }
    const sub = args[0]!.sub;
    const lo = sub.lo === null ? 1 : asInt(this.scalarOf(this.evalExpr(sub.lo, scope), line), line);
    const hi = sub.hi === null ? len : asInt(this.scalarOf(this.evalExpr(sub.hi, scope), line), line);
    if (lo < 1 || hi > len || lo > hi + 1) {
      throw new RuntimeErr(`substring ${lo}:${hi} is outside 1:${len}`, line);
    }
    return { lo, hi };
  }

  // ─── expressions ─────────────────────────────────────────────────────

  private scalarOf(v: Value, line: number): Elem {
    if (v.k === 'array') {
      throw new RuntimeErr(`expected a scalar, found ${describe(v)}`, line);
    }
    return v;
  }

  evalExpr(expr: Expr, scope: Scope): Value {
    switch (expr.t) {
      case 'int': {
        const kind = expr.kind === undefined ? 4 : this.kindSuffix(expr.kind, scope, expr.line);
        return intVal(expr.value, kind);
      }
      case 'real': {
        const kind = expr.kind === undefined ? 4 : this.kindSuffix(expr.kind, scope, expr.line);
        return realVal(expr.value, kind);
      }
      case 'logical': return logicalVal(expr.value);
      case 'string': return charVal(expr.value);
      case 'name': {
        const cell = this.lookup(scope, expr.name);
        if (cell === undefined) {
          if (scope.implicitNone) {
            throw new RuntimeErr(`no implicit typing: '${expr.name}' is not declared (add IMPLICIT NONE and a declaration)`, expr.line);
          }
          return this.ensureImplicit(scope, expr.name, expr.line).value;
        }
        return cell.value;
      }
      case 'apply': return this.evalApply(expr, scope);
      case 'component': {
        const base = this.evalExpr(expr.base, scope);
        return this.readComponent(base, expr.name, expr.line);
      }
      case 'unary': {
        const arg = this.evalExpr(expr.arg, scope);
        if (expr.op === 'not') {
          return this.mapValue(arg, (e) => logicalVal(!asLogical(e, expr.line)), expr.line);
        }
        if (expr.op === '+') return arg;
        return this.mapValue(arg, (e) => {
          if (e.k === 'integer') return intVal(-e.v, e.kind);
          if (e.k === 'real') return realVal(-e.v, e.kind);
          if (e.k === 'complex') return complexVal(-e.re, -e.im, e.kind);
          throw new RuntimeErr(`cannot negate ${describeScalar(e)}`, expr.line);
        }, expr.line);
      }
      case 'binary': {
        const left = this.evalExpr(expr.left, scope);
        const right = this.evalExpr(expr.right, scope);
        return this.binary(expr.op, left, right, expr.line);
      }
      case 'array': return this.evalArrayConstructor(expr.items, scope, expr.line);
      case 'implied': return this.evalImplied(expr, scope);
    }
  }

  private kindSuffix(kind: string, scope: Scope, line: number): number {
    if (/^\d+$/.test(kind)) return Number(kind);
    const cell = this.lookup(scope, kind);
    if (cell !== undefined) return asInt(this.scalarOf(cell.value, line), line);
    if (Object.prototype.hasOwnProperty.call(ISO_FORTRAN_ENV, kind)) return ISO_FORTRAN_ENV[kind]!;
    throw new RuntimeErr(`unknown kind '${kind}'`, line);
  }

  private evalApply(expr: Extract<Expr, { t: 'apply' }>, scope: Scope): Value {
    if (expr.base.t === 'name') {
      const name = expr.base.name;
      const cell = this.lookup(scope, name);
      if (cell !== undefined) {
        const value = cell.value;
        if (value.k === 'array') {
          const specs = this.evalSubscripts(expr.args, value.dims, scope, expr.line);
          return this.readSelection(value, specs, expr.line);
        }
        if (value.k === 'character') {
          const { lo, hi } = this.substringBounds(expr.args, value.v.length, scope, expr.line);
          return charVal(value.v.slice(lo - 1, hi));
        }
        throw new RuntimeErr(`'${name}' is a scalar and cannot be subscripted`, expr.line);
      }
      const proc = this.lookupProc(name, scope);
      if (proc !== undefined) return this.invoke(proc, expr.args, scope, expr.line);
      if (this.isIntrinsic(name)) return this.callIntrinsic(name, expr.args, scope, expr.line);
      const typeDef = this.shared.types.get(name);
      if (typeDef !== undefined) return this.constructDerived(typeDef, expr.args, scope, expr.line);
      if (!scope.implicitNone) {
        const implicitCell = this.ensureImplicit(scope, name, expr.line);
        if (implicitCell.value.k !== 'array') {
          throw new RuntimeErr(`'${name}' is an implicit scalar and cannot be subscripted`, expr.line);
        }
        return this.readSelection(implicitCell.value, this.evalSubscripts(expr.args, implicitCell.value.dims, scope, expr.line), expr.line);
      }
      throw new RuntimeErr(`unknown procedure or array '${name}'`, expr.line);
    }
    const base = this.evalExpr(expr.base, scope);
    if (base.k === 'array') {
      return this.readSelection(base, this.evalSubscripts(expr.args, base.dims, scope, expr.line), expr.line);
    }
    if (base.k === 'character') {
      const { lo, hi } = this.substringBounds(expr.args, base.v.length, scope, expr.line);
      return charVal(base.v.slice(lo - 1, hi));
    }
    throw new RuntimeErr(`cannot subscript ${describe(base)}`, expr.line);
  }

  private evalArrayConstructor(items: Expr[], scope: Scope, line: number): Value {
    const values: Value[] = items.map((item) => this.evalExpr(item, scope));
    const elements: Elem[] = [];
    for (const v of values) {
      if (v.k === 'array') elements.push(...v.data);
      else if (v.k === 'derived') throw new RuntimeErr('derived-type array constructors need identical components — not in this subset', line);
      else elements.push(v);
    }
    if (elements.length === 0) throw new RuntimeErr('an array constructor needs at least one value', line);
    if (elements.length > MAX_ELEMENTS) {
      throw new RuntimeErr(`array constructor has ${elements.length} elements — the teaching limit is ${MAX_ELEMENTS.toLocaleString('en-US')}`, line);
    }
    let base: ScalarBase = 'integer';
    let kind = 4;
    if (elements.some((e) => e.k === 'complex')) { base = 'complex'; kind = 8; }
    else if (elements.some((e) => e.k === 'real')) { base = 'real'; kind = 8; }
    else if (elements.some((e) => e.k === 'integer')) { base = 'integer'; kind = 4; }
    else if (elements.some((e) => e.k === 'logical')) { base = 'logical'; kind = 4; }
    else if (elements.some((e) => e.k === 'character')) { base = 'character'; kind = 1; }
    for (const e of elements) {
      if (base === 'complex' && !isNumeric(e)) throw new RuntimeErr('mixed array constructor types', line);
      if (base === 'real' && !isNumeric(e)) throw new RuntimeErr('mixed array constructor types', line);
      if (base === 'integer' && e.k !== 'integer') throw new RuntimeErr('mixed array constructor types', line);
      if (base === 'logical' && e.k !== 'logical') throw new RuntimeErr('mixed array constructor types', line);
      if (base === 'character' && e.k !== 'character') throw new RuntimeErr('mixed array constructor types', line);
    }
    const kinds = elements
      .filter((e): e is Extract<Elem, { kind: number }> => 'kind' in e)
      .map((e) => e.kind);
    if (kinds.length > 0) kind = Math.max(...kinds);
    const charLen = base === 'character'
      ? Math.max(...elements.map((e) => (e.k === 'character' ? e.v.length : 0)))
      : undefined;
    const data = elements.map((e) => convertElem(e, base, kind, charLen, line));
    return makeArray(base, [{ lo: 1, hi: data.length }], data, { kind, charLen });
  }

  private evalImplied(expr: Extract<Expr, { t: 'implied' }>, scope: Scope): Value {
    const start = asInt(this.scalarOf(this.evalExpr(expr.start, scope), expr.line), expr.line);
    const end = asInt(this.scalarOf(this.evalExpr(expr.end, scope), expr.line), expr.line);
    const step = expr.step === null ? 1 : asInt(this.scalarOf(this.evalExpr(expr.step, scope), expr.line), expr.line);
    if (step === 0) throw new RuntimeErr('an implied-DO step cannot be zero', expr.line);
    const temp = new Scope('implied-do', scope, false, 'procedure');
    const out: Elem[] = [];
    let iterations = 0;
    for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
      if (++iterations > MAX_ELEMENTS) {
        throw new RuntimeErr(`implied-DO exceeds ${MAX_ELEMENTS.toLocaleString('en-US')} iterations`, expr.line);
      }
      temp.vars.set(expr.var, { value: intVal(i) });
      temp.infos.set(expr.var, {
        type: { base: 'integer', kind: 4 }, array: false, allocatable: false,
        parameter: false, intent: null, implicit: false, declaredDims: null,
      });
      const v = this.evalExpr(expr.items.length === 1 ? expr.items[0]! : {
        t: 'array', items: expr.items, line: expr.line,
      }, temp);
      if (v.k === 'array') out.push(...v.data);
      else if (v.k === 'derived') throw new RuntimeErr('derived values in an implied-DO are not in this subset', expr.line);
      else out.push(v);
      if (out.length > MAX_ELEMENTS) {
        throw new RuntimeErr(`implied-DO produces more than ${MAX_ELEMENTS.toLocaleString('en-US')} elements`, expr.line);
      }
    }
    let base: ScalarBase = 'integer';
    let kind = 4;
    if (out.some((e) => e.k === 'complex')) { base = 'complex'; kind = 8; }
    else if (out.some((e) => e.k === 'real')) { base = 'real'; kind = 8; }
    else if (out.some((e) => e.k === 'logical')) { base = 'logical'; kind = 4; }
    else if (out.some((e) => e.k === 'character')) { base = 'character'; kind = 1; }
    const kinds = out
      .filter((e): e is Extract<Elem, { kind: number }> => 'kind' in e)
      .map((e) => e.kind);
    if (kinds.length > 0) kind = Math.max(...kinds);
    const charLen = base === 'character'
      ? Math.max(...out.map((e) => (e.k === 'character' ? e.v.length : 0)))
      : undefined;
    const data = out.map((e) => convertElem(e, base, kind, charLen, expr.line));
    return makeArray(base, [{ lo: 1, hi: data.length }], data, { kind, charLen });
  }

  private mapValue(v: Value, fn: (e: Elem) => Elem, line: number): Value {
    if (v.k !== 'array') return fn(v);
    if (!v.allocated) throw new RuntimeErr('cannot use an unallocated array', line);
    const data = v.data.map(fn);
    return this.retype(v, data);
  }

  private retype(arr: ArrayV, data: Elem[]): ArrayV {
    const first = data[0];
    return {
      ...arr,
      data,
      base: first === undefined ? arr.base : first.k,
      kind: first !== undefined && 'kind' in first ? first.kind : arr.kind,
      ...(first !== undefined && first.k === 'derived' ? { typeName: first.typeName } : {}),
    };
  }

  private binary(op: BinOp, a: Value, b: Value, line: number): Value {
    if (a.k === 'array' || b.k === 'array') {
      const arr = a.k === 'array' ? a : b as ArrayV;
      if (a.k === 'array' && b.k === 'array' && !sameExtents(a, b)) {
        throw new RuntimeErr(
          `shapes do not conform: ${a.dims.map(extent).join('x')} vs ${b.dims.map(extent).join('x')}`,
          line,
        );
      }
      if (arr.base === 'derived' || (a.k === 'derived') || (b.k === 'derived')) {
        throw new RuntimeErr('derived-type values do not support intrinsic operators', line);
      }
      const data: Elem[] = [];
      for (let i = 0; i < arr.data.length; i++) {
        data.push(this.binaryScalar(op, a.k === 'array' ? a.data[i]! : a, b.k === 'array' ? b.data[i]! : b, line));
      }
      return this.retype(arr, data);
    }
    return this.binaryScalar(op, a, b, line);
  }

  private binaryScalar(op: BinOp, a: Elem, b: Elem, line: number): Elem {
    if (op === '//') {
      const x = asString(a, line);
      const y = asString(b, line);
      if (x.length + y.length > MAX_CHAR_LEN) {
        throw new RuntimeErr(`concatenated CHARACTER length ${x.length + y.length} exceeds the teaching limit of ${MAX_CHAR_LEN.toLocaleString('en-US')}`, line);
      }
      return charVal(x + y);
    }
    if (op === 'and' || op === 'or' || op === 'eqv' || op === 'neqv') {
      const x = asLogical(a, line);
      const y = asLogical(b, line);
      if (op === 'and') return logicalVal(x && y);
      if (op === 'or') return logicalVal(x || y);
      if (op === 'eqv') return logicalVal(x === y);
      return logicalVal(x !== y);
    }
    if (op === '==' || op === '/=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
      return logicalVal(this.compareScalar(op, a, b, line));
    }
    if (op === '+' || op === '-' || op === '*' || op === '/' || op === '**') {
      return this.arith(op, a, b, line);
    }
    throw new RuntimeErr(`operator '${op}' is not implemented`, line);
  }

  private compareScalar(op: string, a: Elem, b: Elem, line: number): boolean {
    if (a.k === 'character' && b.k === 'character') {
      const len = Math.max(a.v.length, b.v.length);
      const x = a.v.padEnd(len, ' ');
      const y = b.v.padEnd(len, ' ');
      switch (op) {
        case '==': return x === y;
        case '/=': return x !== y;
        case '<': return x < y;
        case '<=': return x <= y;
        case '>': return x > y;
        case '>=': return x >= y;
      }
    }
    if (a.k === 'logical' && b.k === 'logical') {
      if (op === '==') return a.v === b.v;
      if (op === '/=') return a.v !== b.v;
      throw new RuntimeErr('LOGICAL values only support .EQ. and .NE.', line);
    }
    if (!isNumeric(a) || !isNumeric(b)) {
      throw new RuntimeErr(`cannot compare ${describeScalar(a)} with ${describeScalar(b)}`, line);
    }
    if (a.k === 'complex' || b.k === 'complex') {
      if (op !== '==' && op !== '/=') throw new RuntimeErr('COMPLEX values only support .EQ. and .NE.', line);
      const x = asComplex(a, line);
      const y = asComplex(b, line);
      return op === '==' ? x.re === y.re && x.im === y.im : !(x.re === y.re && x.im === y.im);
    }
    const x = asReal(a, line);
    const y = asReal(b, line);
    switch (op) {
      case '==': return x === y;
      case '/=': return x !== y;
      case '<': return x < y;
      case '<=': return x <= y;
      case '>': return x > y;
      case '>=': return x >= y;
    }
    return false;
  }

  private arith(op: '+' | '-' | '*' | '/' | '**', a: Elem, b: Elem, line: number): Elem {
    if (a.k === 'complex' || b.k === 'complex') {
      const x = asComplex(a, line);
      const y = asComplex(b, line);
      const kind = maxKind(a.k === 'complex' ? a.kind : 4, b.k === 'complex' ? b.kind : 4);
      switch (op) {
        case '+': return complexVal(x.re + y.re, x.im + y.im, kind);
        case '-': return complexVal(x.re - y.re, x.im - y.im, kind);
        case '*': return complexVal(x.re * y.re - x.im * y.im, x.re * y.im + x.im * y.re, kind);
        case '/': {
          const den = y.re * y.re + y.im * y.im;
          if (den === 0) throw new RuntimeErr('complex division by zero', line);
          return complexVal((x.re * y.re + x.im * y.im) / den, (x.im * y.re - x.re * y.im) / den, kind);
        }
        case '**': {
          const r = Math.hypot(x.re, x.im);
          const theta = Math.atan2(x.im, x.re);
          const nr = r ** y.re * Math.exp(-y.im * theta);
          const nt = y.re * theta + y.im * Math.log(r);
          return complexVal(nr * Math.cos(nt), nr * Math.sin(nt), kind);
        }
      }
    }
    if (a.k === 'real' || b.k === 'real') {
      const kind = a.k === 'real' && b.k === 'real'
        ? maxKind(a.kind, b.kind)
        : a.k === 'real' ? a.kind : b.k === 'real' ? b.kind : 8;
      const x = asReal(a, line);
      const y = asReal(b, line);
      switch (op) {
        case '+': return realVal(x + y, kind);
        case '-': return realVal(x - y, kind);
        case '*': return realVal(x * y, kind);
        case '/': return realVal(x / y, kind);
        case '**': return realVal(x ** y, kind);
      }
    }
    if (a.k !== 'integer' || b.k !== 'integer') {
      throw new RuntimeErr(`cannot apply '${op}' to ${describeScalar(a)} and ${describeScalar(b)}`, line);
    }
    const kind = maxKind(a.kind, b.kind);
    switch (op) {
      case '+': return intVal(a.v + b.v, kind);
      case '-': return intVal(a.v - b.v, kind);
      case '*': return intVal(a.v * b.v, kind);
      case '/':
        if (b.v === 0) throw new RuntimeErr('integer division by zero', line);
        return intVal(Math.trunc(a.v / b.v), kind);
      case '**':
        if (b.v < 0) return realVal(a.v ** b.v, 4);
        return intVal(a.v ** b.v, kind);
    }
  }

  // ─── procedures ──────────────────────────────────────────────────────

  private lookupProc(name: string, scope: Scope): ProcEntry | undefined {
    for (let i = this.activeProcs.length - 1; i >= 0; i--) {
      const found = this.activeProcs[i]!.get(name);
      if (found !== undefined) return found;
    }
    for (let s: Scope | null = scope; s !== null; s = s.parent) {
      const found = s.procs.get(name);
      if (found !== undefined) return found;
    }
    return this.shared.procs.get(name);
  }

  private dummyShape(info: VarInfo, actual: ArrayV, scope: Scope, line: number): Dim[] {
    const specs = info.dummyDims;
    if (specs === undefined) return actual.dims.map((d) => ({ ...d }));
    if (specs.length !== actual.dims.length) {
      throw new RuntimeErr(
        `dummy argument has rank ${specs.length} but the actual has rank ${actual.dims.length}`,
        line,
      );
    }
    return specs.map((spec, i) => {
      const lo = spec.lo === null
        ? 1
        : this.intBound(asInt(this.scalarOf(this.evalExpr(spec.lo, scope), line), line), line, 'dummy lower bound');
      const actualExtent = extent(actual.dims[i]!);
      if (spec.deferred || spec.hi === null) {
        return { lo, hi: lo + actualExtent - 1 };
      }
      const hi = this.intBound(asInt(this.scalarOf(this.evalExpr(spec.hi, scope), line), line), line, 'dummy upper bound');
      if (hi - lo + 1 !== actualExtent) {
        throw new RuntimeErr(
          `dummy argument extent ${hi - lo + 1} does not match the actual extent ${actualExtent}`,
          line,
        );
      }
      return { lo, hi };
    });
  }

  private invoke(proc: ProcEntry, actuals: Actual[], caller: Scope, line: number): Value {
    if (this.callDepth >= MAX_DEPTH) throw new RuntimeErr('call depth exceeded — is the recursion unbounded?', line);
    this.callDepth++;
    const decl = proc.decl;
    const scope = new Scope(decl.name, proc.host, decl.implicitNone, 'procedure');
    this.registerTypes(decl.types);
    this.aliasUses(scope, decl.uses);
    const dummies = new Set(decl.args);
    this.applyDecls(scope, decl.decls, dummies, decl.saveAll, 'params');
    this.applyDecls(scope, decl.decls, dummies, decl.saveAll, 'dummies');

    const refs: {
      ref: Ref;
      cell: Cell;
      intent: 'in' | 'out' | 'inout';
      writebackDims: Dim[] | null;
      allocatable: boolean;
      dummy: string;
    }[] = [];
    const boundActuals = new Map<string, Actual>();
    const bound = new Set<string>();
    const positional = actuals.filter((a) => a.name === undefined);
    const keyword = new Map<string, Actual>();
    for (const a of actuals) {
      if (a.name !== undefined) {
        if (keyword.has(a.name)) throw new RuntimeErr(`argument '${a.name}' appears twice`, line);
        keyword.set(a.name, a);
      }
    }
    if (positional.length > decl.args.length) {
      throw new RuntimeErr(`too many actual arguments for ${decl.name}`, line);
    }
    for (let i = 0; i < decl.args.length; i++) {
      const dummy = decl.args[i]!;
      const actual = keyword.get(dummy) ?? positional[i];
      const info = scope.infos.get(dummy);
      if (actual === undefined) {
        throw new RuntimeErr(`missing actual argument for '${dummy}'`, line);
      }
      bound.add(dummy);
      const ref = this.refForActual(actual, caller, line);
      const actualValue = ref.get();
      if (info !== undefined && info.type.base === 'character' && info.type.charLen === undefined) {
        if (actualValue.k === 'character') {
          info.type = { ...info.type, charLen: actualValue.v.length };
          scope.infos.set(dummy, info);
        } else if (actualValue.k === 'array' && actualValue.base === 'character'
          && actualValue.charLen !== undefined) {
          info.type = { ...info.type, charLen: actualValue.charLen };
          scope.infos.set(dummy, info);
        }
      }
      if (info !== undefined) {
        if (info.array && actualValue.k !== 'array') {
          throw new RuntimeErr(`argument '${dummy}' expects an array, got ${describe(actualValue)}`, line);
        }
        if (!info.array && actualValue.k === 'array') {
          throw new RuntimeErr(`argument '${dummy}' expects a scalar, got ${describe(actualValue)}`, line);
        }
        if (actualValue.k !== 'array' && info.type.base !== 'derived' && actualValue.k !== info.type.base
          && !(isNumeric(actualValue) && (info.type.base === 'real' || info.type.base === 'complex'))) {
          throw new RuntimeErr(
            `argument '${dummy}' expects ${info.type.base}, got ${describeScalar(actualValue)}`,
            line,
          );
        }
      }
      const boundCell: Cell = { value: actualValue };
      scope.vars.set(dummy, boundCell);
      boundActuals.set(dummy, actual);
      if (info?.intent !== 'in') {
        refs.push({
          ref, cell: boundCell, intent: info?.intent ?? 'inout',
          writebackDims: null,
          allocatable: info?.allocatable ?? false,
          dummy,
        });
      }
    }
    for (const a of actuals) {
      if (a.name !== undefined && !bound.has(a.name) && !decl.args.includes(a.name)) {
        throw new RuntimeErr(`'${a.name}' is not a dummy argument of ${decl.name}`, line);
      }
    }

    for (const dummy of decl.args) {
      const info = scope.infos.get(dummy);
      const cell = scope.vars.get(dummy);
      if (info === undefined || cell === undefined) continue;
      const actualValue = cell.value;
      const entry = refs.find((r) => r.dummy === dummy);
      if (info.array) {
        if (actualValue.k !== 'array') {
          throw new RuntimeErr(`argument '${dummy}' expects an array, got ${describe(actualValue)}`, line);
        }
        if (info.allocatable) {
          const actual = boundActuals.get(dummy)!;
          if (actual.expr?.t !== 'name') {
            throw new RuntimeErr(`allocatable dummy '${dummy}' needs an allocatable variable`, line);
          }
          const actualInfo = caller.infos.get(actual.expr.name);
          if (actualInfo === undefined || !actualInfo.allocatable) {
            throw new RuntimeErr(`allocatable dummy '${dummy}' needs an allocatable actual argument`, line);
          }
          if (info.intent === 'out') {
            cell.value = makeArray(info.type.base, [], [], {
              kind: info.type.kind, typeName: info.type.typeName,
              charLen: info.type.charLen, allocated: false,
            });
          }
        } else {
          const shape = this.dummyShape(info, actualValue, scope, line);
          if (entry !== undefined) entry.writebackDims = actualValue.dims.map((d) => ({ ...d }));
          if (info.intent === 'out') {
            const fill = this.defaultFor(info.type, scope, line, 0);
            cell.value = filledArray(info.type.base, shape, fill, {
              kind: info.type.kind, typeName: info.type.typeName, charLen: info.type.charLen,
            });
          } else {
            cell.value = makeArray(info.type.base, shape, actualValue.data.map((e) => copyElem(e)), {
              kind: info.type.kind, typeName: info.type.typeName, charLen: info.type.charLen,
            });
          }
        }
      } else if (info.intent === 'out') {
        cell.value = this.defaultFor(info.type, scope, line, 0);
      }
    }

    for (const dummy of decl.args) {
      const info = scope.infos.get(dummy);
      if (info?.dummyCharLenExpr === undefined) continue;
      const cell = scope.vars.get(dummy);
      if (cell === undefined) continue;
      const len = this.intBound(
        asInt(this.scalarOf(this.evalExpr(info.dummyCharLenExpr, scope), line), line),
        line,
        'dummy CHARACTER length',
      );
      if (len < 0 || len > MAX_CHAR_LEN) {
        throw new RuntimeErr(
          `CHARACTER length ${len} exceeds the teaching limit of ${MAX_CHAR_LEN.toLocaleString('en-US')}`,
          line,
        );
      }
      info.type = { ...info.type, charLen: len };
      const v = cell.value;
      if (v.k === 'character') {
        cell.value = this.coerceElem(v, info.type, line);
      } else if (v.k === 'array' && v.base === 'character') {
        cell.value = makeArray(v.base, v.dims, v.data.map((e) => this.coerceElem(e, info.type, line)), {
          kind: v.kind, typeName: v.typeName, charLen: len, allocated: v.allocated,
        });
      }
    }

    this.applyDecls(scope, decl.decls, dummies, decl.saveAll, 'locals');
    let frameSlots = 0;
    for (const [name, cell] of scope.vars) {
      if (dummies.has(name)) continue;
      frameSlots += valueSize(cell.value);
      if (frameSlots > MAX_FRAME_ELEMENTS) {
        throw new RuntimeErr(
          `procedure '${decl.name}' needs more than ${MAX_FRAME_ELEMENTS.toLocaleString('en-US')} local scalar slots`,
          line,
        );
      }
    }

    let resultName: string | null = null;
    if (decl.kind === 'function') {
      resultName = decl.result ?? decl.name;
      let cell = scope.vars.get(resultName);
      if (cell === undefined) {
        if (decl.returnType === null) {
          throw new RuntimeErr(`function '${decl.name}' has no return type`, decl.line);
        }
        const type = this.resolveType(decl.returnType, scope, decl.line);
        cell = { value: this.defaultFor(type, scope, decl.line, 0) };
        scope.vars.set(resultName, cell);
        scope.infos.set(resultName, {
          type, array: false, allocatable: false, parameter: false,
          intent: null, implicit: false, declaredDims: null,
        });
      }
    }

    const localProcs = new Map<string, ProcEntry>();
    for (const inner of decl.internal) localProcs.set(inner.name, { decl: inner, host: scope });
    this.activeProcs.push(localProcs);
    this.frames.push({ name: decl.name, scope, line: decl.line });
    const savedWrite = this.lastWrite;
    try {
      const gen = this.execBlock(decl.body, scope);
      for (const _ of gen) { /* a procedure call is one step at the caller */ }
    } catch (e) {
      if (!(e instanceof ReturnSignal)) throw e;
    } finally {
      this.frames.pop();
      this.activeProcs.pop();
      this.callDepth--;
      for (const entry of refs) {
        const actualExpr = boundActuals.get(entry.dummy)?.expr;
        const actualInfo = actualExpr?.t === 'name' ? caller.infos.get(actualExpr.name) : undefined;
        if (entry.allocatable) {
          entry.ref.set(entry.cell.value, line);
        } else if (entry.writebackDims !== null && entry.cell.value.k === 'array') {
          const v = entry.cell.value;
          const data = actualInfo === undefined
            ? v.data.map((e) => copyElem(e))
            : v.data.map((e) => this.coerceElem(e, actualInfo.type, line));
          entry.ref.set(makeArray(
            actualInfo?.type.base ?? v.base,
            entry.writebackDims,
            data,
            {
              kind: actualInfo?.type.kind ?? v.kind,
              typeName: actualInfo?.type.typeName ?? v.typeName,
              charLen: actualInfo?.type.charLen ?? v.charLen,
            },
          ), line);
        } else if (actualInfo !== undefined) {
          entry.ref.set(this.coerce(entry.cell.value, actualInfo.type, line), line);
        } else {
          entry.ref.set(entry.cell.value, line);
        }
      }
      if (this.lastWrite !== null && this.valueByName(this.lastWrite.name) === undefined) {
        this.lastWrite = savedWrite;
      }
    }

    if (decl.kind === 'function') {
      const cell = scope.vars.get(resultName!);
      if (cell === undefined) throw new RuntimeErr(`function '${decl.name}' produced no result`, line);
      return copyValue(cell.value);
    }
    return logicalVal(true);
  }

  private refForActual(actual: Actual, scope: Scope, line: number): Ref {
    if (actual.expr === undefined) {
      if (actual.sub !== undefined) throw new RuntimeErr('a range cannot be a whole actual argument', line);
      throw new RuntimeErr('empty actual argument', line);
    }
    const expr = actual.expr;
    if (expr.t === 'name' || expr.t === 'apply' || expr.t === 'component') {
      return this.refForExpr(expr, scope, line);
    }
    let temp = this.evalExpr(expr, scope);
    return { get: () => temp, set: (v) => { temp = v; }, addrs: null };
  }

  private callSubroutine(name: string, actuals: Actual[], scope: Scope, line: number): void {
    const proc = this.lookupProc(name, scope);
    if (proc !== undefined) {
      this.invoke(proc, actuals, scope, line);
      return;
    }
    if (this.isIntrinsicSub(name)) {
      this.callIntrinsicSub(name, actuals, scope, line);
      return;
    }
    throw new RuntimeErr(`unknown subroutine '${name}'`, line);
  }

  // ─── derived types ───────────────────────────────────────────────────

  private constructDerived(def: DerivedDef, actuals: Actual[], scope: Scope, line: number): DerivedV {
    const comps = new Map<string, Value>();
    const order: { name: string; type: ResolvedType }[] = [];
    for (const decl of def.components) {
      const type = this.resolveType(decl.type, scope, decl.line);
      for (const entity of decl.entities) {
        order.push({ name: entity.name, type });
        const dims = entity.dims ?? decl.attrs.dimension;
        if (dims !== null) {
          if (dims.some((d) => d.deferred)) {
            comps.set(entity.name, makeArray(type.base, [], [], {
              kind: type.kind, typeName: type.typeName, charLen: type.charLen, allocated: false,
            }));
          } else {
            const shape = this.evalDims(dims, scope, entity.line);
            const fill = this.defaultFor(type, scope, entity.line, 1);
            const arr = filledArray(type.base, shape, fill, {
              kind: type.kind, typeName: type.typeName, charLen: type.charLen,
            });
            if (entity.init !== null) this.assignInto(arr, this.evalExpr(entity.init, scope), entity.line);
            comps.set(entity.name, arr);
          }
        } else if (entity.init !== null) {
          comps.set(entity.name, this.coerce(this.evalExpr(entity.init, scope), type, entity.line));
        } else {
          comps.set(entity.name, this.defaultFor(type, scope, entity.line, 1));
        }
      }
    }
    let position = 0;
    const seen = new Set<string>();
    for (const actual of actuals) {
      if (actual.name !== undefined) {
        const target = order.find((c) => c.name === actual.name);
        if (target === undefined) throw new RuntimeErr(`TYPE(${def.name}) has no component '${actual.name}'`, line);
        if (seen.has(target.name)) throw new RuntimeErr(`component '${target.name}' appears twice`, line);
        seen.add(target.name);
        if (actual.expr === undefined) throw new RuntimeErr('empty structure-constructor value', line);
        const current = comps.get(target.name)!;
        this.setComponentValue(comps, target.name, current, this.evalExpr(actual.expr, scope), target.type, line);
        continue;
      }
      if (actual.expr === undefined) throw new RuntimeErr('empty structure-constructor value', line);
      const target = order[position++];
      if (target === undefined) throw new RuntimeErr(`too many values for TYPE(${def.name})`, line);
      if (seen.has(target.name)) throw new RuntimeErr(`component '${target.name}' appears twice`, line);
      seen.add(target.name);
      const current = comps.get(target.name)!;
      this.setComponentValue(comps, target.name, current, this.evalExpr(actual.expr, scope), target.type, line);
    }
    return { k: 'derived', typeName: def.name, comps };
  }

  // ─── scopes ──────────────────────────────────────────────────────────

  lookup(scope: Scope, name: string): Cell | undefined {
    for (let s: Scope | null = scope; s !== null; s = s.parent) {
      const cell = s.vars.get(name);
      if (cell !== undefined) return cell;
    }
    return undefined;
  }

  private lookupInfo(scope: Scope, name: string): VarInfo | undefined {
    for (let s: Scope | null = scope; s !== null; s = s.parent) {
      const info = s.infos.get(name);
      if (info !== undefined) return info;
    }
    return undefined;
  }

  private ensureCell(scope: Scope, name: string, line: number): Cell {
    const found = this.lookup(scope, name);
    if (found !== undefined) return found;
    if (scope.implicitNone) {
      throw new RuntimeErr(`no implicit typing: '${name}' is not declared (add IMPLICIT NONE and a declaration)`, line);
    }
    return this.ensureImplicit(scope, name, line);
  }

  private ensureImplicit(scope: Scope, name: string, line: number): Cell {
    const isInteger = name >= 'i' && name <= 'n';
    const value: Value = isInteger ? intVal(0) : realVal(0);
    const cell: Cell = { value };
    scope.vars.set(name, cell);
    scope.infos.set(name, {
      type: isInteger ? { base: 'integer', kind: 4 } : { base: 'real', kind: 8 },
      array: false, allocatable: false, parameter: false, intent: null,
      implicit: true, declaredDims: null,
    });
    void line;
    return cell;
  }

  private bindName(scope: Scope, name: string, value: Value, line: number): void {
    const cell = this.ensureCell(scope, name, line);
    const info = this.lookupInfo(scope, name);
    cell.value = info === undefined ? copyValue(value) : this.coerce(value, info.type, line);
  }

  // ─── intrinsics ──────────────────────────────────────────────────────

  private isIntrinsic(name: string): boolean {
    return INTRINSICS[name] === true;
  }

  private isIntrinsicSub(name: string): boolean {
    return INTRINSIC_SUBS[name] === true;
  }

  private evalArgs(actuals: Actual[], scope: Scope, line: number): { pos: Value[]; kw: Map<string, Value> } {
    const pos: Value[] = [];
    const kw = new Map<string, Value>();
    for (const a of actuals) {
      if (a.name !== undefined) {
        if (a.expr === undefined) throw new RuntimeErr('keyword argument without a value', line);
        kw.set(a.name, this.evalExpr(a.expr, scope));
      } else if (a.expr !== undefined) {
        pos.push(this.evalExpr(a.expr, scope));
      } else {
        throw new RuntimeErr('unexpected range in an intrinsic call', line);
      }
    }
    return { pos, kw };
  }

  private callIntrinsic(name: string, actuals: Actual[], scope: Scope, line: number): Value {
    if (name === 'allocated') {
      const arg = actuals[0];
      if (arg?.expr === undefined) throw new RuntimeErr('allocated needs one argument', line);
      const value = this.evalExpr(arg.expr, scope);
      return logicalVal(value.k === 'array' ? value.allocated : true);
    }
    if (name === 'kind') {
      const value = this.evalExpr(actuals[0]!.expr!, scope);
      return intVal(this.typeOfValue(value).kind);
    }
    if (name === 'present') {
      throw new RuntimeErr('OPTIONAL arguments are not in the teaching subset', line);
    }
    const { pos, kw } = this.evalArgs(actuals, scope, line);
    if (name === 'selected_real_kind') {
      const pv = kw.get('p') ?? pos[0];
      const rv = kw.get('r') ?? pos[1];
      const p = pv === undefined ? 0 : asInt(this.scalarOf(pv, line), line);
      const r = rv === undefined ? 0 : asInt(this.scalarOf(rv, line), line);
      if (p <= 6 && r <= 37) return intVal(4);
      if (p <= 15 && r <= 307) return intVal(8);
      return intVal(-1);
    }
    if (name === 'selected_int_kind') {
      const rv = kw.get('r') ?? pos[0];
      if (rv === undefined) throw new RuntimeErr('SELECTED_INT_KIND needs a radix argument', line);
      const r = asInt(this.scalarOf(rv, line), line);
      if (r <= 2) return intVal(1);
      if (r <= 4) return intVal(2);
      if (r <= 9) return intVal(4);
      if (r <= 18) return intVal(8);
      return intVal(-1);
    }
    if (name === 'selected_char_kind') {
      const sv = kw.get('kind') ?? pos[0];
      if (sv === undefined) throw new RuntimeErr('SELECTED_CHAR_KIND needs a kind argument', line);
      const s = asString(this.scalarOf(sv, line), line).toLowerCase();
      return intVal(s === 'ascii' || s === 'default' ? 1 : -1);
    }
    const first = pos[0];
    if (first === undefined) throw new RuntimeErr(`intrinsic '${name}' needs an argument`, line);
    const kindArg = kw.get('kind') ?? pos[1];

    switch (name) {
      case 'abs': return this.mapValue(first, (e) => {
        if (e.k === 'complex') return realVal(Math.hypot(e.re, e.im), e.kind);
        if (e.k === 'real') return realVal(Math.abs(e.v), e.kind);
        if (e.k === 'integer') return intVal(Math.abs(e.v), e.kind);
        throw new RuntimeErr('ABS expects a numeric value', line);
      }, line);
      case 'sqrt': case 'exp': case 'log': case 'log10': case 'sin': case 'cos':
      case 'tan': case 'asin': case 'acos': case 'atan': case 'sinh': case 'cosh': case 'tanh':
        return this.mapValue(first, (e) => {
          if (e.k === 'complex') {
            const c = asComplex(e, line);
            const r = Math.hypot(c.re, c.im);
            const t = Math.atan2(c.im, c.re);
            switch (name) {
              case 'sqrt': {
                const sr = Math.sqrt((r + c.re) / 2);
                const si = Math.sign(c.im) * Math.sqrt(Math.max(0, (r - c.re) / 2));
                return complexVal(sr, si, e.kind);
              }
              case 'exp': return complexVal(Math.exp(c.re) * Math.cos(c.im), Math.exp(c.re) * Math.sin(c.im), e.kind);
              case 'log': return complexVal(Math.log(r), t, e.kind);
              case 'sin': return complexVal(Math.sin(c.re) * Math.cosh(c.im), Math.cos(c.re) * Math.sinh(c.im), e.kind);
              case 'cos': return complexVal(Math.cos(c.re) * Math.cosh(c.im), -Math.sin(c.re) * Math.sinh(c.im), e.kind);
              default: throw new RuntimeErr(`'${name}' on COMPLEX is not implemented`, line);
            }
          }
          const x = asReal(e, line);
          const kind = e.k === 'real' ? e.kind : 8;
          switch (name) {
            case 'sqrt': return realVal(Math.sqrt(x), kind);
            case 'exp': return realVal(Math.exp(x), kind);
            case 'log': return realVal(Math.log(x), kind);
            case 'log10': return realVal(Math.log10(x), kind);
            case 'sin': return realVal(Math.sin(x), kind);
            case 'cos': return realVal(Math.cos(x), kind);
            case 'tan': return realVal(Math.tan(x), kind);
            case 'asin': return realVal(Math.asin(x), kind);
            case 'acos': return realVal(Math.acos(x), kind);
            case 'atan': return realVal(Math.atan(x), kind);
            case 'sinh': return realVal(Math.sinh(x), kind);
            case 'cosh': return realVal(Math.cosh(x), kind);
            case 'tanh': return realVal(Math.tanh(x), kind);
          }
          throw new RuntimeErr('unreachable', line);
        }, line);
      case 'atan2': {
        const y = pos[0]!;
        const x = pos[1]!;
        return this.mapBinary(y, x, (a, b) => {
          const kind = a.k === 'real' && b.k === 'real'
            ? maxKind(a.kind, b.kind)
            : a.k === 'real' ? a.kind : b.k === 'real' ? b.kind : 8;
          return realVal(Math.atan2(asReal(a, line), asReal(b, line)), kind);
        }, line);
      }
      case 'mod': case 'modulo': {
        const p = pos[1];
        if (p === undefined) throw new RuntimeErr(`${name} needs two arguments`, line);
        return this.mapBinary(first, p, (a, b) => {
          if (a.k === 'integer' && b.k === 'integer') {
            if (b.v === 0) throw new RuntimeErr('integer MOD/MODULO by zero', line);
            const r = a.v % b.v;
            return intVal(name === 'mod' ? r : (r !== 0 && (r < 0) !== (b.v < 0) ? r + b.v : r), maxKind(a.kind, b.kind));
          }
          const x = asReal(a, line);
          const y = asReal(b, line);
          if (y === 0) throw new RuntimeErr('MOD/MODULO by zero', line);
          const r = x % y;
          const kind = a.k === 'real' && b.k === 'real'
            ? maxKind(a.kind, b.kind)
            : a.k === 'real' ? a.kind : b.k === 'real' ? b.kind : 8;
          return realVal(name === 'mod' ? r : (r !== 0 && (r < 0) !== (y < 0) ? r + y : r), kind);
        }, line);
      }
      case 'sign': {
        const b = pos[1]!;
        return this.mapBinary(first, b, (a, y) => {
          if (a.k === 'integer' && y.k === 'integer') {
            return intVal(y.v < 0 ? -Math.abs(a.v) : Math.abs(a.v), maxKind(a.kind, y.kind));
          }
          const x = asReal(a, line);
          const s = asReal(y, line);
          const kind = a.k === 'real' && y.k === 'real'
            ? maxKind(a.kind, y.kind)
            : a.k === 'real' ? a.kind : y.k === 'real' ? y.kind : 8;
          return realVal(s < 0 ? -Math.abs(x) : Math.abs(x), kind);
        }, line);
      }
      case 'floor': case 'ceiling': case 'nint': case 'int': {
        const resultKind = kindArg === undefined ? 4 : asInt(this.scalarOf(kindArg, line), line);
        return this.mapValue(first, (e) => {
          const x = asReal(e, line);
          if (name === 'floor') return intVal(Math.floor(x), resultKind);
          if (name === 'ceiling') return intVal(Math.ceil(x), resultKind);
          if (name === 'nint') return intVal(Math.sign(x) * Math.floor(Math.abs(x) + 0.5), resultKind);
          return intVal(Math.trunc(x), resultKind);
        }, line);
      }
      case 'aint': case 'anint': {
        const resultKind = kindArg === undefined ? (first.k === 'real' ? first.kind : 4) : asInt(this.scalarOf(kindArg, line), line);
        return this.mapValue(first, (e) => {
          const x = asReal(e, line);
          if (name === 'aint') return realVal(Math.trunc(x), resultKind);
          return realVal(Math.sign(x) * Math.floor(Math.abs(x) + 0.5), resultKind);
        }, line);
      }
      case 'real': case 'dble': {
        const kind = name === 'dble'
          ? 8
          : kindArg === undefined
            ? (first.k === 'real' || first.k === 'complex' ? first.kind : 4)
            : asInt(this.scalarOf(kindArg, line), line);
        return this.mapValue(first, (e) => {
          if (e.k === 'complex') return realVal(e.re, kind);
          return realVal(asReal(e, line), kind);
        }, line);
      }
      case 'cmplx': {
        const im = pos[1] === undefined ? intVal(0) : pos[1]!;
        const kindValue = kw.get('kind') ?? pos[2];
        const kind = kindValue === undefined ? 4 : asInt(this.scalarOf(kindValue, line), line);
        return this.mapBinary(first, im, (a, b) => complexVal(asReal(a, line), asReal(b, line), kind), line);
      }
      case 'aimag':
        return this.mapValue(first, (e) => realVal(asComplex(e, line).im, e.k === 'complex' ? e.kind : 4), line);
      case 'conjg':
        return this.mapValue(first, (e) => {
          const c = asComplex(e, line);
          return complexVal(c.re, -c.im, e.k === 'complex' ? e.kind : 4);
        }, line);
      case 'max': case 'min': {
        let acc = first;
        for (let i = 1; i < pos.length; i++) {
          acc = this.mapBinary(acc, pos[i]!, (a, b) => {
            const takeB = name === 'max'
              ? this.compareScalar('>', b, a, line)
              : this.compareScalar('<', b, a, line);
            return copyElem(takeB ? b : a);
          }, line);
        }
        return acc;
      }
      case 'dim':
        return this.mapBinary(first, pos[1]!, (a, b) => {
          if (a.k === 'integer' && b.k === 'integer') {
            return intVal(Math.max(a.v - b.v, 0), maxKind(a.kind, b.kind));
          }
          const d = asReal(a, line) - asReal(b, line);
          const kind = a.k === 'real' && b.k === 'real'
            ? maxKind(a.kind, b.kind)
            : a.k === 'real' ? a.kind : b.k === 'real' ? b.kind : 8;
          return realVal(Math.max(d, 0), kind);
        }, line);
      case 'merge': {
        const fsource = pos[1]!;
        const mask = pos[2]!;
        return this.mapTernary(first, fsource, mask, (t, f, m) => (asLogical(m, line) ? copyElem(t) : copyElem(f)), line);
      }
      case 'huge': case 'tiny': case 'epsilon': {
        const type = this.typeOfValue(first);
        if (name === 'huge') {
          // INTEGER(8) lives in a JS number, so HUGE reports the largest
          // exactly representable integer rather than a rounded 2^63-1.
          if (type.base === 'integer') return intVal(type.kind === 8 ? Number.MAX_SAFE_INTEGER : 2 ** (type.kind * 8 - 1) - 1, type.kind);
          return realVal(type.kind === 4 ? 3.4028234663852886e38 : Number.MAX_VALUE, type.kind);
        }
        if (type.base === 'integer') {
          throw new RuntimeErr(`${name.toUpperCase()} expects a REAL or COMPLEX argument`, line);
        }
        if (name === 'tiny') {
          return realVal(type.kind === 4 ? 1.1754943508222875e-38 : 2.2250738585072014e-308, type.kind);
        }
        return realVal(type.kind === 4 ? 1.1920928955078125e-7 : 2.220446049250313e-16, type.kind);
      }
      case 'precision': {
        const t = this.typeOfValue(first);
        if (t.base === 'integer') throw new RuntimeErr('PRECISION expects a REAL or COMPLEX argument', line);
        return intVal(t.kind === 4 ? 6 : 15);
      }
      case 'range': {
        const t = this.typeOfValue(first);
        if (t.base === 'integer') {
          return intVal(t.kind === 1 ? 2 : t.kind === 2 ? 4 : t.kind === 4 ? 9 : 18);
        }
        return intVal(t.kind === 4 ? 37 : 307);
      }
      case 'digits': {
        const t = this.typeOfValue(first);
        if (t.base === 'integer') return intVal(t.kind * 8 - 1);
        return intVal(t.kind === 4 ? 24 : 53);
      }
      case 'radix': return intVal(2);
      case 'len': {
        if (first.k === 'character') return intVal(first.v.length);
        throw new RuntimeErr('LEN expects CHARACTER', line);
      }
      case 'len_trim': {
        const s = asString(this.scalarOf(first, line), line);
        return intVal(s.replace(/ +$/, '').length);
      }
      case 'trim': {
        const s = asString(this.scalarOf(first, line), line);
        return charVal(s.replace(/ +$/, ''));
      }
      case 'adjustl': {
        const s = asString(this.scalarOf(first, line), line);
        const t = s.replace(/^ +/, '');
        return charVal(t + ' '.repeat(s.length - t.length));
      }
      case 'adjustr': {
        const s = asString(this.scalarOf(first, line), line);
        const t = s.replace(/ +$/, '');
        return charVal(' '.repeat(s.length - t.length) + t);
      }
      case 'repeat': {
        const s = asString(this.scalarOf(first, line), line);
        const n = this.intBound(asInt(this.scalarOf(pos[1]!, line), line), line, 'REPEAT count');
        const total = Math.max(0, n) * s.length;
        if (total > MAX_CHAR_LEN) {
          throw new RuntimeErr(`REPEAT would create ${total.toLocaleString('en-US')} characters — the teaching limit is ${MAX_CHAR_LEN.toLocaleString('en-US')}`, line);
        }
        return charVal(s.repeat(Math.max(0, n)));
      }
      case 'index': case 'scan': case 'verify': {
        const s = asString(this.scalarOf(first, line), line);
        const set = asString(this.scalarOf(pos[1]!, line), line);
        const back = pos[2] !== undefined || kw.has('back')
          ? asLogical(this.scalarOf((kw.get('back') ?? pos[2])!, line), line)
          : false;
        let at = -1;
        if (name === 'index') {
          at = back ? s.lastIndexOf(set) : s.indexOf(set);
        } else {
          const indices = [...s].map((c, i) => (name === 'scan' ? set.includes(c) : !set.includes(c)) ? i : -1).filter((i) => i >= 0);
          at = back ? (indices.at(-1) ?? -1) : (indices[0] ?? -1);
        }
        return intVal(at + 1);
      }
      case 'char': case 'achar':
        return this.mapValue(first, (e) => charVal(String.fromCharCode(asInt(e, line))), line);
      case 'ichar': case 'iachar':
        return this.mapValue(first, (e) => intVal(asString(e, line).charCodeAt(0) || 0), line);
      case 'iand': case 'ior': case 'ieor': {
        const b = pos[1]!;
        return this.mapBinary(first, b, (a, y) => {
          const x = asInt(a, line);
          const z = asInt(y, line);
          const kind = maxKind(a.k === 'integer' ? a.kind : 4, y.k === 'integer' ? y.kind : 4);
          if (kind === 8) {
            const bx = BigInt(x);
            const bz = BigInt(z);
            const r = name === 'iand' ? bx & bz : name === 'ior' ? bx | bz : bx ^ bz;
            return intVal(Number(BigInt.asIntN(64, r)), 8);
          }
          const ux = x >>> 0;
          const uz = z >>> 0;
          return intVal(name === 'iand' ? ux & uz : name === 'ior' ? ux | uz : ux ^ uz, kind);
        }, line);
      }
      case 'not':
        return this.mapValue(first, (e) => {
          const x = asInt(e, line);
          const kind = e.k === 'integer' ? e.kind : 4;
          if (kind === 8) return intVal(Number(BigInt.asIntN(64, ~BigInt(x))), 8);
          return intVal(~x, kind);
        }, line);
      case 'ishft': {
        const shift = this.dimArg(this.scalarOf(pos[1]!, line), line);
        return this.mapValue(first, (e) => {
          const kind = e.k === 'integer' ? e.kind : 4;
          const bits = kind * 8;
          if (shift >= bits || shift <= -bits) return intVal(0, kind);
          const x = asInt(e, line);
          if (kind === 8) {
            const b = BigInt(x);
            const r = shift >= 0 ? b << BigInt(shift) : b >> BigInt(-shift);
            return intVal(Number(BigInt.asIntN(64, r)), 8);
          }
          return intVal(shift >= 0 ? x << shift : x >>> -shift, kind);
        }, line);
      }
      case 'btest': {
        const posn = asInt(this.scalarOf(pos[1]!, line), line);
        return this.mapValue(first, (e) => logicalVal(((asInt(e, line) >>> posn) & 1) === 1), line);
      }
      case 'ibits': {
        const posn = asInt(this.scalarOf(pos[1]!, line), line);
        const len = asInt(this.scalarOf(pos[2]!, line), line);
        return this.mapValue(first, (e) => intVal((asInt(e, line) >>> posn) & ((1 << len) - 1), 4), line);
      }
      case 'ibset': {
        const posn = asInt(this.scalarOf(pos[1]!, line), line);
        return this.mapValue(first, (e) => intVal(asInt(e, line) | (1 << posn), 4), line);
      }
      case 'ibclr': {
        const posn = asInt(this.scalarOf(pos[1]!, line), line);
        return this.mapValue(first, (e) => intVal(asInt(e, line) & ~(1 << posn), 4), line);
      }
      case 'size': {
        const arr = this.requireArray(first, line, 'SIZE');
        if (kw.has('dim') || pos[1] !== undefined) {
          const dim = this.dimArg(this.scalarOf(kw.get('dim') ?? pos[1]!, line), line);
          return intVal(extent(this.dimOf(arr, dim, line)), line);
        }
        return intVal(arr.data.length);
      }
      case 'shape': {
        const arr = this.requireArray(first, line, 'SHAPE');
        return makeArray('integer', [{ lo: 1, hi: arr.dims.length }],
          arr.dims.map((d) => intVal(extent(d))), { kind: 4 });
      }
      case 'lbound': case 'ubound': {
        const arr = this.requireArray(first, line, name.toUpperCase());
        if (pos[1] !== undefined || kw.has('dim')) {
          const dim = this.dimArg(this.scalarOf(kw.get('dim') ?? pos[1]!, line), line);
          const d = this.dimOf(arr, dim, line);
          return intVal(name === 'lbound' ? d.lo : d.hi);
        }
        return makeArray('integer', [{ lo: 1, hi: arr.dims.length }],
          arr.dims.map((d) => intVal(name === 'lbound' ? d.lo : d.hi)), { kind: 4 });
      }
      case 'rank': return intVal(rankOf(first));
      case 'sum': case 'product': case 'maxval': case 'minval': case 'count': case 'any': case 'all':
        return this.reduce(name, first, kw.get('dim') ?? pos[1], kw.get('mask') ?? pos[2], line);
      case 'maxloc': case 'minloc':
        return this.locate(
          name, first, kw.get('dim') ?? pos[1], kw.get('mask') ?? pos[2], line,
          kw.get('back') ?? pos[4],
        );
      case 'matmul': return this.matmul(first, pos[1]!, line);
      case 'norm2': {
        const arr = this.requireArray(first, line, 'NORM2');
        if (arr.base !== 'real') throw new RuntimeErr('NORM2 expects a REAL array', line);
        const squared = this.retype(arr, arr.data.map((e) => realVal(asReal(e, line) ** 2, arr.kind)));
        const sums = this.reduce('sum', squared, kw.get('dim') ?? pos[1], undefined, line);
        return this.mapValue(sums, (e) => realVal(Math.sqrt(asReal(e, line)), arr.kind), line);
      }
      case 'dot_product': return this.dotProduct(first, pos[1]!, line);
      case 'transpose': return this.transpose(first, line);
      case 'reshape':
        return this.reshape(first, pos[1]!, pos[2] ?? kw.get('pad'), line, pos[3] ?? kw.get('order'));
      case 'spread':
        return this.spread(first, pos[1] ?? kw.get('dim')!, pos[2] ?? kw.get('ncopies')!, line);
      case 'cshift': return this.cshift(first, pos[1]!, pos[2] ?? kw.get('dim'), line);
      case 'eoshift':
        return this.eoshift(first, pos[1]!, pos[2] ?? kw.get('boundary'), pos[3] ?? kw.get('dim'), line);
      case 'pack': return this.pack(first, pos[1]!, pos[2] ?? kw.get('vector'), line);
      case 'unpack': return this.unpack(first, pos[1]!, pos[2] ?? kw.get('field'), line);
      case 'selected_int_kind':
        throw new RuntimeErr('SELECTED_INT_KIND needs a radix argument', line);
      case 'selected_char_kind':
        throw new RuntimeErr('SELECTED_CHAR_KIND needs a kind argument', line);
      case 'new_line': return charVal('\n');
      case 'bit_size': {
        const t = this.typeOfValue(first);
        return intVal(t.kind * 8);
      }
      case 'this_image': return intVal(1);
      case 'num_images': return intVal(1);
      default:
        throw new RuntimeErr(`intrinsic '${name}' is not implemented`, line);
    }
  }

  private requireArray(v: Value, line: number, what: string): ArrayV {
    if (v.k !== 'array') throw new RuntimeErr(`${what} expects an array`, line);
    if (!v.allocated) throw new RuntimeErr(`${what} on an unallocated array`, line);
    return v;
  }

  private dimOf(arr: ArrayV, dim: number, line: number): Dim {
    if (dim < 1 || dim > arr.dims.length) {
      throw new RuntimeErr(`dimension ${dim} is out of range 1:${arr.dims.length}`, line);
    }
    return arr.dims[dim - 1]!;
  }

  private mapBinary(a: Value, b: Value, fn: (x: Elem, y: Elem) => Elem, line: number): Value {
    if (a.k !== 'array' && b.k !== 'array') return fn(a, b);
    const arr = a.k === 'array' ? a : b as ArrayV;
    if (a.k === 'array' && b.k === 'array' && !sameExtents(a, b)) {
      throw new RuntimeErr('array shapes do not conform', line);
    }
    const data = arr.data.map((_, i) => fn(a.k === 'array' ? a.data[i]! : a, b.k === 'array' ? b.data[i]! : b));
    return this.retype(arr, data);
  }

  private mapTernary(a: Value, b: Value, c: Value, fn: (x: Elem, y: Elem, z: Elem) => Elem, line: number): Value {
    const arrays = [a, b, c].filter((v) => v.k === 'array') as ArrayV[];
    if (arrays.length === 0) return fn(a as Elem, b as Elem, c as Elem);
    const arr = arrays[0]!;
    for (const other of arrays) {
      if (!sameExtents(arr, other)) throw new RuntimeErr('array shapes do not conform', line);
    }
    const data = arr.data.map((_, i) => fn(
      a.k === 'array' ? a.data[i]! : a,
      b.k === 'array' ? b.data[i]! : b,
      c.k === 'array' ? c.data[i]! : c,
    ));
    return this.retype(arr, data);
  }

  private reduce(
    name: string,
    value: Value,
    dimValue: Value | undefined,
    maskValue: Value | undefined,
    line: number,
  ): Value {
    const arr = this.requireArray(value, line, name.toUpperCase());
    const mask = maskValue === undefined ? null : this.maskOf(maskValue, line);
    if (mask !== null && mask.data !== null && !this.sameShape(mask.dims!, arr.dims)) {
      throw new RuntimeErr('reduction mask does not conform to the array', line);
    }
    const isLogicalResult = name === 'any' || name === 'all' || name === 'count';
    const combine = (acc: Elem | null, e: Elem): Elem => {
      if (name === 'sum') {
        if (acc === null) return copyElem(e);
        return this.arith('+', acc, e, line);
      }
      if (name === 'product') {
        if (acc === null) return copyElem(e);
        return this.arith('*', acc, e, line);
      }
      if (name === 'maxval' || name === 'minval') {
        if (acc === null) return copyElem(e);
        const take = name === 'maxval'
          ? this.compareScalar('>', e, acc, line)
          : this.compareScalar('<', e, acc, line);
        return copyElem(take ? e : acc);
      }
      if (name === 'count') {
        return intVal(asInt(acc ?? intVal(0), line) + (asLogical(e, line) ? 1 : 0));
      }
      if (name === 'any') return logicalVal(asLogical(acc ?? logicalVal(false), line) || asLogical(e, line));
      return logicalVal(asLogical(acc ?? logicalVal(true), line) && asLogical(e, line));
    };
    const initial = (): Elem => {
      if (name === 'sum') return defaultScalar(arr.base, arr.kind);
      if (name === 'product') {
        if (arr.base === 'integer') return intVal(1, arr.kind);
        if (arr.base === 'real') return realVal(1, arr.kind);
        if (arr.base === 'complex') return complexVal(1, 0, arr.kind);
        return intVal(1);
      }
      if (name === 'count') return intVal(0);
      if (name === 'any') return logicalVal(false);
      if (name === 'all') return logicalVal(true);
      return intVal(0);
    };
    const finish = (acc: Elem | null): Elem => {
      if (acc === null) {
        if (name === 'maxval') throw new RuntimeErr('MAXVAL of an empty array', line);
        if (name === 'minval') throw new RuntimeErr('MINVAL of an empty array', line);
        return initial();
      }
      return acc;
    };

    if (dimValue === undefined) {
      let acc: Elem | null = null;
      for (let i = 0; i < arr.data.length; i++) {
        if (!this.maskAllows(mask, i)) continue;
        acc = combine(acc, arr.data[i]!);
      }
      return finish(acc);
    }

    const dim = this.dimArg(this.scalarOf(dimValue, line), line);
    this.dimOf(arr, dim, line);
    const sourceReducedDims = arr.dims.filter((_, i) => i !== dim - 1);
    const resultDims = sourceReducedDims.map((d) => ({ lo: 1, hi: extent(d) }));
    const reducedSize = sourceReducedDims.reduce((n, d) => n * extent(d), 1);
    const data: Elem[] = [];
    const dimIndex = dim - 1;
    for (let out = 0; out < reducedSize; out++) {
      const reducedSubs = subsAt(sourceReducedDims, out);
      const full = [...reducedSubs];
      full.splice(dimIndex, 0, arr.dims[dimIndex]!.lo);
      let acc: Elem | null = null;
      const d = arr.dims[dimIndex]!;
      for (let k = d.lo; k <= d.hi; k++) {
        full[dimIndex] = k;
        const off = offsetOf(arr.dims, full);
        if (!this.maskAllows(mask, off)) continue;
        acc = combine(acc, arr.data[off]!);
      }
      data.push(finish(acc));
    }
    if (resultDims.length === 0) return data[0]!;
    const base: ScalarBase = isLogicalResult ? (name === 'count' ? 'integer' : 'logical') : arr.base;
    return makeArray(base, resultDims, data, {
      kind: base === 'integer' ? 4 : arr.kind,
    });
  }

  private locate(
    name: 'maxloc' | 'minloc',
    value: Value,
    dimValue: Value | undefined,
    maskValue: Value | undefined,
    line: number,
    backValue?: Value,
  ): Value {
    const arr = this.requireArray(value, line, name.toUpperCase());
    const mask = maskValue === undefined ? null : this.maskOf(maskValue, line);
    const back = backValue === undefined ? false : asLogical(this.scalarOf(backValue, line), line);
    if (mask !== null && mask.data !== null && !this.sameShape(mask.dims!, arr.dims)) {
      throw new RuntimeErr('mask does not conform to the array', line);
    }
    const better = (a: Elem, b: Elem): boolean => (name === 'maxloc'
      ? this.compareScalar('>', a, b, line)
      : this.compareScalar('<', a, b, line));
    const choose = (offsets: number[]): number | null => {
      let best: number | null = null;
      for (const off of offsets) {
        if (!this.maskAllows(mask, off)) continue;
        if (best === null || better(arr.data[off]!, arr.data[best]!)) best = off;
      }
      return best;
    };
    if (dimValue === undefined) {
      const all = Array.from({ length: arr.data.length }, (_, i) => i);
      if (back) all.reverse();
      const best = choose(all);
      if (best === null) throw new RuntimeErr(`${name.toUpperCase()} of an all-false mask`, line);
      const subs = subsAt(arr.dims, best);
      return makeArray('integer', [{ lo: 1, hi: subs.length }], subs.map((s) => intVal(s)), { kind: 4 });
    }
    const dim = this.dimArg(this.scalarOf(dimValue, line), line);
    this.dimOf(arr, dim, line);
    const sourceReducedDims = arr.dims.filter((_, i) => i !== dim - 1);
    const resultDims = sourceReducedDims.map((d) => ({ lo: 1, hi: extent(d) }));
    const reducedSize = sourceReducedDims.reduce((n, d) => n * extent(d), 1);
    const data: Elem[] = [];
    const dimIndex = dim - 1;
    const d = arr.dims[dimIndex]!;
    for (let out = 0; out < reducedSize; out++) {
      const reducedSubs = subsAt(sourceReducedDims, out);
      const full = [...reducedSubs];
      full.splice(dimIndex, 0, d.lo);
      const offsets: number[] = [];
      for (let k = d.lo; k <= d.hi; k++) {
        full[dimIndex] = k;
        offsets.push(offsetOf(arr.dims, full));
      }
      if (back) offsets.reverse();
      const best = choose(offsets);
      if (best === null) throw new RuntimeErr(`${name.toUpperCase()} of an all-false mask`, line);
      const at = offsets.indexOf(best);
      data.push(intVal(back ? d.hi - at : d.lo + at));
    }
    if (resultDims.length === 0) return data[0]!;
    return makeArray('integer', resultDims, data, { kind: 4 });
  }

  private matmul(a: Value, b: Value, line: number): Value {
    const x = this.requireArray(a, line, 'MATMUL');
    const y = this.requireArray(b, line, 'MATMUL');
    const numeric = (arr: ArrayV): void => {
      if (arr.base === 'logical' || arr.base === 'character' || arr.base === 'derived') {
        throw new RuntimeErr('MATMUL expects numeric arrays', line);
      }
    };
    numeric(x);
    numeric(y);
    const mulAdd = (p: Elem, q: Elem, acc: Elem | null): Elem => {
      const prod = this.arith('*', p, q, line);
      return acc === null ? prod : this.arith('+', acc, prod, line);
    };
    if (x.dims.length === 2 && y.dims.length === 2) {
      const rows = extent(x.dims[0]!);
      const inner = extent(x.dims[1]!);
      if (inner !== extent(y.dims[0]!)) throw new RuntimeErr('MATMUL inner dimensions do not match', line);
      const cols = extent(y.dims[1]!);
      if (rows * cols > MAX_ELEMENTS) {
        throw new RuntimeErr(`MATMUL result has ${rows * cols} elements — the teaching limit is ${MAX_ELEMENTS.toLocaleString('en-US')}`, line);
      }
      const dims = [{ lo: 1, hi: rows }, { lo: 1, hi: cols }];
      const resultKind = maxKind(x.kind, y.kind);
      const data: Elem[] = [];
      for (let j = 0; j < cols; j++) {
        for (let i = 0; i < rows; i++) {
          let acc: Elem | null = null;
          for (let k = 0; k < inner; k++) {
            acc = mulAdd(x.data[i + k * rows]!, y.data[k + j * inner]!, acc);
          }
          data.push(acc ?? defaultScalar(x.base, resultKind));
        }
      }
      return this.retype(makeArray(x.base, dims, data, { kind: maxKind(x.kind, y.kind) }), data);
    }
    if (x.dims.length === 2 && y.dims.length === 1) {
      const rows = extent(x.dims[0]!);
      const inner = extent(x.dims[1]!);
      if (inner !== y.data.length) throw new RuntimeErr('MATMUL inner dimensions do not match', line);
      const data: Elem[] = [];
      const resultKind = maxKind(x.kind, y.kind);
      for (let i = 0; i < rows; i++) {
        let acc: Elem | null = null;
        for (let k = 0; k < inner; k++) acc = mulAdd(x.data[i + k * rows]!, y.data[k]!, acc);
        data.push(acc ?? defaultScalar(x.base, resultKind));
      }
      return this.retype(makeArray(x.base, [{ lo: 1, hi: rows }], data, { kind: resultKind }), data);
    }
    if (x.dims.length === 1 && y.dims.length === 2) {
      const inner = x.data.length;
      const cols = extent(y.dims[1]!);
      if (inner !== extent(y.dims[0]!)) throw new RuntimeErr('MATMUL inner dimensions do not match', line);
      const data: Elem[] = [];
      const resultKind = maxKind(x.kind, y.kind);
      for (let j = 0; j < cols; j++) {
        let acc: Elem | null = null;
        for (let k = 0; k < inner; k++) acc = mulAdd(x.data[k]!, y.data[k + j * inner]!, acc);
        data.push(acc ?? defaultScalar(x.base, resultKind));
      }
      return this.retype(makeArray(x.base, [{ lo: 1, hi: cols }], data, { kind: resultKind }), data);
    }
    throw new RuntimeErr('MATMUL needs rank 1 or 2 arrays', line);
  }

  private dotProduct(a: Value, b: Value, line: number): Value {
    const x = this.requireArray(a, line, 'DOT_PRODUCT');
    const y = this.requireArray(b, line, 'DOT_PRODUCT');
    if (x.dims.length !== 1 || y.dims.length !== 1) throw new RuntimeErr('DOT_PRODUCT needs rank-1 arrays', line);
    if (x.data.length !== y.data.length) throw new RuntimeErr('DOT_PRODUCT lengths do not match', line);
    let acc: Elem | null = null;
    for (let i = 0; i < x.data.length; i++) {
      const left = x.data[i]!;
      const conj = left.k === 'complex' ? complexVal(left.re, -left.im, left.kind) : left;
      const prod = this.arith('*', conj, y.data[i]!, line);
      acc = acc === null ? prod : this.arith('+', acc, prod, line);
    }
    return acc ?? intVal(0);
  }

  private transpose(a: Value, line: number): Value {
    const x = this.requireArray(a, line, 'TRANSPOSE');
    if (x.dims.length !== 2) throw new RuntimeErr('TRANSPOSE needs a rank-2 array', line);
    const rows = extent(x.dims[0]!);
    const cols = extent(x.dims[1]!);
    const data: Elem[] = [];
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) data.push(copyElem(x.data[i + j * rows]!));
    }
    return makeArray(x.base, [{ lo: 1, hi: cols }, { lo: 1, hi: rows }], data, {
      kind: x.kind, typeName: x.typeName, charLen: x.charLen,
    });
  }

  private reshape(source: Value, shapeValue: Value, pad: Value | undefined, line: number, orderValue?: Value): Value {
    const src = this.requireArray(source, line, 'RESHAPE');
    const shapeArr = this.requireArray(shapeValue, line, 'RESHAPE');
    const dims = shapeArr.data.map((e) => {
      const n = this.dimArg(e, line);
      if (n < 0) throw new RuntimeErr('RESHAPE dimensions must be non-negative', line);
      return { lo: 1, hi: n };
    });
    const total = dims.reduce((n, d) => n * extent(d), 1);
    if (!Number.isSafeInteger(total) || total > MAX_ELEMENTS) {
      throw new RuntimeErr(`RESHAPE would create ${total} elements — the teaching limit is ${MAX_ELEMENTS.toLocaleString('en-US')}`, line);
    }
    let order: number[] | null = null;
    if (orderValue !== undefined) {
      const orderArr = this.requireArray(orderValue, line, 'RESHAPE');
      if (orderArr.dims.length !== 1 || orderArr.data.length !== dims.length) {
        throw new RuntimeErr('RESHAPE ORDER must have one entry per dimension', line);
      }
      order = orderArr.data.map((e) => this.dimArg(e, line));
      const sorted = [...order].sort((a, b) => a - b);
      if (sorted.some((v, i) => v !== i + 1)) {
        throw new RuntimeErr('RESHAPE ORDER must be a permutation of the dimensions', line);
      }
    }
    const padElems = pad === undefined ? [] : pad.k === 'array' ? pad.data : [pad];
    if (padElems.length === 0 && total > src.data.length) {
      throw new RuntimeErr('RESHAPE source is shorter than the requested shape and has no PAD', line);
    }
    const data: Elem[] = new Array(total);
    const fillType: ResolvedType = {
      base: src.base, kind: src.kind, charLen: src.charLen, typeName: src.typeName,
    };
    for (let i = 0; i < total; i++) {
      const subs = order === null ? subsAt(dims, i) : this.subsForOrder(dims, i, order);
      const at = offsetOf(dims, subs);
      if (i < src.data.length) data[at] = copyElem(src.data[i]!);
      else {
        const padValue = padElems[(i - src.data.length) % padElems.length]!;
        data[at] = this.coerceElem(padValue, fillType, line);
      }
    }
    return makeArray(src.base, dims, data, { kind: src.kind, typeName: src.typeName, charLen: src.charLen });
  }

  private subsForOrder(dims: Dim[], flat: number, order: number[]): number[] {
    const subs = dims.map((d) => d.lo);
    let rem = flat;
    for (const d of order) {
      const idx = d - 1;
      const len = extent(dims[idx]!);
      subs[idx] = dims[idx]!.lo + (len === 0 ? 0 : rem % len);
      rem = len === 0 ? 0 : Math.floor(rem / len);
    }
    return subs;
  }

  private spread(source: Value, dimValue: Value, copiesValue: Value, line: number): Value {
    const src = this.requireArray(source, line, 'SPREAD');
    const dim = this.dimArg(this.scalarOf(dimValue, line), line);
    const copies = this.dimArg(this.scalarOf(copiesValue, line), line);
    if (dim < 1 || dim > src.dims.length + 1) {
      throw new RuntimeErr(`SPREAD dimension ${dim} is out of range`, line);
    }
    if (copies < 0) throw new RuntimeErr('SPREAD copies must be non-negative', line);
    const dims = [...src.dims];
    dims.splice(dim - 1, 0, { lo: 1, hi: copies });
    const total = dims.reduce((n, d) => n * extent(d), 1);
    if (total > MAX_ELEMENTS) {
      throw new RuntimeErr(`SPREAD would create ${total} elements — the teaching limit is ${MAX_ELEMENTS.toLocaleString('en-US')}`, line);
    }
    const data: Elem[] = [];
    for (let out = 0; out < total; out++) {
      const subs = subsAt(dims, out);
      const sourceSubs = [...subs];
      sourceSubs.splice(dim - 1, 1);
      data.push(copyElem(src.data[offsetOf(src.dims, sourceSubs)]!));
    }
    return makeArray(src.base, dims, data, { kind: src.kind, typeName: src.typeName, charLen: src.charLen });
  }

  private cshift(value: Value, shiftValue: Value, dimValue: Value | undefined, line: number): Value {
    const src = this.requireArray(value, line, 'CSHIFT');
    const shift = asInt(this.scalarOf(shiftValue, line), line);
    const dim = dimValue === undefined ? 1 : this.dimArg(this.scalarOf(dimValue, line), line);
    const d = this.dimOf(src, dim, line);
    const n = extent(d);
    if (n === 0) {
      return makeArray(src.base, src.dims.map((x) => ({ ...x })), src.data.map(copyElem), {
        kind: src.kind, typeName: src.typeName, charLen: src.charLen,
      });
    }
    const dimIndex = dim - 1;
    const data: Elem[] = new Array(src.data.length);
    for (let out = 0; out < src.data.length; out++) {
      const subs = subsAt(src.dims, out);
      const s = subs[dimIndex]!;
      const shifted = d.lo + (((s - d.lo + shift) % n) + n) % n;
      const from = [...subs];
      from[dimIndex] = shifted;
      data[out] = copyElem(src.data[offsetOf(src.dims, from)]!);
    }
    return makeArray(src.base, src.dims.map((x) => ({ ...x })), data, {
      kind: src.kind, typeName: src.typeName, charLen: src.charLen,
    });
  }

  private eoshift(
    value: Value,
    shiftValue: Value,
    boundary: Value | undefined,
    dimValue: Value | undefined,
    line: number,
  ): Value {
    const src = this.requireArray(value, line, 'EOSHIFT');
    const shift = asInt(this.scalarOf(shiftValue, line), line);
    const dim = dimValue === undefined ? 1 : this.dimArg(this.scalarOf(dimValue, line), line);
    const d = this.dimOf(src, dim, line);
    const dimIndex = dim - 1;
    const otherDims = src.dims.filter((_, i) => i !== dimIndex);
    const elemType: ResolvedType = {
      base: src.base, kind: src.kind, charLen: src.charLen, typeName: src.typeName,
    };
    let boundaryArr: ArrayV | null = null;
    let boundaryScalar: Elem | null = null;
    if (boundary !== undefined) {
      if (boundary.k === 'array') {
        if (otherDims.length === 0) {
          throw new RuntimeErr('EOSHIFT boundary must be scalar for a rank-1 array', line);
        }
        if (!this.sameShape(boundary.dims, otherDims)) {
          throw new RuntimeErr('EOSHIFT boundary does not conform to the array slice', line);
        }
        boundaryArr = boundary;
      } else {
        boundaryScalar = this.coerceElem(boundary, elemType, line);
      }
    } else if (src.base === 'derived') {
      throw new RuntimeErr('EOSHIFT of a derived-type array needs an explicit boundary', line);
    } else {
      boundaryScalar = defaultScalar(src.base, src.kind, src.charLen);
    }
    const data: Elem[] = new Array(src.data.length);
    for (let out = 0; out < src.data.length; out++) {
      const subs = subsAt(src.dims, out);
      const s = subs[dimIndex]!;
      const from = s + shift;
      if (from < d.lo || from > d.hi) {
        if (boundaryArr !== null) {
          const otherSubs = subs.filter((_, i) => i !== dimIndex);
          const bsubs = otherSubs.map((v, i) => boundaryArr!.dims[i]!.lo + (v - otherDims[i]!.lo));
          data[out] = copyElem(boundaryArr.data[offsetOf(boundaryArr.dims, bsubs)]!);
        } else {
          data[out] = copyElem(boundaryScalar!);
        }
      } else {
        const fromSubs = [...subs];
        fromSubs[dimIndex] = from;
        data[out] = copyElem(src.data[offsetOf(src.dims, fromSubs)]!);
      }
    }
    return makeArray(src.base, src.dims.map((x) => ({ ...x })), data, {
      kind: src.kind, typeName: src.typeName, charLen: src.charLen,
    });
  }

  private unpack(vectorValue: Value, maskValue: Value, field: Value, line: number): Value {
    const vec = this.requireArray(vectorValue, line, 'UNPACK');
    if (vec.dims.length !== 1) throw new RuntimeErr('UNPACK vector must be rank 1', line);
    const mask = this.maskOf(maskValue, line);
    const maskDims = mask.dims;
    const bits = mask.data;
    if (maskDims === null || bits === null) throw new RuntimeErr('UNPACK mask must be an array', line);
    if (field.k === 'array' && !this.sameShape(field.dims, maskDims)) {
      throw new RuntimeErr('UNPACK field does not conform to the mask', line);
    }
    const elemType: ResolvedType = {
      base: vec.base, kind: vec.kind, charLen: vec.charLen, typeName: vec.typeName,
    };
    let vi = 0;
    const data: Elem[] = [];
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]!) {
        if (vi >= vec.data.length) throw new RuntimeErr('UNPACK vector is too short', line);
        data.push(copyElem(vec.data[vi++]!));
      } else if (field.k === 'array') {
        data.push(this.coerceElem(field.data[i]!, elemType, line));
      } else {
        data.push(this.coerceElem(field, elemType, line));
      }
    }
    return makeArray(vec.base, maskDims.map((x) => ({ ...x })), data, {
      kind: vec.kind, typeName: vec.typeName, charLen: vec.charLen,
    });
  }

  private pack(arrayValue: Value, maskValue: Value, vector: Value | undefined, line: number): Value {
    const src = this.requireArray(arrayValue, line, 'PACK');
    const mask = this.requireArray(maskValue, line, 'PACK');
    if (!this.sameShape(mask.dims, src.dims)) throw new RuntimeErr('PACK mask does not conform', line);
    const picked: Elem[] = [];
    for (let i = 0; i < src.data.length; i++) {
      if (asLogical(mask.data[i]!, line)) picked.push(copyElem(src.data[i]!));
    }
    if (vector !== undefined) {
      const vec = this.requireArray(vector, line, 'PACK');
      if (picked.length > vec.data.length) throw new RuntimeErr('PACK vector is too short', line);
      const data = picked.concat(vec.data.slice(picked.length).map(copyElem));
      return makeArray(vec.base, [{ lo: 1, hi: data.length }], data, { kind: vec.kind, charLen: vec.charLen });
    }
    return makeArray(src.base, [{ lo: 1, hi: picked.length }], picked, {
      kind: src.kind, typeName: src.typeName, charLen: src.charLen,
    });
  }

  // ─── intrinsic subroutines ───────────────────────────────────────────

  private callIntrinsicSub(name: string, actuals: Actual[], scope: Scope, line: number): void {
    if (name === 'random_seed') {
      let seeded = false;
      for (const a of actuals) {
        if (a.expr === undefined) continue;
        if (a.name === 'put') {
          const value = this.evalExpr(a.expr, scope);
          const arr = this.requireArray(value, line, 'RANDOM_SEED');
          let state = 0x9e3779b9;
          for (const e of arr.data) state = (state * 1664525 + asInt(e, line) + 1013904223) >>> 0;
          this.shared.rng = state || 0x9e3779b9;
          seeded = true;
        } else if (a.name === 'size') {
          this.refForExpr(a.expr, scope, line).set(intVal(1), line);
        } else if (a.name === 'get') {
          const ref = this.refForExpr(a.expr, scope, line);
          const value = ref.get();
          if (value.k === 'array') {
            for (let i = 0; i < value.data.length; i++) value.data[i] = intVal(this.shared.rng);
            ref.set(value, line);
          } else {
            ref.set(intVal(this.shared.rng), line);
          }
        }
      }
      if (!seeded && actuals.length === 0) this.shared.rng = 0x9e3779b9;
      return;
    }
    if (name === 'random_number') {
      const arg = actuals[0];
      if (arg?.expr === undefined) throw new RuntimeErr('RANDOM_NUMBER needs one argument', line);
      const ref = this.refForExpr(arg.expr, scope, line);
      const value = ref.get();
      if (value.k === 'array') {
        if (value.base !== 'real') throw new RuntimeErr('RANDOM_NUMBER needs a REAL array', line);
        for (let i = 0; i < value.data.length; i++) value.data[i] = realVal(this.nextRandom(), value.kind);
        ref.set(value, line);
      } else if (value.k === 'real') {
        ref.set(realVal(this.nextRandom(), value.kind), line);
      } else {
        throw new RuntimeErr('RANDOM_NUMBER needs a REAL variable', line);
      }
      return;
    }
    if (name === 'cpu_time') {
      const arg = actuals[0];
      if (arg?.expr === undefined) throw new RuntimeErr('CPU_TIME needs one argument', line);
      const ref = this.refForExpr(arg.expr, scope, line);
      ref.set(realVal(performance.now() / 1000, 8), line);
      return;
    }
    if (name === 'system_clock') {
      let position = 0;
      for (const a of actuals) {
        if (a.expr === undefined) continue;
        const which = a.name ?? ['count', 'count_rate', 'count_max'][position++] ?? 'count';
        if (which !== 'count' && which !== 'count_rate' && which !== 'count_max') {
          throw new RuntimeErr(`unknown SYSTEM_CLOCK argument '${which}'`, line);
        }
        const ref = this.refForExpr(a.expr, scope, line);
        const target = ref.get();
        const kind = target.k === 'integer' ? target.kind : 4;
        if (which === 'count_rate') ref.set(intVal(1000, kind), line);
        else if (which === 'count_max') {
          const max = kind === 8 ? Number.MAX_SAFE_INTEGER : 2 ** (kind * 8 - 1) - 1;
          ref.set(intVal(max, kind), line);
        } else ref.set(intVal(Math.floor(performance.now()), kind), line);
      }
      return;
    }
    throw new RuntimeErr(`intrinsic subroutine '${name}' is not implemented`, line);
  }

  private nextRandom(): number {
    let x = this.shared.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.shared.rng = x >>> 0;
    return (this.shared.rng >>> 0) / 0x100000000;
  }

  // ─── display helpers for the panels ──────────────────────────────────

  workspaceEntries(): { name: string; value: Value; info: VarInfo }[] {
    const out: { name: string; value: Value; info: VarInfo }[] = [];
    for (const [name, cell] of this.mainScope.vars) {
      const info = this.mainScope.infos.get(name);
      if (info === undefined) continue;
      out.push({ name, value: cell.value, info });
    }
    return out;
  }

  /** Find a live variable by name across the active frames, the main
   *  program and the modules — the Arrays panel follows a write into a
   *  procedure's local array too. */
  valueByName(name: string): Value | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const cell = this.frames[i]!.scope.vars.get(name);
      if (cell !== undefined) return cell.value;
    }
    const main = this.lookup(this.mainScope, name);
    if (main !== undefined) return main.value;
    for (const state of this.shared.modules.values()) {
      const cell = state.scope.vars.get(name);
      if (cell !== undefined) return cell.value;
    }
    return undefined;
  }

  moduleEntries(): { module: string; name: string; value: Value }[] {
    const out: { module: string; name: string; value: Value }[] = [];
    for (const [name, state] of this.shared.modules) {
      if (!state.ready) continue;
      for (const [varName, cell] of state.scope.vars) {
        out.push({ module: name, name: varName, value: cell.value });
      }
    }
    return out;
  }
}

const INTRINSICS: Record<string, true> = {
  abs: true, sqrt: true, exp: true, log: true, log10: true, sin: true, cos: true,
  tan: true, asin: true, acos: true, atan: true, atan2: true, sinh: true,
  cosh: true, tanh: true, mod: true, modulo: true, sign: true, floor: true,
  ceiling: true, nint: true, int: true, aint: true, anint: true, real: true,
  dble: true, cmplx: true, aimag: true, conjg: true, max: true, min: true,
  dim: true, merge: true, huge: true, tiny: true, epsilon: true,
  precision: true, range: true, digits: true, radix: true, len: true,
  len_trim: true, trim: true, adjustl: true, adjustr: true, repeat: true,
  index: true, scan: true, verify: true, char: true, achar: true, ichar: true,
  iachar: true, iand: true, ior: true, ieor: true, not: true, ishft: true,
  btest: true, ibits: true, ibset: true, ibclr: true, size: true, shape: true,
  lbound: true, ubound: true, rank: true, sum: true, product: true,
  maxval: true, minval: true, count: true, any: true, all: true,
  maxloc: true, minloc: true, matmul: true, dot_product: true, norm2: true,
  transpose: true, reshape: true, spread: true, cshift: true, eoshift: true,
  pack: true, unpack: true,
  allocated: true, kind: true, present: true, this_image: true,
  num_images: true, selected_real_kind: true, selected_int_kind: true,
  selected_char_kind: true, new_line: true, bit_size: true,
};

const INTRINSIC_SUBS: Record<string, true> = {
  random_number: true, random_seed: true, cpu_time: true, system_clock: true,
};
