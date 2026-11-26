// lexer.ts — hand-written tokenizer for free-form Fortran (F90+).
// Fortran has no reserved words, so every word is a `name` token; the
// parser decides from position whether it is a keyword. Identifiers are
// folded to lower case here (Fortran is case-insensitive), while string
// literals keep their exact bytes. Newlines are tokens because they end
// statements; `;` also separates statements on one line, and `&`
// continues a line. Every token carries a 1-based line number so parser
// and runtime errors are line-mapped.

export type TokenType = 'int' | 'real' | 'string' | 'logical' | 'name' | 'op' | 'nl' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  /** Numeric kind suffix as written (`1_8`, `1.0_dp`): `8` / `dp`. */
  kind?: string;
  line: number;
}

export class LexError extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

/** Dot-delimited named operators, longest first so `.neqv.` wins. */
const DOT_OPS = [
  '.neqv.', '.true.', '.false.', '.and.', '.or.', '.not.', '.eqv.',
  '.eq.', '.ne.', '.lt.', '.le.', '.gt.', '.ge.',
];

const MULTI_OPS = ['(/', '/)', '**', '//', '==', '/=', '<=', '>=', '::', '=>', '=<', '>='];

const SINGLE_OPS = '+-*/(),:;=<>%[]&';

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function isIdentStart(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
}

function isIdentPart(c: string | undefined): boolean {
  return isIdentStart(c) || isDigit(c);
}

export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;

  const push = (type: TokenType, value: string, kind?: string): void => {
    toks.push(kind === undefined ? { type, value, line } : { type, value, kind, line });
  };

  while (i < src.length) {
    const c = src[i]!;

    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      push('nl', '\n');
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') { i++; continue; }

    if (c === '!') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    // Line continuation: a trailing `&` eats the newline, any comment-only
    // lines, leading spaces, and an optional leading `&` on the next line.
    if (c === '&') {
      i++;
      let sawNewline = false;
      for (;;) {
        while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
        if (src[i] === '!') {
          while (i < src.length && src[i] !== '\n') i++;
        }
        if (src[i] === '\n') {
          sawNewline = true;
          i++;
          line++;
          continue;
        }
        break;
      }
      if (!sawNewline) {
        throw new LexError("'&' must end the line it continues", line);
      }
      if (src[i] === '&') i++;
      continue;
    }

    if (c === "'" || c === '"') {
      const quote = c;
      const startLine = line;
      let text = '';
      i++;
      for (;;) {
        if (i >= src.length || src[i] === '\n') {
          throw new LexError('unterminated string literal — close the quote on the same line', startLine);
        }
        if (src[i] === quote) {
          if (src[i + 1] === quote) { text += quote; i += 2; continue; }
          i++;
          break;
        }
        text += src[i]!;
        i++;
      }
      push('string', text);
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const start = i;
      let isReal = false;
      if (c === '.') {
        isReal = true;
        i++;
        while (isDigit(src[i])) i++;
      } else {
        while (isDigit(src[i])) i++;
        if (src[i] === '.') {
          isReal = true;
          i++;
          while (isDigit(src[i])) i++;
        }
      }
      const exp = src[i];
      let doubleExp = false;
      if (exp === 'e' || exp === 'E' || exp === 'd' || exp === 'D') {
        doubleExp = exp === 'd' || exp === 'D';
        let j = i + 1;
        if (src[j] === '+' || src[j] === '-') j++;
        if (isDigit(src[j])) {
          isReal = true;
          i = j;
          while (isDigit(src[i])) i++;
        }
      }
      let kind: string | undefined;
      if (src[i] === '_' && (isIdentStart(src[i + 1]) || isDigit(src[i + 1]))) {
        const kStart = ++i;
        while (isIdentPart(src[i])) i++;
        kind = src.slice(kStart, i).toLowerCase();
      }
      let value = src.slice(start, i);
      if (isReal) value = value.replace(/[dD]/, 'E');
      if (kind === undefined && doubleExp) kind = '8';
      push(isReal ? 'real' : 'int', value, kind);
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      while (isIdentPart(src[i])) i++;
      push('name', src.slice(start, i).toLowerCase());
      continue;
    }

    if (c === '.') {
      let word = '.';
      let j = i + 1;
      while (j < src.length && /[A-Za-z]/.test(src[j]!)) {
        word += src[j]!.toLowerCase();
        j++;
      }
      word += '.';
      if (DOT_OPS.includes(word)) {
        if (word === '.true.' || word === '.false.') {
          push('logical', word === '.true.' ? 'true' : 'false');
        } else {
          push('op', word);
        }
        i = j + 1;
        continue;
      }
      throw new LexError(`unexpected '.' — a dot operator looks like .and. or .true.`, line);
    }

    const two = src.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      push('op', two);
      i += 2;
      continue;
    }
    if (SINGLE_OPS.includes(c)) {
      push('op', c);
      i++;
      continue;
    }

    throw new LexError(`unexpected character '${c}'`, line);
  }

  push('eof', '');
  return toks;
}
