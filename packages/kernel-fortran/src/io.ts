// io.ts — Fortran output formatting.
//
// List-directed output (`print *`) is deliberately readable rather than
// byte-identical to gfortran: values are separated by one space, reals
// keep a decimal point, arrays flatten in column-major order. Explicit
// formats are the real thing, because HPC output is written with them:
// Iw[.m], Fw.d, Ew.d[Ee], ESw.d, ENw.d, Dw.d, Gw.d, Aw, Lw, nX, `/`,
// `:`, quoted literals, repeat counts and nested groups, including
// format reversion when the item list outlives the format.

import {
  asInt, asReal, asString, flatten, fmtScalar,
  type Elem, type Value,
} from './value';
import { RuntimeErr } from './value';

type FmtNode =
  | { k: 'desc'; letter: string; count: number; width: number | null; digits: number | null; exp: number | null }
  | { k: 'lit'; text: string }
  | { k: 'slash' }
  | { k: 'colon' }
  | { k: 'group'; repeat: number; items: FmtNode[] };

/** List-directed item text: one space between values, arrays flattened. */
export function listDirected(values: Value[], line: number): string {
  const items: Elem[] = [];
  for (const v of values) items.push(...flatten(v, line));
  return items.map(fmtScalar).join(' ');
}

class FormatError extends Error {}

class FormatParser {
  private i = 0;

  constructor(private s: string, private line: number) {}

  parse(): FmtNode[] {
    this.skip();
    if (this.s[this.i] !== '(') throw new FormatError('a format must start with "("');
    const nodes = this.parseGroup();
    this.skip();
    if (this.i < this.s.length) throw new FormatError('text after the closing ")" of a format');
    return nodes;
  }

  private parseGroup(): FmtNode[] {
    if (this.s[this.i] !== '(') throw new FormatError('expected "("');
    this.i++;
    const nodes: FmtNode[] = [];
    for (;;) {
      this.skip();
      if (this.i >= this.s.length) throw new FormatError('unterminated format group');
      const c = this.s[this.i]!;
      if (c === ')') { this.i++; return nodes; }
      if (c === ',') { this.i++; continue; }
      if (c === '/') { this.i++; nodes.push({ k: 'slash' }); continue; }
      if (c === ':') { this.i++; nodes.push({ k: 'colon' }); continue; }
      if (c === "'" || c === '"') { nodes.push({ k: 'lit', text: this.parseString(c) }); continue; }
      if (c === '(') { nodes.push({ k: 'group', repeat: 1, items: this.parseGroup() }); continue; }
      if (c >= '0' && c <= '9') {
        const count = this.parseInt();
        this.skip();
        if (this.s[this.i] === '(') {
          nodes.push({ k: 'group', repeat: count, items: this.parseGroup() });
        } else if (this.s[this.i] === "'" || this.s[this.i] === '"') {
          const text = this.parseString(this.s[this.i]!);
          for (let k = 0; k < count; k++) nodes.push({ k: 'lit', text });
        } else {
          nodes.push(this.parseDescriptor(count));
        }
        continue;
      }
      if (/[A-Za-z]/.test(c)) { nodes.push(this.parseDescriptor(1)); continue; }
      throw new FormatError(`unexpected '${c}' in format`);
    }
  }

  private parseDescriptor(count: number): FmtNode {
    this.skip();
    let letter = this.s[this.i]!.toUpperCase();
    this.i++;
    if (letter === 'E' && (this.s[this.i]?.toUpperCase() === 'S' || this.s[this.i]?.toUpperCase() === 'N')) {
      letter += this.s[this.i]!.toUpperCase();
      this.i++;
    }
    let width = this.readOptionalInt();
    if (width === 0) width = null; // I0 / F0.d: minimal width
    let digits: number | null = null;
    let exp: number | null = null;
    if (this.s[this.i] === '.') {
      this.i++;
      digits = this.readOptionalInt();
    }
    if ((letter === 'E' || letter === 'D' || letter === 'ES' || letter === 'EN')
      && this.s[this.i]?.toUpperCase() === 'E') {
      this.i++;
      exp = this.readOptionalInt();
    }
    return { k: 'desc', letter, count, width, digits, exp };
  }

  private readOptionalInt(): number | null {
    if (!/[0-9]/.test(this.s[this.i] ?? '')) return null;
    return this.parseInt();
  }

  private parseInt(): number {
    let n = 0;
    let any = false;
    while (/[0-9]/.test(this.s[this.i] ?? '')) {
      any = true;
      n = n * 10 + Number(this.s[this.i]);
      this.i++;
    }
    if (!any) throw new FormatError('expected a number in the format');
    return n;
  }

  private parseString(quote: string): string {
    this.i++;
    let text = '';
    for (;;) {
      if (this.i >= this.s.length) throw new FormatError('unterminated string in format');
      const c = this.s[this.i]!;
      if (c === quote) {
        if (this.s[this.i + 1] === quote) { text += quote; this.i += 2; continue; }
        this.i++;
        return text;
      }
      text += c;
      this.i++;
    }
  }

  private skip(): void {
    while (this.s[this.i] === ' ') this.i++;
  }
}

function fit(text: string, width: number | null): string {
  if (width === null) return text;
  if (text.length > width) return '*'.repeat(width);
  return text.padStart(width, ' ');
}

function fixed(x: number, digits: number): string {
  const v = Object.is(x, -0) ? 0 : x;
  const text = v.toFixed(digits);
  if (!/[eE]/.test(text)) return text;
  return v.toLocaleString('en-US', {
    useGrouping: false,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function scientific(
  x: number,
  digits: number,
  mode: 'E' | 'ES' | 'EN',
  expWidth: number,
  expLetter: 'E' | 'D' = 'E',
): string {
  const sign = x < 0 ? '-' : '';
  const ax = Math.abs(x);
  const point = digits === 0 ? '.' : '';
  if (ax === 0) {
    return `${sign}0${point}${'0'.repeat(digits)}${expLetter}+${'0'.repeat(expWidth)}`;
  }
  let exp = Math.floor(Math.log10(ax));
  let mant: number;
  let outExp: number;
  if (mode === 'E') {
    outExp = exp + 1;
    mant = ax / 10 ** outExp;
  } else if (mode === 'ES') {
    outExp = exp;
    mant = ax / 10 ** exp;
  } else {
    outExp = Math.floor(exp / 3) * 3;
    mant = ax / 10 ** outExp;
  }
  let mantText = mant.toFixed(digits);
  if (Number(mantText) >= (mode === 'E' ? 1 : mode === 'EN' ? 1000 : 10)) {
    if (mode === 'E') { outExp++; mantText = (mant / 10).toFixed(digits); }
    else if (mode === 'EN') { outExp += 3; mantText = (mant / 1000).toFixed(digits); }
    else { outExp++; mantText = (mant / 10).toFixed(digits); }
  }
  if (mode === 'E' && !mantText.startsWith('0')) mantText = `0${mantText}`;
  if (digits === 0 && !mantText.includes('.')) mantText += '.';
  const eSign = outExp < 0 ? '-' : '+';
  const eDigits = Math.abs(outExp).toString().padStart(expWidth, '0');
  return `${sign}${mantText}${expLetter}${eSign}${eDigits}`;
}

function general(x: number, digits: number, width: number | null, expWidth: number): string {
  const pad = expWidth + 2;
  const fixedForm = (text: string): string => {
    if (width === null) return text;
    if (width <= pad || text.length > width - pad) return '*'.repeat(width);
    return text.padStart(width - pad, ' ') + ' '.repeat(pad);
  };
  if (x === 0) return fixedForm(fixed(0, Math.max(0, digits - 1)));
  const exp = Math.floor(Math.log10(Math.abs(x)));
  if (exp >= -1 && exp < digits) {
    const d = Math.max(0, digits - 1 - exp);
    return fixedForm(fixed(x, d));
  }
  return fit(scientific(x, Math.max(0, digits - 1), 'ES', expWidth), width);
}

interface RenderState {
  items: Elem[];
  cursor: number;
  out: string;
  stop: boolean;
  pendingIm: number | null;
  line: number;
}

function isRealDescriptor(letter: string): boolean {
  return letter === 'F' || letter === 'E' || letter === 'D'
    || letter === 'ES' || letter === 'EN' || letter === 'G';
}

function realItem(item: Elem | undefined, st: RenderState): number {
  if (st.pendingIm !== null) {
    const v = st.pendingIm;
    st.pendingIm = null;
    return v;
  }
  if (item === undefined) throw new RuntimeErr('missing REAL value for an edit descriptor', st.line);
  if (item.k === 'complex') {
    st.pendingIm = item.im;
    return item.re;
  }
  return asReal(item, st.line);
}

function renderNodes(nodes: FmtNode[], st: RenderState): void {
  for (const node of nodes) {
    if (st.stop) return;
    if (node.k === 'desc' && node.letter !== 'X'
      && st.cursor >= st.items.length && st.pendingIm === null) {
      st.stop = true;
      return;
    }
    switch (node.k) {
      case 'lit': st.out += node.text; break;
      case 'slash': st.out += '\n'; break;
      case 'colon':
        if (st.cursor >= st.items.length) st.stop = true;
        break;
      case 'group':
        for (let r = 0; r < node.repeat && !st.stop; r++) renderNodes(node.items, st);
        break;
      case 'desc': {
        for (let r = 0; r < node.count && !st.stop; r++) {
          renderDescriptor(node, st);
        }
        break;
      }
    }
  }
}

function renderDescriptor(
  node: Extract<FmtNode, { k: 'desc' }>,
  st: RenderState,
): void {
  const letter = node.letter;
  if (letter === 'X') {
    st.out += ' ';
    return;
  }
  const realDescriptor = isRealDescriptor(letter);
  let item: Elem | undefined;
  if (st.pendingIm === null) {
    item = st.items[st.cursor];
    if (item === undefined) {
      st.stop = true;
      return;
    }
    st.cursor++;
  } else if (!realDescriptor) {
    throw new RuntimeErr('a COMPLEX item needs two real edit descriptors', st.line);
  }
  switch (letter) {
    case 'I': {
      const v = asInt(item!, st.line);
      const body = String(Math.abs(v)).padStart(node.digits ?? 0, '0');
      st.out += fit(`${v < 0 ? '-' : ''}${body}`, node.width);
      break;
    }
    case 'F': {
      const d = node.digits ?? 0;
      st.out += fit(fixed(realItem(item, st), d), node.width);
      break;
    }
    case 'E':
    case 'D':
    case 'ES':
    case 'EN': {
      const mode = letter === 'ES' ? 'ES' : letter === 'EN' ? 'EN' : 'E';
      const expLetter = letter === 'D' ? 'D' : 'E';
      st.out += fit(
        scientific(realItem(item, st), node.digits ?? 0, mode, node.exp ?? 2, expLetter),
        node.width,
      );
      break;
    }
    case 'G':
      st.out += general(realItem(item, st), node.digits ?? 1, node.width, node.exp ?? 2);
      break;
    case 'A': {
      const s = asString(item!, st.line);
      if (node.width === null) st.out += s;
      else if (s.length > node.width) st.out += s.slice(0, node.width);
      else st.out += s.padStart(node.width, ' ');
      break;
    }
    case 'L': {
      if (item!.k !== 'logical') throw new RuntimeErr('L edit descriptor expects a LOGICAL value', st.line);
      st.out += fit(item!.v ? 'T' : 'F', node.width);
      break;
    }
    case 'Z':
    case 'O':
    case 'B': {
      const base = letter === 'Z' ? 16 : letter === 'O' ? 8 : 2;
      let s = (asInt(item!, st.line) >>> 0).toString(base).toUpperCase();
      if (node.digits !== null) s = s.padStart(node.digits, '0');
      st.out += fit(s, node.width);
      break;
    }
    default:
      throw new RuntimeErr(`unsupported edit descriptor '${letter}'`, st.line);
  }
}

/** Render one WRITE/PRINT with an explicit format. Returns the exact text
 *  (caller adds the final newline unless ADVANCE='no'). */
export function formatOutput(format: string, values: Value[], line: number): string {
  let nodes: FmtNode[];
  try {
    nodes = new FormatParser(format, line).parse();
  } catch (e) {
    if (e instanceof FormatError) throw new RuntimeErr(`format: ${e.message}`, line);
    throw e;
  }
  const items: Elem[] = [];
  for (const v of values) items.push(...flatten(v, line));
  const st: RenderState = { items, cursor: 0, out: '', stop: false, pendingIm: null, line };
  let guard = 0;
  for (;;) {
    const before = st.cursor;
    renderNodes(nodes, st);
    if (st.stop || st.cursor >= items.length) break;
    if (st.cursor === before && ++guard > 64) {
      throw new RuntimeErr('format reversion made no progress — add a data descriptor', line);
    }
    // A reversion starts a new record. (This subset restarts at the whole
    // format rather than the last top-level group.)
    if (!st.out.endsWith('\n')) st.out += '\n';
  }
  if (st.pendingIm !== null) {
    throw new RuntimeErr('a COMPLEX item needs two real edit descriptors', line);
  }
  return st.out;
}
