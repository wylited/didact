// matrix.ts — the only data structure. Every matrix is a shape plus one
// flat array of doubles laid out COLUMN-MAJOR: element (i,j) (both 1-based)
// lives at data[(j-1)*rows + (i-1)], so memory runs down each column first.
// That layout is MATLAB's actual layout and the whole panel story: the
// address of A(i,j) is (col-1)*rows + row - 1, 0-based.

export const MAX_ELEMS = 1_000_000;

export class Mat {
  constructor(
    public rows: number,
    public cols: number,
    /** Column-major flat storage; length === rows * cols. */
    public data: number[],
  ) {}

  /** 1-based element read. */
  get(i: number, j: number): number {
    return this.data[(j - 1) * this.rows + (i - 1)]!;
  }

  /** 1-based element write. */
  set(i: number, j: number, v: number): void {
    this.data[(j - 1) * this.rows + (i - 1)] = v;
  }

  /** 1-based linear (column-major) element read: A(3) is the 3rd element
   *  counting DOWN the first column, then down the second, … */
  lin(k: number): number {
    return this.data[k - 1]!;
  }

  /** 0-based column-major address of element (i,j) — the panel formula. */
  addr(i: number, j: number): number {
    return (j - 1) * this.rows + (i - 1);
  }

  numel(): number {
    return this.rows * this.cols;
  }

  /** MATLAB value semantics: assignment copies. Names never share one
   *  matrix, so a write through B after `B = A` leaves A alone. */
  clone(): Mat {
    return new Mat(this.rows, this.cols, [...this.data]);
  }
}

export function checkElems(rows: number, cols: number, line: number): void {
  const n = rows * cols;
  if (n > MAX_ELEMS) {
    throw new MatErr(
      `matrix too large for the teaching interpreter: ${rows}x${cols} is ${n.toLocaleString('en-US')} elements (limit ${MAX_ELEMS.toLocaleString('en-US')})`,
      line,
    );
  }
}

/** Error carrying the 1-based source line, so linear-algebra helpers can
 *  throw line-mapped errors without dragging the interpreter in. */
export class MatErr extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

// ─── constructors ──────────────────────────────────────────────────────────

export function scalar(x: number): Mat {
  return new Mat(1, 1, [x]);
}

/** Row vector from raw numbers. */
export function row(xs: number[]): Mat {
  return new Mat(1, xs.length, [...xs]);
}

/** Column vector from raw numbers. */
export function col(xs: number[]): Mat {
  return new Mat(xs.length, 1, [...xs]);
}

export function filled(rows: number, cols: number, v: number, line: number): Mat {
  if (rows < 0 || cols < 0 || !Number.isInteger(rows) || !Number.isInteger(cols)) {
    throw new MatErr('matrix dimensions must be non-negative integers', line);
  }
  checkElems(rows, cols, line);
  return new Mat(rows, cols, new Array<number>(rows * cols).fill(v));
}

export function eye(n: number, m: number, line: number): Mat {
  const a = filled(n, m, 0, line);
  for (let k = 0; k < Math.min(n, m); k++) a.set(k + 1, k + 1, 1);
  return a;
}

export function transpose(a: Mat): Mat {
  const out = new Mat(a.cols, a.rows, new Array<number>(a.numel()));
  for (let j = 1; j <= a.cols; j++) {
    for (let i = 1; i <= a.rows; i++) {
      out.set(j, i, a.get(i, j));
    }
  }
  return out;
}

/** Submatrix of the given rows/cols (1-based) — the general gather, also
 *  used to build row/column deletions (keep-lists drop what [] deletes). */
export function gather(a: Mat, rows: number[], cols: number[]): Mat {
  const out = new Mat(rows.length, cols.length, new Array<number>(rows.length * cols.length));
  for (let j = 0; j < cols.length; j++) {
    for (let i = 0; i < rows.length; i++) {
      out.set(i + 1, j + 1, a.get(rows[i]!, cols[j]!));
    }
  }
  return out;
}

/** Column-major gather by linear indices (1-based): A([1 3]) etc. */
export function gatherLin(a: Mat, ks: number[]): Mat {
  return new Mat(ks.length, 1, ks.map((k) => a.lin(k)));
}

// ─── Gaussian elimination (the `\` story) ──────────────────────────────────

/** Solve A*X = B by Gaussian elimination with partial pivoting. A must be
 *  n×n, B n×k. Throws (line-mapped) when a pivot is ~0: singular. This is
 *  the same elimination-with-pivoting idea MATLAB's `\` dispatches to for
 *  square systems (LAPACK's LU). */
export function gaussSolve(A: Mat, B: Mat, line: number): Mat {
  const n = A.rows;
  // Augmented working copy [A | B], column-major.
  const k = B.cols;
  const w = new Array<number>(n * (n + k));
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) w[j * n + i] = A.get(i + 1, j + 1);
  }
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < n; i++) w[(n + j) * n + i] = B.get(i + 1, j + 1);
  }
  let scale = 1;
  for (let i = 0; i < A.data.length; i++) {
    const a = Math.abs(A.data[i]!);
    if (a > scale) scale = a;
  }
  for (let c = 0; c < n; c++) {
    // partial pivot: largest |w| in column c, rows c..n-1
    let p = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(w[c * n + r]!) > Math.abs(w[c * n + p]!)) p = r;
    }
    if (Math.abs(w[c * n + p]!) <= 1e-12 * scale) {
      throw new MatErr('matrix is singular to working precision', line);
    }
    if (p !== c) {
      for (let j = 0; j < n + k; j++) {
        const t = w[j * n + c]!;
        w[j * n + c] = w[j * n + p]!;
        w[j * n + p] = t;
      }
    }
    for (let r = c + 1; r < n; r++) {
      const f = w[c * n + r]! / w[c * n + c]!;
      for (let j = c; j < n + k; j++) w[j * n + r]! -= f * w[j * n + c]!;
    }
  }
  // back substitution, column by column of B
  const X = new Mat(n, k, new Array<number>(n * k));
  for (let b = 0; b < k; b++) {
    for (let r = n - 1; r >= 0; r--) {
      let s = w[(n + b) * n + r]!;
      for (let j = r + 1; j < n; j++) s -= w[j * n + r]! * X.get(j + 1, b + 1);
      X.set(r + 1, b + 1, s / w[r * n + r]!);
    }
  }
  return X;
}

export function det(A: Mat): number {
  const n = A.rows;
  const w = [...A.data];
  let scale = 1;
  for (let i = 0; i < A.data.length; i++) {
    const a = Math.abs(A.data[i]!);
    if (a > scale) scale = a;
  }
  let sign = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(w[c * n + r]!) > Math.abs(w[c * n + p]!)) p = r;
    }
    if (Math.abs(w[c * n + p]!) <= 1e-12 * scale) return 0;
    if (p !== c) {
      for (let j = 0; j < n; j++) {
        const t = w[j * n + c]!;
        w[j * n + c] = w[j * n + p]!;
        w[j * n + p] = t;
      }
      sign = -sign;
    }
    for (let r = c + 1; r < n; r++) {
      const f = w[c * n + r]! / w[c * n + c]!;
      for (let j = c; j < n; j++) w[j * n + r]! -= f * w[j * n + c]!;
    }
  }
  let d = sign;
  for (let c = 0; c < n; c++) d *= w[c * n + c]!;
  return d;
}

export function inv(A: Mat, line: number): Mat {
  if (A.rows !== A.cols) {
    throw new MatErr('inv needs a square matrix', line);
  }
  return gaussSolve(A, eye(A.rows, A.rows, line), line);
}

// ─── formatting (MATLAB-flavored) ───────────────────────────────────────────

/** One number the way the console shows it: integers plain, everything
 *  else rounded to 4 decimal places with trailing zeros trimmed — 0.5
 *  prints as 0.5, never 0.50; 1/3 prints as 0.3333. */
export function fmtNum(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Inf';
  if (x === -Infinity) return '-Inf';
  let v = Object.is(x, -0) ? 0 : x;
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  v = Math.round(v * 1e4) / 1e4;
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  if (v !== 0 && (Math.abs(v) >= 1e15 || Math.abs(v) < 1e-4)) {
    return v.toExponential(4).replace(/\.?0+e/, 'e');
  }
  return String(v);
}

/** The body of a matrix display: one string per row, cells right-aligned
 *  to the widest cell, columns separated by two spaces (MATLAB right-
 *  aligns columns; this panel keeps the separator compact). */
export function fmtRows(m: Mat): string[] {
  if (m.numel() === 0) return [];
  const cells: string[][] = [];
  let w = 1;
  for (let i = 1; i <= m.rows; i++) {
    const r: string[] = [];
    for (let j = 1; j <= m.cols; j++) {
      const s = fmtNum(m.get(i, j));
      w = Math.max(w, s.length);
      r.push(s);
    }
    cells.push(r);
  }
  return cells.map((r) => r.map((s) => s.padStart(w)).join('  '));
}

/** Workspace-panel preview: shape prefix plus a one-line bracketed sketch,
 *  truncated with '…' past 4 columns / 2 rows. */
export function preview(m: Mat): string {
  const shape = `${m.rows}x${m.cols}`;
  if (m.numel() === 0) return `${shape} []`;
  if (m.rows === 1 && m.cols === 1) return `${shape} ${fmtNum(m.get(1, 1))}`;
  const rows: string[] = [];
  const maxCols = 4;
  const maxRows = 2;
  const nrows = Math.min(m.rows, maxRows);
  const ncols = Math.min(m.cols, maxCols);
  for (let i = 1; i <= nrows; i++) {
    const cells: string[] = [];
    for (let j = 1; j <= ncols; j++) cells.push(fmtNum(m.get(i, j)));
    if (m.cols > maxCols) cells.push('…');
    rows.push(cells.join(' '));
  }
  if (m.rows > maxRows) rows.push('…');
  return `${shape} [${rows.join('; ')}]`;
}

/** The 8 bytes of each element as one big-endian hex word — the IEEE 754
 *  pattern of the double, which is exactly what sits in memory. */
export function hex64(x: number): string {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x);
  return [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
