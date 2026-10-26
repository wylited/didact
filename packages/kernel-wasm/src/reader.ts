// reader.ts — s-expression reader for the teaching WAT subset.
// Parenthesized text → Node trees; every node carries the 1-based line of
// its first token, so every downstream error can be line-mapped. Comments
// are `;`-to-end-of-line (the `;;` you see in lessons); block comments
// `(; ;)`, string escapes and any other lexical business are deliberately
// out of the subset and fail with clean, line-mapped errors.

/** A compile-time error that knows the 1-based source line it came from. */
export class WatError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

export interface Atom { kind: 'atom'; line: number; text: string }
export interface Str { kind: 'string'; line: number; text: string }
export interface Lst { kind: 'list'; line: number; items: Node[] }

export type Node = Atom | Str | Lst;

export const isAtom = (n: Node): n is Atom => n.kind === 'atom';
export const isStr = (n: Node): n is Str => n.kind === 'string';
export const isList = (n: Node): n is Lst => n.kind === 'list';

interface Token {
  kind: 'atom' | 'string' | 'open' | 'close';
  text: string;
  line: number;
}

// Any of these characters ends an atom token.
const ATOM_END = ' \t\r\n();"';

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') {
      line++;
      i++;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      i++;
    } else if (c === ';') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '(') {
      if (src[i + 1] === ';') {
        throw new WatError('block comments (; ;) are not in the teaching subset — use ;; line comments', line);
      }
      tokens.push({ kind: 'open', text: '(', line });
      i++;
    } else if (c === ')') {
      tokens.push({ kind: 'close', text: ')', line });
      i++;
    } else if (c === '"') {
      const startLine = line;
      i++;
      let text = '';
      while (i < src.length && src[i] !== '"') {
        const ch = src[i]!;
        if (ch === '\\') {
          throw new WatError('string escapes are not in the teaching subset', startLine);
        }
        if (ch === '\n' || ch < ' ' || ch > '~') {
          throw new WatError(`bad character ${JSON.stringify(ch)} in string literal`, startLine);
        }
        text += ch;
        i++;
      }
      if (i >= src.length) throw new WatError('unclosed string literal', startLine);
      i++;
      tokens.push({ kind: 'string', text, line: startLine });
    } else {
      const start = i;
      while (i < src.length && !ATOM_END.includes(src[i]!)) i++;
      tokens.push({ kind: 'atom', text: src.slice(start, i), line });
    }
  }
  return tokens;
}

/** Read the whole source and return its single `(module …)` node. */
export function parseModule(src: string): Lst {
  const stack: { line: number; items: Node[] }[] = [];
  const root: { line: number; items: Node[] } = { line: 1, items: [] };
  for (const tok of tokenize(src)) {
    let top = stack.length > 0 ? stack[stack.length - 1]! : root;
    switch (tok.kind) {
      case 'open':
        stack.push({ line: tok.line, items: [] });
        break;
      case 'close': {
        if (stack.length === 0) throw new WatError("unexpected ')'", tok.line);
        const closed = stack.pop()!;
        top = stack.length > 0 ? stack[stack.length - 1]! : root;
        top.items.push({ kind: 'list', line: closed.line, items: closed.items });
        break;
      }
      case 'string':
        top.items.push({ kind: 'string', line: tok.line, text: tok.text });
        break;
      case 'atom':
        top.items.push({ kind: 'atom', line: tok.line, text: tok.text });
        break;
    }
  }
  if (stack.length > 0) {
    throw new WatError(`unclosed '(' opened on this line`, stack[stack.length - 1]!.line);
  }
  if (root.items.length === 0) throw new WatError('empty source: expected (module …)', 1);
  if (root.items.length > 1) {
    throw new WatError('expected exactly one (module …) form', root.items[1]!.line);
  }
  const mod = root.items[0]!;
  if (mod.kind !== 'list' || mod.items.length === 0 || mod.items[0]!.kind !== 'atom' || mod.items[0]!.text !== 'module') {
    throw new WatError('expected the source to be a single (module …)', mod.line);
  }
  return mod;
}
