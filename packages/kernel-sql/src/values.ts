// values.ts — the SQL value domain: INTEGER, TEXT, and NULL as a first-class
// "unknown", plus the comparison and rendering rules the interpreter shares.
//
// Booleans exist only as intermediate results of comparisons / logical
// operators (three-valued logic); they may be printed but never stored.

export type SqlValue =
  | { k: 'int'; n: number }
  | { k: 'real'; n: number }
  | { k: 'text'; s: string }
  | { k: 'bool'; b: boolean }
  | null;

export const NULL: SqlValue = null;
export const TRUE: SqlValue = { k: 'bool', b: true };
export const FALSE: SqlValue = { k: 'bool', b: false };

/** Three-valued truth: `null` means UNKNOWN. */
export type Bool3 = boolean | null;

/** Runtime error carrying the 1-based line of the statement that raised it. */
export class SqlError extends Error {
  constructor(readonly line: number, message: string) {
    super(message);
    this.name = 'SqlError';
  }
}

/** Type name used in messages ('INTEGER', 'TEXT', …). */
export function typeName(v: SqlValue): string {
  if (v === null) return 'NULL';
  switch (v.k) {
    case 'int': return 'INTEGER';
    case 'real': return 'REAL';
    case 'text': return 'TEXT';
    case 'bool': return 'BOOLEAN';
  }
}

/** Render a value for a results cell or the Current-row panel. */
export function renderValue(v: SqlValue): string {
  if (v === null) return 'NULL';
  switch (v.k) {
    case 'int': return String(v.n);
    case 'real': {
      // REAL exists so AVG can be fractional; show enough digits, trimmed,
      // but always at least one decimal (2.5, 2.25, 3.0).
      const r = Math.round(v.n * 1e6) / 1e6;
      if (Number.isInteger(r)) return `${r.toFixed(1)}`;
      return String(r);
    }
    case 'text': return v.s;
    case 'bool': return v.b ? 'true' : 'false';
  }
}

/** Compare two same-kind sortable values; caller has checked for NULL/mix. */
export function compareValues(a: SqlValue, b: SqlValue): number {
  if (a !== null && b !== null && a.k === 'int' && b.k === 'int') return a.n - b.n;
  if (a !== null && b !== null && (a.k === 'real' || a.k === 'int') && (b.k === 'real' || b.k === 'int')) {
    return num(a) - num(b);
  }
  if (a !== null && b !== null && a.k === 'text' && b.k === 'text') return a.s < b.s ? -1 : a.s > b.s ? 1 : 0;
  if (a !== null && b !== null && a.k === 'bool' && b.k === 'bool') return a.b === b.b ? 0 : a.b ? 1 : -1;
  return 0;
}

function num(v: SqlValue): number {
  return v !== null && (v.k === 'int' || v.k === 'real') ? v.n : 0;
}

/** Three-valued comparison (=, <>, <, …). NULL on either side → UNKNOWN;
 *  mixed non-numeric kinds are a type error, not a silent false. */
export function compare3(op: '=' | '<>' | '<' | '<=' | '>' | '>=', a: SqlValue, b: SqlValue, line: number): Bool3 {
  if (a === null || b === null) return null;
  if (!sortableWith(a, b)) {
    throw new SqlError(line, `cannot compare ${typeName(a)} with ${typeName(b)}`);
  }
  const c = compareValues(a, b);
  switch (op) {
    case '=': return c === 0;
    case '<>': return c !== 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '>=': return c >= 0;
  }
}

/** ORDER BY comparison: NULLs sort last (they are "unknown"), incomparable
 *  kinds are an error. Returns <0, 0, >0. */
export function orderCompare(a: SqlValue, b: SqlValue, line: number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (a.k !== b.k && !((a.k === 'int' || a.k === 'real') && (b.k === 'int' || b.k === 'real'))) {
    throw new SqlError(line, `cannot sort ${typeName(a)} with ${typeName(b)}`);
  }
  return compareValues(a, b);
}

/** Kinds that may be ordered against each other (numbers with numbers,
 *  text with text, bool with bool). */
function sortableWith(a: Exclude<SqlValue, null>, b: Exclude<SqlValue, null>): boolean {
  const numeric = (v: Exclude<SqlValue, null>) => v.k === 'int' || v.k === 'real';
  if (numeric(a) && numeric(b)) return true;
  return a.k === b.k;
}

/** LIKE with % (any run, including empty) and _ (exactly one); case-SENSITIVE,
 *  no escape syntax in v1. */
export function likeMatch(text: string, pattern: string): boolean {
  const re = pattern.split('').map((ch) => {
    if (ch === '%') return '.*';
    if (ch === '_') return '.';
    return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${re}$`).test(text);
}

/** psql-style ASCII table: padded columns, header, ---- separator. */
export function renderTable(headers: string[], rows: SqlValue[][]): string {
  const cells = rows.map((row) => row.map(renderValue));
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...cells.map((row) => row[c]!.length)));
  const line = (cellsOf: string[]) =>
    cellsOf.map((cell, c) => ` ${cell.padEnd(widths[c]!)} `).join('|');
  const separator = widths.map((w) => '-'.repeat(w + 2)).join('+');
  return [line(headers), separator, ...cells.map(line)].join('\n');
}
