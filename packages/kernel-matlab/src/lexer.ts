// lexer.ts — hand-written tokenizer for the MATLAB-flavored teaching
// subset. Single pass over the source; every token carries a 1-based line
// number so parser errors are line-mapped for free. Newlines are tokens
// (MATLAB uses them as statement separators and, inside [ ], as row
// separators). The "'" ambiguity is resolved exactly the way MATLAB does
// it: a quote directly after a token that can END an expression is the
// transpose operator, otherwise it opens a single-quoted string.

export type TokenType = 'num' | 'str' | 'name' | 'kw' | 'punct' | 'nl' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
}

export class LexError extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

// Control keywords of the subset, plus the words we refuse by name so the
// error says "not in the teaching subset" instead of "undefined variable".
const KEYWORD: Record<string, true> = {
  if: true, elseif: true, else: true, end: true, for: true, while: true,
  break: true, function: true, return: true,
  // refused with a line-mapped "not in the teaching subset" message:
  try: true, catch: true, global: true, persistent: true, switch: true,
  case: true, otherwise: true, classdef: true,
};

// Longest-match-first punctuators. '{', '}', '@' and '.' are lexed but
// refused by the parser with named errors (cells, function handles,
// structs are outside the subset).
const PUNCTS = [
  '<=', '>=', '==', '~=', '&&', '||', '.*', './', '.^', '.\\', ".'",
  '+', '-', '*', '/', '\\', '^', '.', ',', ';', ':', "'", '~',
  '(', ')', '[', ']', '{', '}', '=', '<', '>', '@',
];

/** Tokens that can end an expression — a "'" right after one of these is
 *  the transpose operator, not the start of a string. */
function canEndExpr(t: Token | undefined): boolean {
  if (t === undefined) return false;
  return t.type === 'num' || t.type === 'str' || t.type === 'name'
    || (t.type === 'punct' && (t.value === ')' || t.value === ']'));
}

export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;

  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isIdentStart = (c: string) =>
    (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);

  while (i < src.length) {
    const c = src[i]!;
    if (c === '\r') { i++; continue; }        // CRLF: the \n does the work
    if (c === '\n') {
      toks.push({ type: 'nl', value: '\n', line });
      line++; i++;
      continue;
    }
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '%') {                          // comment to end of line
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      throw new LexError(
        "not in the teaching subset: double-quoted strings — use 'single quotes'",
        line,
      );
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      const start = i;
      while (i < src.length && isDigit(src[i]!)) i++;
      if (src[i] === '.') { i++; while (i < src.length && isDigit(src[i]!)) i++; }
      if (src[i] === 'e' || src[i] === 'E') {
        let j = i + 1;
        if (src[j] === '+' || src[j] === '-') j++;
        if (isDigit(src[j] ?? '')) { i = j; while (i < src.length && isDigit(src[i]!)) i++; }
      }
      toks.push({ type: 'num', value: src.slice(start, i), line });
      continue;
    }
    if (c === "'") {
      if (canEndExpr(toks[toks.length - 1])) {
        toks.push({ type: 'punct', value: "'", line });
        i++;
        continue;
      }
      // single-quoted string; '' inside is a literal quote
      let text = '';
      i++;
      for (;;) {
        if (i >= src.length || src[i] === '\n') {
          throw new LexError('unterminated string — a quoted string must close on its own line', line);
        }
        if (src[i] === "'") {
          if (src[i + 1] === "'") { text += "'"; i += 2; continue; }
          i++;
          break;
        }
        text += src[i]!;
        i++;
      }
      toks.push({ type: 'str', value: text, line });
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src[i]!)) i++;
      const word = src.slice(start, i);
      toks.push({ type: KEYWORD[word] === true ? 'kw' : 'name', value: word, line });
      continue;
    }
    // '.'-led operators before plain '.': ".'" then '.'; a '.' before a
    // digit was already consumed as a number above.
    const two = src.slice(i, i + 2);
    if (two === ".'") {
      toks.push({ type: 'punct', value: ".'", line });
      i += 2;
      continue;
    }
    if (PUNCTS.includes(two)) {
      toks.push({ type: 'punct', value: two, line });
      i += 2;
      continue;
    }
    if (PUNCTS.includes(c)) {
      toks.push({ type: 'punct', value: c, line });
      i++;
      continue;
    }
    throw new LexError(`unexpected character '${c}'`, line);
  }
  toks.push({ type: 'eof', value: '', line });
  return toks;
}
