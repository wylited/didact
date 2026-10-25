// lexer.ts — Lua 5.4-flavored tokenizer. Pure, line-tracking, no regex
// backtracking: one character of lookahead decides the token.

export class LexError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
    this.name = 'LexError';
  }
}

export type TokType =
  | 'name' | 'number' | 'string' | 'keyword'
  | 'op' | 'eof';

export interface Token {
  type: TokType;
  value: string;          // name text, literal string value, operator text
  /** For numbers: 'int' or 'float' — the 1-vs-1.0 distinction starts here. */
  numKind?: 'int' | 'float';
  line: number;
}
const KEYWORDS: Record<string, true> = {
  and: true, break: true, do: true, else: true, elseif: true, end: true,
  false: true, for: true, function: true, goto: true, if: true, in: true,
  local: true, nil: true, not: true, or: true, repeat: true, return: true,
  then: true, true: true, until: true, while: true,
};

const OPS3 = ['...'];
const OPS1 = '+-*/%^#&~|<>=(){}[];:,.';
const OPS2 = ['==', '~=', '<=', '>=', '//', '::', '..'];
function isDigit(c: string): boolean { return c >= '0' && c <= '9'; }
function isHexDigit(c: string): boolean {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
function isNameStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isNameChar(c: string): boolean { return isNameStart(c) || isDigit(c); }

export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    // comments: -- line, --[[ block ]]
    if (c === '-' && src[i + 1] === '-') {
      i += 2;
      if (src[i] === '[' && src[i + 1] === '[') {
        const openLine = line;
        i += 2;
        for (;;) {
          if (i >= n) throw new LexError('unfinished long comment', openLine);
          if (src[i] === '\n') line++;
          if (src[i] === ']' && src[i + 1] === ']') { i += 2; break; }
          i++;
        }
        continue;
      }
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    if (isNameStart(c)) {
      const start = i;
      while (i < n && isNameChar(src[i]!)) i++;
      const word = src.slice(start, i);
      toks.push({ type: KEYWORDS[word] === undefined ? 'name' : 'keyword', value: word, line });
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      const start = i;
      let kind: 'int' | 'float' = 'int';
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        i += 2;
        const hs = i;
        while (i < n && isHexDigit(src[i]!)) i++;
        if (i === hs) throw new LexError('malformed hexadecimal number', line);
        toks.push({ type: 'number', value: String(parseInt(src.slice(start + 2, i), 16)), numKind: 'int', line });
        continue;
      }
      while (i < n && isDigit(src[i]!)) i++;
      if (src[i] === '.') {
        kind = 'float';
        i++;
        while (i < n && isDigit(src[i]!)) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        kind = 'float';
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        const es = i;
        while (i < n && isDigit(src[i]!)) i++;
        if (i === es) throw new LexError('malformed exponent', line);
      }
      toks.push({ type: 'number', value: src.slice(start, i), numKind: kind, line });
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      const openLine = line;
      i++;
      let out = '';
      for (;;) {
        if (i >= n) throw new LexError('unfinished string', openLine);
        const ch = src[i]!;
        if (ch === '\n') throw new LexError('unfinished string', openLine);
        if (ch === quote) { i++; break; }
        if (ch === '\\') {
          i++;
          const esc = src[i]!;
          if (esc === undefined) throw new LexError('unfinished string', openLine);
          switch (esc) {
            case 'n': out += '\n'; break;
            case 't': out += '\t'; break;
            case 'r': out += '\r'; break;
            case '\\': out += '\\'; break;
            case '"': out += '"'; break;
            case "'": out += "'"; break;
            case '\n': out += '\n'; line++; break;
            default: throw new LexError(`invalid escape sequence '\\${esc}'`, openLine);
          }
          i++;
          continue;
        }
        out += ch;
        i++;
      }
      toks.push({ type: 'string', value: out, line });
      continue;
    }

    const three = src.slice(i, i + 3);
    if (OPS3.includes(three)) { toks.push({ type: 'op', value: three, line }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) { toks.push({ type: 'op', value: two, line }); i += 2; continue; }
    if (OPS1.includes(c)) { toks.push({ type: 'op', value: c, line }); i++; continue; }
    throw new LexError(`unexpected symbol near '${c}'`, line);
  }
  toks.push({ type: 'eof', value: '<eof>', line });
  return toks;
}
