// interp.ts — the row-at-a-time execution engine. Every step() performs ONE
// row operation: scan a row, probe a join pair, filter a row, fold a row
// into a group, compare in a sort, or emit a row. The Plan panel is the
// operator pipeline with live counters; the engine never loops without
// ticking the budget (100 000 row operations, then a clean line-mapped error).

import { exprText, type ColRef, type ColumnDef, type Expr, type Stmt } from './parser';
import {
  FALSE, NULL, SqlError, TRUE, compare3, likeMatch, orderCompare,
  renderTable, typeName, type Bool3, type SqlValue,
} from './values';

export const ROW_OP_BUDGET = 100_000;

// ─── tables ────────────────────────────────────────────────────────────────

export interface Table {
  name: string;                  // spelling from CREATE TABLE
  cols: ColumnDef[];
  rows: SqlValue[][];
}

export class Database {
  /** Keyed by lowercased name (identifiers match case-insensitively). */
  readonly tables = new Map<string, Table>();

  create(name: string, cols: ColumnDef[]): Table {
    const t: Table = { name, cols, rows: [] };
    this.tables.set(name.toLowerCase(), t);
    return t;
  }

  get(name: string): Table | undefined {
    return this.tables.get(name.toLowerCase());
  }
}

// ─── schema resolution ─────────────────────────────────────────────────────

export interface SchemaCol {
  table: string;                 // owning table's spelling
  name: string;                  // column spelling from CREATE TABLE
  type: 'INTEGER' | 'TEXT';
  display: string;               // Current-row key: bare, qualified in joins
}

export function buildSchema(outer: Table, inner: Table | undefined): SchemaCol[] {
  const qualify = inner !== undefined;
  const cols: SchemaCol[] = [];
  for (const t of [outer, inner]) {
    if (t === undefined) continue;
    for (const c of t.cols) {
      cols.push({ table: t.name, name: c.name, type: c.type, display: qualify ? `${t.name}.${c.name}` : c.name });
    }
  }
  return cols;
}

/** Resolve a (possibly qualified) column reference to a schema index. */
export function resolveCol(ref: ColRef, schema: SchemaCol[]): number {
  const hits = schema.filter(
    (c) => c.name.toLowerCase() === ref.name.toLowerCase()
      && (ref.table === undefined || c.table.toLowerCase() === ref.table.toLowerCase()),
  );
  if (hits.length === 1) return schema.indexOf(hits[0]!);
  if (hits.length > 1) {
    const both = [...new Set(hits.map((c) => c.table))];
    throw new SqlError(ref.line, `ambiguous column '${ref.name}' — write ${both.map((t) => `${t}.${ref.name}`).join(' or ')}`);
  }
  const scope = [...new Set(schema.map((c) => c.table))].join(', ');
  throw new SqlError(ref.line, `unknown column '${ref.table === undefined ? ref.name : `${ref.table}.${ref.name}`}' (columns in scope: ${schema.map((c) => c.display).join(', ')}) — FROM ${scope}`);
}

export type ColExpr = Extract<Expr, { t: 'col' }>;
export type AggExpr = Extract<Expr, { t: 'agg' }>;

export interface EvalCtx {
  /** Value of a resolved column reference for the current row/group. */
  col(e: ColExpr): SqlValue;
  /** Finalized aggregate value; only grouped contexts implement it. */
  agg?(e: AggExpr): SqlValue;
}

/** A row context over a materialized row. */
export function rowCtx(row: SqlValue[], colIdx: Map<Expr, number>): EvalCtx {
  return {
    col: (e) => {
      const i = colIdx.get(e);
      if (i === undefined) throw new SqlError(e.line, `column '${e.name}' is not resolved`);
      return row[i]!;
    },
  };
}

export function evalExpr(e: Expr, ctx: EvalCtx): SqlValue {
  switch (e.t) {
    case 'num': return { k: 'int', n: e.n };
    case 'str': return { k: 'text', s: e.s };
    case 'null': return NULL;
    case 'col': return ctx.col(e);
    case 'agg': {
      if (ctx.agg === undefined) throw new SqlError(e.line, `${e.fn}(…) cannot be evaluated here`);
      return ctx.agg(e);
    }
    case 'bin': {
      const l = evalExpr(e.l, ctx);
      const r = evalExpr(e.r, ctx);
      if (l === null || r === null) return NULL;
      const ln = l.k === 'int' || l.k === 'real';
      const rn = r.k === 'int' || r.k === 'real';
      if (!ln || !rn) throw new SqlError(e.line, `cannot apply ${e.op} to ${typeName(l)} and ${typeName(r)}`);
      const real = l.k === 'real' || r.k === 'real';
      const a = l.n;
      const b = r.n;
      switch (e.op) {
        case '+': return real ? { k: 'real', n: a + b } : { k: 'int', n: a + b };
        case '-': return real ? { k: 'real', n: a - b } : { k: 'int', n: a - b };
        case '*': return real ? { k: 'real', n: a * b } : { k: 'int', n: a * b };
        case '/': {
          if (b === 0) throw new SqlError(e.line, 'division by zero');
          // INTEGER / INTEGER truncates (PostgreSQL rules); AVG is the
          // operator that produces fractions.
          return real ? { k: 'real', n: a / b } : { k: 'int', n: Math.trunc(a / b) };
        }
      }
      break;
    }
    case 'neg': {
      const v = evalExpr(e.e, ctx);
      if (v === null) return NULL;
      if (v.k !== 'int' && v.k !== 'real') throw new SqlError(e.line, `cannot negate ${typeName(v)}`);
      return { k: v.k, n: -v.n };
    }
    case 'cmp': {
      const b = compare3(e.op, evalExpr(e.l, ctx), evalExpr(e.r, ctx), e.line);
      return b === null ? NULL : b ? TRUE : FALSE;
    }
    case 'like': {
      const v = evalExpr(e.e, ctx);
      const p = evalExpr(e.pat, ctx);
      if (v === null || p === null) return NULL;
      if (v.k !== 'text' || p.k !== 'text') {
        throw new SqlError(e.line, `LIKE needs TEXT on both sides — got ${typeName(v)} and ${typeName(p)}`);
      }
      return likeMatch(v.s, p.s) ? TRUE : FALSE;
    }
    case 'in': {
      const v = evalExpr(e.e, ctx);
      if (v === null) return NULL;
      let sawNull = false;
      for (const member of e.list) {
        const m = evalExpr(member, ctx);
        if (m === null) { sawNull = true; continue; }
        if (compare3('=', v, m, e.line) === true) return TRUE;
      }
      return sawNull ? NULL : FALSE;
    }
    case 'isnull': {
      const v = evalExpr(e.e, ctx);
      return (v === null) !== e.neg ? TRUE : FALSE;
    }
    case 'and': {
      const l = toBool3(evalExpr(e.l, ctx), e.line, 'AND');
      if (l === false) return FALSE;          // FALSE dominates, even under NULL
      const r = toBool3(evalExpr(e.r, ctx), e.line, 'AND');
      if (r === false) return FALSE;
      return l === null || r === null ? NULL : TRUE;
    }
    case 'or': {
      const l = toBool3(evalExpr(e.l, ctx), e.line, 'OR');
      if (l === true) return TRUE;
      const r = toBool3(evalExpr(e.r, ctx), e.line, 'OR');
      if (r === true) return TRUE;
      return l === null || r === null ? NULL : FALSE;
    }
    case 'not': {
      const b = toBool3(evalExpr(e.e, ctx), e.line, 'NOT');
      return b === null ? NULL : b ? FALSE : TRUE;
    }
  }
}

/** WHERE/HAVING/ON truth: only real booleans (or NULL) may flow here. */
export function toBool3(v: SqlValue, line: number, what: string): Bool3 {
  if (v === null) return null;
  if (v.k === 'bool') return v.b;
  throw new SqlError(line, `${what} needs true/false — got ${typeName(v)}`);
}

// ─── stages: one operator, one row per advance() ───────────────────────────

/** The row an operator just touched, for the Current-row panel. */
export interface RowView {
  schema: string[];
  values: SqlValue[];
  types?: (string | undefined)[];
}

export abstract class Stage {
  seen = 0;
  passed = 0;
  emitted = 0;
  done = false;
  out: SqlValue[][] = [];
  /** Set by every advance() — the row this step touched. */
  last: RowView | null = null;
  abstract readonly kind: string;
  abstract readonly label: string;
  abstract readonly tip: string;
  abstract readonly schema: string[];
  /** Perform exactly one row operation (returns false for pure bookkeeping,
   *  which does not count against the budget); may throw SqlError. */
  abstract advance(): boolean;
}

class ScanStage extends Stage {
  readonly kind = 'Scan';
  readonly label: string;
  readonly tip = 'Reads the table top to bottom, one row per step.';
  readonly schema: string[];
  private readonly types: string[];
  private idx = 0;

  constructor(private readonly table: Table) {
    super();
    this.label = `Scan ${table.name}`;
    this.schema = table.cols.map((c) => c.name);
    this.types = table.cols.map((c) => c.type);
  }

  advance(): boolean {
    if (this.idx >= this.table.rows.length) { this.done = true; return false; }
    const row = this.table.rows[this.idx++]!;
    this.seen++;
    this.passed++;
    this.emitted++;
    this.out.push(row);
    this.last = { schema: this.schema, values: row, types: this.types };
    if (this.idx >= this.table.rows.length) this.done = true;
    return true;
  }
}

class JoinStage extends Stage {
  readonly kind = 'NestedLoop';
  readonly label: string;
  readonly tip = 'For every row from above, probes every inner row and tests ON — the row-pair count is the join truth.';
  readonly schema: string[];
  private readonly types: (string | undefined)[];
  private outerIdx = 0;
  private innerIdx = 0;

  constructor(
    private readonly input: SqlValue[][],
    schema: SchemaCol[],
    types: (string | undefined)[],
    private readonly inner: Table,
    private readonly on: Expr,
    private readonly colIdx: Map<Expr, number>,
  ) {
    super();
    this.label = `NestedLoop join ${inner.name} ON ${clip(exprText(on))}`;
    this.schema = schema.map((c) => c.display);
    this.types = types;
  }

  advance(): boolean {
    // Inputs are the previous stage's out array, still filling: check
    // exhaustion here, not only after processing a row.
    if (this.outerIdx >= this.input.length || this.inner.rows.length === 0) { this.done = true; return false; }
    const outer = this.input[this.outerIdx]!;
    const innerRow = this.inner.rows[this.innerIdx]!;
    const pair = [...outer, ...innerRow];
    this.seen++;                                   // one probe = one row op
    if (toBool3(evalExpr(this.on, rowCtx(pair, this.colIdx)), this.on.line, 'ON') === true) {
      this.passed++;
      this.emitted++;
      this.out.push(pair);
    }
    this.last = { schema: this.schema, values: pair, types: this.types };
    this.innerIdx++;
    if (this.innerIdx >= this.inner.rows.length) {
      this.innerIdx = 0;
      this.outerIdx++;
      if (this.outerIdx >= this.input.length) this.done = true;
    }
    return true;
  }
}

class FilterStage extends Stage {
  readonly kind = 'Filter';
  readonly label: string;
  readonly tip = 'Tests the condition on each row; UNKNOWN (NULL) rows are dropped — only TRUE passes.';
  readonly schema: string[];
  private readonly types: (string | undefined)[];
  private idx = 0;

  constructor(
    private readonly input: SqlValue[][],
    private readonly cond: Expr,
    private readonly colIdx: Map<Expr, number>,
    schema: string[],
    types: (string | undefined)[],
  ) {
    super();
    this.label = `Filter ${clip(exprText(cond))}`;
    this.schema = schema;
    this.types = types;
  }

  advance(): boolean {
    if (this.idx >= this.input.length) { this.done = true; return false; }
    const row = this.input[this.idx++]!;
    this.seen++;
    if (toBool3(evalExpr(this.cond, rowCtx(row, this.colIdx)), this.cond.line, 'WHERE') === true) {
      this.passed++;
      this.emitted++;
      this.out.push(row);
    }
    this.last = { schema: this.schema, values: row, types: this.types };
    if (this.idx >= this.input.length) this.done = true;
    return true;
  }
}

class ProjectStage extends Stage {
  readonly kind = 'Project';
  readonly label: string;
  readonly tip = 'Computes the select list for each surviving row — this is where col+1 happens.';
  readonly schema: string[];
  private idx = 0;

  constructor(
    private readonly input: SqlValue[][],
    private readonly stmt: Extract<Stmt, { t: 'select' }>,
    private readonly headers: string[],
    private readonly colIdx: Map<Expr, number>,
    inputSchema: string[],
  ) {
    super();
    this.label = `Project ${stmt.star ? '*' : stmt.items.map((it) => clip(exprText(it))).join(', ')}`;
    this.schema = stmt.star ? inputSchema : headers;
  }

  advance(): boolean {
    if (this.idx >= this.input.length) { this.done = true; return false; }
    const row = this.input[this.idx++]!;
    this.seen++;
    const values = this.stmt.star ? row.slice() : this.stmt.items.map((it) => evalExpr(it, rowCtx(row, this.colIdx)));
    this.passed++;
    this.emitted++;
    this.out.push(values);
    this.last = { schema: this.schema, values };
    if (this.idx >= this.input.length) this.done = true;
    return true;
  }
}

/** Running state of one aggregate over one group. */
interface AggAcc { count: number; sum: number; real: boolean; best: SqlValue }

class GroupByStage extends Stage {
  readonly kind = 'GroupBy';
  readonly label: string;
  readonly tip = 'Folds each row into its group (updating the aggregates), then finalizes one group per step: HAVING, then the select list.';
  readonly schema: string[];
  private readonly groups = new Map<string, { keys: SqlValue[]; accs: AggAcc[] }>();
  private readonly order: { keys: SqlValue[]; accs: AggAcc[] }[] = [];
  private foldIdx = 0;
  private finalIdx = 0;
  private folding = true;

  constructor(
    private readonly input: SqlValue[][],
    private readonly inputSchema: string[],
    private readonly types: (string | undefined)[],
    private readonly groupIdxs: number[],
    private readonly aggs: AggExpr[],
    private readonly stmt: Extract<Stmt, { t: 'select' }>,
    private readonly headers: string[],
    private readonly colIdx: Map<Expr, number>,
    implicit: boolean,
  ) {
    super();
    this.label = `GroupBy ${stmt.groupBy === undefined ? '()' : stmt.groupBy.map((g) => (g.table === undefined ? g.name : `${g.table}.${g.name}`)).join(', ')}`;
    this.schema = headers;
    if (implicit) this.bucket([]);               // aggregates over the whole table
  }

  private bucket(keys: SqlValue[]): { keys: SqlValue[]; accs: AggAcc[] } {
    const key = JSON.stringify(keys);
    let g = this.groups.get(key);
    if (g === undefined) {
      g = { keys, accs: this.aggs.map(() => ({ count: 0, sum: 0, real: false, best: NULL })) };
      this.groups.set(key, g);
      this.order.push(g);
    }
    return g;
  }

  advance(): boolean {
    if (this.folding && this.foldIdx >= this.input.length) this.folding = false;
    if (!this.folding && this.finalIdx >= this.order.length) { this.done = true; return false; }
    if (this.folding) {
      const row = this.input[this.foldIdx++]!;
      this.seen++;
      const g = this.bucket(this.groupIdxs.map((i) => row[i]!));
      const ctx = rowCtx(row, this.colIdx);
      for (let a = 0; a < this.aggs.length; a++) {
        this.fold(this.aggs[a]!, g.accs[a]!, ctx);
      }
      this.last = { schema: this.inputSchema, values: row, types: this.types };
      if (this.foldIdx >= this.input.length) this.folding = false;
      return true;
    }
    // finalize: one group per step — HAVING, then the select list
    const g = this.order[this.finalIdx++]!;
    const ctx: EvalCtx = {
      col: (e) => {
        const i = this.colIdx.get(e);
        return i === undefined ? NULL : g.keys[this.groupIdxs.indexOf(i)] ?? NULL;
      },
      agg: (e) => {
        const a = this.aggs.indexOf(e);
        return a < 0 ? NULL : this.finalize(this.aggs[a]!, g.accs[a]!);
      },
    };
    if (this.stmt.having === undefined
      || toBool3(evalExpr(this.stmt.having, ctx), this.stmt.having.line, 'HAVING') === true) {
      this.passed++;
      this.emitted++;
      const values = this.stmt.star ? [] : this.stmt.items.map((it) => evalExpr(it, ctx));
      this.out.push(values);
      this.last = { schema: this.schema, values };
    } else {
      this.last = { schema: this.schema, values: this.stmt.items.map((it) => evalExpr(it, ctx)) };
    }
    if (this.finalIdx >= this.order.length) this.done = true;
    return true;
  }

  private fold(spec: AggExpr, acc: AggAcc, ctx: EvalCtx): void {
    if (spec.arg === '*') { acc.count++; return; }        // COUNT(*): rows, NULLs included
    const v = evalExpr(spec.arg, ctx);
    if (v === null) return;                                // aggregates skip NULLs
    switch (spec.fn) {
      case 'COUNT': acc.count++; break;
      case 'SUM':
      case 'AVG':
        if (v.k !== 'int' && v.k !== 'real') throw new SqlError(spec.line, `cannot ${spec.fn} over ${typeName(v)} — only numbers`);
        acc.sum += v.n;
        if (v.k === 'real') acc.real = true;
        acc.count++;
        break;
      case 'MIN':
      case 'MAX': {
        if (acc.best === null) { acc.best = v; break; }
        const c = orderCompare(v, acc.best, spec.line);
        if ((spec.fn === 'MIN' && c < 0) || (spec.fn === 'MAX' && c > 0)) acc.best = v;
        break;
      }
    }
  }

  private finalize(spec: AggExpr, acc: AggAcc): SqlValue {
    switch (spec.fn) {
      case 'COUNT': return { k: 'int', n: acc.count };
      case 'SUM': return acc.count === 0 ? NULL : acc.real ? { k: 'real', n: acc.sum } : { k: 'int', n: acc.sum };
      case 'AVG': return acc.count === 0 ? NULL : { k: 'real', n: acc.sum / acc.count };
      case 'MIN':
      case 'MAX': return acc.best;
    }
  }
}

interface SortKey { idx: number; desc: boolean; line: number }

class SortStage extends Stage {
  readonly kind = 'Sort';
  readonly label: string;
  readonly tip = 'Bottom-up merge sort: one comparison per step, ties keep input order (stable). NULLs sort last.';
  readonly schema: string[];
  private work: SqlValue[][] = [];
  private width = 1;
  private lo = 0;
  private i = 0;
  private j = 0;
  private mid = 0;
  private hi = 0;
  private tmp: SqlValue[][] = [];
  private started = false;

  /** Input is the previous stage's out array, still filling when this stage
   *  is built — so the sort starts lazily, at its first advance(). */
  constructor(private readonly input: SqlValue[][], schema: string[], private readonly keys: SortKey[]) {
    super();
    this.label = `Sort ${keys.map((k) => `${schema[k.idx]!}${k.desc ? ' DESC' : ''}`).join(', ')}`;
    this.schema = schema;
  }

  private start(): boolean {
    this.seen = this.input.length;
    this.work = this.input.slice();
    if (this.work.length <= 1) {
      this.publish();
      this.done = true;
      return false;                    // no comparisons to make
    }
    this.setupMerge();
    return true;
  }

  /** The next stage holds this.out by reference; publish in place. */
  private publish(): void {
    this.out.splice(0, this.out.length, ...this.work);
    this.emitted = this.work.length;
  }

  private setupMerge(): void {
    this.mid = Math.min(this.lo + this.width, this.work.length);
    this.hi = Math.min(this.lo + 2 * this.width, this.work.length);
    this.i = this.lo;
    this.j = this.mid;
    this.tmp = [];
    // One side may already be exhausted (e.g. the odd tail run): drain it.
    this.drain();
  }

  private drain(): void {
    while (this.i >= this.mid && this.j < this.hi) { this.tmp.push(this.work[this.j++]!); this.emitted++; }
    while (this.j >= this.hi && this.i < this.mid) { this.tmp.push(this.work[this.i++]!); this.emitted++; }
  }

  advance(): boolean {
    if (!this.started) {
      this.started = true;
      if (!this.start()) return false;
    }
    for (;;) {
      if (this.i >= this.mid && this.j >= this.hi) {
        // merge finished: copy back, move to the next merge / next pass
        for (let k = 0; k < this.tmp.length; k++) this.work[this.lo + k] = this.tmp[k]!;
        this.lo += 2 * this.width;
        if (this.lo >= this.work.length) {
          this.width *= 2;
          this.lo = 0;
          if (this.width >= this.work.length) {
            this.publish();
            this.done = true;
            return true;
          }
        }
        this.setupMerge();
        continue;                      // bookkeeping, not a comparison
      }
      const c = this.compareKeys(this.work[this.i]!, this.work[this.j]!);
      const takeLeft = c <= 0;         // stable: ties take the left run
      const row = takeLeft ? this.work[this.i++]! : this.work[this.j++]!;
      this.tmp.push(row);
      this.passed++;                   // one comparison per step
      this.emitted++;
      this.last = { schema: this.schema, values: row };
      this.drain();                    // bookkeeping, not row ops
      return true;
    }
  }

  private compareKeys(a: SqlValue[], b: SqlValue[]): number {
    for (const key of this.keys) {
      const c = orderCompare(a[key.idx]!, b[key.idx]!, key.line);
      if (c !== 0) return key.desc ? -c : c;
    }
    return 0;
  }
}

class LimitStage extends Stage {
  readonly kind = 'Limit';
  readonly label: string;
  readonly tip = 'Lets the first n rows through, then stops reading.';
  readonly schema: string[];
  private idx = 0;

  constructor(private readonly input: SqlValue[][], schema: string[], private readonly n: number) {
    super();
    this.label = `Limit ${n}`;
    this.schema = schema;
  }

  advance(): boolean {
    if (this.idx >= this.input.length) { this.done = true; return false; }
    const row = this.input[this.idx++]!;
    this.seen++;
    if (this.out.length < this.n) {
      this.passed++;
      this.emitted++;
      this.out.push(row);
      if (this.out.length >= this.n) this.done = true;
    }
    if (this.idx >= this.input.length) this.done = true;
    return true;
  }
}

class InsertStage extends Stage {
  readonly kind = 'Insert';
  readonly label: string;
  readonly tip = 'Appends one literal row per step, checking each value against the column type.';
  readonly schema: string[];
  private readonly types: string[];
  private idx = 0;

  constructor(
    private readonly table: Table,
    private readonly rows: Expr[][],
    private readonly onRow: (table: Table) => void,
  ) {
    super();
    this.label = `Insert ${table.name}`;
    this.schema = table.cols.map((c) => c.name);
    this.types = table.cols.map((c) => c.type);
  }

  advance(): boolean {
    const exprs = this.rows[this.idx++]!;
    if (exprs.length !== this.table.cols.length) {
      throw new SqlError(exprs[0]?.line ?? 0,
        `expected ${this.table.cols.length} values for ${this.table.name} (${this.table.cols.map((c) => c.name).join(', ')}) — got ${exprs.length}`);
    }
    const values: SqlValue[] = exprs.map((e, c) => {
      const col = this.table.cols[c]!;
      if (e.t === 'null') return NULL;
      if (e.t === 'num' && col.type === 'INTEGER') return { k: 'int', n: e.n };
      if (e.t === 'str' && col.type === 'TEXT') return { k: 'text', s: e.s };
      throw new SqlError(e.line, `cannot insert ${e.t === 'num' ? 'INTEGER' : 'TEXT'} into ${col.type} column '${col.name}'`);
    });
    this.table.rows.push(values);
    this.seen++;
    this.passed++;
    this.emitted++;
    this.last = { schema: this.schema, values, types: this.types };
    this.onRow(this.table);
    if (this.idx >= this.rows.length) this.done = true;
    return true;
  }
}

class CreateStage extends Stage {
  readonly kind = 'Create';
  readonly label: string;
  readonly tip = 'Declares the table — columns and types, no rows yet.';
  readonly schema: string[];

  constructor(table: Table) {
    super();
    this.label = `Create ${table.name}`;
    this.schema = table.cols.map((c) => c.name);
    this.done = true;
    this.last = { schema: this.schema, values: table.cols.map(() => NULL), types: table.cols.map((c) => c.type) };
  }

  advance(): boolean {
    // A declaration, not data: CREATE TABLE completes at plan time.
    return false;
  }
}

/** Truncate long expressions in Plan labels. */
function clip(s: string, max = 24): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ─── statement analysis ────────────────────────────────────────────────────

interface SelectAnalysis {
  schema: SchemaCol[];
  colIdx: Map<Expr, number>;
  aggs: AggExpr[];
  grouped: boolean;
  groupIdxs: number[];
  headers: string[];
  types: (string | undefined)[];
}

/** Walk an expression; visit(node, inAgg) sees col/agg nodes. */
function walk(e: Expr, visit: (node: Expr, inAgg: boolean) => void, inAgg = false): void {
  switch (e.t) {
    case 'col':
    case 'agg':
      visit(e, inAgg);
      if (e.t === 'agg' && e.arg !== '*') walk(e.arg, visit, true);
      return;
    case 'bin': case 'cmp': case 'and': case 'or':
      walk(e.l, visit, inAgg);
      walk(e.r, visit, inAgg);
      return;
    case 'like':
      walk(e.e, visit, inAgg);
      walk(e.pat, visit, inAgg);
      return;
    case 'neg': case 'not':
      walk(e.e, visit, inAgg);
      return;
    case 'in':
      walk(e.e, visit, inAgg);
      for (const m of e.list) walk(m, visit, inAgg);
      return;
    case 'isnull':
      walk(e.e, visit, inAgg);
      return;
    default: return;
  }
}

/** Resolve every column of every clause; enforce the placement rules. */
function analyzeSelect(stmt: Extract<Stmt, { t: 'select' }>, db: Database): SelectAnalysis {
  const outer = db.get(stmt.from);
  if (outer === undefined) throw new SqlError(stmt.fromLine, `unknown table '${stmt.from}'`);
  const inner = stmt.join === undefined ? undefined : db.get(stmt.join.table);
  if (stmt.join !== undefined && inner === undefined) {
    throw new SqlError(stmt.join.line, `unknown table '${stmt.join.table}'`);
  }
  const schema = buildSchema(outer, inner);
  const colIdx = new Map<Expr, number>();
  const aggs: AggExpr[] = [];

  const resolveAll = (e: Expr, clause: 'WHERE' | 'ON' | 'SELECT' | 'HAVING'): void => {
    walk(e, (node, inAgg) => {
      if (node.t === 'agg') {
        if (inAgg) throw new SqlError(node.line, 'an aggregate cannot nest inside another aggregate');
        if (clause === 'WHERE' || clause === 'ON') {
          throw new SqlError(node.line, `${node.fn}(…) is not allowed in ${clause} — aggregates belong in the select list or HAVING`);
        }
        if (!aggs.includes(node)) aggs.push(node);
        return;
      }
      if (node.t !== 'col') return;
      colIdx.set(node, resolveCol(node, schema));
    });
  };

  if (stmt.join !== undefined) resolveAll(stmt.join.on, 'ON');
  if (stmt.where !== undefined) resolveAll(stmt.where, 'WHERE');
  for (const item of stmt.items) resolveAll(item, 'SELECT');
  if (stmt.having !== undefined) resolveAll(stmt.having, 'HAVING');

  const groupIdxs = stmt.groupBy === undefined ? [] : stmt.groupBy.map((g) => resolveCol(g, schema));
  const grouped = stmt.groupBy !== undefined || aggs.length > 0 || stmt.having !== undefined;

  if (grouped && stmt.star) {
    throw new SqlError(stmt.line, `'*' cannot be used with GROUP BY or aggregates — name the grouping columns instead`);
  }
  if (grouped) {
    const check = (e: Expr): void => {
      walk(e, (node, inAgg) => {
        if (node.t !== 'col' || inAgg) return;
        if (!groupIdxs.includes(colIdx.get(node)!)) {
          throw new SqlError(node.line, `column '${node.name}' must appear in GROUP BY or inside an aggregate`);
        }
      });
    };
    for (const item of stmt.items) check(item);
    if (stmt.having !== undefined) check(stmt.having);
  }

  const headers = stmt.star
    ? schema.map((c) => c.name)
    : stmt.items.map((it) => (it.t === 'col' ? schema[colIdx.get(it)!]!.name : exprText(it)));
  return { schema, colIdx, aggs, grouped, groupIdxs, headers, types: schema.map((c) => c.type) };
}


// ─── the engine ────────────────────────────────────────────────────────────

export class Engine {
  readonly db = new Database();
  ops = 0;
  pc = 0;
  stages: Stage[] = [];
  stageIdx = 0;
  running = false;
  finished = false;
  error: SqlError | null = null;
  /** pc of a statement we just paused at; run() skips its bp check once. */
  resumeSkipPc: number | null = null;
  outputs: string[] = [];
  lastTouched: Table | null = null;
  /** Line of the statement the current plan belongs to (persists after it
   *  completes, so the Plan panel keeps its line mapping). */
  planLine = 0;

  constructor(readonly stmts: Stmt[]) {}

  /** Begin the statement at pc (throws SqlError on analysis failures). */
  beginStatement(): void {
    const stmt = this.stmts[this.pc]!;
    this.planLine = stmt.line;
    this.stages = this.buildStages(stmt);
    this.stageIdx = 0;
    this.running = true;
    if (this.stages.length > 0 && this.stages.every((s) => s.done)) this.finalizeStatement();
  }

  private finalizeStatement(): void {
    const stmt = this.stmts[this.pc]!;
    if (stmt.t === 'insert') this.outputs.push(`INSERT 0 ${stmt.rows.length}`);
    if (stmt.t === 'select') {
      const last = this.stages[this.stages.length - 1]!;
      this.outputs.push(renderTable(last.schema, last.out));
    }
    this.running = false;
    this.pc++;
  }

  /** Perform exactly one row operation (throws SqlError). Stages may return
   *  false for pure bookkeeping (a sort with nothing to compare); that does
   *  not count as a row op. */
  performOp(): void {
    while (this.stageIdx < this.stages.length && this.stages[this.stageIdx]!.done) this.stageIdx++;
    const st = this.stages[this.stageIdx];
    if (st === undefined) { this.finalizeStatement(); return; }
    if (st.advance()) {
      this.ops++;
      if (this.ops > ROW_OP_BUDGET) {
        throw new SqlError(this.planLine, `budget exceeded — more than ${ROW_OP_BUDGET.toLocaleString('en-US')} row operations (a cross join of big tables does this)`);
      }
    }
    if (st.done) {
      this.stageIdx++;
      while (this.stageIdx < this.stages.length && this.stages[this.stageIdx]!.done) this.stageIdx++;
      if (this.stageIdx >= this.stages.length) this.finalizeStatement();
    }
  }

  private buildStages(stmt: Stmt): Stage[] {
    if (stmt.t === 'create') {
      if (this.db.get(stmt.table) !== undefined) {
        throw new SqlError(stmt.line, `table '${stmt.table}' already exists`);
      }
      const table = this.db.create(stmt.table, stmt.cols);
      this.lastTouched = table;
      return [new CreateStage(table)];
    }
    if (stmt.t === 'insert') {
      const table = this.db.get(stmt.table);
      if (table === undefined) throw new SqlError(stmt.line, `unknown table '${stmt.table}'`);
      return [new InsertStage(table, stmt.rows, (t) => { this.lastTouched = t; })];
    }
    const a = analyzeSelect(stmt, this.db);
    const stages: Stage[] = [new ScanStage(this.db.get(stmt.from)!)];
    let rows: Stage = stages[0]!;
    let schema = a.schema.map((c) => c.display);
    let types = a.types;
    if (stmt.join !== undefined) {
      const join = new JoinStage(rows.out, a.schema, types, this.db.get(stmt.join.table)!, stmt.join.on, a.colIdx);
      stages.push(join);
      rows = join;
    }
    if (stmt.where !== undefined) {
      const filter = new FilterStage(rows.out, stmt.where, a.colIdx, schema, types);
      stages.push(filter);
      rows = filter;
    }
    if (a.grouped) {
      const group = new GroupByStage(
        rows.out, schema, types, a.groupIdxs, a.aggs, stmt, a.headers, a.colIdx,
        stmt.groupBy === undefined,
      );
      stages.push(group);
      rows = group;
      schema = a.headers;
      types = a.headers.map(() => undefined);
    } else {
      const project = new ProjectStage(rows.out, stmt, a.headers, a.colIdx, schema);
      stages.push(project);
      rows = project;
      schema = project.schema;
      types = schema.map(() => undefined);
    }
    if (stmt.orderBy !== undefined) {
      const keys = stmt.orderBy.map((k) => {
        const idx = schema.findIndex((h) => h.toLowerCase() === k.name.toLowerCase());
        if (idx < 0) {
          throw new SqlError(k.line, `unknown ORDER BY column '${k.name}' — it must be a column of the result (the select list)`);
        }
        return { idx, desc: k.desc, line: k.line } satisfies SortKey;
      });
      stages.push(new SortStage(rows.out, schema, keys));
      rows = stages[stages.length - 1]!;
    }
    if (stmt.limit !== undefined) {
      stages.push(new LimitStage(rows.out, schema, stmt.limit));
    }
    return stages;
  }

  /** Console text: one chunk per statement that printed, blank line between. */
  consoleText(): string {
    return this.outputs.length === 0 ? '' : `${this.outputs.join('\n\n')}\n`;
  }
}
