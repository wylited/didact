// parser.ts — recursive-descent parser for the Lua subset. Every rejection
// of full Lua (goto, varargs, generic-for iterators beyond pairs/ipairs)
// is a clean ParseError carrying a 1-based source line.

import { LexError, tokenize, type Token } from './lexer';
import { LuaFloat, LuaInt, type ExpNode, type Program, type StatNode } from './value';

export class ParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
    this.name = 'ParseError';
  }
}

export function parse(src: string): Program {
  const toks = tokenize(src); // LexError propagates with its own line
  let pos = 0;

  const peek = (): Token => toks[pos]!;
  const next = (): Token => toks[pos++]!;

  function expectOp(op: string): void {
    const t = next();
    if (t.type !== 'op' || t.value !== op) {
      throw new ParseError(`'${op}' expected near '${t.value}'`, t.line);
    }
  }

  function expectKw(kw: string): void {
    const t = next();
    if (t.type !== 'keyword' || t.value !== kw) {
      throw new ParseError(`'${kw}' expected near '${t.value}'`, t.line);
    }
  }

  function atOp(op: string): boolean {
    const t = peek();
    return t.type === 'op' && t.value === op;
  }

  function atKw(kw: string): boolean {
    const t = peek();
    return t.type === 'keyword' && t.value === kw;
  }

  function name(): Token {
    const t = next();
    if (t.type !== 'name') throw new ParseError(`<name> expected near '${t.value}'`, t.line);
    return t;
  }

  function blockStopper(): boolean {
    const t = peek();
    if (t.type !== 'keyword') return false;
    return ['end', 'else', 'elseif', 'until'].includes(t.value);
  }

  function parseChunk(): StatNode[] {
    const body: StatNode[] = [];
    for (;;) {
      const t = peek();
      if (t.type === 'eof') break;
      if (blockStopper()) break;
      if (t.type === 'keyword' && t.value === 'return') {
        body.push(parseReturn());
        break; // return terminates the chunk
      }
      const stat = parseStat();
      if (stat !== null) body.push(stat);
    }
    return body;
  }

  function parseReturn(): StatNode {
    const kw = next(); // 'return'
    const exps: ExpNode[] = [];
    const t = peek();
    if (!(t.type === 'eof' || t.type === 'op' && (t.value === ';' || t.value === '}')) && !blockStopper()) {
      exps.push(...parseExpList());
    }
    if (atOp(';')) next();
    return { kind: 'return', exps, line: kw.line };
  }

  function parseStat(): StatNode | null {
    const t = peek();
    if (t.type === 'op' && t.value === ';') { next(); return null; }
    if (t.type === 'keyword') {
      switch (t.value) {
        case 'local': return parseLocal();
        case 'break': next(); return { kind: 'break', line: t.line };
        case 'do': {
          next();
          const body = parseChunk();
          expectKw('end');
          return { kind: 'do', body, line: t.line };
        }
        case 'while': return parseWhile();
        case 'repeat': return parseRepeat();
        case 'if': return parseIf();
        case 'for': return parseFor();
        case 'function': return parseFuncStat();
        case 'goto':
          throw new ParseError('goto is not in the Lua subset', t.line);
        default:
          throw new ParseError(`unexpected keyword '${t.value}'`, t.line);
      }
    }
    if (t.type === 'op' && t.value === '::') {
      throw new ParseError('labels and goto are not in the Lua subset', t.line);
    }
    // assignment or call statement
    const target = parseSuffixed();
    if (atOp('=') || atOp(',')) {
      const targets = [prefixToTarget(target)];
      while (atOp(',')) {
        next();
        const e = parseSuffixed();
        targets.push(prefixToTarget(e));
      }
      expectOp('=');
      const exps = parseExpList();
      return { kind: 'assign', targets, exps, line: t.line };
    }
    if (target.kind !== 'call' && target.kind !== 'method') {
      throw new ParseError('syntax error near unexpected expression (only calls are statements)', t.line);
    }
    return { kind: 'exprstat', call: target, line: t.line };
  }

  type Target = ({ kind: 'name'; name: string } | { kind: 'index'; obj: ExpNode; key: ExpNode }) & { line: number };

  function prefixToTarget(e: ExpNode): Target {
    if (e.kind === 'var') return { kind: 'name', name: e.name, line: e.line };
    if (e.kind === 'index') return { kind: 'index', obj: e.obj, key: e.key, line: e.line };
    throw new ParseError('cannot assign to this expression', lineOfExp(e));
  }

/** Best-effort source line of an expression node for error messages. */
function lineOfExp(e: ExpNode): number {
  if ('line' in e) return e.line;
  return 0;
}

  function parseLocal(): StatNode {
    const kw = next(); // 'local'
    if (atKw('function')) {
      next();
      const fn = name();
      const def = parseFuncbody(fn.value);
      return { kind: 'local', names: [fn.value], exps: [def], line: kw.line, fn: true };
    }
    const names = [name().value];
    while (atOp(',')) { next(); names.push(name().value); }
  const exps: ExpNode[] = [];
  if (atOp('=')) { next(); exps.push(...parseExpList()); }
    return { kind: 'local', names, exps, line: kw.line };
  }

  function parseWhile(): StatNode {
    const kw = next();
    const cond = parseExp();
    expectKw('do');
    const body = parseChunk();
    expectKw('end');
    return { kind: 'while', cond, body, line: kw.line };
  }

  function parseRepeat(): StatNode {
    const kw = next();
    const body = parseChunk();
    expectKw('until');
    const cond = parseExp();
    return { kind: 'repeat', body, cond, line: kw.line };
  }

  function parseIf(): StatNode {
    const kw = next(); // 'if'
    const clauses: { cond: ExpNode; body: StatNode[] }[] = [];
    const cond = parseExp();
    expectKw('then');
    clauses.push({ cond, body: parseChunk() });
    let elseBody: StatNode[] | null = null;
    for (;;) {
      if (atKw('elseif')) {
        next();
        const c = parseExp();
        expectKw('then');
        clauses.push({ cond: c, body: parseChunk() });
        continue;
      }
      if (atKw('else')) {
        next();
        elseBody = parseChunk();
      }
      expectKw('end');
      break;
    }
    return { kind: 'if', clauses, elseBody, line: kw.line };
  }

  function parseFor(): StatNode {
    const kw = next(); // 'for'
    const first = name();
    if (atOp('=')) {
      next();
      const start = parseExp();
      expectOp(',');
      const limit = parseExp();
      let step: ExpNode | null = null;
      if (atOp(',')) { next(); step = parseExp(); }
      expectKw('do');
      const body = parseChunk();
      expectKw('end');
      return { kind: 'fornum', name: first.value, start, limit, step, body, line: kw.line };
    }
    // generic for: `for k, v in pairs(t)` / `in ipairs(t)` only
    const names = [first.value];
    while (atOp(',')) { next(); names.push(name().value); }
    expectKw('in');
    const iter = parseExp();
    let iterKind: 'pairs' | 'ipairs';
    let iterArg: ExpNode;
    if (
      iter.kind === 'call' && iter.fn.kind === 'var' &&
      (iter.fn.name === 'pairs' || iter.fn.name === 'ipairs') &&
      iter.args.length === 1
    ) {
      iterKind = iter.fn.name;
      iterArg = iter.args[0]!;
    } else {
      throw new ParseError("generic for only supports 'pairs(t)' or 'ipairs(t)' in this subset", kw.line);
    }
    expectKw('do');
    const body = parseChunk();
    expectKw('end');
    return { kind: 'forin', names, iter: iterKind, iterArg, body, line: kw.line };
  }

  function parseFuncStat(): StatNode {
    const kw = next(); // 'function'
    // funcname: Name {'.' Name} [':' Name]
    let obj: ExpNode | null = null;
    let lastName = name().value;
    let isMethod = false;
    for (;;) {
      if (atOp('.')) {
        next();
        if (obj !== null) obj = { kind: 'index', obj, key: { kind: 'str', value: lastName }, line: kw.line };
        else obj = { kind: 'var', name: lastName, line: kw.line };
        lastName = name().value;
        continue;
      }
      if (atOp(':')) {
        next();
        if (obj !== null) obj = { kind: 'index', obj, key: { kind: 'str', value: lastName }, line: kw.line };
        else obj = { kind: 'var', name: lastName, line: kw.line };
        lastName = name().value;
        isMethod = true;
        continue;
      }
      break;
    }
    const params = isMethod ? ['self', ...parseFuncparams()] : parseFuncparams();
    const body = parseChunk();
    expectKw('end');
    const fn: ExpNode = { kind: 'function', params, body, name: lastName, line: kw.line };
    if (obj === null) {
      // plain name: resolves to a local if one is in scope, else _G
      return {
        kind: 'assign',
        targets: [{ kind: 'name', name: lastName, line: kw.line }],
        exps: [fn],
        line: kw.line,
      };
    }
    return {
      kind: 'assign',
      targets: [{ kind: 'index', obj, key: { kind: 'str', value: lastName }, line: kw.line }],
      exps: [fn],
      line: kw.line,
    };
  }

  function parseFuncparams(): string[] {
    expectOp('(');
    const params: string[] = [];
    if (!atOp(')')) {
      for (;;) {
        const t = next();
        if (t.type === 'op' && t.value === '...') {
          throw new ParseError('varargs (...) are not in the Lua subset', t.line);
        }
        if (t.type !== 'name') throw new ParseError(`<name> expected near '${t.value}'`, t.line);
        params.push(t.value);
        if (atOp(',')) { next(); continue; }
        break;
      }
    }
    expectOp(')');
    return params;
  }

  function parseFuncbody(fnName: string): ExpNode {
    const params = parseFuncparams();
    const line = peek().line;
    const body = parseChunk();
    expectKw('end');
    return { kind: 'function', params, body, name: fnName, line };
  }

  // ─── expressions ─────────────────────────────────────────────────────────

  function parseExpList(): ExpNode[] {
    const list = [parseExp()];
    while (atOp(',')) { next(); list.push(parseExp()); }
    return list;
  }

  // Binary precedence, Lua table: or < and < comparison < .. < +- < mul < unary < ^
  const BINPREC: Record<string, [number, number]> = {
    or: [1, 1], and: [2, 2],
    '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
    '..': [5, 4], // right associative
    '+': [6, 6], '-': [6, 6],
    '*': [7, 7], '/': [7, 7], '//': [7, 7], '%': [7, 7],
    '^': [11, 10], // right associative, binds above unary
  };

  function binKind(t: Token): 'or' | 'and' | 'binop' | null {
    if (t.type === 'keyword' && t.value === 'or') return 'or';
    if (t.type === 'keyword' && t.value === 'and') return 'and';
    if (t.type === 'op' && BINPREC[t.value] !== undefined) return 'binop';
    return null;
  }

  function parseExp(limit = 0): ExpNode {
    let left: ExpNode;
    const t = peek();
    if ((t.type === 'op' && (t.value === '-' || t.value === '#')) ||
        (t.type === 'keyword' && t.value === 'not')) {
      next();
      const e = parseExp(8); // unary binds between * and ^, below neither
      left = t.value === 'not'
        ? { kind: 'unop', op: 'not', e, line: t.line }
        : { kind: 'unop', op: t.value, e, line: t.line };
    } else {
      left = parseSimpleExp();
    }
    for (;;) {
      const op = peek();
      const kind = binKind(op);
      if (kind === null) break;
      const [leftPrec, rightPrec] = BINPREC[op.value as string]!;
      if (leftPrec <= limit) break;
      next();
      const right = parseExp(rightPrec);
      if (kind === 'or') left = { kind: 'or', l: left, r: right };
      else if (kind === 'and') left = { kind: 'and', l: left, r: right };
      else left = { kind: 'binop', op: op.value, l: left, r: right, line: op.line };
    }
    return left;
  }

  function parseSimpleExp(): ExpNode {
    const t = next();
    if (t.type === 'number') {
      const n = Number(t.value);
      if (t.numKind === 'int' && !Number.isSafeInteger(n)) {
        throw new ParseError(
          'integer literals beyond 2^53 are not in the teaching subset — ' +
          'Lua integers are 64-bit, this interpreter is not', t.line);
      }
      return { kind: 'num', value: t.numKind === 'int' ? new LuaInt(n) : new LuaFloat(n) };
    }
    if (t.type === 'string') return { kind: 'str', value: t.value };
    if (t.type === 'keyword') {
      if (t.value === 'nil') return { kind: 'nil' };
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'function') return parseFuncbody('?');
    }
    if (t.type === 'op' && t.value === '...') {
      throw new ParseError('varargs (...) are not in the Lua subset', t.line);
    }
    if (t.type === 'op' && t.value === '{') return parseTableCtor(t.line);
    if (t.type === 'name' || t.type === 'op' && t.value === '(') {
      pos--; // re-read as prefix
      return parseSuffixed();
    }
    throw new ParseError(`unexpected symbol near '${t.value}'`, t.line);
  }

  function parseTableCtor(line: number): ExpNode {
    const fields: { key: ExpNode | null; name: string | null; value: ExpNode }[] = [];
    if (!atOp('}')) {
      for (;;) {
        if (peek().type === 'name' && atNextOp('=')) {
          const nm = name();
          next(); // '='
          fields.push({ key: null, name: nm.value, value: parseExp() });
        } else if (atOp('[')) {
          next();
          const k = parseExp();
          expectOp(']');
          expectOp('=');
          fields.push({ key: k, name: null, value: parseExp() });
        } else {
          fields.push({ key: null, name: null, value: parseExp() });
        }
        if (atOp(',') || atOp(';')) { next(); if (atOp('}')) break; continue; }
        break;
      }
    }
    expectOp('}');
    return { kind: 'tablector', fields, line };
  }

  function atNextOp(op: string): boolean {
    const t = toks[pos + 1];
    return t !== undefined && t.type === 'op' && t.value === op;
  }

  function parseSuffixed(): ExpNode {
    let e = parsePrimary();
    for (;;) {
      const t = peek();
      if (t.type === 'op' && t.value === '.') {
        next();
        e = { kind: 'index', obj: e, key: { kind: 'str', value: name().value }, line: t.line };
        continue;
      }
      if (t.type === 'op' && t.value === '[') {
        next();
        const key = parseExp();
        expectOp(']');
        e = { kind: 'index', obj: e, key, line: t.line };
        continue;
      }
      if (t.type === 'op' && t.value === ':') {
        next();
        const nm = name();
        const args = parseCallargs();
        e = { kind: 'method', self: e, name: nm.value, args, line: t.line };
        continue;
      }
      if (t.type === 'op' && t.value === '(' || t.type === 'string') {
        const args = parseCallargs();
        e = { kind: 'call', fn: e, args, line: t.line };
        continue;
      }
      break;
    }
    return e;
  }

  function parseCallargs(): ExpNode[] {
    const t = peek();
    if (t.type === 'string') { next(); return [{ kind: 'str', value: t.value }]; }
    expectOp('(');
    if (atOp(')')) { next(); return []; }
    const args = parseExpList();
    expectOp(')');
    return args;
  }

  function parsePrimary(): ExpNode {
    const t = next();
    if (t.type === 'name') return { kind: 'var', name: t.value, line: t.line };
    if (t.type === 'op' && t.value === '(') {
      const e = parseExp();
      expectOp(')');
      // Parentheses truncate a call's multiple returns to exactly one —
      // the rule the lesson teaches — so keep the wrapper on calls.
      if (e.kind === 'call' || e.kind === 'method') {
        return { kind: 'paren', e, line: t.line };
      }
      return e;
    }
    throw new ParseError(`unexpected symbol near '${t.value}'`, t.line);
  }

  const body = parseChunk();
  const eof = next();
  if (eof.type !== 'eof') {
    throw new ParseError(`unexpected symbol near '${eof.value}'`, eof.line);
  }
  return { body };
}

export { LexError };
