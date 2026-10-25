// Reader: source text → Form syntax trees with 1-based line tracking.
//
// Every parenthesised form is a plain array whose `line` property records
// the line of its opening token; errors are raised with that line. The
// reader allocates nothing on the heap — quoted data only becomes cons
// cells when `quote` evaluates it (formToValue in machine.ts).
//
// Syntax: ( ) , ' ` , ,@ strings "…" , comments ; to end of line, atoms
// (numbers, symbols, #t/#f), and dotted pairs (a . b) inside lists.

import { LispError, Sym, type Form, type FormArray } from './value';

interface Token {
  text: string;
  line: number;
}

/** Tokenize; raises LispError with the offending line. */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === ';') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '(' || ch === ')' || ch === "'" || ch === '`') {
      tokens.push({ text: ch, line });
      i++;
      continue;
    }
    if (ch === ',') {
      if (src[i + 1] === '@') { tokens.push({ text: ',@', line }); i += 2; }
      else { tokens.push({ text: ',', line }); i++; }
      continue;
    }
    if (ch === '"') {
      const startLine = line;
      let s = '';
      i++;
      while (i < src.length && src[i] !== '"') {
        const c = src[i]!;
        if (c === '\\' && i + 1 < src.length) {
          const esc = src[i + 1]!;
          s += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          i += 2;
          continue;
        }
        if (c === '\n') line++;
        s += c;
        i++;
      }
      if (i >= src.length) throw new LispError('unterminated string literal', startLine);
      i++; // closing quote
      tokens.push({ text: `"${s}"`, line: startLine });
      continue;
    }
    // atom: read until a delimiter
    let a = '';
    while (i < src.length && !' \t\r\n()\'`,;"'.includes(src[i]!)) {
      a += src[i]!;
      i++;
    }
    if (a.length === 0) throw new LispError(`unexpected character '${ch}'`, line);
    tokens.push({ text: a, line });
  }
  return tokens;
}

function form(elems: Form[], line: number): FormArray {
  const f = elems as FormArray;
  f.line = line;
  return f;
}

/** Parse all top-level forms. Any leftover tokens are an error. */
export function readProgram(src: string): Form[] {
  const tokens = tokenize(src);
  const forms: Form[] = [];
  let pos = 0;
  while (pos < tokens.length) {
    const [f, p] = readForm(tokens, pos);
    forms.push(f);
    pos = p;
  }
  return forms;
}

/** Read one form at `pos`; returns [form, next position]. */
function readForm(tokens: Token[], pos: number): [Form, number] {
  const tok = tokens[pos]!;
  if (tok.text === '(') return readList(tokens, pos + 1, tok.line);
  if (tok.text === ')') throw new LispError('unexpected )', tok.line);
  if (tok.text === "'" || tok.text === '`' || tok.text === ',' || tok.text === ',@') {
    const [inner, p] = readForm(tokens, pos + 1);
    const head = tok.text === "'" ? 'quote'
      : tok.text === '`' ? 'quasiquote'
      : tok.text === ',' ? 'unquote' : 'unquote-splicing';
    return [form([Sym.intern(head), inner], tok.line), p];
  }
  return [readAtom(tok), pos + 1];
}

/** Read until the closing ); supports one dotted tail: (a b . c). */
function readList(tokens: Token[], pos: number, openLine: number): [Form, number] {
  const elems: Form[] = [];
  let dot: Form | null = null;
  let i = pos;
  for (; i < tokens.length; i) {
    const tok = tokens[i]!;
    if (tok.text === ')') {
      const f = form(elems, openLine);
      if (dot !== null) (f as FormArray & { dot?: Form }).dot = dot;
      return [f, i + 1];
    }
    if (tok.text === '.') {
      if (dot !== null) throw new LispError('more than one . in a list', tok.line);
      const [tail, p] = readForm(tokens, i + 1);
      dot = tail;
      i = p;
      continue;
    }
    const [f, p] = readForm(tokens, i);
    elems.push(f);
    i = p;
  }
  throw new LispError('unclosed ( — missing )', openLine);
}

/** An atom token → number | boolean | string | symbol. */
function readAtom(tok: Token): Form {
  const t = tok.text;
  if (t.startsWith('"')) return t.slice(1, -1);
  if (t === '#t' || t === '#true') return true;
  if (t === '#f' || t === '#false') return false;
  const n = Number(t);
  // Number() accepts '' and whitespace; both impossible here (non-empty,
  // delimiter-free), but reject NaN explicitly for anything symbolic.
  if (!Number.isNaN(n)) return n;
  return Sym.intern(t);
}
