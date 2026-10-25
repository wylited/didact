// parser.ts — recursive-descent parser producing a line-annotated AST for
// the teaching subset. Strict by design: anything outside the subset is a
// load-time SyntaxError that names the construct and its 1-based line, so
// the site can point at exactly what to remove.

import { tokenize, type Token } from './lexer';

// ─── AST ───────────────────────────────────────────────────────────────────

export interface Node {
  line: number; // 1-based source line
}

export type Expression =
  | (Node & { type: 'Num'; value: number })
  | (Node & { type: 'Str'; value: string })
  | (Node & { type: 'Tpl'; parts: (string | Expression)[] })
  | (Node & { type: 'Bool'; value: boolean })
  | (Node & { type: 'Null' })
  | (Node & { type: 'Undefined' })
  | (Node & { type: 'Ident'; name: string })
  | (Node & { type: 'Func'; name: string | null; params: string[]; body: Statement[]; expression?: Expression; isArrow?: boolean })
  | (Node & { type: 'Unary'; op: string; arg: Expression })
  | (Node & { type: 'Binary'; op: string; left: Expression; right: Expression })
  | (Node & { type: 'Logical'; op: string; left: Expression; right: Expression })
  | (Node & { type: 'Member'; object: Expression; property: Expression | null; name: string | null })
  | (Node & { type: 'Member'; object: Expression; property: Expression | null; name: string | null })
  | (Node & { type: 'Assign'; op: string; target: Expression; value: Expression })
  | (Node & { type: 'ArrayLit'; elements: Expression[] })
  | (Node & { type: 'ObjectLit'; entries: { key: string; value: Expression }[] })
  | (Node & { type: 'Call'; callee: Expression; args: Expression[] });

export type Statement =
  | (Node & { type: 'Empty' })
  | (Node & { type: 'ExprStmt'; expr: Expression })
  | (Node & { type: 'VarDecl'; kind: 'var' | 'let' | 'const'; name: string; init: Expression | null })
  | (Node & { type: 'FuncDecl'; name: string; params: string[]; body: Statement[] })
  | (Node & { type: 'Block'; body: Statement[] })
  | (Node & { type: 'If'; test: Expression; consequent: Statement; alternate: Statement | null })
  | (Node & { type: 'While'; test: Expression; body: Statement })
  | (Node & { type: 'For'; init: Statement | null; test: Expression | null; update: Expression | null; body: Statement })
  | (Node & { type: 'Return'; value: Expression | null })
  | (Node & { type: 'Break' })
  | (Node & { type: 'Continue' });

export type BlockStmt = Extract<Statement, { type: 'Block' }>;

export interface Program {
  body: Statement[];
}

// ─── errors ────────────────────────────────────────────────────────────────

export class ParseError extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

/** Load-time rejection wording: one rule, quoted verbatim in tests/lesson. */
export const NOT_IN_SUBSET = 'is not in the teaching subset';

// ─── parser ────────────────────────────────────────────────────────────────

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=']);

export function parse(src: string): Program {
  return new Parser(tokenize(src)).parseProgram();
}

class Parser {
  private pos = 0;

  constructor(private toks: Token[]) {}

  // -- token helpers -----------------------------------------------------

  private peek(offset = 0): Token {
    return this.toks[Math.min(this.pos + offset, this.toks.length - 1)]!;
  }
  private next(): Token {
    return this.toks[this.pos++] ?? this.toks[this.toks.length - 1]!;
  }
  private at(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return (t.type === 'punct' || t.type === 'kw' || t.type === 'tplstart') && t.value === value;
  }
  private eat(value: string): boolean {
    if (this.at(value)) { this.pos++; return true; }
    return false;
  }
  private expect(value: string): Token {
    if (!this.at(value)) {
      const t = this.peek();
      throw new ParseError(`expected '${value}' but found ${describe(t)}`, t.line);
    }
    return this.next();
  }
  /** An identifier that is not a reserved word. */
  private ident(context: string): Token {
    const t = this.peek();
    if (t.type !== 'name') {
      throw new ParseError(`expected ${context} but found ${describe(t)}`, t.line);
    }
    return this.next();
  }

  // -- unsupported constructs: named, line-mapped rejections --------------

  /** Rejected keywords, each reported with the construct it introduces. */
  private reject(t: Token): never {
    const what: Record<string, string> = {
      class: 'class', this: 'this', new: 'new', async: 'async functions',
      await: 'await', yield: 'generators', instanceof: 'instanceof',
      delete: 'delete', do: 'do-while', in: "'in' expressions", of: "'of' expressions",
    };
    throw new ParseError(`'${what[t.value] ?? t.value}' ${NOT_IN_SUBSET}`, t.line);
  }

  // -- program & statements ----------------------------------------------

  parseProgram(): Program {
    const body: Statement[] = [];
    while (this.peek().type !== 'eof') body.push(this.parseStatement());
    this.checkLexicalRedeclares(body, new Set());
    return { body };
  }

  private parseStatement(): Statement {
    const t = this.peek();
    if (t.type === 'kw') {
      switch (t.value) {
        case 'var': case 'let': case 'const': return this.parseVarDecl();
        case 'function': {
          if (this.peek(1).value === '*') {
            throw new ParseError(`generators ${NOT_IN_SUBSET}`, t.line);
          }
          return this.parseFuncDecl();
        }
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'for': return this.parseFor();
        case 'return': return this.parseReturn();
        case 'break': {
          this.next();
          this.eat(';');
          return { type: 'Break', line: t.line };
        }
        case 'continue': {
          this.next();
          this.eat(';');
          return { type: 'Continue', line: t.line };
        }
        default: this.reject(t);
      }
    }
    if (this.at('{')) return this.parseBlock();
    if (this.eat(';')) return { type: 'Empty', line: t.line };
    const expr = this.parseExpression();
    this.eat(';');
    return { type: 'ExprStmt', expr, line: t.line };
  }

  private parseVarDecl(): Statement {
    const kw = this.next(); // var/let/const keyword
    const name = this.parseBindingTarget('a variable name');
    if (this.eat('=')) {
      const init = this.parseAssignment();
      this.eat(';');
      return { type: 'VarDecl', kind: kw.value as 'var' | 'let' | 'const', name, init, line: kw.line };
    }
    if (kw.value === 'const') {
      throw new ParseError('Missing initializer in const declaration', kw.line);
    }
    this.eat(';');
    return { type: 'VarDecl', kind: kw.value as 'var' | 'let' | 'const', name, init: null, line: kw.line };
  }

  /** Binding position: only a plain identifier; '['/'{' = destructuring. */
  private parseBindingTarget(context: string): string {
    if (this.at('[') || this.at('{')) {
      throw new ParseError(`destructuring ${NOT_IN_SUBSET}`, this.peek().line);
    }
    return this.ident(context).value;
  }

  private parseFuncDecl(): Statement {
    const fn = this.next(); // 'function'
    const name = this.ident('a function name').value;
    const params = this.parseParams();
    const body = this.parseBlock();
    return { type: 'FuncDecl', name, params, body: body.body, line: fn.line };
  }

  private parseParams(): string[] {
    this.expect('(');
    const params: string[] = [];
    while (!this.at(')')) {
      if (this.at('...')) throw new ParseError(`spread parameters ${NOT_IN_SUBSET}`, this.peek().line);
      params.push(this.parseBindingTarget('a parameter name'));
      if (!this.eat(',')) break;
    }
    this.expect(')');
    const seen = new Set<string>();
    for (const p of params) {
      if (seen.has(p)) throw new ParseError(`duplicate parameter '${p}'`, this.peek().line);
      seen.add(p);
    }
    return params;
  }

  private parseBlock(): BlockStmt {
    const open = this.expect('{');
    const body: Statement[] = [];
    while (!this.at('}') && this.peek().type !== 'eof') body.push(this.parseStatement());
    this.expect('}');
    this.checkLexicalRedeclares(body, new Set());
    return { type: 'Block', body, line: open.line };
  }

  /** let/const (and their clash with var) must collide at load time. */
  private checkLexicalRedeclares(body: Statement[], lexical: Set<string>): void {
    for (const s of body) {
      if (s.type === 'VarDecl') {
        if (lexical.has(s.name)) {
          throw new ParseError(`Identifier '${s.name}' has already been declared`, s.line);
        }
        if (s.kind !== 'var') lexical.add(s.name);
      }
    }
  }

  private parseIf(): Statement {
    const kw = this.next();
    this.expect('(');
    const test = this.parseExpression();
    this.expect(')');
    const consequent = this.parseStatement();
    let alternate: Statement | null = null;
    if (this.at('else')) {
      this.next();
      alternate = this.parseStatement();
    }
    return { type: 'If', test, consequent, alternate, line: kw.line };
  }

  private parseWhile(): Statement {
    const kw = this.next();
    this.expect('(');
    const test = this.parseExpression();
    this.expect(')');
    const body = this.parseStatement();
    return { type: 'While', test, body, line: kw.line };
  }

  private parseFor(): Statement {
    const kw = this.next();
    this.expect('(');
    // for-in / for-of, detected before any init expression is parsed:
    // `for (x in y)` puts 'in' one token out, `for (var x in y)` two.
    const t1 = this.peek();
    const declHead = t1.value === 'var' || t1.value === 'let' || t1.value === 'const';
    const off = declHead ? 2 : 1;
    if ((t1.type === 'name' || declHead) && (this.at('in', off) || this.at('of', off))) {
      const form = this.at('in', off) ? 'for-in' : 'for-of';
      throw new ParseError(`${form} loops ${NOT_IN_SUBSET}`, t1.line);
    }
    let init: Statement | null = null;
    if (!this.at(';')) {
      if (this.at('var') || this.at('let') || this.at('const')) {
        const d = this.parseVarDeclFor();
        init = d;
      } else {
        const expr = this.parseExpression();
        init = { type: 'ExprStmt', expr, line: expr.line };
        this.eat(';');
      }
    } else {
      this.next();
    }
    const test = this.at(';') ? null : this.parseExpression();
    this.expect(';');
    const update = this.at(')') ? null : this.parseExpression();
    this.expect(')');
    const body = this.parseStatement();
    return { type: 'For', init, test, update, body, line: kw.line };
  }

  /** for-head declaration: same shape as parseVarDecl but ';' terminated. */
  private parseVarDeclFor(): Statement {
    const kw = this.next();
    const name = this.parseBindingTarget('a variable name');
    if (this.eat('=')) {
      const init = this.parseAssignment();
      this.expect(';');
      return { type: 'VarDecl', kind: kw.value as 'var' | 'let' | 'const', name, init, line: kw.line };
    }
    if (kw.value === 'const') throw new ParseError('Missing initializer in const declaration', kw.line);
    this.expect(';');
    return { type: 'VarDecl', kind: kw.value as 'var' | 'let' | 'const', name, init: null, line: kw.line };
  }

  private parseReturn(): Statement {
    const kw = this.next();
    let value: Expression | null = null;
    if (!this.at(';') && !this.at('}') && this.peek().type !== 'eof' && !this.at(')')) {
      value = this.parseExpression();
    }
    this.eat(';');
    return { type: 'Return', value, line: kw.line };
  }

  // -- expressions (precedence climbing) ----------------------------------

  parseExpression(): Expression {
    return this.parseAssignment();
  }

  private parseAssignment(): Expression {
    // Arrow functions introduce themselves: `x => …` or `(a, b) => …`.
    const arrow = this.tryParseArrow();
    if (arrow !== null) return arrow;
    const left = this.parseBinary(0);
    const t = this.peek();
    if (t.type === 'punct' && ASSIGN_OPS.has(t.value)) {
      if (left.type !== 'Ident' && left.type !== 'Member') {
        throw new ParseError('invalid assignment target', t.line);
      }
      this.next();
      const value = this.parseAssignment();
      return { type: 'Assign', op: t.value, target: left, value, line: t.line };
    }
    return left;
  }

  /** Lookahead-based arrow detection: `ident =>` or `( … ) =>`. */
  private tryParseArrow(): Expression | null {
    const t = this.peek();
    if (t.type === 'name' && this.at('=>', 1)) {
      this.next(); this.next();
      return this.finishArrow([t.value], t.line);
    }
    if (!this.at('(')) return null;
    // Scan past the balanced paren group; an '=>' right after means arrow.
    let depth = 0;
    let j = this.pos;
    for (; ; j++) {
      const tok = this.toks[j]!;
      if (tok.type === 'eof') return null;
      if (tok.type === 'punct' && tok.value === '(') depth++;
      if (tok.type === 'punct' && tok.value === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (!this.at('=>', j - this.pos + 1)) return null;
    const params = this.parseParams();
    this.expect('=>');
    return this.finishArrow(params, t.line);
  }

  private finishArrow(params: string[], line: number): Expression {
    if (this.at('{')) {
      const body = this.parseBlock();
      return { type: 'Func', name: null, params, body: body.body, isArrow: true, line };
    }
    const expression = this.parseAssignment();
    return { type: 'Func', name: null, params, body: [], expression, isArrow: true, line };
  }

  // Binary operator precedence table (higher binds tighter).
  private static readonly LEVELS: string[][] = [
    ['||'], ['&&'], ['==', '!=', '===', '!=='], ['<', '>', '<=', '>='],
    ['+', '-'], ['*', '/', '%'], ['**'],
  ];

  private parseBinary(level: number): Expression {
    if (level >= Parser.LEVELS.length) return this.parseUnary();
    const ops = Parser.LEVELS[level]!;
    let left = this.parseBinary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.type === 'punct' && ops.includes(t.value)) {
        this.next();
        const right = this.parseBinary(level + 1); // left-assoc; ** is close enough for the subset
        const kind = t.value === '||' || t.value === '&&' ? 'Logical' : 'Binary';
        left = { type: kind, op: t.value, left, right, line: t.line } as Expression;
      } else {
        return left;
      }
    }
  }

  private parseUnary(): Expression {
    const t = this.peek();
    if (t.type === 'punct' && (t.value === '!' || t.value === '-' || t.value === '+')) {
      this.next();
      return { type: 'Unary', op: t.value, arg: this.parseUnary(), line: t.line };
    }
    if (t.type === 'kw' && t.value === 'typeof') {
      this.next();
      return { type: 'Unary', op: 'typeof', arg: this.parseUnary(), line: t.line };
    }
    if (t.type === 'punct' && (t.value === '++' || t.value === '--')) {
      throw new ParseError(`'${t.value}' ${NOT_IN_SUBSET} (use x = x + 1)`, t.line);
    }
    if (t.type === 'punct' && t.value === '?') {
      throw new ParseError(`the conditional operator '?:' ${NOT_IN_SUBSET} (use if/else)`, t.line);
    }
    return this.parseCallMember();
  }

  private parseCallMember(): Expression {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.at('.')) {
        this.next();
        const prop = this.ident('a property name after .');
        expr = { type: 'Member', object: expr, property: null, name: prop.value, line: prop.line };
      } else if (this.at('[')) {
        const open = this.next();
        const index = this.parseExpression();
        this.expect(']');
        expr = { type: 'Member', object: expr, property: index, name: null, line: open.line };
      } else if (this.at('(')) {
        this.next();
        const args: Expression[] = [];
        while (!this.at(')')) {
          if (this.at('...')) throw new ParseError(`spread arguments ${NOT_IN_SUBSET}`, this.peek().line);
          args.push(this.parseAssignment());
          if (!this.eat(',')) break;
        }
        this.expect(')');
        expr = { type: 'Call', callee: expr, args, line: expr.line };
      } else {
        return expr;
      }
    }
  }

  private parsePrimary(): Expression {
    const t = this.peek();
    if (t.type === 'num') { this.next(); return { type: 'Num', value: Number(t.value), line: t.line }; }
    if (t.type === 'str') { this.next(); return { type: 'Str', value: t.value, line: t.line }; }
    if (t.type === 'tplchunk') return this.parseTemplate();
    if (t.type === 'name') { this.next(); return { type: 'Ident', name: t.value, line: t.line }; }
    if (t.type === 'kw') {
      switch (t.value) {
        case 'true': case 'false':
          this.next(); return { type: 'Bool', value: t.value === 'true', line: t.line };
        case 'null': this.next(); return { type: 'Null', line: t.line };
        case 'undefined': this.next(); return { type: 'Undefined', line: t.line };
        case 'function': {
          if (this.peek(1).value === '*') throw new ParseError(`generators ${NOT_IN_SUBSET}`, t.line);
          this.next();
          let name: string | null = null;
          if (this.peek().type === 'name') name = this.next().value;
          const params = this.parseParams();
          const body = this.parseBlock();
          return { type: 'Func', name, params, body: body.body, line: t.line };
        }
        default: this.reject(t);
      }
    }
    if (this.at('(')) {
      this.next();
      const expr = this.parseExpression();
      this.expect(')');
      return expr;
    }
    if (this.at('[')) return this.parseArray();
    if (this.at('{')) return this.parseObject();
    if (this.at('...')) throw new ParseError(`spread ${NOT_IN_SUBSET}`, t.line);
    throw new ParseError(`unexpected ${describe(t)}`, t.line);
  }

  private parseTemplate(): Expression {
    const first = this.next(); // tplchunk token (may be empty)
    const parts: (string | Expression)[] = [first.value];
    while (this.at('${')) {
      this.next(); // tplstart
      parts.push(this.parseExpression());
      const end = this.peek();
      if (end.type !== 'tplend') throw new ParseError(`expected '}' to close \${ but found ${describe(end)}`, end.line);
      this.next();
      const chunk = this.peek();
      if (chunk.type !== 'tplchunk') {
        throw new ParseError(`expected template text after '}' but found ${describe(chunk)}`, chunk.line);
      }
      this.next();
      parts.push(chunk.value);
    }
    return { type: 'Tpl', parts, line: first.line };
  }

  private parseArray(): Expression {
    const open = this.expect('[');
    const elements: Expression[] = [];
    while (!this.at(']')) {
      if (this.at('...')) throw new ParseError(`spread ${NOT_IN_SUBSET}`, this.peek().line);
      elements.push(this.parseAssignment());
      if (!this.eat(',')) break;
    }
    this.expect(']');
    return { type: 'ArrayLit', elements, line: open.line };
  }

  private parseObject(): Expression {
    const open = this.expect('{');
    const entries: { key: string; value: Expression }[] = [];
    while (!this.at('}')) {
      if (this.at('...')) throw new ParseError(`spread ${NOT_IN_SUBSET}`, this.peek().line);
      if (this.at('[')) throw new ParseError(`computed object keys ${NOT_IN_SUBSET}`, this.peek().line);
      const kt = this.peek();
      let key: string;
      if (kt.type === 'name' || kt.type === 'str' || kt.type === 'num') { this.next(); key = kt.value; }
      else throw new ParseError(`expected an object key but found ${describe(kt)}`, kt.line);
      let value: Expression;
      if (this.eat(':')) {
        value = this.parseAssignment();
      } else if (kt.type === 'name') {
        value = { type: 'Ident', name: kt.value, line: kt.line }; // shorthand {x}
      } else {
        throw new ParseError(`expected ':' after key '${key}'`, kt.line);
      }
      entries.push({ key, value });
      if (!this.eat(',')) break;
    }
    this.expect('}');
    return { type: 'ObjectLit', entries, line: open.line };
  }
}

function describe(t: Token): string {
  if (t.type === 'eof') return 'end of input';
  return `'${t.value}'`;
}
