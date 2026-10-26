// lexer.ts — SQL tokenizer. Keywords are recognized case-insensitively;
// string literals keep their case (values are case-SENSITIVE). Every token
// carries the 1-based line it starts on, so load-time errors are line-mapped.

/** One token; `up` is the uppercased text for keyword checks. */
export type Token =
  | { type: 'word'; text: string; up: string; line: number }
  | { type: 'number'; text: string; up: string; value: number; line: number }
  | { type: 'string'; text: string; up: string; value: string; line: number }
  | { type: 'op'; text: string; up: string; line: number }
  | { type: 'end'; text: string; up: string; line: number };

export class SqlSyntaxError extends Error {
  constructor(readonly line: number, message: string) {
    super(message);
    this.name = 'SqlSyntaxError';
  }
}

const OPS = ['<=', '>=', '<>', '<', '>', '=', '+', '-', '*', '/', '(', ')', ',', '.', ';'];

// (identifier = [A-Za-z_][A-Za-z0-9_]*; INTEGER literals are digit runs)

/** Tokenize a whole block. Throws SqlSyntaxError with a 1-based line. */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {          // -- comment to end of line
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c >= '0' && c <= '9') {                      // INTEGER literal (no decimals in v1)
      let j = i;
      while (j < n && src[j]! >= '0' && src[j]! <= '9') j++;
      const text = src.slice(i, j);
      tokens.push({ type: 'number', text, up: text, value: Number(text), line });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {                       // identifier or keyword
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      const text = src.slice(i, j);
      tokens.push({ type: 'word', text, up: text.toUpperCase(), line });
      i = j;
      continue;
    }
    if (c === "'") {                                 // 'string', '' escapes a quote
      let j = i + 1;
      let value = '';
      const startLine = line;                        // errors name where the string began
      for (;;) {
        if (j >= n) throw new SqlSyntaxError(startLine, "unterminated string literal — a ' is missing");
        if (src[j] === "'") {
          if (src[j + 1] === "'") { value += "'"; j += 2; continue; }
          break;
        }
        if (src[j] === '\n') line++;
        value += src[j]!;
        j++;
      }
      tokens.push({ type: 'string', text: `'${value}'`, up: value.toUpperCase(), value, line: startLine });
      j++;
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op !== undefined) {
      tokens.push({ type: 'op', text: op, up: op, line });
      i += op.length;
      continue;
    }
    throw new SqlSyntaxError(line, `unexpected character '${c}'`);
  }
  tokens.push({ type: 'end', text: '', up: '', line });
  return tokens;
}

