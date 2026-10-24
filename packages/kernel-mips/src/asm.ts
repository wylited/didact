// Two-pass MIPS32 assembler for the SPIM/MARS teaching dialect.
//
// Pass 1 walks the source once: it strips `#` comments, records labels,
// lays out `.data` (`.word/.half/.byte/.ascii/.asciiz/.space/.align`) and
// sizes `.text` by expanding pseudo-instructions — expansion *width* never
// depends on label values (`la` and label loads are always 2 words; `li`
// folds to 1 word only for literal constants), so addresses are stable.
// Pass 2 re-expands with labels resolved and encodes each real instruction
// to its 32-bit word with the regular MIPS R/I/J encoders. Every word keeps
// its 1-based source line so load errors, runtime faults, breakpoints and
// the listing all map back to the editor.

export const TEXT_BASE = 0x00400000; // SPIM text segment
export const DATA_BASE = 0x10010000; // SPIM .data segment

export interface AsmError { line: number; message: string }

/** One encoded machine word; `addr` is its byte address in `.text`. */
export interface WordRow {
  word: number;   // encoded 32-bit instruction, >>> 0
  addr: number;
  line: number;   // 1-based source line (a pseudo-op yields 2 rows, same line)
  text: string;   // the source mnemonic + operands, as the student wrote it
}

export type AssembleResult =
  | {
      ok: true;
      words: WordRow[];
      data: Uint8Array;              // .data image, starts at DATA_BASE
      comments: Map<number, string>; // source line → trailing `#` comment
    }
  | { ok: false; errors: AsmError[] };

/** A real (post-expansion) instruction waiting to be encoded. */
interface Real { mnem: string; ops: string[]; line: number; text: string }

/** A staged `.text` source line. */
interface StagedInsn { line: number; text: string; mnem: string; ops: string[] }

// ---------------------------------------------------------------------------
// Registers — ABI names plus numeric $0..$31.
// ---------------------------------------------------------------------------

const REG_NAMES: readonly (readonly [string, number])[] = [
  ['zero', 0], ['at', 1], ['v0', 2], ['v1', 3],
  ['a0', 4], ['a1', 5], ['a2', 6], ['a3', 7],
  ['t0', 8], ['t1', 9], ['t2', 10], ['t3', 11],
  ['t4', 12], ['t5', 13], ['t6', 14], ['t7', 15],
  ['s0', 16], ['s1', 17], ['s2', 18], ['s3', 19],
  ['s4', 20], ['s5', 21], ['s6', 22], ['s7', 23],
  ['t8', 24], ['t9', 25], ['k0', 26], ['k1', 27],
  ['gp', 28], ['sp', 29], ['fp', 30], ['s8', 30], ['ra', 31],
];

/** Display order: $zero … $ra (32 ABI names; $fp is shown as fp). */
export const ABI_NAMES: readonly string[] = [
  'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
  't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
  't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra',
];

const REGS = new Map<string, number>();
for (const [name, num] of REG_NAMES) REGS.set(name, num);
for (let i = 0; i < 32; i++) REGS.set(String(i), i);

// ---------------------------------------------------------------------------
// Opcode / funct tables (MIPS32 integer subset + syscall).
// ---------------------------------------------------------------------------

const SPECIAL_FUNCT: Readonly<Record<string, number>> = {
  sll: 0x00, srl: 0x02, sra: 0x03, sllv: 0x04, srlv: 0x06, srav: 0x07,
  jr: 0x08, jalr: 0x09, syscall: 0x0c,
  mfhi: 0x10, mthi: 0x11, mflo: 0x12, mtlo: 0x13,
  mult: 0x18, multu: 0x19, div: 0x1a, divu: 0x1b,
  add: 0x20, addu: 0x21, sub: 0x22, subu: 0x23,
  and: 0x24, or: 0x25, xor: 0x26, nor: 0x27,
  slt: 0x2a, sltu: 0x2b,
};

const OPCODES: Readonly<Record<string, number>> = {
  beq: 0x04, bne: 0x05, blez: 0x06, bgtz: 0x07,
  addi: 0x08, addiu: 0x09, slti: 0x0a, sltiu: 0x0b,
  andi: 0x0c, ori: 0x0d, xori: 0x0e, lui: 0x0f,
  lb: 0x20, lh: 0x21, lw: 0x23, lbu: 0x24, lhu: 0x25,
  sb: 0x28, sh: 0x29, sw: 0x2b,
};

const LOADS_STORES = ['lb', 'lbu', 'lh', 'lhu', 'lw', 'sb', 'sh', 'sw'] as const;
const IMM_ARITH = ['addi', 'addiu', 'slti', 'sltiu', 'andi', 'ori', 'xori'] as const;
const ZERO_EXT_IMM = ['andi', 'ori', 'xori'] as const;

// ---------------------------------------------------------------------------
// Encoding helpers — the three regular MIPS32 formats.
// ---------------------------------------------------------------------------

function rType(rs: number, rt: number, rd: number, shamt: number, funct: number): number {
  return (((rs & 31) << 21) | ((rt & 31) << 16) | ((rd & 31) << 11) | ((shamt & 31) << 6) | funct) >>> 0;
}

function iType(op: number, rs: number, rt: number, imm: number): number {
  return (((op & 63) << 26) | ((rs & 31) << 21) | ((rt & 31) << 16) | (imm & 0xffff)) >>> 0;
}

function jType(op: number, target: number): number {
  return (((op & 63) << 26) | ((target >>> 2) & 0x03ff_ffff)) >>> 0;
}

// ---------------------------------------------------------------------------
// Parsing utilities. All failures carry the 1-based source line.
// ---------------------------------------------------------------------------

class AsmFailure extends Error {
  constructor(readonly line: number, message: string) { super(message); }
}

/** Split a comma-separated operand list; commas inside "strings" and
 *  `off($reg)` groups never appear at top level except legitimately. */
function splitOps(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' && s[i - 1] !== '\\') inStr = !inStr;
    if (ch === ',' && !inStr) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter((t) => t.length > 0);
}

const INT16_MIN = -0x8000, INT16_MAX = 0x7fff, UINT16_MAX = 0xffff;

function parseCharLiteral(tok: string): number | null {
  const m = /^'(\\.|[^\\'])'$/.exec(tok);
  if (!m) return null;
  const body = m[1]!;
  if (body.length === 2 && body[0] === '\\') {
    switch (body[1]) {
      case 'n': return 10; case 't': return 9; case 'r': return 13;
      case '0': return 0; case '\\': return 92; case "'": return 39;
      case '"': return 34;
      default: return null;
    }
  }
  return body.charCodeAt(0);
}

/** Evaluate a constant: decimal, 0x hex, or 'c' char literal. */
function parseConst(tok: string, line: number): number {
  if (/^[+-]?0x[0-9a-f]+$/i.test(tok)) return Number.parseInt(tok, 16);
  const ch = parseCharLiteral(tok);
  if (ch !== null) return ch;
  if (/^[+-]?\d+$/.test(tok)) return Number.parseInt(tok, 10);
  throw new AsmFailure(line, `'${tok}' is not a number I understand (decimal, 0x hex, or 'c' char)`);
}

/**
 * Immediate or `label` / `label+4` / `label-8` expression.
 * `label` means text or data address; const means a literal.
 */
function parseImmExpr(tok: string, line: number): { kind: 'const'; value: number } | { kind: 'label'; name: string; offset: number } {
  const m = /^([A-Za-z_.$][\w.$]*)\s*([+-]\s*\w+)?$/.exec(tok);
  if (m) {
    const offset = m[2] ? parseConst(m[2]!.replace(/\s+/g, ''), line) : 0;
    return { kind: 'label', name: m[1]!, offset };
  }
  return { kind: 'const', value: parseConst(tok, line) };
}

function parseReg(tok: string, line: number): number {
  if (!tok.startsWith('$')) throw new AsmFailure(line, `'${tok}' is not a register — expected e.g. $t0 or $8`);
  const num = REGS.get(tok.slice(1));
  if (num === undefined) throw new AsmFailure(line, `unknown register '${tok}'`);
  return num;
}

/** Operand-count check with a uniform message. */
function need(mnem: string, ops: string[], n: number, line: number): void {
  if (ops.length !== n)
    throw new AsmFailure(line, `${mnem} takes ${n} operand${n === 1 ? '' : 's'} (got ${ops.length})`);
}

function hex8(v: number): string { return (v >>> 0).toString(16).padStart(8, '0'); }

/** Branch word offset: (target − (insn+4)) / 4, must fit int16. */
function branchOffset(target: number, addr: number, mnem: string, line: number): number {
  const delta = target - (addr + 4);
  if (delta % 4 !== 0) throw new AsmFailure(line, `branch target 0x${hex8(target)} is not word-aligned`);
  const off = delta >> 2;
  if (off < INT16_MIN || off > INT16_MAX)
    throw new AsmFailure(line, `${mnem} target is too far away (±128 KiB range)`);
  return off >>> 0; // u16 bit pattern for iType
}

// ---------------------------------------------------------------------------
// Pseudo-instruction expansion → real instruction list.
// ---------------------------------------------------------------------------

/**
 * Expand one source instruction into 1–2 real instructions. `resolve` maps
 * labels to addresses; pass 1 passes a placeholder resolver — expansion
 * *count* must not depend on the resolved value (see `la`/`li` below).
 */
function expand(mnem: string, ops: string[], line: number, text: string, resolve: (name: string) => number): Real[] {
  const one = (m: string, ...o: string[]): Real[] => [{ mnem: m, ops: o, line, text }];
  const two = (a: readonly [string, ...string[]], b: readonly [string, ...string[]]): Real[] =>
    [{ mnem: a[0], ops: a.slice(1), line, text }, { mnem: b[0], ops: b.slice(1), line, text }];
  const at = '$at';
  /** Load a 32-bit constant into $at (1 word if it fits 16 bits, else 2). */
  const materialize = (tok: string): [string, ...string[]][] => {
    const v = parseConst(tok, line);
    if (v >= INT16_MIN && v <= INT16_MAX) return [['addiu', at, '$zero', String(v)]];
    const u = v >>> 0;
    if (u <= UINT16_MAX) return [['ori', at, '$zero', String(u)]];
    return [['lui', at, String(u >>> 16)], ['ori', at, at, String(u & 0xffff)]];
  };
  const many = (specs: readonly (readonly [string, ...string[]])[]): Real[] =>
    specs.map(([m, ...o]) => ({ mnem: m, ops: o, line, text }));

  switch (mnem) {
    case 'nop': return one('sll', '$zero', '$zero', '0');
    case 'move': need(mnem, ops, 2, line); return one('addu', ops[0]!, '$zero', ops[1]!);
    case 'not': need(mnem, ops, 2, line); return one('nor', ops[0]!, ops[1]!, '$zero');
    case 'neg': need(mnem, ops, 2, line); return one('sub', ops[0]!, '$zero', ops[1]!);
    case 'li': {
      need(mnem, ops, 2, line);
      const e = parseImmExpr(ops[1]!, line);
      const value = e.kind === 'const' ? e.value : resolve(e.name) + e.offset;
      if (value < -0x8000_0000 || value > 0xffff_ffff)
        throw new AsmFailure(line, `li value ${value} does not fit in 32 bits`);
      const u = value >>> 0;
      if (value >= INT16_MIN && value <= INT16_MAX) return one('addiu', ops[0]!, '$zero', String(value));
      if (u <= UINT16_MAX) return one('ori', ops[0]!, '$zero', String(u));
      return two(['lui', at, String(u >>> 16)], ['ori', ops[0]!, at, String(u & 0xffff)]);
    }
    case 'la': { // always 2 words so pass-1 sizing is label-independent
      need(mnem, ops, 2, line);
      const e = parseImmExpr(ops[1]!, line);
      const addr = (e.kind === 'label' ? resolve(e.name) + e.offset : e.value) >>> 0;
      return two(['lui', at, String(addr >>> 16)], ['ori', ops[0]!, at, String(addr & 0xffff)]);
    }
    case 'mul': need(mnem, ops, 3, line);
      return two(['mult', ops[1]!, ops[2]!], ['mflo', ops[0]!]);
    case 'rem': need(mnem, ops, 3, line);
      return two(['div', ops[1]!, ops[2]!], ['mfhi', ops[0]!]);
    case 'div':
      if (ops.length === 3) return two(['div', ops[1]!, ops[2]!], ['mflo', ops[0]!]);
      return one('div', ...ops);
    case 'beq': case 'bne': // beq/bne with an immediate second operand
      if (ops.length === 3 && !ops[1]!.startsWith('$'))
        return many([...materialize(ops[1]!), [mnem, ops[0]!, at, ops[2]!]]);
      return one(mnem, ...ops);
    case 'beqz': need(mnem, ops, 2, line); return one('beq', ops[0]!, '$zero', ops[1]!);
    case 'bnez': need(mnem, ops, 2, line); return one('bne', ops[0]!, '$zero', ops[1]!);
    case 'b': need(mnem, ops, 1, line); return one('beq', '$zero', '$zero', ops[0]!);
    case 'blt': case 'bgt': case 'ble': case 'bge': {
      need(mnem, ops, 3, line);
      parseReg(ops[0]!, line); // left side must be a register
      const rhsReg = ops[1]!.startsWith('$');
      // blt/bge: at = (s < t);  bgt/ble: at = (t < s) — the immediate case
      // materializes t into $at first, then compares through $at.
      const cmp: readonly [string, string, string, string] = mnem === 'blt' || mnem === 'bge'
        ? ['slt', at, ops[0]!, rhsReg ? ops[1]! : at]
        : ['slt', at, rhsReg ? ops[1]! : at, ops[0]!];
      // blt/bgt branch when at != 0;  ble/bge when at == 0
      const br: readonly [string, string, string, string] =
        mnem === 'blt' || mnem === 'bgt' ? ['bne', at, '$zero', ops[2]!]
                                          : ['beq', at, '$zero', ops[2]!];
      return many([...(rhsReg ? [] : materialize(ops[1]!)), cmp, br]);
    }
    default:
      return one(mnem, ...ops);
  }
}

/**
 * Expand a staged source line, normalizing loads/stores whose address is a
 * bare label or a big absolute to a `lui $at, hi` + `op rt, lo($at)` pair
 * (always exactly 2 words; the `off($reg)` form stays 1 word).
 */
function expandStaged(s: StagedInsn, resolve: (name: string) => number): Real[] {
  if (!(LOADS_STORES as readonly string[]).includes(s.mnem)) return expand(s.mnem, s.ops, s.line, s.text, resolve);
  need(s.mnem, s.ops, 2, s.line);
  const operand = s.ops[1]!;
  if (!/^(.*)\(\$\w+\)$/.test(operand)) {
    const e = parseImmExpr(operand, s.line);
    const bigConst = e.kind === 'const' && (e.value < INT16_MIN || e.value > INT16_MAX);
    if (e.kind === 'label' || bigConst) {
      const target = ((e.kind === 'label' ? resolve(e.name) + e.offset : e.value) >>> 0);
      const hi = ((target + 0x8000) >>> 16) & 0xffff;   // compensate lo ≥ 0x8000
      const lo = target & 0xffff;
      const loSigned = lo >= 0x8000 ? lo - 0x10000 : lo;
      return [
        { mnem: 'lui', ops: ['$at', String(hi)], line: s.line, text: s.text },
        { mnem: s.mnem, ops: [s.ops[0]!, `${loSigned}($at)`], line: s.line, text: s.text },
      ];
    }
  }
  return expand(s.mnem, s.ops, s.line, s.text, resolve);
}

// ---------------------------------------------------------------------------
// Pass 2: encode one real instruction to its 32-bit word.
// ---------------------------------------------------------------------------

function encode(real: Real, addr: number, resolve: (name: string) => number): number {
  const { mnem, ops, line } = real;

  if ((LOADS_STORES as readonly string[]).includes(mnem)) {
    need(mnem, ops, 2, line);
    const rt = parseReg(ops[0]!, line);
    const m = /^(.*)\((\$\w+)\)$/.exec(ops[1]!);
    if (!m) throw new AsmFailure(line, `internal: ${mnem} reached the encoder without an offset($reg) operand`);
    const base = parseReg(m[2]!, line);
    const offStr = m[1]!.trim();
    const off = offStr === '' ? 0
      : (() => { const e = parseImmExpr(offStr, line); return e.kind === 'label' ? resolve(e.name) + e.offset : e.value; })();
    if (off < INT16_MIN || off > INT16_MAX)
      throw new AsmFailure(line, `${mnem} offset ${off} does not fit in 16 bits`);
    return iType(OPCODES[mnem]!, base, rt, off);
  }

  if (mnem === 'lui') {
    need(mnem, ops, 2, line);
    const rt = parseReg(ops[0]!, line);
    const v = parseConst(ops[1]!, line);
    if (v < 0 || v > UINT16_MAX) throw new AsmFailure(line, `lui immediate ${v} must be 0..65535`);
    return iType(OPCODES.lui!, 0, rt, v);
  }

  if (mnem in SPECIAL_FUNCT) {
    const funct = SPECIAL_FUNCT[mnem]!;
    switch (mnem) {
      case 'sll': case 'srl': case 'sra': {
        need(mnem, ops, 3, line);
        const rd = parseReg(ops[0]!, line), rt = parseReg(ops[1]!, line);
        const sh = parseConst(ops[2]!, line);
        if (sh < 0 || sh > 31) throw new AsmFailure(line, `shift amount ${sh} must be 0..31`);
        return rType(0, rt, rd, sh, funct);
      }
      case 'sllv': case 'srlv': case 'srav': {
        need(mnem, ops, 3, line); // rd, rt, rs — rs supplies the shift count
        const rd = parseReg(ops[0]!, line), rt = parseReg(ops[1]!, line), rs = parseReg(ops[2]!, line);
        return rType(rs, rt, rd, 0, funct);
      }
      case 'jr': need(mnem, ops, 1, line); return rType(parseReg(ops[0]!, line), 0, 0, 0, funct);
      case 'jalr': {
        if (ops.length === 1) return rType(parseReg(ops[0]!, line), 0, 31, 0, funct);
        need(mnem, ops, 2, line); // jalr rd, rs
        return rType(parseReg(ops[1]!, line), 0, parseReg(ops[0]!, line), 0, funct);
      }
      case 'syscall': need(mnem, ops, 0, line); return rType(0, 0, 0, 0, funct);
      case 'mfhi': case 'mflo': need(mnem, ops, 1, line); return rType(0, 0, parseReg(ops[0]!, line), 0, funct);
      case 'mthi': case 'mtlo': need(mnem, ops, 1, line); return rType(parseReg(ops[0]!, line), 0, 0, 0, funct);
      case 'mult': case 'multu': case 'div': case 'divu':
        need(mnem, ops, 2, line);
        return rType(parseReg(ops[0]!, line), parseReg(ops[1]!, line), 0, 0, funct);
      default: // add addu sub subu and or xor nor slt sltu: op rd, rs, rt
        need(mnem, ops, 3, line);
        return rType(parseReg(ops[1]!, line), parseReg(ops[2]!, line), parseReg(ops[0]!, line), 0, funct);
    }
  }

  if (mnem === 'beq' || mnem === 'bne') {
    need(mnem, ops, 3, line);
    const rs = parseReg(ops[0]!, line), rt = parseReg(ops[1]!, line);
    return iType(OPCODES[mnem]!, rs, rt, branchOffset(targetOf(ops[2]!, resolve, line), addr, mnem, line));
  }
  if (mnem === 'blez' || mnem === 'bgtz') {
    need(mnem, ops, 2, line);
    return iType(OPCODES[mnem]!, parseReg(ops[0]!, line), 0, branchOffset(targetOf(ops[1]!, resolve, line), addr, mnem, line));
  }
  if (mnem === 'bltz' || mnem === 'bgez') { // REGIMM opcode 0x01, rt selects the test
    need(mnem, ops, 2, line);
    return iType(0x01, parseReg(ops[0]!, line), mnem === 'bltz' ? 0 : 1, branchOffset(targetOf(ops[1]!, resolve, line), addr, mnem, line));
  }

  if ((IMM_ARITH as readonly string[]).includes(mnem)) {
    need(mnem, ops, 3, line);
    const rt = parseReg(ops[0]!, line), rs = parseReg(ops[1]!, line);
    const e = parseImmExpr(ops[2]!, line);
    const v = (e.kind === 'label' ? resolve(e.name) + e.offset : e.value) >>> 0;
    if ((ZERO_EXT_IMM as readonly string[]).includes(mnem)) {
      if (v > UINT16_MAX)
        throw new AsmFailure(line, `${mnem} immediate ${v} must be 0..65535 (it is zero-extended, not sign-extended — use li for big values)`);
      return iType(OPCODES[mnem]!, rs, rt, v);
    }
    if (v > UINT16_MAX && v < 0xffff_8000)
      throw new AsmFailure(line, `${mnem} immediate ${v} does not fit in 16 bits (use li to load big values)`);
    return iType(OPCODES[mnem]!, rs, rt, v);
  }

  if (mnem === 'j' || mnem === 'jal') {
    need(mnem, ops, 1, line);
    const target = targetOf(ops[0]!, resolve, line);
    if ((target & 0xf000_0000) !== ((addr + 4) & 0xf000_0000))
      throw new AsmFailure(line, `${mnem} target 0x${hex8(target)} is outside the 256 MiB region of this program`);
    return jType(mnem === 'j' ? 0x02 : 0x03, target);
  }

  throw new AsmFailure(line, `unknown instruction '${mnem}'`);
}

function targetOf(tok: string, resolve: (name: string) => number, line: number): number {
  const e = parseImmExpr(tok, line);
  const v = (e.kind === 'label' ? resolve(e.name) + e.offset : e.value) >>> 0;
  if (v % 4 !== 0) throw new AsmFailure(line, `jump/branch target 0x${hex8(v)} is not word-aligned`);
  return v;
}

// ---------------------------------------------------------------------------
// Source lexing: `#` comments (never inside strings), blank lines dropped.
// ---------------------------------------------------------------------------

interface Line { num: number; body: string }

function lex(src: string): { lines: Line[]; comments: Map<number, string> } {
  const lines: Line[] = [];
  const comments = new Map<number, string>();
  const raw = src.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i]!;
    let inStr = false, hash = -1;
    for (let c = 0; c < text.length; c++) {
      const ch = text[c]!;
      if (ch === '"' && text[c - 1] !== '\\') inStr = !inStr;
      else if (ch === '#' && !inStr) { hash = c; break; }
    }
    const comment = hash >= 0 ? text.slice(hash + 1).trim() : '';
    const body = (hash >= 0 ? text.slice(0, hash) : text).trim();
    if (comment !== '') comments.set(i + 1, comment);
    if (body !== '') lines.push({ num: i + 1, body });
  }
  return { lines, comments };
}

function decodeString(lit: string, line: number): number[] {
  if (lit.length < 2 || lit[0] !== '"' || lit[lit.length - 1] !== '"')
    throw new AsmFailure(line, 'expected a double-quoted string');
  const escapes: Readonly<Record<string, number>> = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, '"': 34 };
  const out: number[] = [];
  for (let i = 1; i < lit.length - 1; i++) {
    const ch = lit[i]!;
    if (ch === '\\') {
      const next = lit[++i];
      if (next === undefined || !(next in escapes))
        throw new AsmFailure(line, `unknown escape '\\${next ?? ''}' in string`);
      out.push(escapes[next]!);
    } else out.push(ch.charCodeAt(0) & 0xff);
  }
  return out;
}

/** Strip one leading `name:` label (call repeatedly for several). */
function takeLabel(rest: string): { name: string; rest: string } | null {
  const m = /^([A-Za-z_.$][\w.$]*)\s*:\s*/.exec(rest);
  return m ? { name: m[1]!, rest: rest.slice(m[0].length).trim() } : null;
}

/** Head token (mnemonic/directive) + the raw operand string after it. */
function headOf(body: string): { head: string; operandStr: string } {
  const sp = /^\S+/.exec(body);
  const head = (sp ? sp[0] : body).toLowerCase();
  return { head, operandStr: body.slice(sp ? sp[0].length : 0).trim() };
}

const IGNORED_DIRECTIVES: Record<string, true> = { '.globl': true, '.global': true, '.extern': true };

// ---------------------------------------------------------------------------
// Top-level assemble.
// ---------------------------------------------------------------------------

export function assemble(src: string): AssembleResult {
  const { lines, comments } = lex(src);
  const errors: AsmError[] = [];
  const labels = new Map<string, number>();
  const staged: StagedInsn[] = [];
  // Pass-1 placeholder: real addresses are ≥ TEXT_BASE, which never fits in
  // 16 bits — so label-dependent expansions keep their 2-word shape here.
  const placeholder = () => TEXT_BASE;

  // ---- Pass 1: labels, .data sizing, .text sizing ---------------------------
  let section: 'data' | 'text' = 'text';
  let dataOff = 0, textWords = 0;
  const dataAlign = (n: number, line: number): void => {
    if (n < 0 || n > 16) throw new AsmFailure(line, `.align ${n} is out of range`);
    dataOff = Math.ceil(dataOff / (1 << n)) * (1 << n);
  };
  for (const { num, body } of lines) {
    try {
      let rest = body;
      for (let l = takeLabel(rest); l !== null; l = takeLabel(rest)) {
        if (labels.has(l.name)) throw new AsmFailure(num, `label '${l.name}' is defined twice`);
        labels.set(l.name, section === 'text' ? TEXT_BASE + textWords * 4 : DATA_BASE + dataOff);
        rest = l.rest;
      }
      if (rest === '') continue;
      const { head, operandStr } = headOf(rest);
      const ops = operandStr === '' ? [] : splitOps(operandStr);

      if (head === '.text' || head === '.data') {
        if (operandStr !== '') throw new AsmFailure(num, `${head} takes no address in this kernel (segments are fixed)`);
        section = head === '.text' ? 'text' : 'data';
        continue;
      }
      if (IGNORED_DIRECTIVES[head] === true) continue;

      if (section === 'data') {
        if (head === '.align') { need(head, ops, 1, num); dataAlign(parseConst(ops[0]!, num), num); }
        else if (head === '.space') {
          need(head, ops, 1, num);
          const n = parseConst(ops[0]!, num);
          if (n < 0 || n > 0x10000) throw new AsmFailure(num, `.space ${n} is out of range`);
          dataOff += n;
        } else if (head === '.word') { need(head, ops, 1, num); dataAlign(2, num); dataOff += ops.length * 4; }
        else if (head === '.half') { need(head, ops, 1, num); dataAlign(1, num); dataOff += ops.length * 2; }
        else if (head === '.byte') { need(head, ops, 1, num); dataOff += ops.length; }
        else if (head === '.ascii' || head === '.asciiz') {
          need(head, ops, 1, num);
          for (const o of ops) dataOff += decodeString(o, num).length + (head === '.asciiz' ? 1 : 0);
        } else throw new AsmFailure(num, `unknown directive '${head}' in .data`);
        continue;
      }

      if (head.startsWith('.')) throw new AsmFailure(num, `directive '${head}' is not allowed in .text`);
      const s: StagedInsn = { line: num, text: rest, mnem: head, ops };
      staged.push(s);
      textWords += expandStaged(s, placeholder).length;
    } catch (e) {
      if (e instanceof AsmFailure) errors.push({ line: e.line, message: e.message });
      else throw e;
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // ---- Pass 2: resolve labels, expand, encode -------------------------------
  const resolve = (name: string): number => {
    const v = labels.get(name);
    if (v === undefined) throw new AsmFailure(-1, `label '${name}' is not defined`);
    return v;
  };
  const words: WordRow[] = [];
  for (const s of staged) {
    try {
      for (const r of expandStaged(s, resolve)) {
        const addr = TEXT_BASE + words.length * 4;
        words.push({ word: encode(r, addr, resolve), addr, line: s.line, text: s.text });
      }
    } catch (e) {
      if (e instanceof AsmFailure) errors.push({ line: e.line >= 0 ? e.line : s.line, message: e.message });
      else throw e;
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // ---- Pass 2b: materialize .data (same layout walk as pass 1) --------------
  const data = new Uint8Array(dataOff);
  let off = 0;
  section = 'text';
  for (const { num, body } of lines) {
    try {
      let rest = body;
      for (let l = takeLabel(rest); l !== null; l = takeLabel(rest)) rest = l.rest;
      if (rest === '') continue;
      const { head, operandStr } = headOf(rest);
      const ops = operandStr === '' ? [] : splitOps(operandStr);
      if (head === '.text' || head === '.data') section = head === '.text' ? 'text' : 'data';
      else if (IGNORED_DIRECTIVES[head] === true || section !== 'data') continue;
      else if (head === '.align') off = Math.ceil(off / (1 << parseConst(ops[0]!, num))) * (1 << parseConst(ops[0]!, num));
      else if (head === '.space') off += parseConst(ops[0]!, num);
      else if (head === '.word') {
        off = Math.ceil(off / 4) * 4;
        for (const o of ops) {
          const e = parseImmExpr(o, num);
          const v = ((e.kind === 'label' ? resolve(e.name) + e.offset : e.value) >>> 0);
          data.set([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff], off);
          off += 4;
        }
      } else if (head === '.half') {
        off = Math.ceil(off / 2) * 2;
        for (const o of ops) {
          const v = parseConst(o, num) & 0xffff;
          data.set([v & 0xff, (v >>> 8) & 0xff], off);
          off += 2;
        }
      } else if (head === '.byte') {
        for (const o of ops) data[off++] = parseConst(o, num) & 0xff;
      } else if (head === '.ascii' || head === '.asciiz') {
        for (const o of ops) {
          data.set(decodeString(o, num), off);
          off += decodeString(o, num).length + (head === '.asciiz' ? 1 : 0);
        }
      }
    } catch (e) {
      if (e instanceof AsmFailure) errors.push({ line: e.line >= 0 ? e.line : num, message: e.message });
      else throw e;
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, words, data, comments };
}
