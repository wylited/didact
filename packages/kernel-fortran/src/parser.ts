// parser.ts — recursive-descent parser for the free-form Fortran
// teaching subset (F90/95 plus the F2003 pieces HPC code leans on:
// modules, allocatable arrays, derived types, array sections, `where`).
//
// Fortran has no reserved words, so statements are recognised by their
// leading word and context, exactly like a compiler front end. Anything
// the interpreter cannot model honestly is refused HERE with a
// line-mapped "not in the teaching subset" message, so a block never
// starts running half-parsed. Fixed-form source, `goto`/labels,
// pointers, `read`, and type-bound procedures are refused by name.

import { tokenize, type Token } from './lexer';

export const NOT_IN_SUBSET = 'not in the teaching subset:';

export class ParseError extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

// ─── types ─────────────────────────────────────────────────────────────────

export type TypeBase =
  | 'integer' | 'real' | 'logical' | 'character' | 'complex' | 'derived' | 'auto';

export interface TypeSpec {
  base: TypeBase;
  /** Resolved numeric kind (4, 8, …) once a declaration is processed. */
  kind?: number;
  /** Unevaluated `kind=` expression (`real(dp)`). */
  kindExpr?: Expr;
  /** Resolved character length, when declared. */
  charLen?: number;
  charLenExpr?: Expr;
  /** `character(*)` / `character(len=*)`: take the actual length. */
  charLenAssumed?: boolean;
  /** Derived type name for `type(t)`. */
  derived?: string;
}

export interface DimSpec {
  /** Lower bound expression; null means the Fortran default of 1. */
  lo: Expr | null;
  /** Upper bound; null with `deferred` means `:` (allocatable/assumed shape). */
  hi: Expr | null;
  deferred: boolean;
  assumedSize: boolean;
}

export interface Attrs {
  allocatable: boolean;
  parameter: boolean;
  save: boolean;
  pointer: boolean;
  optional: boolean;
  external: boolean;
  intrinsic: boolean;
  target: boolean;
  value: boolean;
  intent: 'in' | 'out' | 'inout' | null;
  dimension: DimSpec[] | null;
}

export interface Entity {
  name: string;
  dims: DimSpec[] | null;
  charLenExpr: Expr | null;
  init: Expr | null;
  line: number;
}

export interface Decl {
  type: TypeSpec;
  attrs: Attrs;
  entities: Entity[];
  line: number;
}

export interface DerivedDef {
  name: string;
  components: Decl[];
  line: number;
}

export interface UseStmt {
  module: string;
  only: string[] | null;
  line: number;
}

// ─── expressions ───────────────────────────────────────────────────────────

export interface Subscript {
  kind: 'range';
  lo: Expr | null;
  hi: Expr | null;
  step: Expr | null;
}

export interface Actual {
  name?: string;
  expr?: Expr;
  sub?: Subscript;
}

export type BinOp =
  | '+' | '-' | '*' | '/' | '**' | '//'
  | '==' | '/=' | '<' | '<=' | '>' | '>=' | 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'
  | 'and' | 'or' | 'eqv' | 'neqv';

export type Expr =
  | { t: 'int'; value: number; kind?: string; line: number }
  | { t: 'real'; value: number; kind?: string; line: number }
  | { t: 'logical'; value: boolean; line: number }
  | { t: 'string'; value: string; line: number }
  | { t: 'name'; name: string; line: number }
  | { t: 'apply'; base: Expr; args: Actual[]; line: number }
  | { t: 'component'; base: Expr; name: string; line: number }
  | { t: 'unary'; op: '+' | '-' | 'not'; arg: Expr; line: number }
  | { t: 'binary'; op: BinOp; left: Expr; right: Expr; line: number }
  | { t: 'array'; items: Expr[]; line: number }
  | { t: 'implied'; items: Expr[]; var: string; start: Expr; end: Expr; step: Expr | null; line: number };

// ─── statements ────────────────────────────────────────────────────────────

export interface Designator {
  base: string;
  parts: Part[];
  line: number;
}

export type Part =
  | { kind: 'subs'; args: Actual[] }
  | { kind: 'component'; name: string };

export interface CaseSelector {
  lo: Expr | null;
  hi: Expr | null;
}

export type Stmt =
  | { t: 'assign'; target: Designator; expr: Expr; line: number }
  | { t: 'call'; name: string; args: Actual[]; line: number }
  | {
      t: 'if'; construct: string | null;
      arms: { cond: Expr; body: Stmt[] }[];
      elseBody: Stmt[] | null; line: number;
    }
  | {
      t: 'do'; construct: string | null;
      varName: string | null; start: Expr | null; end: Expr | null;
      step: Expr | null; whileCond: Expr | null;
      body: Stmt[]; line: number;
    }
  | { t: 'exit'; construct: string | null; line: number }
  | { t: 'cycle'; construct: string | null; line: number }
  | {
      t: 'select'; expr: Expr;
      cases: { selectors: CaseSelector[]; body: Stmt[] }[];
      defaultBody: Stmt[] | null; line: number;
    }
  | { t: 'where'; mask: Expr; body: Stmt[]; elsewhere: { mask: Expr | null; body: Stmt[] }[]; line: number }
  | { t: 'print'; fmt: Expr | null; items: Expr[]; line: number }
  | { t: 'write'; unit: Expr | null; fmt: Expr | null; advance: Expr | null; items: Expr[]; line: number }
  | { t: 'allocate'; items: { name: string; dims: DimSpec[] }[]; stat: string | null; line: number }
  | { t: 'deallocate'; names: string[]; stat: string | null; line: number }
  | { t: 'stop'; message: Expr | null; isError: boolean; line: number }
  | { t: 'return'; line: number }
  | { t: 'continue'; line: number };

export interface ProcDecl {
  kind: 'subroutine' | 'function';
  name: string;
  args: string[];
  result: string | null;
  returnType: TypeSpec | null;
  uses: UseStmt[];
  implicitNone: boolean;
  saveAll: boolean;
  decls: Decl[];
  types: DerivedDef[];
  body: Stmt[];
  internal: ProcDecl[];
  line: number;
}

export interface ProgramUnit {
  kind: 'program' | 'module';
  name: string;
  uses: UseStmt[];
  implicitNone: boolean;
  saveAll: boolean;
  decls: Decl[];
  types: DerivedDef[];
  body: Stmt[];
  internal: ProcDecl[];
  line: number;
}

export interface Program {
  main: ProgramUnit | null;
  modules: ProgramUnit[];
  externals: ProcDecl[];
}

// ─── parser ────────────────────────────────────────────────────────────────

const TYPE_WORDS: Record<string, true> = {
  integer: true, real: true, logical: true, character: true, complex: true,
  double: true, type: true, class: true,
};

const ATTR_WORDS: Record<string, true> = {
  parameter: true, allocatable: true, save: true, pointer: true, optional: true,
  external: true, intrinsic: true, target: true, value: true, intent: true,
  dimension: true, public: true, private: true, contiguous: true,
  protected: true, volatile: true, asynchronous: true, bind: true,
};

const PREC: Record<string, number> = {
  eqv: 0, neqv: 0, or: 1, and: 2,
  '==': 3, '/=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
  eq: 3, ne: 3, lt: 3, le: 3, gt: 3, ge: 3,
  '//': 4, '+': 5, '-': 5, '*': 6, '/': 6, '**': 8,
};

const DOT_BINARY: Record<string, BinOp> = {
  '.eq.': '==', '.ne.': '/=', '.lt.': '<', '.le.': '<=', '.gt.': '>', '.ge.': '>=',
  '.and.': 'and', '.or.': 'or', '.eqv.': 'eqv', '.neqv.': 'neqv',
};

const END_WORDS: Record<string, true> = {
  end: true, endprogram: true, endmodule: true, endsubroutine: true,
  endfunction: true, endif: true, enddo: true, endselect: true,
  endwhere: true, endtype: true, endinterface: true,
};

function emptyAttrs(): Attrs {
  return {
    allocatable: false, parameter: false, save: false, pointer: false,
    optional: false, external: false, intrinsic: false, target: false,
    value: false, intent: null, dimension: null,
  };
}

export function parse(src: string): Program {
  return new Parser(tokenize(src)).parseProgram();
}

class Parser {
  private pos = 0;

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

  private line(): number {
    return this.peek().line;
  }

  private atEof(): boolean {
    return this.peek().type === 'eof';
  }

  private atNl(): boolean {
    const t = this.peek();
    return t.type === 'nl' || t.type === 'eof';
  }

  private atOp(value: string, k = 0): boolean {
    const t = this.peek(k);
    return t.type === 'op' && t.value === value;
  }

  private atWord(word: string, k = 0): boolean {
    const t = this.peek(k);
    return t.type === 'name' && t.value === word;
  }

  private word(k = 0): string | null {
    const t = this.peek(k);
    return t.type === 'name' ? t.value : null;
  }

  private eatOp(value: string): Token {
    if (!this.atOp(value)) {
      throw new ParseError(`expected '${value}'`, this.line());
    }
    return this.next();
  }

  private eatWord(word: string): Token {
    if (!this.atWord(word)) {
      throw new ParseError(`expected '${word}'`, this.line());
    }
    return this.next();
  }

  private takeName(what = 'a name'): string {
    const t = this.peek();
    if (t.type !== 'name') throw new ParseError(`expected ${what}`, t.line);
    this.next();
    return t.value;
  }

  private skipNewlines(): void {
    while (this.peek().type === 'nl') this.next();
  }

  private skipSeparators(): void {
    for (;;) {
      if (this.peek().type === 'nl') { this.next(); continue; }
      if (this.atOp(';')) { this.next(); continue; }
      break;
    }
  }

  private skipParenthesized(): void {
    if (!this.atOp('(')) return;
    this.next();
    let depth = 1;
    while (depth > 0 && !this.atEof()) {
      const t = this.next();
      if (t.type === 'op' && t.value === '(') depth++;
      else if (t.type === 'op' && t.value === ')') depth--;
    }
  }

  /** A simple statement must end at a newline, `;`, or EOF. */
  private finishSimple(): void {
    if (!this.atNl() && !this.atOp(';')) {
      throw new ParseError(`unexpected '${this.peek().value}' after the statement`, this.line());
    }
  }

  private atAnyEnd(): boolean {
    const w = this.word();
    return w !== null && END_WORDS[w] === true;
  }

  private atUnitEnd(kind: string): boolean {
    return this.atWord('end') || this.atWord(`end${kind}`);
  }

  private eatUnitEnd(kind: string, name: string): void {
    if (this.atWord(`end${kind}`)) {
      this.next();
    } else if (this.atWord('end')) {
      this.next();
      if (this.atWord(kind)) this.next();
    } else {
      throw new ParseError(`expected 'end ${kind}'`, this.line());
    }
    if (this.peek().type === 'name') {
      const trailing = this.next().value;
      if (trailing !== name) {
        throw new ParseError(`'end ${kind} ${trailing}' does not match '${name}'`, this.peek().line);
      }
    }
    this.finishSimple();
  }

  // -- program units ----------------------------------------------------

  parseProgram(): Program {
    const program: Program = { main: null, modules: [], externals: [] };
    this.skipSeparators();
    while (!this.atEof()) {
      if (this.atWord('program')) {
        if (program.main !== null) throw new ParseError('only one main program unit per block', this.line());
        program.main = this.parseUnit('program');
      } else if (this.atWord('module') && !this.atWord('procedure', 1)) {
        program.modules.push(this.parseUnit('module'));
      } else if (this.startsProc()) {
        program.externals.push(this.parseProc());
      } else if (this.atWord('use') || this.atWord('implicit') || this.isDeclStart()
        || this.atWord('contains') || this.atWord('end')) {
        if (program.main !== null) throw new ParseError('only one main program unit per block', this.line());
        program.main = this.parseBareMain();
      } else {
        if (program.main !== null) throw new ParseError('only one main program unit per block', this.line());
        program.main = this.parseBareMain();
      }
      this.skipSeparators();
    }
    return program;
  }

  private parseUnit(kind: 'program' | 'module'): ProgramUnit {
    const line = this.eatWord(kind).line;
    let name = kind === 'program' ? 'main' : '';
    if (this.peek().type === 'name' && !this.atWord('end')) name = this.takeName();
    if (name === '') throw new ParseError('a module needs a name', line);
    this.finishSimple();
    const spec = this.parseSpecification();
    const body = this.parseBody(new Set(['contains', 'end', `end${kind}`]));
    let internal: ProcDecl[] = [];
    if (this.atWord('contains')) {
      this.next();
      this.finishSimple();
      internal = this.parseInternalProcs(kind);
    }
    this.eatUnitEnd(kind, name);
    return {
      kind, name, uses: spec.uses, implicitNone: spec.implicitNone,
      saveAll: spec.saveAll,
      decls: spec.decls, types: spec.types, body, internal, line,
    };
  }

  private parseBareMain(): ProgramUnit {
    const line = this.line();
    const spec = this.parseSpecification();
    const body: Stmt[] = [];
    for (;;) {
      this.skipSeparators();
      if (this.atEof() || this.atWord('contains') || this.atAnyEnd() || this.startsProc()) break;
      body.push(this.parseStmt());
      this.finishSimple();
    }
    let internal: ProcDecl[] = [];
    if (this.atWord('contains')) {
      this.next();
      this.finishSimple();
      internal = this.parseInternalProcs('program');
    }
    if (this.atWord('endprogram')) {
      this.next();
      if (this.peek().type === 'name') this.next();
      this.finishSimple();
    } else if (this.atWord('end')) {
      this.next();
      if (this.atWord('program')) this.next();
      if (this.peek().type === 'name') this.next();
      this.finishSimple();
    } else if (this.atAnyEnd()) {
      throw new ParseError(`unexpected '${this.word()}' — expected 'end' or 'end program'`, this.line());
    }
    return {
      kind: 'program', name: 'main', uses: spec.uses, implicitNone: spec.implicitNone,
      saveAll: spec.saveAll,
      decls: spec.decls, types: spec.types, body, internal, line,
    };
  }

  private parseInternalProcs(kind: string): ProcDecl[] {
    const out: ProcDecl[] = [];
    for (;;) {
      this.skipSeparators();
      if (this.atEof() || this.atUnitEnd(kind)) break;
      if (!this.startsProc()) {
        throw new ParseError(`expected an internal procedure after 'contains'`, this.line());
      }
      out.push(this.parseProc());
    }
    return out;
  }

  // -- specification part ----------------------------------------------

  private parseSpecification(): {
    uses: UseStmt[]; implicitNone: boolean; saveAll: boolean; decls: Decl[]; types: DerivedDef[];
  } {
    const uses: UseStmt[] = [];
    const decls: Decl[] = [];
    const types: DerivedDef[] = [];
    let implicitNone = false;
    let saveAll = false;

    for (;;) {
      this.skipSeparators();
      if (this.atEof() || this.atAnyEnd() || this.atWord('contains')) break;

      if (this.atWord('use')) {
        uses.push(this.parseUse());
        continue;
      }
      if (this.atWord('implicit')) {
        this.next();
        if (this.atWord('none')) {
          this.next();
          if (this.atOp('(')) this.skipParens();
          implicitNone = true;
          this.finishSimple();
          continue;
        }
        throw new ParseError(
          `${NOT_IN_SUBSET} implicit typing rules — write 'implicit none' and declare every name`,
          this.line(),
        );
      }
      if (this.atWord('type') && !this.atOp('(', 1)) {
        types.push(this.parseDerivedType());
        continue;
      }
      if (this.atWord('class')) {
        throw new ParseError(`${NOT_IN_SUBSET} polymorphic 'class(...)' declarations`, this.line());
      }
      if (this.isDeclStart()) {
        decls.push(this.parseDecl());
        continue;
      }
      if (this.atWord('parameter') && this.atOp('(', 1)) {
        decls.push(this.parseOldParameter());
        continue;
      }
      if (this.atWord('dimension')) {
        throw new ParseError(
          `${NOT_IN_SUBSET} DIMENSION statements — put the bounds in the declaration`,
          this.line(),
        );
      }
      if (this.atWord('save')) {
        saveAll = true;
        this.skipStatement();
        continue;
      }
      if (this.atWord('external') || this.atWord('intrinsic')) {
        this.skipStatement();
        continue;
      }
      if (this.atWord('public') || this.atWord('private')) {
        this.skipStatement();
        continue;
      }
      if (this.atWord('interface') || (this.atWord('abstract') && this.atWord('interface', 1))) {
        throw new ParseError(`${NOT_IN_SUBSET} interfaces — call the procedure directly`, this.line());
      }
      if (this.atWord('common') || this.atWord('equivalence') || this.atWord('data')
        || this.atWord('namelist') || this.atWord('sequence') || this.atWord('bind')) {
        throw new ParseError(`${NOT_IN_SUBSET} '${this.word()}' — modules own shared data in this subset`, this.line());
      }
      break;
    }

    return { uses, implicitNone, saveAll, decls, types };
  }

  private skipStatement(): void {
    while (!this.atNl() && !this.atOp(';') && !this.atEof()) this.next();
  }

  private skipParens(): void {
    this.eatOp('(');
    let depth = 1;
    while (depth > 0) {
      if (this.atEof()) throw new ParseError('unterminated parenthesis', this.line());
      if (this.atOp('(')) depth++;
      else if (this.atOp(')')) depth--;
      this.next();
    }
  }

  private parseUse(): UseStmt {
    const line = this.eatWord('use').line;
    if (this.atOp(',')) {
      this.next();
      const nature = this.takeName('intrinsic or non_intrinsic');
      if (nature !== 'intrinsic' && nature !== 'non_intrinsic') {
        throw new ParseError(`unknown USE nature '${nature}'`, line);
      }
      this.eatOp('::');
    }
    const module = this.takeName('a module name');
    let only: string[] | null = null;
    if (this.atOp(',')) {
      this.next();
      if (this.atWord('only')) {
        this.next();
        this.eatOp(':');
        only = [];
        for (;;) {
          const name = this.takeName('a name in ONLY');
          if (this.atOp('=>')) {
            throw new ParseError(`${NOT_IN_SUBSET} USE renaming — only 'only:' is supported`, line);
          }
          only.push(name);
          if (!this.atOp(',')) break;
          this.next();
        }
      } else {
        throw new ParseError(`${NOT_IN_SUBSET} USE renaming — only 'only:' is supported`, line);
      }
    }
    this.finishSimple();
    return { module, only, line };
  }

  private isDeclStart(): boolean {
    const w = this.word();
    if (w === null || TYPE_WORDS[w] !== true) return false;
    if (w === 'type' || w === 'class') return this.atOp('(', 1);
    return true;
  }

  private skipProcPrefixes(): void {
    while (this.atWord('recursive') || this.atWord('pure')
      || this.atWord('elemental') || this.atWord('impure')) {
      this.next();
    }
  }

  private startsProc(): boolean {
    const save = this.pos;
    try {
      this.skipProcPrefixes();
      if (this.atWord('subroutine') || this.atWord('function')) return true;
      if (!this.isDeclStart()) return false;
      this.parseTypeSpec();
      this.skipProcPrefixes();
      return this.atWord('function');
    } catch {
      return false;
    } finally {
      this.pos = save;
    }
  }

  private parseTypeSpec(): TypeSpec {
    const w = this.word();
    if (w === 'double') {
      this.next();
      if (this.atWord('precision')) {
        this.next();
        return { base: 'real', kind: 8 };
      }
      if (this.atWord('complex')) {
        this.next();
        return { base: 'complex', kind: 8 };
      }
      throw new ParseError(`expected 'precision' or 'complex' after 'double'`, this.line());
    }
    if (w === 'type' || w === 'class') {
      this.next();
      this.eatOp('(');
      const derived = this.takeName('a derived type name');
      this.eatOp(')');
      return { base: 'derived', derived };
    }
    if (w === 'integer' || w === 'real' || w === 'logical' || w === 'complex' || w === 'character') {
      this.next();
      const spec: TypeSpec = { base: w as TypeSpec['base'] };
      if (this.atOp('*')) {
        this.next();
        if (this.atOp('(')) {
          this.next();
          if (this.atOp('*') || this.atOp(':')) {
            this.next();
            spec.charLenAssumed = true;
          } else {
            const n = this.parseIntLiteral();
            if (w === 'character') spec.charLen = n;
            else spec.kind = n;
          }
          this.eatOp(')');
        } else {
          const n = this.parseIntLiteral();
          if (w === 'character') spec.charLen = n;
          else spec.kind = n;
        }
        return spec;
      }
      if (this.atOp('(')) {
        this.next();
        if (this.atOp('*') || this.atOp(':')) {
          this.next();
          this.eatOp(')');
          spec.charLenAssumed = true;
          return spec;
        }
        if (this.atWord('kind') && this.atOp('=', 1)) {
          this.next();
          this.eatOp('=');
          spec.kindExpr = this.parseExpr();
        } else if (this.atWord('len') && this.atOp('=', 1)) {
          this.next();
          this.eatOp('=');
          if (this.atOp('*') || this.atOp(':')) {
            this.next();
            spec.charLenAssumed = true;
          } else {
            spec.charLenExpr = this.parseExpr();
          }
        } else {
          const e = this.parseExpr();
          if (w === 'character') spec.charLenExpr = e;
          else spec.kindExpr = e;
        }
        this.eatOp(')');
      }
      return spec;
    }
    throw new ParseError(`expected a type specification`, this.line());
  }

  private parseIntLiteral(): number {
    const t = this.peek();
    if (t.type !== 'int') throw new ParseError('expected an integer literal', t.line);
    this.next();
    return parseInt(t.value, 10);
  }

  private parseDerivedType(): DerivedDef {
    const line = this.eatWord('type').line;
    if (this.atOp(',')) {
      throw new ParseError(`${NOT_IN_SUBSET} type attributes (extends/public/private)`, line);
    }
    if (this.atOp('::')) this.next();
    const name = this.takeName('a derived type name');
    this.finishSimple();
    const components: Decl[] = [];
    for (;;) {
      this.skipSeparators();
      if (this.atEof()) throw new ParseError(`unterminated type '${name}'`, line);
      if (this.atWord('end') || this.atWord('endtype')) break;
      if (this.atWord('private') || this.atWord('sequence')) {
        this.skipStatement();
        continue;
      }
      if (this.atWord('contains')) {
        throw new ParseError(`${NOT_IN_SUBSET} type-bound procedures`, this.line());
      }
      if (!this.isDeclStart()) {
        throw new ParseError(`expected a component declaration in type '${name}'`, this.line());
      }
      components.push(this.parseDecl());
    }
    if (this.atWord('endtype')) this.next();
    else {
      this.next();
      if (this.atWord('type')) this.next();
    }
    if (this.peek().type === 'name') {
      const trailing = this.next().value;
      if (trailing !== name) throw new ParseError(`'end type ${trailing}' does not match '${name}'`, line);
    }
    this.finishSimple();
    return { name, components, line };
  }

  private parseDecl(): Decl {
    const line = this.line();
    const type = this.parseTypeSpec();
    const attrs = emptyAttrs();
    while (this.atOp(',')) {
      this.next();
      const attr = this.takeName('a declaration attribute');
      if (ATTR_WORDS[attr] !== true) {
        throw new ParseError(`unknown declaration attribute '${attr}'`, this.line());
      }
      switch (attr) {
        case 'parameter': attrs.parameter = true; break;
        case 'allocatable': attrs.allocatable = true; break;
        case 'save': attrs.save = true; break;
        case 'pointer':
          throw new ParseError(`${NOT_IN_SUBSET} POINTER — use ALLOCATABLE arrays`, this.line());
        case 'optional':
          throw new ParseError(`${NOT_IN_SUBSET} OPTIONAL arguments`, this.line());
        case 'bind':
          throw new ParseError(`${NOT_IN_SUBSET} BIND(C)`, this.line());
        case 'external': attrs.external = true; break;
        case 'intrinsic': attrs.intrinsic = true; break;
        case 'target': attrs.target = true; break;
        case 'value':
          throw new ParseError(`${NOT_IN_SUBSET} the VALUE attribute — arguments are by reference`, this.line());
        case 'intent': {
          this.eatOp('(');
          const intent = this.takeName('in, out or inout');
          if (intent !== 'in' && intent !== 'out' && intent !== 'inout') {
            throw new ParseError(`unknown INTENT '${intent}'`, this.line());
          }
          attrs.intent = intent;
          this.eatOp(')');
          break;
        }
        case 'dimension':
          attrs.dimension = this.parseDimSpecs();
          break;
        default:
          // public/private/contiguous/protected/volatile/asynchronous:
          // accepted and ignored — they do not change execution here.
          if (attr === 'public' || attr === 'private') {
            if (this.atOp('(')) this.skipParens();
          }
          break;
      }
    }
    if (this.atOp('::')) this.next();

    const entities: Entity[] = [];
    for (;;) {
      const entityLine = this.line();
      const name = this.takeName('a variable name');
      let dims: DimSpec[] | null = null;
      let charLenExpr: Expr | null = null;
      if (this.atOp('(')) dims = this.parseDimSpecs();
      if (this.atOp('*')) {
        this.next();
        charLenExpr = this.parseExpr();
      }
      let init: Expr | null = null;
      if (this.atOp('=')) {
        this.next();
        init = this.parseExpr();
      } else if (this.atOp('=>')) {
        throw new ParseError(`${NOT_IN_SUBSET} pointer initialisation ('=>')`, this.line());
      }
      entities.push({ name, dims, charLenExpr, init, line: entityLine });
      if (!this.atOp(',')) break;
      this.next();
    }
    this.finishSimple();
    return { type, attrs, entities, line };
  }

  private parseOldParameter(): Decl {
    const line = this.eatWord('parameter').line;
    this.eatOp('(');
    const entities: Entity[] = [];
    for (;;) {
      const entityLine = this.line();
      const name = this.takeName('a parameter name');
      this.eatOp('=');
      const init = this.parseExpr();
      entities.push({ name, dims: null, charLenExpr: null, init, line: entityLine });
      if (!this.atOp(',')) break;
      this.next();
    }
    this.eatOp(')');
    this.finishSimple();
    const attrs = emptyAttrs();
    attrs.parameter = true;
    return { type: { base: 'auto' }, attrs, entities, line };
  }

  private parseDimSpecs(): DimSpec[] {
    this.eatOp('(');
    const dims: DimSpec[] = [];
    for (;;) {
      if (this.atOp(':')) {
        this.next();
        if (this.atOp(',') || this.atOp(')')) {
          dims.push({ lo: null, hi: null, deferred: true, assumedSize: false });
        } else {
          const hi = this.parseExpr();
          dims.push({ lo: null, hi, deferred: false, assumedSize: true });
        }
      } else {
        const first = this.parseExpr();
        if (this.atOp(':')) {
          this.next();
          if (this.atOp(',') || this.atOp(')')) {
            dims.push({ lo: first, hi: null, deferred: false, assumedSize: true });
          } else {
            const hi = this.parseExpr();
            dims.push({ lo: first, hi, deferred: false, assumedSize: false });
          }
        } else {
          dims.push({ lo: null, hi: first, deferred: false, assumedSize: false });
        }
      }
      if (!this.atOp(',')) break;
      this.next();
    }
    this.eatOp(')');
    return dims;
  }

  // -- procedures -------------------------------------------------------

  private parseProc(): ProcDecl {
    const line = this.line();
    this.skipProcPrefixes();
    let returnType: TypeSpec | null = null;
    if (!this.atWord('subroutine') && !this.atWord('function')) {
      returnType = this.parseTypeSpec();
      this.skipProcPrefixes();
    }
    let kind: 'subroutine' | 'function';
    if (this.atWord('subroutine')) { this.next(); kind = 'subroutine'; }
    else if (this.atWord('function')) { this.next(); kind = 'function'; }
    else throw new ParseError(`expected 'subroutine' or 'function'`, line);
    const name = this.takeName(`${kind} name`);
    const args: string[] = [];
    if (this.atOp('(')) {
      this.next();
      if (!this.atOp(')')) {
        for (;;) {
          args.push(this.takeName('a dummy argument'));
          if (!this.atOp(',')) break;
          this.next();
        }
      }
      this.eatOp(')');
    }
    let result: string | null = null;
    if (this.atWord('result')) {
      this.next();
      this.eatOp('(');
      result = this.takeName('a result name');
      this.eatOp(')');
    }
    if (this.atWord('bind')) {
      throw new ParseError(`${NOT_IN_SUBSET} BIND(C) procedures`, this.line());
    }
    this.finishSimple();
    const spec = this.parseSpecification();
    const body = this.parseBody(new Set(['contains', 'end', `end${kind}`]));
    let internal: ProcDecl[] = [];
    if (this.atWord('contains')) {
      this.next();
      this.finishSimple();
      internal = this.parseInternalProcs(kind);
    }
    this.eatUnitEnd(kind, name);
    return {
      kind, name, args, result, returnType, uses: spec.uses,
      implicitNone: spec.implicitNone, saveAll: spec.saveAll,
      decls: spec.decls, types: spec.types,
      body, internal, line,
    };
  }

  // -- statements -------------------------------------------------------

  private parseBody(stop: Set<string>): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      this.skipSeparators();
      if (this.atEof()) break;
      const w = this.word();
      if (w !== null && (stop.has(w) || this.atAnyEnd())) break;
      if (this.atWord('end') || this.atAnyEnd()) break;
      out.push(this.parseStmt());
      this.finishSimple();
    }
    return out;
  }

  private parseStmt(): Stmt {
    const line = this.line();

    // Statement labels imply goto/format, which this subset does not have.
    if (this.peek().type === 'int' && this.peek(1).type === 'name') {
      throw new ParseError(
        `${NOT_IN_SUBSET} statement labels and FORMAT statements — use a character format in WRITE`,
        line,
      );
    }

    let construct: string | null = null;
    if (this.peek().type === 'name' && this.atOp(':', 1)) {
      construct = this.next().value;
      this.next();
    }

    const w = this.word();
    if (w === null) {
      throw new ParseError(`expected a statement`, line);
    }

    switch (w) {
      case 'if': return this.parseIf(construct);
      case 'do': return this.parseDo(construct);
      case 'select': return this.parseSelect(construct);
      case 'where': return this.parseWhere(construct);
      case 'call': return this.parseCall();
      case 'print': return this.parsePrint();
      case 'write': return this.parseWrite();
      case 'allocate': return this.parseAllocate();
      case 'deallocate': return this.parseDeallocate();
      case 'stop': return this.parseStop(false);
      case 'sync':
        this.next();
        if (this.atWord('all')) {
          this.next();
          return { t: 'continue', line };
        }
        throw new ParseError(`${NOT_IN_SUBSET} SYNC IMAGES/MEMORY — this is a single image`, line);
      case 'return': this.next(); return { t: 'return', line };
      case 'continue': this.next(); return { t: 'continue', line };
      case 'exit':
      case 'cycle': {
        this.next();
        let target: string | null = null;
        if (this.peek().type === 'name') target = this.next().value;
        return { t: w, construct: target, line };
      }
      case 'error':
        if (this.atWord('stop', 1)) {
          this.next();
          return this.parseStop(true);
        }
        break;
      case 'read':
        throw new ParseError(
          `${NOT_IN_SUBSET} READ — a block has no stdin; assign the values or make them parameters`,
          line,
        );
      case 'open': case 'close': case 'inquire': case 'rewind':
      case 'backspace': case 'endfile': case 'flush': case 'wait': {
        this.next();
        if (this.atOp('(')) this.skipParenthesized();
        this.finishSimple();
        return { t: 'continue', line };
      }
      case 'goto': case 'go': case 'format': case 'entry': case 'include':
      case 'interface': case 'procedure': case 'associate': case 'block':
      case 'forall': case 'nullify': case 'import': case 'submodule':
        throw new ParseError(`${NOT_IN_SUBSET} '${w}'`, line);
      case 'else': case 'elseif': case 'elsewhere': case 'case':
        throw new ParseError(`unexpected '${w}' without a matching construct`, line);
      case 'end':
        throw new ParseError(`unexpected 'end' without a matching construct`, line);
      case 'enddo': case 'endif': case 'endselect': case 'endwhere':
        throw new ParseError(`unexpected '${w}' without a matching construct`, line);
      default:
        break;
    }

    // Assignment: designator '=' expression.
    const target = this.parseDesignator();
    if (!this.atOp('=')) {
      if (this.atOp('=>')) {
        throw new ParseError(`${NOT_IN_SUBSET} pointer assignment ('=>')`, line);
      }
      throw new ParseError(
        `expected '=' after '${target.base}' — a bare procedure call needs CALL`,
        line,
      );
    }
    this.next();
    const expr = this.parseExpr();
    return { t: 'assign', target, expr, line };
  }

  private parseIf(construct: string | null): Stmt {
    const line = this.eatWord('if').line;
    this.eatOp('(');
    const cond = this.parseExpr();
    this.eatOp(')');

    if (!this.atWord('then')) {
      const stmt = this.parseStmt();
      return { t: 'if', construct, arms: [{ cond, body: [stmt] }], elseBody: null, line };
    }
    this.next();
    this.finishSimple();

    const arms: { cond: Expr; body: Stmt[] }[] = [];
    let elseBody: Stmt[] | null = null;
    arms.push({ cond, body: this.parseBody(new Set(['else', 'elseif', 'endif', 'end'])) });
    for (;;) {
      if (this.atWord('elseif') || (this.atWord('else') && this.atWord('if', 1))) {
        if (this.atWord('else')) {
          this.next();
          this.next();
        } else {
          this.next();
        }
        this.eatOp('(');
        const c = this.parseExpr();
        this.eatOp(')');
        this.eatWord('then');
        this.finishSimple();
        arms.push({ cond: c, body: this.parseBody(new Set(['else', 'elseif', 'endif', 'end'])) });
        continue;
      }
      if (this.atWord('else')) {
        this.next();
        this.finishSimple();
        elseBody = this.parseBody(new Set(['endif', 'end']));
      }
      break;
    }
    if (this.atWord('endif')) this.next();
    else {
      this.eatWord('end');
      this.eatWord('if');
    }
    if (this.peek().type === 'name' && this.peek().value === construct) this.next();
    this.finishSimple();
    return { t: 'if', construct, arms, elseBody, line };
  }

  private parseDo(construct: string | null): Stmt {
    const line = this.eatWord('do').line;
    let whileCond: Expr | null = null;
    let varName: string | null = null;
    let start: Expr | null = null;
    let end: Expr | null = null;
    let step: Expr | null = null;

    if (this.atWord('concurrent')) {
      this.next();
      this.eatOp('(');
      const specs: { varName: string; start: Expr; end: Expr; step: Expr | null }[] = [];
      for (;;) {
        const indexName = this.takeName('a concurrent index');
        this.eatOp('=');
        const first = this.parseExpr();
        this.eatOp(':');
        const last = this.parseExpr();
        let stride: Expr | null = null;
        if (this.atOp(':')) {
          this.next();
          stride = this.parseExpr();
        }
        specs.push({ varName: indexName, start: first, end: last, step: stride });
        if (!this.atOp(',')) break;
        this.next();
      }
      this.eatOp(')');
      if (this.atWord('local') || this.atWord('reduce')) {
        throw new ParseError(`${NOT_IN_SUBSET} DO CONCURRENT locality specifiers`, this.line());
      }
      this.finishSimple();
      const concurrentBody = this.parseBody(new Set(['enddo', 'end']));
      if (this.atWord('enddo')) this.next();
      else {
        this.eatWord('end');
        this.eatWord('do');
      }
      if (this.peek().type === 'name' && this.peek().value === construct) this.next();
      this.finishSimple();
      if (specs.length === 0) throw new ParseError('DO CONCURRENT needs at least one index', line);
      let nested: Stmt = {
        t: 'do', construct: specs.length === 1 ? construct : null, whileCond: null,
        body: concurrentBody, line, ...specs[specs.length - 1]!,
      };
      for (let k = specs.length - 2; k >= 0; k--) {
        nested = {
          t: 'do', construct: k === 0 ? construct : null, whileCond: null,
          body: [nested], line, ...specs[k]!,
        };
      }
      return nested;
    }

    if (this.atWord('while') && this.atOp('(', 1)) {
      this.next();
      this.eatOp('(');
      whileCond = this.parseExpr();
      this.eatOp(')');
    } else if (this.peek().type === 'name' && this.atOp('=', 1)) {
      varName = this.takeName('a loop variable');
      this.eatOp('=');
      start = this.parseExpr();
      this.eatOp(',');
      end = this.parseExpr();
      if (this.atOp(',')) {
        this.next();
        step = this.parseExpr();
      }
    } else if (!this.atNl() && !this.atOp(';')) {
      throw new ParseError(`expected 'do', 'do while (...)', or 'do i = a, b'`, line);
    }
    this.finishSimple();

    const body = this.parseBody(new Set(['enddo', 'end']));
    if (this.atWord('enddo')) this.next();
    else {
      this.eatWord('end');
      this.eatWord('do');
    }
    if (this.peek().type === 'name' && this.peek().value === construct) this.next();
    this.finishSimple();
    return { t: 'do', construct, varName, start, end, step, whileCond, body, line };
  }

  private parseSelect(construct: string | null): Stmt {
    const line = this.eatWord('select').line;
    this.eatWord('case');
    this.eatOp('(');
    const expr = this.parseExpr();
    this.eatOp(')');
    this.finishSimple();

    const cases: { selectors: CaseSelector[]; body: Stmt[] }[] = [];
    let defaultBody: Stmt[] | null = null;
    for (;;) {
      this.skipSeparators();
      if (this.atWord('endselect') || this.atWord('end')) break;
      this.eatWord('case');
      if (this.atWord('default')) {
        this.next();
        this.finishSimple();
        defaultBody = this.parseBody(new Set(['case', 'endselect', 'end']));
        continue;
      }
      this.eatOp('(');
      const selectors: CaseSelector[] = [];
      for (;;) {
        if (this.atOp(':')) {
          this.next();
          selectors.push({ lo: null, hi: this.atOp(',') || this.atOp(')') ? null : this.parseExpr() });
        } else {
          const lo = this.parseExpr();
          if (this.atOp(':')) {
            this.next();
            selectors.push({ lo, hi: this.atOp(',') || this.atOp(')') ? null : this.parseExpr() });
          } else {
            selectors.push({ lo, hi: lo });
          }
        }
        if (!this.atOp(',')) break;
        this.next();
      }
      this.eatOp(')');
      this.finishSimple();
      cases.push({ selectors, body: this.parseBody(new Set(['case', 'endselect', 'end'])) });
    }
    if (this.atWord('endselect')) this.next();
    else {
      this.eatWord('end');
      this.eatWord('select');
    }
    if (this.peek().type === 'name' && this.peek().value === construct) this.next();
    this.finishSimple();
    return { t: 'select', expr, cases, defaultBody, line };
  }

  private parseWhere(construct: string | null): Stmt {
    const line = this.eatWord('where').line;
    this.eatOp('(');
    const mask = this.parseExpr();
    this.eatOp(')');

    if (!this.atNl() && !this.atOp(';')) {
      const stmt = this.parseStmt();
      return { t: 'where', mask, body: [stmt], elsewhere: [], line };
    }
    this.finishSimple();
    const body = this.parseBody(new Set(['elsewhere', 'endwhere', 'end']));
    const elsewhere: { mask: Expr | null; body: Stmt[] }[] = [];
    while (this.atWord('elsewhere')) {
      this.next();
      let otherMask: Expr | null = null;
      if (this.atOp('(')) {
        this.next();
        otherMask = this.parseExpr();
        this.eatOp(')');
      }
      this.finishSimple();
      elsewhere.push({
        mask: otherMask,
        body: this.parseBody(new Set(['elsewhere', 'endwhere', 'end'])),
      });
    }
    if (this.atWord('endwhere')) this.next();
    else {
      this.eatWord('end');
      this.eatWord('where');
    }
    if (this.peek().type === 'name' && this.peek().value === construct) this.next();
    this.finishSimple();
    return { t: 'where', mask, body, elsewhere, line };
  }

  private parseCall(): Stmt {
    const line = this.eatWord('call').line;
    const name = this.takeName('a procedure name');
    let args: Actual[] = [];
    if (this.atOp('(')) args = this.parseActuals();
    return { t: 'call', name, args, line };
  }

  private parsePrint(): Stmt {
    const line = this.eatWord('print').line;
    let fmt: Expr | null = null;
    if (this.atOp('*')) {
      this.next();
    } else if (!this.atNl() && !this.atOp(';')) {
      fmt = this.parseExpr();
    }
    const items: Expr[] = [];
    if (this.atOp(',')) {
      this.next();
      if (!this.atNl() && !this.atOp(';')) items.push(...this.parseExprList());
    }
    return { t: 'print', fmt, items, line };
  }

  private parseWrite(): Stmt {
    const line = this.eatWord('write').line;
    this.eatOp('(');
    let unit: Expr | null = null;
    let fmt: Expr | null = null;
    let advance: Expr | null = null;

    const readSpec = (): { key: string | null; value: Expr | null } => {
      if (this.atOp('*')) {
        this.next();
        return { key: null, value: null };
      }
      if (this.peek().type === 'name' && this.atOp('=', 1)) {
        const key = this.next().value;
        this.next();
        if (this.atOp('*')) {
          this.next();
          return { key, value: null };
        }
        return { key, value: this.parseExpr() };
      }
      return { key: null, value: this.parseExpr() };
    };

    let spec = readSpec();
    let hasUnit = false;
    let hasFmt = false;
    if (spec.key === 'fmt') { fmt = spec.value; hasFmt = true; }
    else if (spec.key === 'unit') { unit = spec.value; hasUnit = true; }
    else if (spec.key === null) { unit = spec.value; hasUnit = true; }
    else throw new ParseError(`unknown WRITE specifier '${spec.key}'`, line);
    while (this.atOp(',')) {
      this.next();
      spec = readSpec();
      if (spec.key === 'unit') {
        if (hasUnit) throw new ParseError('UNIT appears twice in WRITE', line);
        unit = spec.value;
        hasUnit = true;
      } else if (spec.key === 'fmt') {
        if (hasFmt) throw new ParseError('FMT appears twice in WRITE', line);
        fmt = spec.value;
        hasFmt = true;
      } else if (spec.key === 'advance') {
        advance = spec.value;
      } else if (spec.key === null) {
        if (!hasUnit) { unit = spec.value; hasUnit = true; }
        else if (!hasFmt) { fmt = spec.value; hasFmt = true; }
        else throw new ParseError('too many positional WRITE specifiers', line);
      } else if (spec.key === 'iostat' || spec.key === 'iomsg'
        || spec.key === 'size' || spec.key === 'id') {
        throw new ParseError(`${NOT_IN_SUBSET} '${spec.key}=' in WRITE`, line);
      } else {
        throw new ParseError(`unknown WRITE specifier '${spec.key}'`, line);
      }
    }
    this.eatOp(')');

    const items: Expr[] = [];
    if (!this.atNl() && !this.atOp(';')) items.push(...this.parseExprList());
    return { t: 'write', unit, fmt, advance, items, line };
  }

  private parseAllocate(): Stmt {
    const line = this.eatWord('allocate').line;
    this.eatOp('(');
    const items: { name: string; dims: DimSpec[] }[] = [];
    let stat: string | null = null;
    for (;;) {
      if (this.peek().type === 'name' && this.atOp('=', 1)
        && (this.word() === 'stat' || this.word() === 'errmsg')) {
        const key = this.next().value;
        this.next();
        const value = this.takeName('a variable');
        if (key === 'stat') stat = value;
        else throw new ParseError(`${NOT_IN_SUBSET} 'errmsg=' in ALLOCATE`, line);
      } else {
        const name = this.takeName('an allocatable name');
        const dims = this.parseDimSpecs();
        items.push({ name, dims });
      }
      if (!this.atOp(',')) break;
      this.next();
    }
    this.eatOp(')');
    return { t: 'allocate', items, stat, line };
  }

  private parseDeallocate(): Stmt {
    const line = this.eatWord('deallocate').line;
    this.eatOp('(');
    const names: string[] = [];
    let stat: string | null = null;
    for (;;) {
      if (this.peek().type === 'name' && this.atOp('=', 1) && this.word() === 'stat') {
        this.next();
        this.next();
        stat = this.takeName('a variable');
      } else {
        names.push(this.takeName('an allocatable name'));
      }
      if (!this.atOp(',')) break;
      this.next();
    }
    this.eatOp(')');
    return { t: 'deallocate', names, stat, line };
  }

  private parseStop(isError: boolean): Stmt {
    const line = this.eatWord('stop').line;
    let message: Expr | null = null;
    if (!this.atNl() && !this.atOp(';')) message = this.parseExpr();
    return { t: 'stop', message, isError, line };
  }

  private parseExprList(): Expr[] {
    const out = [this.parseArrayItem()];
    while (this.atOp(',')) {
      this.next();
      out.push(this.parseArrayItem());
    }
    return out;
  }

  // -- designators ------------------------------------------------------

  private parseDesignator(): Designator {
    const t = this.peek();
    if (t.type !== 'name') throw new ParseError('expected a variable name', t.line);
    this.next();
    const parts: Part[] = [];
    for (;;) {
      if (this.atOp('(')) {
        parts.push({ kind: 'subs', args: this.parseActuals() });
      } else if (this.atOp('%')) {
        this.next();
        parts.push({ kind: 'component', name: this.takeName('a component name') });
      } else {
        break;
      }
    }
    return { base: t.value, parts, line: t.line };
  }

  private parseActuals(): Actual[] {
    this.eatOp('(');
    const args: Actual[] = [];
    if (this.atOp(')')) {
      this.next();
      return args;
    }
    for (;;) {
      if (this.atOp('::')) {
        this.next();
        const step = this.parseExpr();
        args.push({ sub: { kind: 'range', lo: null, hi: null, step } });
      } else if (this.atOp(':')) {
        this.next();
        const hi = this.atOp(',') || this.atOp(')') ? null : this.parseExpr();
        let step: Expr | null = null;
        if (this.atOp(':')) {
          this.next();
          step = this.parseExpr();
        }
        args.push({ sub: { kind: 'range', lo: null, hi, step } });
      } else {
        const first = this.parseExpr();
        if (this.atOp('::')) {
          this.next();
          const step = this.parseExpr();
          args.push({ sub: { kind: 'range', lo: first, hi: null, step } });
        } else if (this.atOp(':')) {
          this.next();
          const hi = this.atOp(',') || this.atOp(')') ? null : this.parseExpr();
          let step: Expr | null = null;
          if (this.atOp(':')) {
            this.next();
            step = this.parseExpr();
          }
          args.push({ sub: { kind: 'range', lo: first, hi, step } });
        } else if (this.atOp('=')) {
          if (first.t !== 'name') throw new ParseError(`keyword arguments need a name before '='`, first.line);
          this.next();
          args.push({ name: first.name, expr: this.parseExpr() });
        } else {
          args.push({ expr: first });
        }
      }
      if (!this.atOp(',')) break;
      this.next();
    }
    this.eatOp(')');
    return args;
  }

  // -- expressions ------------------------------------------------------

  parseExpr(minPrec = 0): Expr {
    let left = this.parsePrefix();
    for (;;) {
      const op = this.binaryOp();
      if (op === null) break;
      const prec = PREC[op]!;
      if (prec < minPrec) break;
      this.next();
      const right = this.parseExpr(op === '**' ? prec : prec + 1);
      left = { t: 'binary', op, left, right, line: left.line };
    }
    return left;
  }

  private binaryOp(): BinOp | null {
    const t = this.peek();
    if (t.type !== 'op') return null;
    if (DOT_BINARY[t.value] !== undefined) return DOT_BINARY[t.value]!;
    if (t.value === '+' || t.value === '-' || t.value === '*' || t.value === '/'
      || t.value === '**' || t.value === '//' || t.value === '=='
      || t.value === '/=' || t.value === '<' || t.value === '<=' || t.value === '>'
      || t.value === '>=') {
      return t.value as BinOp;
    }
    return null;
  }

  private parsePrefix(): Expr {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '+' || t.value === '-')) {
      this.next();
      return { t: 'unary', op: t.value, arg: this.parseExpr(8), line: t.line };
    }
    if (t.type === 'op' && t.value === '.not.') {
      this.next();
      return { t: 'unary', op: 'not', arg: this.parseExpr(3), line: t.line };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(base: Expr): Expr {
    let expr = base;
    for (;;) {
      if (this.atOp('(')) {
        expr = { t: 'apply', base: expr, args: this.parseActuals(), line: expr.line };
      } else if (this.atOp('%')) {
        this.next();
        expr = { t: 'component', base: expr, name: this.takeName('a component name'), line: expr.line };
      } else {
        break;
      }
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.type === 'int') {
      this.next();
      return { t: 'int', value: parseInt(t.value, 10), kind: t.kind, line: t.line };
    }
    if (t.type === 'real') {
      this.next();
      return { t: 'real', value: parseFloat(t.value), kind: t.kind, line: t.line };
    }
    if (t.type === 'string') {
      this.next();
      return { t: 'string', value: t.value, line: t.line };
    }
    if (t.type === 'logical') {
      this.next();
      return { t: 'logical', value: t.value === 'true', line: t.line };
    }
    if (t.type === 'name') {
      this.next();
      return { t: 'name', name: t.value, line: t.line };
    }
    if (this.atOp('(')) {
      this.next();
      const first = this.parseExpr();
      if (this.atOp(',')) {
        this.next();
        const second = this.parseExpr();
        this.eatOp(')');
        return {
          t: 'apply',
          base: { t: 'name', name: 'cmplx', line: first.line },
          args: [{ expr: first }, { expr: second }],
          line: first.line,
        };
      }
      this.eatOp(')');
      return first;
    }
    if (this.atOp('[')) return this.parseArrayConstructor(']');
    if (this.atOp('(/')) return this.parseArrayConstructor('/)');
    throw new ParseError(`expected an expression, found '${t.value}'`, t.line);
  }

  private parseArrayConstructor(close: ']' | '/)'): Expr {
    const line = this.next().line;
    const items: Expr[] = [];
    if (this.atOp(close)) {
      throw new ParseError('an array constructor needs at least one value', line);
    }
    for (;;) {
      items.push(this.parseArrayItem());
      if (!this.atOp(',')) break;
      this.next();
    }
    this.eatOp(close);
    return { t: 'array', items, line };
  }

  private parseArrayItem(): Expr {
    if (!this.atOp('(')) return this.parseExpr();
    const save = this.pos;
    const line = this.peek().line;
    this.next();
    const items = [this.parseExpr()];
    for (;;) {
      if (!this.atOp(',')) break;
      if (this.peek(1).type === 'name' && this.atOp('=', 2)) break;
      this.next();
      items.push(this.parseExpr());
    }
    if (this.atOp(',') && this.peek(1).type === 'name' && this.atOp('=', 2)) {
      this.next();
      const varName = this.takeName('the implied-do variable');
      this.eatOp('=');
      const start = this.parseExpr();
      this.eatOp(',');
      const end = this.parseExpr();
      let step: Expr | null = null;
      if (this.atOp(',')) {
        this.next();
        step = this.parseExpr();
      }
      this.eatOp(')');
      return { t: 'implied', items, var: varName, start, end, step, line };
    }
    this.pos = save;
    return this.parseExpr();
  }
}
