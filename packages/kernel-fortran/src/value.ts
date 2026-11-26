// value.ts — runtime values for the Fortran kernel. Fortran's defining
// layout fact lives here: an array is ONE flat buffer in COLUMN-MAJOR
// order, with explicit lower bounds, so A(3,2) is addressed
// (3-lo1) + (2-lo2)*extent1 — the panel makes that arithmetic visible.
//
// Scalars carry their kind: INTEGER kinds wrap at their storage width,
// REAL(4) rounds through float32 (`Math.fround`) and REAL(8) is float64,
// LOGICAL is a boolean, CHARACTER is a string padded/truncated on
// assignment, COMPLEX is a pair. Derived-type values hold a component
// map. Arrays copy on assignment (Fortran intrinsic assignment is value
// semantics) but procedure arguments share the caller's variable.

// Scalars carry their kind: INTEGER kinds wrap at their storage width,

export type ScalarBase = 'integer' | 'real' | 'logical' | 'character' | 'complex' | 'derived';

export interface IntV { k: 'integer'; v: number; kind: number }
export interface RealV { k: 'real'; v: number; kind: number }
export interface LogicalV { k: 'logical'; v: boolean }
export interface CharV { k: 'character'; v: string; len?: number }
export interface ComplexV { k: 'complex'; re: number; im: number; kind: number }

export type Scalar = IntV | RealV | LogicalV | CharV | ComplexV;

export interface DerivedV {
  k: 'derived';
  typeName: string;
  comps: Map<string, Value>;
}

export type Elem = Scalar | DerivedV;

export interface Dim {
  lo: number;
  hi: number;
}

export interface ArrayV {
  k: 'array';
  base: ScalarBase;
  kind: number;
  typeName?: string;
  charLen?: number;
  dims: Dim[];
  /** Column-major, exactly `size` elements. */
  data: Elem[];
  /** ALLOCATABLE arrays start false; fixed-shape arrays start true. */
  allocated: boolean;
}

export type Value = Elem | ArrayV;

export class RuntimeErr extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

export class BudgetErr extends Error {
  constructor(public line: number, limit: number) {
    super(`run budget exceeded (${limit.toLocaleString('en-US')} statements) — the program never finished`);
  }
}

// ─── scalar constructors ───────────────────────────────────────────────────

/** Wrap to the storage width of an INTEGER kind (1, 2, 4, 8). */
export function wrapInt(v: number, kind: number): number {
  const n = Math.trunc(v);
  if (kind === 1) return ((n + 128) % 256 + 256) % 256 - 128;
  if (kind === 2) return ((n + 32768) % 65536 + 65536) % 65536 - 32768;
  if (kind === 8) {
    if (!Number.isSafeInteger(n)) {
      throw new RangeError('INTEGER(8) value exceeds the exactly representable range');
    }
    return n;
  }
  return n | 0;
}

export function intVal(v: number, kind = 4): IntV {
  return { k: 'integer', v: wrapInt(v, kind), kind };
}

export function realVal(v: number, kind = 4): RealV {
  return { k: 'real', v: kind === 4 ? Math.fround(v) : v, kind };
}

export function logicalVal(v: boolean): LogicalV {
  return { k: 'logical', v };
}

export function charVal(v: string, len?: number): CharV {
  if (len !== undefined && len > MAX_CHAR_LEN) {
    throw new RangeError(`CHARACTER length ${len} exceeds the teaching limit of ${MAX_CHAR_LEN.toLocaleString('en-US')}`);
  }
  if (v.length > MAX_CHAR_LEN) {
    throw new RangeError(`CHARACTER value of ${v.length} characters exceeds the teaching limit of ${MAX_CHAR_LEN.toLocaleString('en-US')}`);
  }
  const text = len === undefined ? v : padChar(v, len);
  return len === undefined ? { k: 'character', v: text } : { k: 'character', v: text, len };
}

export function complexVal(re: number, im: number, kind = 4): ComplexV {
  return kind === 4
    ? { k: 'complex', re: Math.fround(re), im: Math.fround(im), kind }
    : { k: 'complex', re, im, kind };
}

export function padChar(s: string, len: number): string {
  if (len > MAX_CHAR_LEN) {
    throw new RangeError(`CHARACTER length ${len} exceeds the teaching limit of ${MAX_CHAR_LEN.toLocaleString('en-US')}`);
  }
  if (s.length > MAX_CHAR_LEN) {
    throw new RangeError(`CHARACTER value of ${s.length} characters exceeds the teaching limit of ${MAX_CHAR_LEN.toLocaleString('en-US')}`);
  }
  return s.length >= len ? s.slice(0, len) : s.padEnd(len, ' ');
}

// ─── array constructors ────────────────────────────────────────────────────

export const MAX_ELEMENTS = 1_000_000;
export const MAX_CHAR_LEN = 100_000;
export const MAX_CHAR_BYTES = 4_000_000;
export const MAX_FRAME_ELEMENTS = 2_000_000;

function checkArraySize(dims: Dim[], charLen?: number): void {
  let n = 1;
  for (const d of dims) {
    if (!Number.isSafeInteger(d.lo) || !Number.isSafeInteger(d.hi)) {
      throw new RangeError('array bounds must be finite integers');
    }
    if (d.hi < d.lo - 1) throw new RangeError(`invalid array bounds ${d.lo}:${d.hi}`);
    n *= extent(d);
    if (!Number.isSafeInteger(n) || n > MAX_ELEMENTS) {
      throw new RangeError(`array size ${n} exceeds the teaching limit of ${MAX_ELEMENTS.toLocaleString('en-US')} elements`);
    }
  }
  if (charLen !== undefined) {
    if (!Number.isSafeInteger(charLen) || charLen < 0 || charLen > MAX_CHAR_LEN) {
      throw new RangeError(`CHARACTER length ${charLen} exceeds the teaching limit of ${MAX_CHAR_LEN.toLocaleString('en-US')}`);
    }
    if (n * charLen > MAX_CHAR_BYTES) {
      throw new RangeError(`CHARACTER array needs ${(n * charLen).toLocaleString('en-US')} characters — the teaching limit is ${MAX_CHAR_BYTES.toLocaleString('en-US')}`);
    }
  }
}

export function extent(d: Dim): number {
  return Math.max(0, d.hi - d.lo + 1);
}

export function sizeOf(v: Value): number {
  if (v.k !== 'array') return 1;
  return v.dims.reduce((n, d) => n * extent(d), 1);
}

export function rankOf(v: Value): number {
  return v.k === 'array' ? v.dims.length : 0;
}

export function strides(dims: Dim[]): number[] {
  const out: number[] = [];
  let s = 1;
  for (const d of dims) {
    out.push(s);
    s *= extent(d);
  }
  return out;
}

/** Offset of a full set of 1-based subscripts in column-major order. */
export function offsetOf(dims: Dim[], subs: number[]): number {
  const st = strides(dims);
  let off = 0;
  for (let i = 0; i < dims.length; i++) off += (subs[i]! - dims[i]!.lo) * st[i]!;
  return off;
}

/** The 1-based subscripts at a column-major offset, for the panels. */
export function subsAt(dims: Dim[], off: number): number[] {
  const st = strides(dims);
  const subs: number[] = [];
  for (let i = 0; i < dims.length; i++) {
    subs.push(dims[i]!.lo + Math.floor(off / st[i]!) % extent(dims[i]!));
  }
  return subs;
}

export function makeArray(
  base: ScalarBase,
  dims: Dim[],
  data: Elem[],
  opts: { kind?: number; typeName?: string; charLen?: number; allocated?: boolean } = {},
): ArrayV {
  checkArraySize(dims, opts.charLen);
  if (opts.allocated !== false && dims.length > 0) {
    const n = dims.reduce((a, d) => a * extent(d), 1);
    if (data.length !== n) {
      throw new RangeError(`array has ${data.length} elements but its shape needs ${n}`);
    }
  }
  if (base === 'derived' && data.length > 0) {
    let total = 0;
    for (const e of data) total += valueSize(e);
    if (total > MAX_ELEMENTS * 4) {
      throw new RangeError(`derived-type array needs ${total.toLocaleString('en-US')} scalar slots — the teaching limit is ${(MAX_ELEMENTS * 4).toLocaleString('en-US')}`);
    }
  }
  return {
    k: 'array', base, dims, data,
    kind: opts.kind ?? 4,
    ...(opts.typeName === undefined ? {} : { typeName: opts.typeName }),
    ...(opts.charLen === undefined ? {} : { charLen: opts.charLen }),
    allocated: opts.allocated ?? true,
  };
}

export function filledArray(base: ScalarBase, dims: Dim[], fill: Elem, opts: { kind?: number; typeName?: string; charLen?: number } = {}): ArrayV {
  checkArraySize(dims, opts.charLen);
  const n = dims.reduce((a, d) => a * extent(d), 1);
  if (fill.k === 'derived') {
    const unit = valueSize(fill);
    if (n * unit > MAX_ELEMENTS * 4) {
      throw new RangeError(`array of derived values needs ${(n * unit).toLocaleString('en-US')} scalar slots — the teaching limit is ${(MAX_ELEMENTS * 4).toLocaleString('en-US')}`);
    }
  }
  return makeArray(base, dims, Array.from({ length: n }, () => copyElem(fill)), opts);
}

/** Total scalar slots in a value, including nested derived components and
 *  arrays. Used to keep nested containers inside one teaching-sized budget. */
export function valueSize(v: Value, depth = 0): number {
  if (depth > 32) throw new RangeError('derived-type nesting exceeds 32 levels');
  if (v.k === 'array') {
    let n = v.data.length;
    if (v.base === 'derived') {
      for (const e of v.data) if (e.k === 'derived') n += valueSize(e, depth + 1);
    }
    return n;
  }
  if (v.k === 'derived') {
    let n = 1;
    for (const c of v.comps.values()) n += valueSize(c, depth + 1);
    return n;
  }
  return 1;
}

// ─── predicates / copies ───────────────────────────────────────────────────

export function isArray(v: Value): v is ArrayV {
  return v.k === 'array';
}

export function isNumeric(v: Elem): v is IntV | RealV | ComplexV {
  return v.k === 'integer' || v.k === 'real' || v.k === 'complex';
}

export function copyElem(v: Elem): Elem {
  if (v.k === 'derived') {
    const comps = new Map<string, Value>();
    for (const [name, value] of v.comps) comps.set(name, copyValue(value));
    return { k: 'derived', typeName: v.typeName, comps };
  }
  return { ...v };
}

export function copyValue(v: Value): Value {
  if (v.k !== 'array') return copyElem(v);
  return {
    ...v,
    dims: v.dims.map((d) => ({ ...d })),
    data: v.data.map(copyElem),
  };
}

// ─── conversions ───────────────────────────────────────────────────────────

export function asInt(v: Elem, line: number): number {
  if (v.k === 'integer') return v.v;
  if (v.k === 'real') return Math.trunc(v.v);
  throw new RuntimeErr(`cannot convert ${describeScalar(v)} to INTEGER`, line);
}

export function asReal(v: Elem, line: number): number {
  if (v.k === 'real') return v.v;
  if (v.k === 'integer') return v.v;
  throw new RuntimeErr(`cannot convert ${describeScalar(v)} to REAL`, line);
}

export function asComplex(v: Elem, line: number): { re: number; im: number } {
  if (v.k === 'complex') return { re: v.re, im: v.im };
  if (v.k === 'real') return { re: v.v, im: 0 };
  if (v.k === 'integer') return { re: v.v, im: 0 };
  throw new RuntimeErr(`cannot convert ${describeScalar(v)} to COMPLEX`, line);
}

export function asLogical(v: Elem, line: number): boolean {
  if (v.k === 'logical') return v.v;
  throw new RuntimeErr(`expected LOGICAL, found ${describeScalar(v)}`, line);
}

export function asString(v: Elem, line: number): string {
  if (v.k === 'character') return v.v;
  throw new RuntimeErr(`expected CHARACTER, found ${describeScalar(v)}`, line);
}

/** Convert one element to a declared type, Fortran-style (pad/truncate
 *  CHARACTER, truncate INTEGER, round to float32 for REAL(4)). */
export function convertElem(v: Elem, base: ScalarBase, kind: number, charLen: number | undefined, line: number): Elem {
  switch (base) {
    case 'integer': return intVal(asInt(v, line), kind);
    case 'real': return realVal(asReal(v, line), kind);
    case 'logical': return logicalVal(asLogical(v, line));
    case 'character': return charVal(asString(v, line), charLen);
    case 'complex': {
      const c = asComplex(v, line);
      return complexVal(c.re, c.im, kind);
    }
    case 'derived':
      if (v.k !== 'derived') throw new RuntimeErr(`expected a derived-type value, found ${describeScalar(v)}`, line);
      return copyElem(v);
  }
}

export function convertValue(v: Value, base: ScalarBase, kind: number, charLen: number | undefined, line: number): Value {
  if (v.k !== 'array') return convertElem(v, base, kind, charLen, line);
  return {
    ...v,
    base,
    kind,
    ...(charLen === undefined ? {} : { charLen }),
    data: v.data.map((e) => convertElem(e, base, kind, charLen, line)),
  };
}

export function defaultScalar(base: ScalarBase, kind: number, charLen?: number): Elem {
  switch (base) {
    case 'integer': return intVal(0, kind);
    case 'real': return realVal(0, kind);
    case 'logical': return logicalVal(false);
    case 'character': return charVal('', charLen ?? 0);
    case 'complex': return complexVal(0, 0, kind);
    case 'derived': throw new Error('derived defaults are built by the interpreter');
  }
}

export function scalarKindName(base: ScalarBase, kind: number): string {
  if (base === 'integer' || base === 'real' || base === 'complex') return `${base}(${kind})`;
  return base;
}

export function describeScalar(v: Elem): string {
  switch (v.k) {
    case 'integer': return `INTEGER(${v.kind})`;
    case 'real': return `REAL(${v.kind})`;
    case 'logical': return 'LOGICAL';
    case 'character': return 'CHARACTER';
    case 'complex': return `COMPLEX(${v.kind})`;
    case 'derived': return `TYPE(${v.typeName})`;
  }
}

// ─── display ───────────────────────────────────────────────────────────────

/** Real formatting used by list-directed output: shortest exact decimal,
 *  always with a decimal point; REAL(4) is shown with 7 significant
 *  digits (what its storage can carry). */
export function fmtReal(v: number, kind: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  if (v === 0) return '0.0';
  const rounded = kind === 4 ? Number(v.toPrecision(7)) : v;
  let s = String(rounded);
  if (/[eE]/.test(s)) {
    const m = /^(-?\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
    if (m !== null) {
      const exp = Number(m[3]);
      return `${m[1]}.${m[2] ?? '0'}E${exp >= 0 ? '+' : ''}${exp}`;
    }
    s = s.replace('e', 'E');
  } else if (!s.includes('.')) {
    s += '.0';
  }
  return s;
}

export function fmtScalar(v: Elem): string {
  switch (v.k) {
    case 'integer': return String(v.v);
    case 'real': return fmtReal(v.v, v.kind);
    case 'logical': return v.v ? 'T' : 'F';
    case 'character': return v.v;
    case 'complex': return `(${fmtReal(v.re, v.kind)},${fmtReal(v.im, v.kind)})`;
    case 'derived': return `${v.typeName}(…)`;
  }
}

function clip(s: string): string {
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/** Full value identity for workspace change detection — unlike PREVIEW this
 *  includes every element, so a write past the sixth element still shows. */
export function valueSignature(v: Value): string {
  if (v.k === 'array') {
    return `${v.base}:${v.kind}:${v.charLen ?? ''}:${v.allocated ? 'a' : 'u'}:${v.dims.map((d) => `${d.lo}:${d.hi}`).join(',')}:${v.data.map((e) => valueSignature(e)).join('|')}`;
  }
  if (v.k === 'derived') {
    return `${v.typeName}(${[...v.comps].map(([n, c]) => `${n}=${valueSignature(c)}`).join('|')})`;
  }
  return fmtScalar(v);
}

export function preview(v: Value): string {
  if (v.k === 'array') {
    if (!v.allocated) return 'unallocated';
    const shape = v.dims.map(extent).join('x') || '0';
    const shown = v.data.slice(0, 6).map((e) => (e.k === 'character' ? `'${clip(e.v)}'` : fmtScalar(e)));
    const more = v.data.length > shown.length ? `, … ${v.data.length - shown.length} more` : '';
    return `${shape} [${shown.join(', ')}${more}]`;
  }
  if (v.k === 'character') return `'${clip(v.v)}'`;
  if (v.k === 'derived') {
    const parts = [...v.comps].map(([n, c]) => `${n}=${c.k === 'character' ? `'${clip(c.v)}'` : preview(c)}`);
    return `${v.typeName}(${parts.join(', ')})`;
  }
  return fmtScalar(v);
}

export function typeLabel(v: Value): string {
  if (v.k === 'array') {
    const shape = v.allocated ? v.dims.map(extent).join('x') : 'unallocated';
    const base = v.base === 'derived' ? `type(${v.typeName ?? '?'})` : scalarKindName(v.base, v.kind);
    return `${base} · ${shape}`;
  }
  if (v.k === 'derived') return `type(${v.typeName})`;
  return scalarKindName(v.k, 'kind' in v ? v.kind : 0);
}

/** Flatten a value for list-directed/formatted output (column-major). */
export function flatten(v: Value, line: number): Elem[] {
  if (v.k !== 'array') {
    if (v.k === 'derived') {
      throw new RuntimeErr(
        `cannot print TYPE(${v.typeName}) without defined I/O — print its components`,
        line,
      );
    }
    return [v];
  }
  if (!v.allocated) throw new RuntimeErr('cannot use an unallocated array', line);
  if (v.base === 'derived') {
    throw new RuntimeErr(`cannot print a TYPE(${v.typeName ?? '?'}) array without defined I/O`, line);
  }
  return v.data;
}
