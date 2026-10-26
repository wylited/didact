// parser.ts — statement parser for the teaching dialect:
//   CREATE TABLE name (col TYPE, …)                TYPE ∈ INTEGER | TEXT
//   INSERT INTO name VALUES (lit, …), (lit, …)     lit ∈ number | 'text' | NULL
//   SELECT items FROM t [JOIN t ON e] [WHERE e] [GROUP BY cols] [HAVING e]
//          [ORDER BY col [ASC|DESC], …] [LIMIT n]
// Identifiers are matched case-insensitively; string values keep their case.

import { SqlSyntaxError, tokenize, type Token } from './lexer';

// ─── expressions ───────────────────────────────────────────────────────────

export type CmpOp = '=' | '<>' | '<' | '<=' | '>' | '>=';

export type Expr =
  | { t: 'num'; n: number; line: number }
  | { t: 'str'; s: string; line: number }
  | { t: 'null'; line: number }
  | { t: 'col'; table?: string; name: string; line: number }
  | { t: 'agg'; fn: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'; arg: Expr | '*'; line: number }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; l: Expr; r: Expr; line: number }
  | { t: 'neg'; e: Expr; line: number }
  | { t: 'cmp'; op: CmpOp; l: Expr; r: Expr; line: number }
  | { t: 'like'; e: Expr; pat: Expr; line: number }
  | { t: 'in'; e: Expr; list: Expr[]; line: number }
  | { t: 'isnull'; e: Expr; neg: boolean; line: number }
  | { t: 'and'; l: Expr; r: Expr; line: number }
  | { t: 'or'; l: Expr; r: Expr; line: number }
  | { t: 'not'; e: Expr; line: number };

export interface ColRef { table?: string; name: string; line: number }

// ─── statements ────────────────────────────────────────────────────────────

export interface ColumnDef { name: string; type: 'INTEGER' | 'TEXT'; line: number }

export type Stmt =
  | { t: 'create'; line: number; table: string; cols: ColumnDef[] }
  | { t: 'insert'; line: number; table: string; rows: Expr[][] }
  | {
      t: 'select'; line: number; from: string; fromLine: number;
      join?: { table: string; on: Expr; line: number };
      where?: Expr;
      groupBy?: ColRef[];
      having?: Expr;
      orderBy?: { name: string; desc: boolean; line: number }[];
      limit?: number;
      star: boolean;
      items: Expr[];
    };

/** Canonical expression text — output headers and Plan labels use it. */
export function exprText(e: Expr): string {
  switch (e.t) {
    case 'num': return String(e.n);
    case 'str': return `'${e.s}'`;
    case 'null': return 'NULL';
    case 'col': return e.table === undefined ? e.name : `${e.table}.${e.name}`;
    case 'agg': return e.arg === '*' ? `${e.fn}(*)` : `${e.fn}(${exprText(e.arg)})`;
    case 'bin': return `${exprText(e.l)} ${e.op} ${exprText(e.r)}`;
    case 'neg': return `-${exprText(e.e)}`;
    case 'cmp': return `${exprText(e.l)} ${e.op} ${exprText(e.r)}`;
    case 'like': return `${exprText(e.e)} LIKE ${exprText(e.pat)}`;
    case 'in': return `${exprText(e.e)} IN (${e.list.map(exprText).join(', ')})`;
    case 'isnull': return `${exprText(e.e)} IS ${e.neg ? 'NOT ' : ''}NULL`;
    case 'and': return `${exprText(e.l)} AND ${exprText(e.r)}`;
    case 'or': return `${exprText(e.l)} OR ${exprText(e.r)}`;
    case 'not': return `NOT ${exprText(e.e)}`;
  }
}

// ─── the parser ────────────────────────────────────────────────────────────

const AGGREGATES: Record<string, true | undefined> = { COUNT: true, SUM: true, AVG: true, MIN: true, MAX: true };
const TYPES: Record<string, 'INTEGER' | 'TEXT' | undefined> = { INTEGER: 'INTEGER', TEXT: 'TEXT' };
type AggFn = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

class Parser {
  private pos = 0;

  constructor(private readonly toks: Token[]) {}

  private peek(): Token { return this.toks[this.pos]!; }
  private next(): Token { return this.toks[this.pos++]!; }

  private isKw(up: string): boolean {
    const t = this.peek();
    return t.type === 'word' && t.up === up;
  }

  private eatKw(up: string): Token {
    if (!this.isKw(up)) {
      throw new SqlSyntaxError(this.peek().line, `expected ${up} — got ${shown(this.peek())}`);
    }
    return this.next();
  }

  private isOp(text: string): boolean {
    const t = this.peek();
    return t.type === 'op' && t.text === text;
  }

  private eatOp(text: string): void {
    if (!this.isOp(text)) {
      throw new SqlSyntaxError(this.peek().line, `expected '${text}' — got ${shown(this.peek())}`);
    }
    this.pos++;
  }

  private ident(what: string): Token {
    const t = this.peek();
    if (t.type !== 'word') throw new SqlSyntaxError(t.line, `${what} — got ${shown(t)}`);
    if (AGGREGATES[t.up] === true || t.up === 'NULL' || t.up === 'SELECT' || t.up === 'FROM') {
      throw new SqlSyntaxError(t.line, `${what} — '${t.text}' is a reserved word here`);
    }
    this.pos++;
    return t;
  }

  /** Whole program: statements separated (and terminated) by ';'. */
  parseProgram(): Stmt[] {
    const stmts: Stmt[] = [];
    this.skipSemis();
    while (this.peek().type !== 'end') {
      stmts.push(this.statement());
      this.eatOp(';');
      this.skipSemis();
    }
    return stmts;
  }

  private skipSemis(): void {
    while (this.isOp(';')) this.pos++;
  }

  private statement(): Stmt {
    const t = this.peek();
    if (this.isKw('CREATE')) return this.create();
    if (this.isKw('INSERT')) return this.insert();
    if (this.isKw('SELECT')) return this.select();
    throw new SqlSyntaxError(t.line, `expected a statement (CREATE TABLE, INSERT or SELECT) — got ${shown(t)}`);
  }

  private create(): Stmt {
    const line = this.next().line;              // CREATE
    this.eatKw('TABLE');
    const name = this.ident('CREATE TABLE needs a table name');
    this.eatOp('(');
    const cols: ColumnDef[] = [];
    for (;;) {
      const col = this.ident('expected a column name');
      const tyTok = this.peek();
      if (tyTok.type !== 'word' || TYPES[tyTok.up] === undefined) {
        throw new SqlSyntaxError(
          tyTok.line,
          tyTok.type === 'word'
            ? `unknown type '${tyTok.text}' — this dialect has INTEGER and TEXT`
            : `expected a column type (INTEGER or TEXT) — got ${shown(tyTok)}`,
        );
      }
      this.pos++;
      const type = TYPES[tyTok.up]!;
      if (cols.some((c) => c.name.toLowerCase() === col.text.toLowerCase())) {
        throw new SqlSyntaxError(col.line, `duplicate column '${col.text}'`);
      }
      cols.push({ name: col.text, type, line: col.line });
      if (this.isOp(',')) { this.pos++; continue; }
      break;
    }
    this.eatOp(')');
    if (cols.length === 0) throw new SqlSyntaxError(line, 'a table needs at least one column');
    return { t: 'create', line, table: name.text, cols };
  }

  private insert(): Stmt {
    const line = this.next().line;              // INSERT
    this.eatKw('INTO');
    const name = this.ident('INSERT INTO needs a table name');
    this.eatKw('VALUES');
    const rows: Expr[][] = [this.valueRow()];
    while (this.isOp(',')) {
      this.pos++;
      rows.push(this.valueRow());
    }
    return { t: 'insert', line, table: name.text, rows };
  }

  /** One VALUES row: literals or NULL only (a negative number is a literal). */
  private valueRow(): Expr[] {
    this.eatOp('(');
    const vals: Expr[] = [this.literal()];
    while (this.isOp(',')) {
      this.pos++;
      vals.push(this.literal());
    }
    this.eatOp(')');
    return vals;
  }

  private literal(): Expr {
    const t = this.peek();
    if (t.type === 'number') { this.pos++; return { t: 'num', n: t.value, line: t.line }; }
    if (t.type === 'string') { this.pos++; return { t: 'str', s: t.value, line: t.line }; }
    if (t.type === 'word' && t.up === 'NULL') { this.pos++; return { t: 'null', line: t.line }; }
    if (t.type === 'op' && t.text === '-') {
      const numTok = this.toks[this.pos + 1]!;
      if (numTok.type === 'number') {
        this.pos += 2;
        return { t: 'num', n: -numTok.value, line: t.line };
      }
    }
    throw new SqlSyntaxError(t.line, `INSERT values must be literals or NULL — got ${shown(t)}`);
  }

  private select(): Stmt {
    const line = this.next().line;              // SELECT
    let star = false;
    const items: Expr[] = [];
    if (this.isOp('*')) {
      this.pos++;
      star = true;
    } else {
      items.push(this.expr());
      while (this.isOp(',')) { this.pos++; items.push(this.expr()); }
    }
    this.eatKw('FROM');
    const from = this.ident('FROM needs a table name');
    let join: { table: string; on: Expr; line: number } | undefined;
    if (this.isKw('JOIN')) {
      const jline = this.next().line;
      const table = this.ident('JOIN needs a table name');
      this.eatKw('ON');
      join = { table: table.text, on: this.expr(), line: jline };
    }
    let where: Expr | undefined;
    if (this.isKw('WHERE')) { this.pos++; where = this.expr(); }
    let groupBy: ColRef[] | undefined;
    if (this.isKw('GROUP')) {
      this.pos++;
      this.eatKw('BY');
      groupBy = [this.colRef()];
      while (this.isOp(',')) { this.pos++; groupBy.push(this.colRef()); }
    }
    let having: Expr | undefined;
    if (this.isKw('HAVING')) { this.pos++; having = this.expr(); }
    let orderBy: { name: string; desc: boolean; line: number }[] | undefined;
    if (this.isKw('ORDER')) {
      this.pos++;
      this.eatKw('BY');
      orderBy = [];
      for (;;) {
        // t.col is accepted; the qualifier is dropped — the key matches the
        // result's (unqualified) column names.
        const ref = this.colRef();
        let desc = false;
        if (this.isKw('ASC')) this.pos++;
        else if (this.isKw('DESC')) { this.pos++; desc = true; }
        orderBy.push({ name: ref.name, desc, line: ref.line });
        if (this.isOp(',')) { this.pos++; continue; }
        break;
      }
    }
    let limit: number | undefined;
    if (this.isKw('LIMIT')) {
      this.pos++;
      const t = this.peek();
      if (t.type !== 'number') throw new SqlSyntaxError(t.line, `LIMIT needs a number — got ${shown(t)}`);
      this.pos++;
      limit = t.value;
    }
    return { t: 'select', line, from: from.text, fromLine: from.line, join, where, groupBy, having, orderBy, limit, star, items };
  }

  /** A column reference: name or table.name. */
  private colRef(): ColRef {
    const first = this.ident('GROUP BY needs a column name');
    if (this.isOp('.')) {
      this.pos++;
      const col = this.ident(`expected a column name after '${first.text}.'`);
      return { table: first.text, name: col.text, line: first.line };
    }
    return { name: first.text, line: first.line };
  }

  // expression grammar, loosest binding first:
  //   or → and → not → comparison → additive → multiplicative → unary → primary
  expr(): Expr { return this.orExpr(); }

  private orExpr(): Expr {
    let l = this.andExpr();
    while (this.isKw('OR')) {
      const line = this.next().line;
      l = { t: 'or', l, r: this.andExpr(), line };
    }
    return l;
  }

  private andExpr(): Expr {
    let l = this.notExpr();
    while (this.isKw('AND')) {
      const line = this.next().line;
      l = { t: 'and', l, r: this.notExpr(), line };
    }
    return l;
  }

  private notExpr(): Expr {
    if (this.isKw('NOT')) {
      const line = this.next().line;
      return { t: 'not', e: this.notExpr(), line };
    }
    return this.comparison();
  }

  private comparison(): Expr {
    const l = this.additive();
    const t = this.peek();
    if (t.type === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(t.text)) {
      this.pos++;
      return { t: 'cmp', op: t.text as CmpOp, l, r: this.additive(), line: t.line };
    }
    if (this.isKw('LIKE')) {
      const line = this.next().line;
      return { t: 'like', e: l, pat: this.additive(), line };
    }
    if (this.isKw('IN')) {
      const line = this.next().line;
      this.eatOp('(');
      const list = [this.expr()];
      while (this.isOp(',')) { this.pos++; list.push(this.expr()); }
      this.eatOp(')');
      return { t: 'in', e: l, list, line };
    }
    if (this.isKw('IS')) {
      const line = this.next().line;
      let neg = false;
      if (this.isKw('NOT')) { this.pos++; neg = true; }
      this.eatKw('NULL');
      return { t: 'isnull', e: l, neg, line };
    }
    return l;
  }

  private additive(): Expr {
    let l = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.text === '+' || t.text === '-')) {
        this.pos++;
        l = { t: 'bin', op: t.text as '+' | '-', l, r: this.multiplicative(), line: t.line };
      } else return l;
    }
  }

  private multiplicative(): Expr {
    let l = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.text === '*' || t.text === '/')) {
        this.pos++;
        l = { t: 'bin', op: t.text as '*' | '/', l, r: this.unary(), line: t.line };
      } else return l;
    }
  }

  private unary(): Expr {
    if (this.isOp('-')) {
      const line = this.next().line;
      return { t: 'neg', e: this.unary(), line };
    }
    return this.primary();
  }

  private primary(): Expr {
    const t = this.peek();
    if (t.type === 'number') { this.pos++; return { t: 'num', n: t.value, line: t.line }; }
    if (t.type === 'string') { this.pos++; return { t: 'str', s: t.value, line: t.line }; }
    if (t.type === 'word' && t.up === 'NULL') { this.pos++; return { t: 'null', line: t.line }; }
    if (t.type === 'word' && AGGREGATES[t.up] === true && this.toks[this.pos + 1]!.type === 'op' && this.toks[this.pos + 1]!.text === '(') {
      this.pos += 2;                            // FN (
      const fn = t.up as AggFn;
      let arg: Expr | '*';
      if (this.isOp('*')) {
        if (t.up !== 'COUNT') throw new SqlSyntaxError(t.line, `${t.up}(*) is not allowed — only COUNT(*)`);
        this.pos++;
        arg = '*';
      } else {
        arg = this.expr();
      }
      this.eatOp(')');
      return { t: 'agg', fn, arg, line: t.line };
    }
    if (t.type === 'word') {
      const ref = this.colRef();
      return { t: 'col', table: ref.table, name: ref.name, line: ref.line };
    }
    if (this.isOp('(')) {
      this.pos++;
      const e = this.expr();
      this.eatOp(')');
      return e;
    }
    throw new SqlSyntaxError(t.line, `expected an expression — got ${shown(t)}`);
  }
}

function shown(t: Token): string {
  if (t.type === 'end') return 'end of input';
  return `'${t.text}'`;
}

/** Parse a block into statements; throws SqlSyntaxError (1-based line). */
export function parseProgram(src: string): Stmt[] {
  return new Parser(tokenize(src)).parseProgram();
}

/** Parse one expression (used by tests only). */
export function parseExpr(src: string): Expr {
  const p = new Parser(tokenize(src));
  return p.expr();
}
