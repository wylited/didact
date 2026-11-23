// reader.ts — the Emacs Lisp reader for the teaching kernel.
//
// `readProgram` turns source text into forms. Nothing is evaluated here:
// quote syntax becomes ordinary `(quote …)` lists, so the evaluator and
// macros see exactly what the reader saw. Every parenthesised form carries
// the 1-based line of its opening token; reader errors carry the line of
// the offending token (or the opening line for an unterminated construct).

import { Float, type Form, type FormArray, FormVector, LispError, Sym } from './value';

type Prefix = 'quote' | 'quasiquote' | 'unquote' | 'unquote-splicing' | 'function';

type Token =
  | { kind: 'open' | 'close' | 'vopen' | 'vclose' | 'dot'; line: number }
  | { kind: 'atom'; line: number; form: Form }
  | { kind: 'prefix'; line: number; name: Prefix; text: string };

/** Whitespace or one of the reader's terminating characters. */
const DELIM = /[\s()\[\]"';,`]/;

/** Integer or float, optionally signed. `-` and `+` alone stay symbols. */
const NUMBER = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };

/** Bind an item array to the FormArray interface, stamping its line. */
function formArray(items: Form[], line: number): FormArray {
  const arr = items as FormArray;
  arr.line = line;
  return arr;
}

function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  if (src.startsWith('#!')) {
    const nl = src.indexOf('\n');
    i = nl < 0 ? src.length : nl + 1;
    line = 2;
  }

  while (i < n) {
    const c = src[i]!;
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === ';') { while (i < n && src[i] !== '\n') i++; continue; }

    if (c === '(') { toks.push({ kind: 'open', line }); i++; continue; }
    if (c === ')') { toks.push({ kind: 'close', line }); i++; continue; }
    if (c === '[') { toks.push({ kind: 'vopen', line }); i++; continue; }
    if (c === ']') { toks.push({ kind: 'vclose', line }); i++; continue; }
    if (c === "'") { toks.push({ kind: 'prefix', line, name: 'quote', text: "'" }); i++; continue; }
    if (c === '`') { toks.push({ kind: 'prefix', line, name: 'quasiquote', text: '`' }); i++; continue; }
    if (c === ',') {
      const splice = src[i + 1] === '@';
      toks.push({ kind: 'prefix', line, name: splice ? 'unquote-splicing' : 'unquote', text: splice ? ',@' : ',' });
      i += splice ? 2 : 1;
      continue;
    }
    if (c === '#' && src[i + 1] === "'") {
      toks.push({ kind: 'prefix', line, name: 'function', text: "#'" });
      i += 2;
      continue;
    }

    if (c === '"') {
      const startLine = line;
      i++;
      let out = '';
      for (;;) {
        if (i >= n) throw new LispError('unterminated string', startLine);
        const d = src[i]!;
        if (d === '"') { i++; break; }
        if (d === '\\') {
          i++;
          if (i >= n) throw new LispError('unterminated string', startLine);
          const e = src[i]!;
          i++;
          if (e === '\n') line++;
          out += ESCAPES[e] ?? e;
          continue;
        }
        if (d === '\n') line++;
        out += d;
        i++;
      }
      toks.push({ kind: 'atom', line: startLine, form: out });
      continue;
    }

    if (c === '?') {
      const startLine = line;
      i++;
      if (i >= n) throw new LispError('invalid character literal', startLine);
      const d = src[i]!;
      let code: number;
      if (d === '\\') {
        i++;
        if (i >= n) throw new LispError('invalid character literal', startLine);
        let mods = 0;
        for (;;) {
          if (src.slice(i, i + 2) === 'C-') { mods |= 1 << 26; i += 2; continue; }
          if (src.slice(i, i + 2) === 'M-') { mods |= 1 << 27; i += 2; continue; }
          if (src.slice(i, i + 2) === 'S-') { mods |= 1 << 25; i += 2; continue; }
          if (src.slice(i, i + 2) === 'H-') { mods |= 1 << 24; i += 2; continue; }
          if (src.slice(i, i + 2) === 'A-') { mods |= 1 << 23; i += 2; continue; }
          if (src[i] === '^') { mods |= 1 << 26; i++; continue; }
          break;
        }
        if (i >= n) throw new LispError('invalid character literal', startLine);
        const e = src[i]!;
        i++;
        if (e === '\n') line++;
        if (mods === 0 && e === 'x') {
          const hex = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i));
          if (hex === null) throw new LispError('invalid hex character escape', startLine);
          code = parseInt(hex[0], 16);
          i += hex[0].length;
        } else if (mods === 0 && e >= '0' && e <= '7') {
          const oct = new RegExp('^[0-7]{0,2}').exec(src.slice(i))![0];
          code = parseInt(e + oct, 8);
          i += oct.length;
        } else if (mods !== 0) {
          code = e === 'n' ? 10
            : e === 't' ? 9
            : e === 'r' ? 13
            : e === 's' ? 32
            : e === '\\' ? 92
            : e.codePointAt(0)!;
        } else {
          code = e === 'n' ? 10
            : e === 't' ? 9
            : e === 'r' ? 13
            : e === 's' ? 32
            : e === 'a' ? 7
            : e === 'b' ? 8
            : e === 'd' ? 127
            : e === 'e' ? 27
            : e === 'f' ? 12
            : e === 'v' ? 11
            : e === '\\' ? 92
            : e.codePointAt(0)!;
        }
        if ((mods & (1 << 26)) !== 0) code &= 0x1f;
        code |= mods & ~(1 << 26);
      } else {
        if (d === '\n') line++;
        code = d.codePointAt(0)!;
        i++;
      }
      toks.push({ kind: 'atom', line: startLine, form: code });
      continue;
    }

    const start = i;
    while (i < n && !DELIM.test(src[i]!)) i++;
    const text = src.slice(start, i);
    if (text === '.') toks.push({ kind: 'dot', line });
    else if (NUMBER.test(text)) {
      const n = Number(text);
      toks.push({ kind: 'atom', line, form: /[.eE]/.test(text) ? new Float(n) : n });
    }
    else toks.push({ kind: 'atom', line, form: Sym.intern(text) });
  }
  return toks;
}

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  all(): Form[] {
    const out: Form[] = [];
    const lines: number[] = [];
    while (this.i < this.toks.length) {
      lines.push(this.toks[this.i]!.line);
      out.push(this.form());
    }
    const tagged = out as Form[] & { lines: number[] };
    Object.defineProperty(tagged, 'lines', { value: lines, enumerable: false });
    return tagged;
  }

  private form(): Form {
    const t = this.toks[this.i]!;
    switch (t.kind) {
      case 'atom':
        this.i++;
        return t.form;
      case 'prefix': {
        this.i++;
        if (this.i >= this.toks.length) {
          throw new LispError(`unexpected end of input after ${t.text}`, t.line);
        }
        return formArray([Sym.intern(t.name), this.form()], t.line);
      }
      case 'open':
        return this.list();
      case 'vopen':
        return this.vector();
      case 'close':
        throw new LispError('unexpected )', t.line);
      case 'vclose':
        throw new LispError('unexpected ]', t.line);
      case 'dot':
        throw new LispError('unexpected .', t.line);
    }
  }

  private list(): FormArray {
    const line = this.toks[this.i]!.line;
    this.i++;
    const out = formArray([], line);
    for (;;) {
      if (this.i >= this.toks.length) throw new LispError('unterminated list', line);
      const t = this.toks[this.i]!;
      if (t.kind === 'close') { this.i++; return out; }
      if (t.kind === 'vclose') throw new LispError('unexpected ]', t.line);
      if (t.kind === 'dot') {
        if (out.length === 0) throw new LispError('malformed dotted pair', t.line);
        const dotLine = t.line;
        this.i++;
        if (this.i >= this.toks.length) throw new LispError('malformed dotted pair', dotLine);
        const tail = this.toks[this.i]!;
        if (tail.kind === 'dot' || tail.kind === 'close') {
          throw new LispError('malformed dotted pair', dotLine);
        }
        if (tail.kind === 'vclose') throw new LispError('unexpected ]', tail.line);
        out.dot = this.form();
        if (this.i >= this.toks.length) throw new LispError('unterminated list', line);
        const end = this.toks[this.i]!;
        if (end.kind === 'vclose') throw new LispError('unexpected ]', end.line);
        if (end.kind !== 'close') throw new LispError('malformed dotted pair', dotLine);
        this.i++;
        return out;
      }
      out.push(this.form());
    }
  }

  private vector(): FormVector {
    const line = this.toks[this.i]!.line;
    this.i++;
    const items: Form[] = [];
    for (;;) {
      if (this.i >= this.toks.length) throw new LispError('unterminated vector', line);
      const t = this.toks[this.i]!;
      if (t.kind === 'vclose') { this.i++; return new FormVector(items, line); }
      if (t.kind === 'close') throw new LispError('unexpected )', t.line);
      if (t.kind === 'dot') throw new LispError('unexpected .', t.line);
      items.push(this.form());
    }
  }
}

/** Read every form in `src`; never evaluates. */
export function readProgram(src: string): Form[] {
  return new Parser(tokenize(src)).all();
}
