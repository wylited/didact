// Two-pass assembler front-end for Keystone.
//
// Keystone has NO labels, directives or sections: it assembles single
// instructions in Intel syntax, and it DOES honour the per-call base address
// when encoding branch/call displacements and [absolute] memory operands
// (disp32 forms come out RIP-relative, computed from that address). So this
// module:
//
//   1. parses the student source itself (labels, `;` comments, `.text`/`.data`
//      sections, `db/dw/dd/dq` data, `equ`/`=` constants, `$`),
//   2. computes instruction lengths iteratively — Keystone picks the short
//      rel8 form whenever a branch target is in range, so layout and encoding
//      are re-computed until stable (sizes shrink monotonically: converges),
//   3. re-encodes every instruction from its final address with all labels
//      substituted as absolute hex targets,
//   4. maps every source line to its address range for the editor and the
//      disassembly panel.

import type { KeystoneFacade } from './vendor';

export const CODE_BASE = 0x401000;
export const CODE_SIZE = 0x10000;
export const DATA_BASE = 0x601000;
export const DATA_SIZE = 0x10000;
/** Longest possible x86-64 instruction + 1; dummy size used before first encoding. */
const DUMMY_INSN_SIZE = 16;

export interface AsmError {
  line: number;
  message: string;
}

export interface CodeLine {
  line: number;
  addr: number;
  size: number;
  /** The exact text handed to Keystone (labels already substituted). */
  text: string;
}

export interface AssembledProgram {
  code: Uint8Array;
  data: Uint8Array;
  entry: number;
  sourceLines: CodeLine[];
  labels: Map<string, number>;
}

export type AssembleResult =
  | { ok: true; program: AssembledProgram }
  | { ok: false; errors: AsmError[] };

type Section = 'text' | 'data';
type DataOp = 'db' | 'dw' | 'dd' | 'dq';

interface Stmt {
  line: number;
  section: Section;
  /** Enclosing global label, for resolving NASM-style `.local` names. */
  scope: string;
  labels: string[];
  kind: 'insn' | 'data' | 'equ' | 'anchor';
  text: string;
  directive?: DataOp;
  items?: string[];
  dataSize?: number;
  equName?: string;
  equExpr?: string;
}

function staticTable(words: string): Record<string, true> {
  const table: Record<string, true> = {};
  for (const w of words.split(/\s+/)) table[w] = true;
  return table;
}

const REGISTERS = staticTable(
  'rax rbx rcx rdx rsi rdi rbp rsp r8 r9 r10 r11 r12 r13 r14 r15 ' +
    'eax ebx ecx edx esi edi ebp esp r8d r9d r10d r11d r12d r13d r14d r15d ' +
    'ax bx cx dx si di bp sp r8w r9w r10w r11w r12w r13w r14w r15w ' +
    'al bl cl dl sil dil bpl spl ah bh ch dh r8b r9b r10b r11b r12b r13b r14b r15b ' +
    'rip eip ip eflags flags ' +
    'xmm0 xmm1 xmm2 xmm3 xmm4 xmm5 xmm6 xmm7 xmm8 xmm9 xmm10 xmm11 xmm12 xmm13 xmm14 xmm15 ' +
    'cs ds es fs gs ss st0 st1 st2 st3 st4 st5 st6 st7 cr0 cr2 cr3 cr4',
);
const OPERAND_KEYWORDS = staticTable('ptr byte word dword qword short near far offset');
const DATA_OPS: Record<string, DataOp> = { db: 'db', dw: 'dw', dd: 'dd', dq: 'dq' };
const DATA_SIZES: Record<DataOp, number> = { db: 1, dw: 2, dd: 4, dq: 8 };

/** Index of the first top-level `;`, ignoring `;` inside string/char literals; -1 if none. */
function commentStart(raw: string): number {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ';') {
      return i;
    }
  }
  return -1;
}

/** Cut a `;` comment, ignoring `;` inside string/char literals. */
function stripComment(raw: string): string {
  const at = commentStart(raw);
  return at < 0 ? raw : raw.slice(0, at);
}

/** Map each 1-based source line to its trailing `;` comment text (trimmed); lines without one are absent. */
export function lineComments(source: string): Map<number, string> {
  const map = new Map<number, string>();
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const at = commentStart(lines[i]);
    if (at >= 0) {
      const text = lines[i].slice(at + 1).trim();
      if (text.length > 0) map.set(i + 1, text);
    }
  }
  return map;
}

/** Decode backslash escapes to byte values; used for db strings and char literals. */
function decodeEscapes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '\\' || i + 1 >= text.length) {
      out.push(c.charCodeAt(0));
      continue;
    }
    i++;
    const e = text[i];
    if (e === 'n') out.push(10);
    else if (e === 't') out.push(9);
    else if (e === 'r') out.push(13);
    else if (e === '0') out.push(0);
    else if (e === 'a') out.push(7);
    else if (e === 'b') out.push(8);
    else if (e === '\\') out.push(92);
    else if (e === '"') out.push(34);
    else if (e === "'") out.push(39);
    else if (e === 'x') {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{1,2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += hex.length;
      } else {
        out.push(e.charCodeAt(0));
      }
    } else {
      out.push(e.charCodeAt(0));
    }
  }
  return out;
}

/** Split `a, b, "c, d", e` on top-level commas only. */
function splitItems(text: string): string[] {
  const items: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === '\\') {
        if (i + 1 < text.length) cur += text[++i];
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      items.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim().length > 0) items.push(cur.trim());
  return items;
}

function isStringItem(item: string): boolean {
  return item.length >= 2 && item.startsWith('"') && item.endsWith('"');
}

interface ParsedSource {
  stmts: Stmt[];
  errors: AsmError[];
}

function parseSource(source: string): ParsedSource {
  const stmts: Stmt[] = [];
  const errors: AsmError[] = [];
  const lines = source.split(/\r?\n/);
  let section: Section = 'text';
  let pending: string[] = [];
  let scope = '';
  const seenSymbols = new Set<string>();

  const define = (line: number, scoped: string): void => {
    if (seenSymbols.has(scoped)) {
      errors.push({ line, message: `symbol '${scoped}' is defined more than once` });
    }
    seenSymbols.add(scoped);
  };

  /** Bind pending labels to the current end offset of `sect` (zero-size anchor). */
  const anchor = (line: number, sect: Section): void => {
    if (pending.length === 0) return;
    stmts.push({ line, section: sect, scope, labels: pending, kind: 'anchor', text: '' });
    pending = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const text = stripComment(lines[i]).trim();
    if (text.length === 0) continue;

    // Leading labels (`name:`, possibly several, possibly `.local:`).
    let rest = text;
    const labels: string[] = [];
    for (;;) {
      const m = /^([A-Za-z_.$][\w.$]*)\s*:\s*/.exec(rest);
      if (!m) break;
      const name = m[1];
      if (name.toLowerCase() in REGISTERS) {
        errors.push({ line: lineNo, message: `'${name}' is a register name and cannot be used as a label` });
      }
      if (name.startsWith('.')) {
        define(lineNo, scope + name);
        labels.push(scope + name);
      } else {
        define(lineNo, name);
        labels.push(name);
        scope = name;
      }
      rest = rest.slice(m[0].length);
    }

    if (rest.length === 0) {
      pending.push(...labels);
      continue;
    }

    // Section switches and ignorable directives.
    const lower = rest.toLowerCase();
    if (lower === '.text' || lower === 'section .text' || lower === 'section .code' || lower === 'segment .text') {
      anchor(lineNo, section);
      section = 'text';
      continue;
    }
    if (lower === '.data' || lower === 'section .data' || lower === 'segment .data') {
      anchor(lineNo, section);
      section = 'data';
      continue;
    }
    if (/^(\.global|\.globl|\.extern|\.type|\.size)\b/.test(lower)) continue;
    if (/^(section|segment)\b/.test(lower)) {
      errors.push({ line: lineNo, message: `unsupported section directive: '${rest}' (use .text or .data)` });
      continue;
    }

    // `name equ expr` / `name = expr` constants.
    const equ = /^([A-Za-z_.$][\w.$]*)\s+equ\s+(.+)$/i.exec(rest);
    const assign = !equ ? /^([A-Za-z_.$][\w.$]*)\s*=\s*(.+)$/.exec(rest) : null;
    if (equ || assign) {
      const name = (equ ?? assign)![1];
      const expr = ((equ ?? assign)![2] as string).trim();
      const scoped = name.startsWith('.') ? scope + name : name;
      define(lineNo, scoped);
      stmts.push({
        line: lineNo,
        section,
        scope,
        labels: [...pending, ...labels],
        kind: 'equ',
        text: rest,
        equName: scoped,
        equExpr: expr,
      });
      pending = [];
      continue;
    }

    // Data directives.
    const firstWord = /^(\S+)/.exec(rest)?.[1] ?? '';
    const dataOp = DATA_OPS[firstWord.toLowerCase()];
    if (dataOp) {
      const items = splitItems(rest.slice(firstWord.length));
      if (items.length === 0) {
        errors.push({ line: lineNo, message: `${firstWord} needs at least one value` });
        continue;
      }
      let size = 0;
      for (const item of items) {
        if (isStringItem(item)) {
          if (dataOp !== 'db') errors.push({ line: lineNo, message: 'quoted strings can only be used with db' });
          size += decodeEscapes(item.slice(1, -1)).length;
        } else {
          size += DATA_SIZES[dataOp];
        }
      }
      stmts.push({
        line: lineNo,
        section,
        scope,
        labels: [...pending, ...labels],
        kind: 'data',
        text: rest,
        directive: dataOp,
        items,
        dataSize: size,
      });
      pending = [];
      continue;
    }

    if (firstWord.startsWith('.')) {
      errors.push({ line: lineNo, message: `unsupported directive '${firstWord}' (supported: .text, .data, section)` });
      continue;
    }

    // Plain instruction.
    stmts.push({ line: lineNo, section, scope, labels: [...pending, ...labels], kind: 'insn', text: rest });
    pending = [];
  }
  anchor(lines.length, section);
  return { stmts, errors };
}

// ---------------------------------------------------------------------------
// Expression evaluation: numbers, char literals, labels, `$`, + - * / parens.
// ---------------------------------------------------------------------------

class ExprError extends Error {}

interface ExprContext {
  /** Resolve a symbol to its value, or undefined when unknown. */
  resolve: (name: string) => number | undefined;
  /** Address of the statement the expression lives in ($). */
  currentAddr: number;
  /** Enclosing global label; prefixes NASM-style `.local` references. */
  scopePrefix: string;
}

class ExprParser {
  private readonly src: string;
  private readonly ctx: ExprContext;
  private pos = 0;

  constructor(src: string, ctx: ExprContext) {
    this.src = src;
    this.ctx = ctx;
  }


  parse(): number {
    const v = this.parseSum();
    if (this.pos < this.src.length) throw new ExprError(`unexpected '${this.src[this.pos]}' in expression`);
    return v;
  }

  private parseSum(): number {
    let v = this.parseTerm();
    for (;;) {
      this.skipWs();
      const op = this.src[this.pos];
      if (op === '+' || op === '-') {
        this.pos++;
        const rhs = this.parseTerm();
        v = op === '+' ? v + rhs : v - rhs;
      } else {
        return v;
      }
    }
  }

  private parseTerm(): number {
    let v = this.parseFactor();
    for (;;) {
      this.skipWs();
      const op = this.src[this.pos];
      if (op === '*' || op === '/') {
        this.pos++;
        const rhs = this.parseFactor();
        if (op === '*') v *= rhs;
        else {
          if (rhs === 0) throw new ExprError('division by zero');
          v = Math.trunc(v / rhs);
        }
      } else {
        return v;
      }
    }
  }

  private parseFactor(): number {
    this.skipWs();
    const c = this.src[this.pos];
    if (c === undefined) throw new ExprError('unexpected end of expression');
    if (c === '-') {
      this.pos++;
      return -this.parseFactor();
    }
    if (c === '+') {
      this.pos++;
      return this.parseFactor();
    }
    if (c === '(') {
      this.pos++;
      const v = this.parseSum();
      this.skipWs();
      if (this.src[this.pos] !== ')') throw new ExprError('missing ) in expression');
      this.pos++;
      return v;
    }
    const num = /^(0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+)/.exec(this.src.slice(this.pos));
    if (num) {
      this.pos += num[0].length;
      return Number(num[0]);
    }
    const chr = /^'(?:\\.|[^'\\])'/.exec(this.src.slice(this.pos));
    if (chr) {
      this.pos += chr[0].length;
      return decodeEscapes(chr[0].slice(1, -1))[0] ?? 0;
    }
    const ident = /^[$A-Za-z_.][\w.$]*/.exec(this.src.slice(this.pos));
    if (ident) {
      this.pos += ident[0].length;
      if (ident[0] === '$') return this.ctx.currentAddr;
      const scoped = ident[0].startsWith('.') ? this.ctx.scopePrefix + ident[0] : ident[0];
      const v = this.ctx.resolve(scoped);
      if (v === undefined) throw new ExprError(`unknown symbol '${ident[0]}'`);
      return v;
    }
    throw new ExprError(`unexpected '${c}' in expression`);
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }
}

function evalExpr(expr: string, ctx: ExprContext): number {
  return new ExprParser(expr, ctx).parse();
}

// ---------------------------------------------------------------------------
// Operand rewriting: label → absolute hex, `byte [` → `byte ptr [`,
// `[0x601000+4]` folded to a single number.
// ---------------------------------------------------------------------------

/** Rewrite identifiers outside string/char literals via `fn`. */
function mapOutsideQuotes(text: string, fn: (word: string) => string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_.$]/.test(c)) {
      let j = i;
      while (j < text.length && /[\w.$]/.test(text[j])) j++;
      out += fn(text.slice(i, j));
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function isNumericExpr(text: string): boolean {
  return /^[0-9a-fA-FxX+\-*/\s]+$/.test(text);
}

/**
 * Rewrite bare decimal literals to explicit `0x…` hex. This build of
 * Keystone reads bare numbers as hexadecimal (verified: `mov rax, 60`
 * assembles to 0x60), while teaching material must keep NASM-style decimal
 * semantics; pinning the radix makes the meaning independent of the engine.
 * Quoted literals and `0x`/`0X`/`0b`/`0B`/`0o`/`0O` prefixes are left
 * untouched.
 */
function pinNumberRadix(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // Prefixed literals already pin their own radix (hex, binary, octal —
    // both letter cases); hand them to the engine unchanged.
    const prefixed = /^0[xX][0-9a-fA-F]+|^0[bB][01]+|^0[oO][0-7]+/.exec(text.slice(i));
    if (prefixed) {
      out += prefixed[0];
      i += prefixed[0].length;
      continue;
    }
    const dec = /^\d+/.exec(text.slice(i));
    if (dec) {
      const prev = i > 0 ? text[i - 1] : ' ';
      if (/[\w.$]/.test(prev)) {
        out += c; // digit inside an identifier (already copied as part of it)
        i++;
      } else {
        out += '0x' + Number(dec[0]).toString(16);
        i += dec[0].length;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}


/**
 * Substitute labels in one instruction. Returns the text to hand to Keystone
 * plus the list of operand identifiers that could not be resolved (used for
 * friendlier diagnostics when Keystone rejects the result).
 */
function substituteInsn(
  text: string,
  resolve: (name: string) => number | undefined,
): { text: string; unknown: string[] } {
  // Keystone's Intel flavour needs `byte ptr […]`, not `byte […]`.
  let t = text.replace(/\b(byte|word|dword|qword)\s+\[/gi, (m) => m.replace(/\s+\[/, ' ptr ['));
  const parts = /^(\S+)\s*([\s\S]*)$/.exec(t);
  if (!parts) return { text: t, unknown: [] };
  const mnemonic = parts[1];
  const unknown: string[] = [];
  let ops = mapOutsideQuotes(parts[2], (word) => {
    const v = resolve(word);
    if (v !== undefined) return '0x' + v.toString(16);
    const lower = word.toLowerCase();
    if (!(lower in REGISTERS) && !(lower in OPERAND_KEYWORDS)) unknown.push(word);
    return word;
  });
  // Fold pure numeric address arithmetic inside brackets: [0x601000+4] → [0x601004]
  ops = ops.replace(/\[([^\[\]]*)\]/g, (_all: string, inner: string) => {
    if (!isNumericExpr(inner)) return `[${inner}]`;
    try {
      const v = evalExpr(inner, { resolve: () => undefined, currentAddr: 0, scopePrefix: '' });
      return `[0x${v.toString(16)}]`;
    } catch {
      return `[${inner}]`;
    }
  });
  ops = pinNumberRadix(ops);
  return { text: mnemonic + (ops.trim().length > 0 ? ' ' + ops.trim() : ''), unknown };
}

// ---------------------------------------------------------------------------
// Layout + encode loop.
// ---------------------------------------------------------------------------

interface EquDef {
  expr: string;
  line: number;
  section: Section;
  /** Current-section offset at the point of definition ($). */
  offset: number;
  scopePrefix: string;
}

/** Symbol resolver: labels plus lazily-evaluated equ constants (cycle-safe). */
function makeResolver(
  symbols: Map<string, number>,
  equDefs: Map<string, EquDef>,
  errors: AsmError[],
): (name: string) => number | undefined {
  const evaluating = new Set<string>();
  const cache = new Map<string, number>();
  return function resolve(name: string): number | undefined {
    if (symbols.has(name)) return symbols.get(name);
    const def = equDefs.get(name);
    if (!def) return undefined;
    if (evaluating.has(name)) {
      errors.push({ line: def.line, message: `circular definition of '${name}'` });
      return undefined;
    }
    if (cache.has(name)) return cache.get(name);
    evaluating.add(name);
    const base = def.section === 'text' ? CODE_BASE : DATA_BASE;
    let value: number | undefined;
    try {
      value = evalExpr(def.expr, {
        resolve,
        currentAddr: base + def.offset,
        scopePrefix: def.scopePrefix,
      });
    } catch (e) {
      errors.push({
        line: def.line,
        message: e instanceof ExprError ? e.message : `cannot evaluate '${name}'`,
      });
    }
    evaluating.delete(name);
    if (value !== undefined) cache.set(name, value);
    return value;
  };
}

function encodeDataStmt(stmt: Stmt, ctx: ExprContext, out: number[]): string | null {
  const op = stmt.directive as DataOp;
  const size = DATA_SIZES[op];
  let firstError: string | null = null;
  for (const item of stmt.items ?? []) {
    if (isStringItem(item)) {
      out.push(...decodeEscapes(item.slice(1, -1)));
      continue;
    }
    let value: number;
    try {
      value = evalExpr(item, ctx);
    } catch (e) {
      const msg = e instanceof ExprError ? e.message : 'bad expression';
      if (firstError === null) firstError = msg;
      out.push(...new Array(size).fill(0));
      continue;
    }
    const bn = BigInt.asUintN(size * 8, BigInt(value));
    for (let b = 0; b < size; b++) out.push(Number((bn >> BigInt(8 * b)) & 0xffn));
  }
  return firstError;
}

export function assemble(source: string, ks: KeystoneFacade): AssembleResult {
  const parsed = parseSource(source);
  const stmts = parsed.stmts;
  const fatal = [...parsed.errors];

  const equDefs = new Map<string, EquDef>();
  const symbols = new Map<string, number>();
  for (const s of stmts) {
    if (s.kind === 'equ' && s.equName) {
      equDefs.set(s.equName, { expr: s.equExpr ?? '0', line: s.line, section: s.section, offset: 0, scopePrefix: s.scope });
    }
  }

  const encodings: Array<Uint8Array | null> = stmts.map(() => null);
  const lengths: number[] = stmts.map(() => DUMMY_INSN_SIZE);
  const addrs: number[] = stmts.map(() => 0);
  const insnCount = stmts.reduce((n, s) => (s.kind === 'insn' ? n + 1 : n), 0);
  let iterErrors: AsmError[] = [];

  // Layout + encode until stable: branch encodings may shrink rel32 → rel8,
  // which shifts later addresses, which can enable more rel8 forms. Sizes
  // shrink monotonically, so this converges in a few iterations.
  for (let iter = 0; iter < 12; iter++) {
    iterErrors = [];
    symbols.clear();

    // Layout: assign statement addresses and bind labels to them.
    let tOff = 0;
    let dOff = 0;
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      const base = s.section === 'text' ? CODE_BASE : DATA_BASE;
      const off = s.section === 'text' ? tOff : dOff;
      if (s.kind === 'equ') {
        const def = equDefs.get(s.equName ?? '');
        if (def) def.offset = off;
      }
      for (const lab of s.labels) symbols.set(lab, base + off);
      if (s.kind === 'equ') continue;
      let size = 0;
      if (s.kind === 'insn') size = lengths[i];
      else if (s.kind === 'data') size = s.dataSize ?? 0;
      addrs[i] = base + off;
      if (s.section === 'text') tOff += size;
      else dOff += size;
    }

    // Encode every instruction from its current address.
    let changed = false;
    const resolve = makeResolver(symbols, equDefs, iterErrors);
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      if (s.kind !== 'insn') continue;
      const addr = addrs[i];
      const { text, unknown } = substituteInsn(s.text, (n) => resolve(n.startsWith('.') ? s.scope + n : n));
      const r = ks.assemble(text, addr);
      if (!r.ok) {
        if (unknown.length > 0) {
          iterErrors.push({ line: s.line, message: `unknown label '${unknown[0]}'` });
        } else {
          iterErrors.push({ line: s.line, message: `cannot assemble this instruction: '${s.text}'` });
        }
        if (encodings[i] === null) {
          lengths[i] = 2; // placeholder keeps the layout walk sane
          changed = true;
        }
        continue;
      }
      if (r.bytes.length !== lengths[i]) {
        lengths[i] = r.bytes.length;
        changed = true;
      }
      encodings[i] = r.bytes;
    }
    if (!changed || iterErrors.length > 0) break;
  }


  if (fatal.length > 0) return { ok: false, errors: fatal.slice(0, 8) };
  if (iterErrors.length > 0) return { ok: false, errors: iterErrors.slice(0, 8) };
  if (insnCount === 0) {
    return { ok: false, errors: [{ line: 1, message: 'no instructions found — the block is empty or only contains data' }] };
  }

  // --- final pass: build code/data images and the source-line map ---
  const code: number[] = [];
  const data: number[] = [];
  const sourceLines: CodeLine[] = [];
  const errors: AsmError[] = [];
  const resolve = makeResolver(symbols, equDefs, errors);
  let tOff = 0;
  let dOff = 0;
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (s.kind === 'equ') {
      const def = equDefs.get(s.equName ?? '');
      if (def) def.offset = s.section === 'text' ? tOff : dOff;
      continue;
    }
    const base = s.section === 'text' ? CODE_BASE : DATA_BASE;
    const buf = s.section === 'text' ? code : data;
    const off = s.section === 'text' ? tOff : dOff;
    const addr = base + off;
    let size = 0;
    if (s.kind === 'insn') {
      const bytes = encodings[i];
      if (!bytes) continue; // unreachable: encoding errors returned above
      const { text } = substituteInsn(s.text, (n) => resolve(n.startsWith('.') ? s.scope + n : n));
      buf.push(...bytes);
      size = bytes.length;
      sourceLines.push({ line: s.line, addr, size, text });
    } else if (s.kind === 'data') {
      const ctx: ExprContext = { resolve, currentAddr: addr, scopePrefix: s.scope };
      const err = encodeDataStmt(s, ctx, buf);
      if (err) errors.push({ line: s.line, message: err });
      size = s.dataSize ?? 0;
      sourceLines.push({ line: s.line, addr, size, text: s.text });
    }
    for (const lab of s.labels) symbols.set(lab, addr);
    if (s.section === 'text') tOff += size;
    else dOff += size;
  }

  if (code.length > CODE_SIZE) {
    return { ok: false, errors: [{ line: 1, message: `code is ${code.length} bytes; the code region holds ${CODE_SIZE}` }] };
  }
  if (data.length > DATA_SIZE) {
    return { ok: false, errors: [{ line: 1, message: `data is ${data.length} bytes; the data region holds ${DATA_SIZE}` }] };
  }
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 8) };

  return {
    ok: true,
    program: {
      code: Uint8Array.from(code),
      data: Uint8Array.from(data),
      entry: CODE_BASE,
      sourceLines,
      labels: symbols,
    },
  };
}
