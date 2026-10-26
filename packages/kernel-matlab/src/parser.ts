// parser.ts — recursive-descent parser for the MATLAB-flavored teaching
// subset. Every construct the language refuses (cells, structs, function
// handles, try/catch, …) is refused HERE with a line-mapped
// "not in the teaching subset" message, so a block never starts running
// if it contains something the interpreter cannot model honestly.
//
// Two MATLAB-isms handled explicitly:
//   * 'end' is a block terminator at statement level but an index-bound
//     expression inside parentheses — disambiguated with a paren depth;
//   * inside [ ] every space- or comma-separated item is ONE value: no
//     binary + or - between items ([(1-2)] computes, [1 - 2] is a row).

import { tokenize, type Token } from './lexer';

export const NOT_IN_SUBSET = 'not in the teaching subset:';

export class ParseError extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

// ─── AST ───────────────────────────────────────────────────────────────────

export type Expr =
  | { type: 'Num'; value: number; line: number }
  | { type: 'Str'; text: string; line: number }
  | { type: 'Name'; name: string; line: number }
  | { type: 'End'; line: number }
  /** A whole dimension in an index: A(:, 2). Only valid inside ( ). */
  | { type: 'Colon'; line: number }
  /** [ ] literal; rows of items, each item a restricted expression. */
  | { type: 'Matrix'; rows: Expr[][]; line: number }
  | { type: 'Range'; start: Expr; step: Expr | null; stop: Expr; line: number }
  | { type: 'Unary'; op: '-' | '~'; arg: Expr; line: number }
  | { type: 'Binary'; op: BinOp; left: Expr; right: Expr; line: number }
  | { type: 'Logic'; op: '&&' | '||'; left: Expr; right: Expr; line: number }
  | { type: 'Transpose'; arg: Expr; line: number }
  /** name(args) — indexing when `name` is a workspace variable, a call
   *  when it is a function or builtin (MATLAB resolves the same way). */
  | { type: 'Call'; name: string; args: Expr[]; line: number };

export type BinOp =
  | '+' | '-' | '*' | '/' | '\\' | '.*' | './' | '.^' | '.\\' | '^'
  | '<' | '<=' | '>' | '>=' | '==' | '~=';

export interface FunctionDecl {
  kind: 'function';
  name: string;
  params: string[];
  /** null for `function f(x)` — no outputs declared. */
  outputs: string[] | null;
  body: Stmt[];
  line: number;
}

export type Stmt =
  | { type: 'Expr'; expr: Expr; quiet: boolean; line: number }
  | { type: 'Assign'; target: NameTarget; expr: Expr; quiet: boolean; line: number }
  | { type: 'MultiAssign'; names: string[]; call: Extract<Expr, { type: 'Call' }>; quiet: boolean; line: number }
  | { type: 'If'; arms: { cond: Expr; body: Stmt[] }[]; elseBody: Stmt[] | null; line: number }
  | { type: 'While'; cond: Expr; body: Stmt[]; line: number }
  | { type: 'For'; v: string; expr: Expr; body: Stmt[]; line: number }
  | { type: 'Break'; line: number }
  | { type: 'Return'; line: number };

export type NameTarget =
  | { kind: 'name'; name: string }
  | { kind: 'index'; name: string; args: Expr[] };

export interface Program {
  functions: FunctionDecl[];
  body: Stmt[];
}

// ─── parser ────────────────────────────────────────────────────────────────

const REFUSAL: Record<string, string> = {
  try: 'try/catch — an error stops the block and names its line',
  catch: 'try/catch — an error stops the block and names its line',
  global: "'global' — functions own their workspace; scripts share the base workspace",
  persistent: "'persistent' — functions own their workspace; scripts share the base workspace",
  switch: 'switch/case — use if / elseif / else',
  case: 'switch/case — use if / elseif / else',
  otherwise: 'switch/case — use if / elseif / else',
  classdef: 'classes (classdef)',
};

export function parse(src: string): Program {
  return new Parser(tokenize(src)).parseProgram();
}

class Parser {
  private pos = 0;
  /** > 0 while parsing inside ( ) — there 'end' is an index bound. */
  private parenDepth = 0;

  constructor(private toks: Token[]) {}

  // -- token plumbing ---------------------------------------------------

  private peek(k = 0): Token {
    return this.toks[Math.min(this.pos + k, this.toks.length - 1)]!;
  }

  private next(): Token {
    const t = this.toks[this.pos]!;
    if (t.type !== 'eof') this.pos++;
    return t;
  }

  private isPunct(v: string, k = 0): boolean {
    const t = this.peek(k);
    return t.type === 'punct' && t.value === v;
  }

  private isKw(v: string, k = 0): boolean {
    const t = this.peek(k);
    return t.type === 'kw' && t.value === v;
  }

  private eatPunct(v: string): Token {
    if (!this.isPunct(v)) {
      throw new ParseError(`expected '${v}'`, this.peek().line);
    }
    return this.next();
  }

  private eatKw(v: string): Token {
    if (!this.isKw(v)) {
      throw new ParseError(`expected '${v}'`, this.peek().line);
    }
    return this.next();
  }

  /** Skip statement/matrix separators: ';', ',' and newlines. */
  private skipSeparators(): void {
    while (this.peek().type === 'nl' || this.isPunct(';') || this.isPunct(',')) this.pos++;
  }

  private skipNewlines(): void {
    while (this.peek().type === 'nl') this.pos++;
  }

  // -- program ----------------------------------------------------------

  parseProgram(): Program {
    const functions: FunctionDecl[] = [];
    for (;;) {
      this.skipSeparators();
      if (!this.isKw('function')) break;
      functions.push(this.parseFunction());
    }
    const body: Stmt[] = [];
    this.skipSeparators();
    while (this.peek().type !== 'eof') {
      if (this.isKw('function')) {
        throw new ParseError(
          'functions must be defined at the top of the block — scripts come after',
          this.peek().line,
        );
      }
      body.push(this.parseStmt());
      this.endOfSimple();
      this.skipSeparators();
    }
    return { functions, body };
  }

  private parseFunction(): FunctionDecl {
    const fn = this.eatKw('function');
    let outputs: string[] | null = null;
    if (this.isPunct('[')) {
      this.next();
      const names: string[] = [];
      for (;;) {
        const t = this.next();
        if (t.type === 'name') names.push(t.value);
        else if (t.type === 'punct' && t.value === ']') break;
        else if (t.type === 'punct' && t.value === ',') continue;
        else throw new ParseError("expected an output name, ',' or ']'", t.line);
        if (names.length > 0 && this.isPunct(',') && this.isPunct(']', 1)) {
          throw new ParseError("expected an output name after ','", this.peek().line);
        }
      }
      outputs = names;
      this.eatPunct('=');
    } else {
      const t = this.peek();
      if (t.type === 'name' && this.isPunct('=', 1)) {
        this.next(); // name
        this.next(); // =
        outputs = [t.value];
      }
    }
    const nameTok = this.next();
    if (nameTok.type !== 'name') {
      throw new ParseError("expected the function's name", nameTok.line);
    }
    this.eatPunct('(');
    const params: string[] = [];
    while (!this.isPunct(')')) {
      const t = this.next();
      if (t.type === 'name') params.push(t.value);
      else if (t.type === 'punct' && t.value === ',') continue;
      else throw new ParseError("expected a parameter name, ',' or ')'", t.line);
    }
    this.eatPunct(')');
    const body = this.parseStmtList(['end']);
    this.eatKw('end');
    // A nested `function` keyword is refused by parseStmt with a
    // line-mapped "functions must be defined at the top of the block".
    return { kind: 'function', name: nameTok.value, params, outputs, body, line: fn.line };
  }

  // -- statements -------------------------------------------------------

  /** Parse statements until a block-closing keyword or EOF; separators
   *  between statements are required (newline, ';' or ','). */
  private parseStmtList(closers: string[]): Stmt[] {
    const out: Stmt[] = [];
    this.skipSeparators();
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') {
        if (closers.length > 0) {
          throw new ParseError(`missing 'end' — every if/for/while/function block needs one`, t.line);
        }
        return out;
      }
      if (t.type === 'kw' && closers.includes(t.value)) return out;
      if (t.type === 'kw' && ['else', 'elseif', 'end'].includes(t.value)) {
        throw new ParseError(`'${t.value}' without a matching if/for/while/function`, t.line);
      }
      out.push(this.parseStmt());
      this.endOfSimple();
      this.skipSeparators();
    }
  }

  /** After a statement: ';', ',', newline, a closing keyword or EOF. */
  private endOfSimple(): void {
    const t = this.peek();
    if (t.type === 'nl' || t.type === 'eof') return;
    if (t.type === 'punct' && (t.value === ';' || t.value === ',')) return;
    if (t.type === 'kw' && ['end', 'else', 'elseif'].includes(t.value)) return;
    throw new ParseError(`expected ';' (silent), ',' or a new line after the statement`, t.line);
  }

  private parseStmt(): Stmt {
    const t = this.peek();
    if (t.type === 'kw') {
      if (REFUSAL[t.value] !== undefined) {
        throw new ParseError(`${NOT_IN_SUBSET} ${REFUSAL[t.value]}`, t.line);
      }
      switch (t.value) {
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'for': return this.parseFor();
        case 'break': this.next(); return { type: 'Break', line: t.line };
        case 'return': this.next(); return { type: 'Return', line: t.line };
        case 'function':
          throw new ParseError('functions must be defined at the top of the block — scripts come after', t.line);
      }
      if (t.value === 'end' || t.value === 'else' || t.value === 'elseif') {
        throw new ParseError(`'${t.value}' without a matching if/for/while/function`, t.line);
      }
      throw new ParseError(`unexpected keyword '${t.value}'`, t.line);
    }
    return this.parseSimple();
  }

  private parseIf(): Stmt {
    const kw = this.eatKw('if');
    const arms: { cond: Expr; body: Stmt[] }[] = [];
    const cond = this.parseExpr();
    this.endOfSimple();
    arms.push({ cond, body: this.parseStmtList(['elseif', 'else', 'end']) });
    let elseBody: Stmt[] | null = null;
    for (;;) {
      if (this.isKw('elseif')) {
        this.next();
        const c = this.parseExpr();
        this.endOfSimple();
        arms.push({ cond: c, body: this.parseStmtList(['elseif', 'else', 'end']) });
      } else if (this.isKw('else')) {
        this.next();
        elseBody = this.parseStmtList(['end']);
        this.eatKw('end');
        break;
      } else {
        this.eatKw('end');
        break;
      }
    }
    return { type: 'If', arms, elseBody, line: kw.line };
  }

  private parseWhile(): Stmt {
    const kw = this.eatKw('while');
    const cond = this.parseExpr();
    this.endOfSimple();
    const body = this.parseStmtList(['end']);
    this.eatKw('end');
    return { type: 'While', cond, body, line: kw.line };
  }

  private parseFor(): Stmt {
    const kw = this.eatKw('for');
    const v = this.next();
    if (v.type !== 'name') throw new ParseError("expected the loop variable's name", v.line);
    this.eatPunct('=');
    const expr = this.parseExpr();
    this.endOfSimple();
    const body = this.parseStmtList(['end']);
    this.eatKw('end');
    return { type: 'For', v: v.value, expr, body, line: kw.line };
  }

  private parseSimple(): Stmt {
    const startTok = this.peek();
    const expr = this.parseExpr();
    if (this.isPunct('=')) {
      this.next();
      const rhs = this.parseExpr();
      return this.makeAssignment(expr, rhs, startTok.line);
    }
    // 'quiet' = the statement ended with ';' (echo suppressed)
    const quiet = this.isPunct(';');
    return { type: 'Expr', expr, quiet, line: startTok.line };
  }

  private makeAssignment(lhs: Expr, rhs: Expr, line: number): Stmt {
    const quiet = this.isPunct(';');
    if (lhs.type === 'Name') {
      return { type: 'Assign', target: { kind: 'name', name: lhs.name }, expr: rhs, quiet, line };
    }
    if (lhs.type === 'Call') {
      return { type: 'Assign', target: { kind: 'index', name: lhs.name, args: lhs.args }, expr: rhs, quiet, line };
    }
    if (lhs.type === 'Matrix' && lhs.rows.length === 1
      && lhs.rows[0]!.every((it) => it.type === 'Name')) {
      if (rhs.type !== 'Call') {
        throw new ParseError(
          "'[a, b] = …' needs a function call on the right — only a function can return two outputs",
          line,
        );
      }
      const names = lhs.rows[0]!.map((it) => (it as Extract<Expr, { type: 'Name' }>).name);
      return { type: 'MultiAssign', names, call: rhs, quiet, line };
    }
    throw new ParseError(
      "the left side of '=' must be a name (A), an index (A(i,j)) or outputs ([a, b])",
      line,
    );
  }

  // -- expressions (loosest → tightest) ─────────────────────────────────

  parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isPunct('||')) {
      const op = this.next();
      const right = this.parseAnd();
      left = { type: 'Logic', op: '||', left, right, line: op.line };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseCmp();
    while (this.isPunct('&&')) {
      const op = this.next();
      const right = this.parseCmp();
      left = { type: 'Logic', op: '&&', left, right, line: op.line };
    }
    return left;
  }

  private parseCmp(): Expr {
    const left = this.parseRange();
    for (const op of ['==', '~=', '<=', '>=', '<', '>'] as const) {
      if (this.isPunct(op)) {
        const t = this.next();
        const right = this.parseRange();
        if (this.peek().type === 'punct' && ['==', '~=', '<=', '>=', '<', '>'].includes(this.peek().value)) {
          throw new ParseError('chained comparisons are not in the teaching subset — combine with &&', this.peek().line);
        }
        return { type: 'Binary', op, left, right, line: t.line };
      }
    }
    return left;
  }

  /** start : stop  or  start : step : stop (MATLAB precedence: between
   *  comparisons and + / -). */
  private parseRange(): Expr {
    const start = this.parseAdd();
    if (!this.isPunct(':')) return start;
    const colon = this.next();
    const second = this.parseAdd();
    if (!this.isPunct(':')) {
      return { type: 'Range', start, step: null, stop: second, line: colon.line };
    }
    this.next();
    const third = this.parseAdd();
    if (this.isPunct(':')) {
      throw new ParseError("too many ':' — a range is start:stop or start:step:stop", this.peek().line);
    }
    return { type: 'Range', start, step: second, stop: third, line: colon.line };
  }

  private parseAdd(): Expr {
    let left = this.parseMul();
    while (this.isPunct('+') || this.isPunct('-')) {
      const op = this.next();
      const right = this.parseMul();
      left = { type: 'Binary', op: op.value as '+' | '-', left, right, line: op.line };
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    while (this.isPunct('*') || this.isPunct('/') || this.isPunct('\\')
      || this.isPunct('.*') || this.isPunct('./') || this.isPunct('.^') || this.isPunct('.\\') || this.isPunct('^')) {
      const op = this.next();
      const right = this.parseUnary();
      left = { type: 'Binary', op: op.value as BinOp, left, right, line: op.line };
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.type === 'punct' && (t.value === '-' || t.value === '~')) {
      this.next();
      return { type: 'Unary', op: t.value, arg: this.parseUnary(), line: t.line };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    while (this.isPunct("'") || this.isPunct(".'")) {
      const t = this.next();
      e = { type: 'Transpose', arg: e, line: t.line };
    }
    if (this.isPunct('(')) {
      throw new ParseError(
        "cannot index a call or result directly — assign it to a name first, then index the name",
        this.peek().line,
      );
    }
    if (this.isPunct('.')) {
      throw new ParseError(`${NOT_IN_SUBSET} structs (a.b) — matrices are the only data structure`, this.peek().line);
    }
    return e;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.type === 'num') {
      this.next();
      return { type: 'Num', value: Number(t.value), line: t.line };
    }
    if (t.type === 'str') {
      this.next();
      return { type: 'Str', text: t.value, line: t.line };
    }
    if (t.type === 'name') {
      this.next();
      if (this.isPunct('(')) {
        return { type: 'Call', name: t.value, args: this.parseArgs(), line: t.line };
      }
      return { type: 'Name', name: t.value, line: t.line };
    }
    if (t.type === 'kw' && t.value === 'end' && this.parenDepth > 0) {
      this.next();
      return { type: 'End', line: t.line };
    }
    if (this.isPunct('(')) {
      this.next();
      this.parenDepth++;
      const e = this.parseExpr();
      this.parenDepth--;
      this.eatPunct(')');
      return e;
    }
    if (this.isPunct('[')) {
      return this.parseMatrixLit();
    }
    if (this.isPunct('{')) {
      throw new ParseError(`${NOT_IN_SUBSET} cell arrays ({}) — matrices are the only data structure`, t.line);
    }
    if (this.isPunct('@')) {
      throw new ParseError(`${NOT_IN_SUBSET} anonymous functions (@)`, t.line);
    }
    if (t.type === 'kw') {
      throw new ParseError(`unexpected keyword '${t.value}'`, t.line);
    }
    throw new ParseError(`expected a value, name, '(' or '['`, t.line);
  }

  /** Comma-separated index arguments; ':' alone is a whole dimension. */
  private parseArgs(): Expr[] {
    this.eatPunct('(');
    this.parenDepth++;
    const args: Expr[] = [];
    for (;;) {
      if (this.isPunct(':')) {
        const t = this.next();
        args.push({ type: 'Colon', line: t.line });
      } else {
        args.push(this.parseExpr());
      }
      if (this.isPunct(',')) { this.next(); continue; }
      break;
    }
    this.parenDepth--;
    this.eatPunct(')');
    if (args.length === 0) {
      throw new ParseError('an index needs at least one argument', this.peek().line);
    }
    return args;
  }

  // -- matrix literals ---------------------------------------------------

  /** [ ] literal: rows separated by ';' or newline, items by space or ','.
   *  An item is ONE value: a number, name, call, range, (expr), nested
   *  [ ], optionally negated or transposed — never binary arithmetic. */
  private parseMatrixLit(): Expr {
    const open = this.eatPunct('[');
    const rows: Expr[][] = [];
    let row: Expr[] = [];
    for (;;) {
      const t = this.peek();
      if (this.isPunct(']')) {
        this.next();
        if (row.length > 0) rows.push(row);
        break;
      }
      if (t.type === 'eof') {
        throw new ParseError(`missing ']' to close the matrix literal`, t.line);
      }
      // ';' and newline both end a row; repeated separators add nothing
      if (this.isPunct(';') || t.type === 'nl') {
        this.next();
        if (row.length > 0) { rows.push(row); row = []; }
        continue;
      }
      row.push(this.parseItem());
      if (this.isPunct(',')) this.next();
    }
    return { type: 'Matrix', rows, line: open.line };

  }

  /** One item inside [ ] — restricted grammar, see parseMatrixLit. */
  private parseItem(): Expr {
    const t = this.peek();
    let neg = false;
    if (this.isPunct('-')) {
      neg = true;
      this.next();
    }
    let e: Expr = this.parsePostfix();
    if (this.isPunct(':')) {
      // range whose parts are items: 1:0.5:3, a:b, A(1):A(2)
      const colon = this.next();
      const second = this.parsePostfix();
      let step: Expr | null = null;
      let stop = second;
      if (this.isPunct(':')) {
        this.next();
        step = second;
        stop = this.parsePostfix();
        if (this.isPunct(':')) {
          throw new ParseError("too many ':' — a range is start:stop or start:step:stop", t.line);
        }
      }
      e = { type: 'Range', start: e, step, stop, line: colon.line };
    }
    return neg ? { type: 'Unary', op: '-', arg: e, line: t.line } : e;
  }
}
