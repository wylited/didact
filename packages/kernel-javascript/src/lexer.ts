// lexer.ts — hand-written tokenizer for the teaching subset of JavaScript.
// Single pass over the source; every token carries a 1-based line number so
// parser errors are line-mapped for free. Template literals lex as a token
// stream the parser reassembles: `tplchunk` (cooked text, possibly empty),
// `tplstart` ('${'), the expression's normal tokens, `tplend` ('}') — the
// lexer tracks brace nesting per open substitution so a '}' that closes a
// substitution becomes `tplend` while every other '}' stays a punctuator.

export type TokenType =
  | 'num' | 'str' | 'tplchunk' | 'tplstart' | 'tplend'
  | 'name' | 'kw' | 'punct' | 'eof';

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

// Static keyword table (Record, not Set: fixed string-keyed membership).
const KEYWORD: Record<string, true> = {
  var: true, let: true, const: true, function: true, return: true,
  if: true, else: true, while: true, for: true, break: true,
  continue: true, true: true, false: true, null: true, undefined: true,
  typeof: true, new: true, this: true, class: true, async: true,
  await: true, yield: true, in: true, of: true, instanceof: true,
  delete: true, void: true, do: true,
};

// Longest-match-first punctuators of the subset (plus tokens we reject with
// a named 'not in the teaching subset' error: ++ -- ... ? and `**=` etc).
const PUNCTS = [
  '===', '!==', '**=', '...', '&&=', '||=', '??=', '==', '!=', '<=', '>=',
  '&&', '||', '=>', '++', '--', '+=', '-=', '*=', '/=', '%=', '**',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '(', ')', '{', '}',
  '[', ']', ';', ',', '.', ':', '?',
];

export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  // Brace depth inside each open template substitution; the innermost
  // substitution's depth is the last element.
  const tplDepths: number[] = [];

  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isIdentStart = (c: string) =>
    (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
  const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);

  function readEscape(): string {
    // Consumed after the backslash; `\$` in templates keeps the '$' literal.
    const c = src[i++];
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case '0': return '\0';
      case '\n': line++; return ''; // line continuation
      case undefined: throw new LexError('unterminated escape sequence', line);
      default: return c; // \\ \' \" \` \$ and anything else keep the char
    }
  }

  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      if (i >= src.length) throw new LexError('unterminated block comment', line);
      i += 2;
      continue;
    }

    // String literals.
    if (c === "'" || c === '"') {
      const startLine = line;
      i++;
      let out = '';
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\n') throw new LexError('unterminated string literal', startLine);
        if (src[i] === '\\') { i++; out += readEscape(); }
        else out += src[i++]!;
      }
      if (i >= src.length) throw new LexError('unterminated string literal', startLine);
      i++;
      toks.push({ type: 'str', value: out, line: startLine });
      continue;
    }

    // Template literal: emit the first chunk, then either the token after
    // the closing backtick (template complete) or tplstart for '${'.
    if (c === '`') {
      i++;
      let chunk = '';
      let closed = false;
      while (i < src.length) {
        const t = src[i]!;
        if (t === '`') { i++; closed = true; break; }
        if (t === '\\' && src[i + 1] !== undefined) { i++; chunk += readEscape(); continue; }
        if (t === '$' && src[i + 1] === '{') { i += 2; break; }
        if (t === '\n') line++;
        chunk += t;
        i++;
      }
      if (!closed && i >= src.length && (src[src.length - 1] !== '`' || chunk === '')) {
        // Only an error when we ran off the end without closing anything.
        if (src[i - 1] !== '`') throw new LexError('unterminated template literal', line);
      }
      toks.push({ type: 'tplchunk', value: chunk, line });
      if (!closed) {
        toks.push({ type: 'tplstart', value: '${', line });
        tplDepths.push(0);
      }
      continue;
    }

    // Numbers: decimal integer/fraction/exponent (no hex, BigInt, etc.).
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      const start = i;
      while (i < src.length && isDigit(src[i]!)) i++;
      if (src[i] === '.') { i++; while (i < src.length && isDigit(src[i]!)) i++; }
      if (src[i] === 'e' || src[i] === 'E') {
        const save = i;
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        if (isDigit(src[i] ?? '')) { while (i < src.length && isDigit(src[i]!)) i++; }
        else i = save; // trailing 'e' belongs to the next token
      }
      toks.push({ type: 'num', value: src.slice(start, i), line });
      continue;
    }

    // Identifiers and keywords.
    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src[i]!)) i++;
      const word = src.slice(start, i);
      toks.push({ type: KEYWORD[word] === true ? 'kw' : 'name', value: word, line });
      continue;
    }

    // Punctuators.
    let matched = '';
    for (const p of PUNCTS) {
      if (src.startsWith(p, i)) { matched = p; break; }
    }
    if (matched === '') throw new LexError(`unexpected character '${c}'`, line);
    i += matched.length;
    if (matched === '{' && tplDepths.length > 0) tplDepths[tplDepths.length - 1]!++;
    if (matched === '}' && tplDepths.length > 0) {
      const depth = tplDepths[tplDepths.length - 1]!;
      if (depth === 0) {
        tplDepths.pop();
        toks.push({ type: 'tplend', value: '}', line });
        // Resume template-text mode: lex the next chunk right away.
        let chunk = '';
        let closed = false;
        while (i < src.length) {
          const t = src[i]!;
          if (t === '`') { i++; closed = true; break; }
          if (t === '\\' && src[i + 1] !== undefined) { i++; chunk += readEscape(); continue; }
          if (t === '$' && src[i + 1] === '{') { i += 2; break; }
          if (t === '\n') line++;
          chunk += t;
          i++;
        }
        if (!closed && !chunk && i >= src.length) throw new LexError('unterminated template literal', line);
        toks.push({ type: 'tplchunk', value: chunk, line });
        if (!closed) {
          toks.push({ type: 'tplstart', value: '${', line });
          tplDepths.push(0);
        }
        continue;
      }
      tplDepths[tplDepths.length - 1] = depth - 1;
    }
    toks.push({ type: 'punct', value: matched, line });
  }
  toks.push({ type: 'eof', value: '', line });
  return toks;
}
