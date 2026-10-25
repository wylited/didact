// parse.ts — tokenizer + clause parser for the Prolog teaching kernel.
// Grammar: clauses end with '.'; a clause is `head.` or `head :- body.`;
// bodies are conjunctions (,) and disjunctions (;); queries are `?- goal.`
// Operator precedence: :- 1200 xfx, ; 1100 xfy, , 1000 xfy, comparisons and
// is/=/\=/==/\== 700 xfx, + - 500 yfx, * // mod 400 yfx. Lists: [a, b | T].

import { PrologError, type Term } from './terms';

interface Tok { kind: 'atom' | 'var' | 'int' | 'punct'; text: string; n?: number; line: number }

const MULTI = [':-', '?-', '\\==', '=:=', '=\\=', '\\=', '==', '=<', '>=', '//'];
const SINGLE = '()[]{},.;!|=<>+-*';

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '%') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"' && src[j] !== '\n') j++;
      if (src[j] !== '"') throw new PrologError('unterminated string literal', line);
      toks.push({ kind: 'atom', text: src.slice(i + 1, j), line });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      toks.push({ kind: 'int', text: src.slice(i, j), n: Number(src.slice(i, j)), line });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      const text = src.slice(i, j);
      toks.push({ kind: /^[A-Z_]/.test(c) ? 'var' : 'atom', text, line });
      i = j;
      continue;
    }
    let matched = false;
    for (const m of MULTI) {
      if (src.startsWith(m, i)) {
        toks.push({ kind: 'punct', text: m, line });
        i += m.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (SINGLE.includes(c)) {
      toks.push({ kind: 'punct', text: c, line });
      i++;
      continue;
    }
    throw new PrologError(`unexpected character '${c}'`, line);
  }
  return toks;
}

interface OpInfo { prec: number; type: 'xfx' | 'yfx' | 'xfy' }
const OPS: Record<string, OpInfo> = {
  ':-': { prec: 1200, type: 'xfx' },
  ';': { prec: 1100, type: 'xfy' },
  ',': { prec: 1000, type: 'xfy' },
  '=': { prec: 700, type: 'xfx' }, '\\=': { prec: 700, type: 'xfx' },
  '==': { prec: 700, type: 'xfx' }, '\\==': { prec: 700, type: 'xfx' },
  is: { prec: 700, type: 'xfx' },
  '<': { prec: 700, type: 'xfx' }, '>': { prec: 700, type: 'xfx' },
  '=<': { prec: 700, type: 'xfx' }, '>=': { prec: 700, type: 'xfx' },
  '=:=': { prec: 700, type: 'xfx' }, '=\\=': { prec: 700, type: 'xfx' },
  '+': { prec: 500, type: 'yfx' }, '-': { prec: 500, type: 'yfx' },
  '*': { prec: 400, type: 'yfx' }, '//': { prec: 400, type: 'yfx' },
  mod: { prec: 400, type: 'yfx' },
};

class Parser {
  private pos = 0;
  /** Variable scope for the clause or query being parsed. */
  private vars = new Map<string, Term>();
  private varCount = 0;

  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok {
    const t = this.toks[this.pos];
    if (t === undefined) throw new PrologError('unexpected end of input', this.toks.length > 0 ? this.toks[this.toks.length - 1]!.line : 1);
    this.pos++;
    return t;
  }
  private isPunct(text: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'punct' && t.text === text;
  }
  private expectPunct(text: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.text !== text) throw new PrologError(`expected '${text}' but found '${t.text}'`, t.line);
  }

  /** Begin a fresh variable scope (one per clause, one per query). */
  newScope(): void { this.vars = new Map(); this.varCount = 0; }

  namedVars(): VarTerm[] { return [...this.vars.values()].filter((v): v is VarTerm => v.t === 'var' && v.name !== '_'); }

  private mkVar(name: string): Term {
    // '_' is a fresh anonymous variable at every occurrence — two _ never
    // share a cell, so member(X, [X|_]) and the second clause's [_|T] work.
    if (name === '_') return { t: 'var', id: this.varCount++, name: '_' };
    let v = this.vars.get(name);
    if (v === undefined) {
      v = { t: 'var', id: this.varCount++, name };
      this.vars.set(name, v);
    }
    return v;
  }

  parseProgram(): Program {
    const clauses: Clause[] = [];
    const queries: Query[] = [];
    while (this.peek() !== undefined) {
      if (this.isPunct('?-')) {
        const qline = this.next().line;
        this.newScope();
        const goal = this.expr(1199, qline);
        this.expectPunct('.');
        const named = this.namedVars();
        queries.push({ goals: flattenConj(goal), line: qline, vars: named });
        continue;
      }
      const t = this.next();
      if (t.kind === 'punct' && t.text === ':-') throw new PrologError('directive (:- at top level) is not supported', t.line);
      this.pos--;
      this.newScope();
      const term = this.expr(1200, t.line);
      this.expectPunct('.');
      if (term.t === 'str' && term.name === ':-' && term.args.length === 2) {
        clauses.push({ head: term.args[0]!, body: flattenConj(term.args[1]!), line: t.line });
      } else {
        if (term.t === 'var') throw new PrologError('clause head must be an atom or compound term', t.line);
        clauses.push({ head: term, body: [], line: t.line });
      }
    }
    return { clauses, queries };
  }

  private expr(maxPrec: number, line: number): Term {
    let left = this.primary(line);
    for (;;) {
      const t = this.peek();
      if (t === undefined) return left;
      const isOpTok =
        (t.kind === 'punct' && OPS[t.text] !== undefined) ||
        (t.kind === 'atom' && OPS[t.text] !== undefined);
      if (!isOpTok) return left;
      const op = OPS[t.text]!;
      if (op.prec > maxPrec) return left;
      this.next();
      const right = this.expr(op.type === 'yfx' ? op.prec : op.prec - 1, t.line);
      left = { t: 'str', name: t.text, args: [left, right] };
    }
  }

  private primary(_line: number): Term {
    const t = this.next();
    if (t.kind === 'int') return { t: 'int', n: t.n! };
    if (t.kind === 'var') return this.mkVar(t.text);
    if (t.kind === 'atom') {
      if (this.isPunct('(')) {
        this.next();
        const args = [this.expr(999, t.line)];
        while (this.isPunct(',')) { this.next(); args.push(this.expr(999, t.line)); }
        this.expectPunct(')');
        return { t: 'str', name: t.text, args };
      }
      return { t: 'atom', name: t.text };
    }
    if (t.text === '!') return { t: 'atom', name: '!' };
    if (t.text === '(') {
      const e = this.expr(1200, t.line);
      this.expectPunct(')');
      return e;
    }
    if (t.text === '[') {
      const items: Term[] = [];
      if (!this.isPunct(']')) {
        items.push(this.expr(999, t.line));
        while (this.isPunct(',')) { this.next(); items.push(this.expr(999, t.line)); }
        if (this.isPunct('|')) {
          this.next();
          const tail = this.expr(999, t.line);
          this.expectPunct(']');
          return buildList(items, tail);
        }
      }
      this.expectPunct(']');
      return buildList(items, { t: 'atom', name: '[]' });
    }
    throw new PrologError(`unexpected token '${t.text}'`, t.line);
  }
}

function buildList(items: Term[], tail: Term): Term {
  let out = tail;
  for (let i = items.length - 1; i >= 0; i--) out = { t: 'str', name: '.', args: [items[i]!, out] };
  return out;
}

/** Split top-level `A, B, C` (already right-nested by the parser) into goals. */
export function flattenConj(t: Term): Term[] {
  if (t.t === 'str' && t.name === ',' && t.args.length === 2) {
    return [...flattenConj(t.args[0]!), ...flattenConj(t.args[1]!)];
  }
  return [t];
}

/** A named query variable — the ones the Bindings panel reports. */
export interface VarTerm { t: 'var'; id: number; name: string }

export interface Query { goals: Term[]; line: number; vars: VarTerm[] }
export interface Clause { head: Term; body: Term[]; line: number }
export interface Program { clauses: Clause[]; queries: Query[] }

export function parseProgram(src: string): Program {
  return new Parser(tokenize(src)).parseProgram();
}
