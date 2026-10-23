// asm.ts — a two-pass assembler for a teaching subset of x86-64 (Intel/NASM syntax).
//
// Subset: labels, `;` comments, sections `.text`/`.data`, `db`/`dq` data with
// C-escaped ASCII strings, `equ` constants (with `$`), 64-bit + 32-bit forms of
// a fixed instruction list, and the addressing forms
//   r64 · imm · [r64] · [r64+disp] · [r64+r64*scale] · [label] · [label+disp].
// It produces REAL x86-64 machine-code bytes (REX + opcode + ModRM/SIB + disp +
// imm) plus a structured op per instruction so the interpreter can execute it.
// Every error carries a 1-based source line number.

export const TEXT_BASE = 0x401000;
export const STACK_TOP = 0x7ffffffff000;

const M64 = (1n << 64n) - 1n;
const M32 = 0xffffffffn;

export class AsmError extends Error {
  readonly line: number;
  readonly msg: string;
  constructor(line: number, msg: string) {
    super(`line ${line}: ${msg}`);
    this.line = line;
    this.msg = msg;
  }
}

// ---------------------------------------------------------------------------
// registers
// ---------------------------------------------------------------------------

export const REG64 = [
  "rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi",
  "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15",
];
export const REG32 = [
  "eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi",
  "r8d", "r9d", "r10d", "r11d", "r12d", "r13d", "r14d", "r15d",
];

const reg64Index: Record<string, number> = {};
REG64.forEach((n, i) => { reg64Index[n] = i; });
const reg32Index: Record<string, number> = {};
REG32.forEach((n, i) => { reg32Index[n] = i; });

const regSmall: Record<string, boolean> = {
  al: true, bl: true, cl: true, dl: true, sil: true, dil: true, bpl: true, spl: true,
  ah: true, bh: true, ch: true, dh: true,
  r8b: true, r9b: true, r10b: true, r11b: true, r12b: true, r13b: true, r14b: true, r15b: true,
  ax: true, bx: true, cx: true, dx: true, si: true, di: true, bp: true, sp: true,
  r8w: true, r9w: true, r10w: true, r11w: true, r12w: true, r13w: true, r14w: true, r15w: true,
};

// condition codes for the jcc family (hardware encoding numbers)
const CC: Record<string, number> = {
  jo: 0, jno: 1, jb: 2, jc: 2, jnae: 2, jae: 3, jnb: 3, jnc: 3,
  je: 4, jz: 4, jne: 5, jnz: 5, jbe: 6, jna: 6, ja: 7, jnbe: 7,
  js: 8, jns: 9, jp: 10, jpe: 10, jnp: 11, jpo: 11,
  jl: 12, jnge: 12, jge: 13, jnl: 13, jle: 14, jng: 14, jg: 15, jnle: 15,
};

const ARITH_DIGIT: Record<string, { rm_r: number; r_rm: number; digit: number }> = {
  add: { rm_r: 0x01, r_rm: 0x03, digit: 0 },
  or: { rm_r: 0x08, r_rm: 0x0b, digit: 1 },
  and: { rm_r: 0x21, r_rm: 0x23, digit: 4 },
  sub: { rm_r: 0x29, r_rm: 0x2b, digit: 5 },
  xor: { rm_r: 0x31, r_rm: 0x33, digit: 6 },
  cmp: { rm_r: 0x39, r_rm: 0x3b, digit: 7 },
};

const SCALE_BITS: Record<number, number> = { 1: 0, 2: 1, 4: 2, 8: 3 };

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

type Tok =
  | { k: "id"; v: string; start: number; end: number }
  | { k: "num"; v: bigint; start: number; end: number }
  | { k: "str"; v: string; start: number; end: number }
  | { k: "here"; start: number; end: number }
  | { k: "p"; v: string; start: number; end: number };

function tokStr(t: Tok): string {
  if (t.k === "id") return t.v;
  if (t.k === "num") return t.v.toString();
  if (t.k === "str") return `"${t.v}"`;
  if (t.k === "here") return "$";
  return t.v;
}

function unescapeChar(ch: string | undefined, ln: number): string {
  switch (ch) {
    case "n": return "\n";
    case "t": return "\t";
    case "r": return "\r";
    case "0": return "\0";
    case "a": return "\x07";
    case "b": return "\x08";
    case "\\": return "\\";
    case "'": return "'";
    case '"': return '"';
    default: throw new AsmError(ln, `unknown escape sequence '\\${ch ?? ""}'`);
  }
}

function tokenize(s: string, ln: number): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === ";") break; // comment to end of line
    const start = i;
    if (c === "'" || c === '"') {
      let v = "";
      let j = i + 1;
      while (j < s.length && s[j] !== c) {
        if (s[j] === "\\") { v += unescapeChar(s[j + 1], ln); j += 2; }
        else { v += s[j]!; j++; }
      }
      if (j >= s.length) throw new AsmError(ln, "unterminated string literal");
      i = j + 1;
      out.push({ k: "str", v, start, end: i });
      continue;
    }
    if (c === "$" && !(i + 1 < s.length && /[A-Za-z0-9_]/.test(s[i + 1]!))) {
      out.push({ k: "here", start, end: i + 1 });
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      if (c === "0" && (s[j + 1] === "x" || s[j + 1] === "X")) {
        j += 2;
        const hStart = j;
        while (j < s.length && /[0-9a-fA-F]/.test(s[j]!)) j++;
        if (j === hStart) throw new AsmError(ln, "malformed hex literal (expected digits after 0x)");
        const v = BigInt("0x" + s.slice(hStart, j));
        out.push({ k: "num", v, start, end: j });
        i = j;
        continue;
      }
      while (j < s.length && /[0-9]/.test(s[j]!)) j++;
      out.push({ k: "num", v: BigInt(s.slice(i, j)), start, end: j });
      i = j;
      continue;
    }
    if (/[A-Za-z_.]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_.$]/.test(s[j]!)) j++;
      out.push({ k: "id", v: s.slice(i, j), start, end: j });
      i = j;
      continue;
    }
    if (",[]:+-*".includes(c)) {
      out.push({ k: "p", v: c, start, end: i + 1 });
      i++;
      continue;
    }
    throw new AsmError(ln, `unexpected character '${c}'`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// operands (parsed = unresolved)
// ---------------------------------------------------------------------------

export type Term = { sign: 1 | -1; kind: "num" | "sym" | "here"; v?: bigint; name?: string };

export type PReg = { k: "reg"; r: number; size: 8 | 4 };
export type PMem = {
  k: "mem"; size: 8 | 4 | null;
  base: number | null; index: number | null; scale: 1 | 2 | 4 | 8;
  disp: Term[] | null; sym: boolean;
};
export type PImm = { k: "imm"; terms: Term[]; sym: boolean };
export type POp = PReg | PMem | PImm;


function parseExpr(toks: Tok[], ln: number): Term[] {
  const terms: Term[] = [];
  let sign: 1 | -1 = 1;
  let state: "start" | "op" | "term" = "start";
  for (const t of toks) {
    if (t.k === "p" && (t.v === "+" || t.v === "-")) {
      if (state === "op") throw new AsmError(ln, "malformed expression (doubled operator)");
      sign = t.v === "+" ? 1 : -1;
      state = "op";
      continue;
    }
    if (state === "term") throw new AsmError(ln, `expected '+' or '-' before '${tokStr(t)}'`);
    if (t.k === "num") terms.push({ sign, kind: "num", v: t.v });
    else if (t.k === "str") {
      if (t.v.length !== 1) throw new AsmError(ln, "character literal must hold exactly one character");
      terms.push({ sign, kind: "num", v: BigInt(t.v.charCodeAt(0)) });
    } else if (t.k === "here") terms.push({ sign, kind: "here" });
    else if (t.k === "id") terms.push({ sign, kind: "sym", name: t.v });
    else throw new AsmError(ln, `unexpected token '${tokStr(t)}' in expression`);
    sign = 1;
    state = "term";
  }
  if (state !== "term") throw new AsmError(ln, "empty or malformed expression");
  return terms;
}



function parseMemBody(toks: Tok[], ln: number): Omit<PMem, "k" | "size"> {
  let base: number | null = null;
  let index: number | null = null;
  let scale: 1 | 2 | 4 | 8 = 1;
  const disp: Term[] = [];
  let sym = false;
  let sign: 1 | -1 = 1;
  let state: "start" | "op" | "term" = "start";
  let i = 0;
  const checkScale = (v: bigint): 1 | 2 | 4 | 8 => {
    const n = Number(v);
    if (n !== 1 && n !== 2 && n !== 4 && n !== 8) throw new AsmError(ln, `scale ${v} is invalid (use 1, 2, 4 or 8)`);
    return n as 1 | 2 | 4 | 8;
  };
  const regOf = (name: string, ln2: number): number => {
    const l = name.toLowerCase();
    if (reg64Index[l] !== undefined) return reg64Index[l]!;
    if (reg32Index[l] !== undefined) throw new AsmError(ln2, `32-bit register '${name}' cannot be used in an address (use the 64-bit name)`);
    if (l === "rip" || l === "eip") throw new AsmError(ln2, "rip-relative addressing is not supported in this teaching subset");
    if (regSmall[l]) throw new AsmError(ln2, `register '${name}' (8/16-bit) is not supported in this teaching subset`);
    return -1; // not a register
  };
  while (i < toks.length) {
    const t = toks[i]!;
    if (t.k === "p" && (t.v === "+" || t.v === "-")) {
      if (state === "op") throw new AsmError(ln, "malformed addressing expression");
      sign = t.v === "+" ? 1 : -1;
      state = "op";
      i++;
      continue;
    }
    if (state === "term") throw new AsmError(ln, `expected '+' or '-' before '${tokStr(t)}'`);
    if (t.k === "id" && regOf(t.v, ln) >= 0) {
      const r = regOf(t.v, ln);
      const nx = toks[i + 1];
      const nx2 = toks[i + 2];
      if (nx !== undefined && nx.k === "p" && nx.v === "*" && nx2 !== undefined && nx2.k === "num") {
        if (index !== null) throw new AsmError(ln, "at most one scaled index register is allowed");
        if (r === 4) throw new AsmError(ln, "rsp cannot be used as an index register");
        if (sign !== 1) throw new AsmError(ln, "the index register cannot have a '-' sign");
        index = r;
        scale = checkScale(nx2.v);
        i += 3;
      } else {
        if (base !== null) throw new AsmError(ln, "at most one base register is allowed");
        if (sign !== 1) throw new AsmError(ln, "the base register cannot have a '-' sign");
        base = r;
        i++;
      }
    } else if (t.k === "num") {
      const a1 = toks[i + 1];
      const a2 = toks[i + 2];
      if (a1 !== undefined && a1.k === "p" && a1.v === "*" && a2 !== undefined && a2.k === "id" && regOf(a2.v, ln) >= 0) {
        const r = regOf(a2.v, ln);
        if (index !== null) throw new AsmError(ln, "at most one scaled index register is allowed");
        if (r === 4) throw new AsmError(ln, "rsp cannot be used as an index register");
        index = r;
        scale = checkScale(t.v);
        i += 3;
      } else {
        disp.push({ sign, kind: "num", v: t.v });
        i++;
      }
    } else if (t.k === "str") {
      if (t.v.length !== 1) throw new AsmError(ln, "character literal must hold exactly one character");
      disp.push({ sign, kind: "num", v: BigInt(t.v.charCodeAt(0)) });
      i++;
    } else if (t.k === "here") {
      disp.push({ sign, kind: "here" });
      i++;
    } else if (t.k === "id") {
      disp.push({ sign, kind: "sym", name: t.v });
      sym = true;
      i++;
    } else {
      throw new AsmError(ln, `unexpected token '${tokStr(t)}' in memory operand`);
    }
    sign = 1;
    state = "term";
  }
  if (state !== "term") throw new AsmError(ln, "empty memory operand");
  return { base, index, scale, disp: disp.length > 0 ? disp : null, sym };
}

function parseOperand(toks: Tok[], ln: number): POp {
  if (toks.length === 0) throw new AsmError(ln, "empty operand");
  let i = 0;
  let size: 8 | 4 | null = null;
  const t0 = toks[0]!;
  if (t0.k === "id") {
    const l = t0.v.toLowerCase();
    if (l === "byte" || l === "word") {
      throw new AsmError(ln, `'${t0.v}' (8/16-bit) operands are not supported in this teaching subset`);
    }
    if (l === "qword" || l === "dword") {
      size = l === "qword" ? 8 : 4;
      i = 1;
      const p = toks[i];
      if (p !== undefined && p.k === "id" && p.v.toLowerCase() === "ptr") i++;
    }
  }
  const rest = toks.slice(i);
  if (rest.length === 0) throw new AsmError(ln, "missing operand after size specifier");
  const r0 = rest[0]!;
  if (r0.k === "p" && r0.v === "[") {
    const last = rest[rest.length - 1]!;
    if (!(last.k === "p" && last.v === "]")) throw new AsmError(ln, "expected ']' to close the memory operand");
    const inner = rest.slice(1, rest.length - 1);
    for (const t of inner) {
      if (t.k === "p" && (t.v === "[" || t.v === "]")) throw new AsmError(ln, "nested brackets in memory operand");
    }
    const m = parseMemBody(inner, ln);
    return { k: "mem", size, base: m.base, index: m.index, scale: m.scale, disp: m.disp, sym: m.sym };
  }
  if (size !== null) throw new AsmError(ln, "size specifier (qword/dword) only makes sense in front of a [...] operand");
  if (rest.length === 1 && r0.k === "id") {
    const l = r0.v.toLowerCase();
    if (reg64Index[l] !== undefined) return { k: "reg", r: reg64Index[l]!, size: 8 };
    if (reg32Index[l] !== undefined) return { k: "reg", r: reg32Index[l]!, size: 4 };
    if (regSmall[l]) throw new AsmError(ln, `register '${r0.v}' (8/16-bit) is not supported in this teaching subset`);
    if (l === "rip" || l === "eip") throw new AsmError(ln, "rip-relative addressing is not supported in this teaching subset");
    return { k: "imm", terms: [{ sign: 1, kind: "sym", name: r0.v }], sym: true };
  }
  const terms = parseExpr(rest, ln);
  return { k: "imm", terms, sym: terms.some((t) => t.kind !== "num") };
}

function splitCommas(toks: Tok[], ln: number): Tok[][] {
  const groups: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.k === "p" && t.v === "[") depth++;
    else if (t.k === "p" && t.v === "]") {
      depth--;
      if (depth < 0) throw new AsmError(ln, "unmatched ']'");
    }
    if (t.k === "p" && t.v === "," && depth === 0) {
      groups.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (depth !== 0) throw new AsmError(ln, "unmatched '['");
  groups.push(cur);
  if (groups.length === 1 && groups[0]!.length === 0) return [];
  return groups;
}

// ---------------------------------------------------------------------------
// statement-level parse
// ---------------------------------------------------------------------------

interface RawInsn {
  ln: number; text: string; mne: string; ops: POp[]; shiftCl: boolean; size: 8 | 4;
  branchSym: string | null; branchAbs: bigint | null; branchTerms: Term[] | null; width: 8 | 32;
}
interface DataCell { ln: number; str?: string; terms?: Term[] }
interface RawData { ln: number; kind: "db" | "dq"; cells: DataCell[] }
interface RawEqu { ln: number; name: string; terms: Term[]; sec: "text" | "data"; idx: number }
interface LabelDef { name: string; ln: number; sec: "text" | "data"; idx: number }

function unifySizes(a: POp, b: POp, mne: string, ln: number): 8 | 4 {
  let size: 8 | 4 | null = null;
  for (const o of [a, b]) {
    const os = o.k === "reg" ? o.size : o.k === "mem" ? o.size : null;
    if (os !== null) {
      if (size === null) size = os;
      else if (size !== os) throw new AsmError(ln, `cannot mix 32-bit and 64-bit operands in '${mne}'`);
    }
  }
  return size ?? 8;
}

function validateInsn(mne: string, ops: POp[], shiftCl: boolean, ln: number): 8 | 4 {
  const count = ops.length + (shiftCl ? 1 : 0);
  const isRM = (o: POp | undefined): o is PReg | PMem => o !== undefined && (o.k === "reg" || o.k === "mem");
  const need = (n: number) => {
    if (count !== n) throw new AsmError(ln, `'${mne}' expects ${n} operand${n === 1 ? "" : "s"}, got ${count}`);
  };
  if (CC[mne] !== undefined) {
    need(1);
    const o = ops[0]!;
    if (o.k !== "imm" || o.terms.length !== 1 || o.terms[0]!.kind !== "sym") {
      throw new AsmError(ln, `'${mne}' takes a .text label as its target`);
    }
    return 8;
  }
  switch (mne) {
    case "mov": case "add": case "sub": case "and": case "or": case "xor": case "cmp": case "test": {
      need(2);
      const d = ops[0]!, s = ops[1]!;
      if (d.k === "imm") throw new AsmError(ln, `the first operand of '${mne}' must be a register or memory`);
      if (d.k === "mem" && s.k === "mem") throw new AsmError(ln, "memory-to-memory operands are not supported in this teaching subset");
      return unifySizes(d, s, mne, ln);
    }
    case "lea": {
      need(2);
      const d = ops[0]!, s = ops[1]!;
      if (d.k !== "reg") throw new AsmError(ln, "the lea destination must be a register");
      if (s.k !== "mem") throw new AsmError(ln, "lea needs a memory source such as [rbx+8]");
      return d.size;
    }
    case "imul": {
      if (count !== 2 && count !== 3) throw new AsmError(ln, `'${mne}' expects 2 or 3 operands, got ${count}`);
      if (ops[0]!.k !== "reg") throw new AsmError(ln, "the imul destination must be a register");
      if (!isRM(ops[1])) throw new AsmError(ln, "the imul source must be a register or memory");
      if (count === 3 && ops[2]!.k !== "imm") throw new AsmError(ln, "the third imul operand must be an immediate");
      return unifySizes(ops[0]!, ops[1]!, mne, ln);
    }
    case "idiv": case "div": case "inc": case "dec": case "neg": case "not": {
      need(1);
      const o = ops[0]!;
      if (!isRM(o)) throw new AsmError(ln, `'${mne}' needs a register or memory operand`);
      return o.size ?? 8;
    }
    case "shl": case "shr": case "sar": {
      need(2);
      const d = ops[0]!;
      if (!isRM(d)) throw new AsmError(ln, `'${mne}' needs a register or memory destination`);
      if (!shiftCl && ops[1]!.k !== "imm") throw new AsmError(ln, `'${mne}' count must be 'cl' or an immediate`);
      return d.size ?? 8;
    }
    case "jmp": case "call": {
      need(1);
      const o = ops[0]!;
      if (o.k === "reg" && o.size !== 8) throw new AsmError(ln, `'${mne}' needs a 64-bit register`);
      return 8;
    }
    case "ret": case "syscall": case "nop": {
      need(0);
      return 8;
    }
    case "push": {
      need(1);
      return 8;
    }
    case "pop": {
      need(1);
      if (ops[0]!.k === "imm") throw new AsmError(ln, "pop needs a register or memory operand");
      return 8;
    }
    default:
      throw new AsmError(ln, `unknown instruction '${mne}' — it is outside this teaching subset (see README)`);
  }
}

// ---------------------------------------------------------------------------
// resolved operands + encoder
// ---------------------------------------------------------------------------

export type RegOp = { k: "reg"; r: number; size: 8 | 4 };
export type MemOp = {
  k: "mem"; base: number | null; index: number | null; scale: 1 | 2 | 4 | 8;
  disp: bigint; size: 8 | 4;
};
export type ImmOp = { k: "imm"; v: bigint };
export type XOp = RegOp | MemOp | ImmOp;

export type Op =
  | { t: "mov"; d: RegOp | MemOp; s: XOp }
  | { t: "alu"; a: "add" | "sub" | "and" | "or" | "xor"; d: RegOp | MemOp; s: XOp }
  | { t: "cmp"; a: RegOp | MemOp; b: XOp }
  | { t: "test"; a: RegOp | MemOp; b: XOp }
  | { t: "lea"; d: RegOp; m: MemOp }
  | { t: "imul"; d: RegOp; s: XOp }
  | { t: "imul3"; d: RegOp; s: XOp; imm: bigint }
  | { t: "idiv"; s: XOp }
  | { t: "div"; s: XOp }
  | { t: "un"; u: "inc" | "dec" | "neg" | "not"; d: RegOp | MemOp }
  | { t: "shift"; sh: "shl" | "shr" | "sar"; d: RegOp | MemOp; by: "cl" | bigint }
  | { t: "jmp"; to: bigint }
  | { t: "jmpind"; s: XOp }
  | { t: "jcc"; cc: number; to: bigint }
  | { t: "call"; to: bigint }
  | { t: "callind"; s: XOp }
  | { t: "ret" }
  | { t: "push"; s: XOp }
  | { t: "pop"; d: RegOp | MemOp }
  | { t: "syscall" }
  | { t: "nop" };

// during the length-probe pass, symbols are encoded with worst-case sizes so
// probe length == final length. these mirror RegOp/MemOp/ImmOp but keep the
// "had a symbol" flag that drives encoding-size decisions.
type EReg = RegOp;
type EMem = { k: "mem"; base: number | null; index: number | null; scale: 1 | 2 | 4 | 8; disp: bigint | null; sym: boolean; size: 8 | 4 };
type EImm = { k: "imm"; v: bigint; sym: boolean };
type EOp = EReg | EMem | EImm;

interface EInsn {
  ln: number; mne: string; ops: EOp[]; shiftCl: boolean; size: 8 | 4;
  target: bigint | null; branch: boolean; cc: number | null; width: 8 | 32;
}

function rexByte(w: boolean, r: boolean, x: boolean, b: boolean): number[] {
  const v = 0x40 | ((w ? 1 : 0) << 3) | ((r ? 1 : 0) << 2) | ((x ? 1 : 0) << 1) | (b ? 1 : 0);
  return w || r || x || b ? [v] : [];
}
const modrm = (mod: number, reg: number, rm: number) => (mod << 6) | ((reg & 7) << 3) | (rm & 7);
const sib = (sc: number, idx: number, base: number) => (sc << 6) | ((idx & 7) << 3) | (base & 7);

function i32bytes(v: bigint, ln: number): number[] {
  if (v < -0x80000000n || v > 0x7fffffffn) {
    throw new AsmError(ln, `value ${v} does not fit in a signed 32-bit displacement/immediate`);
  }
  const u = v & M32;
  return [Number(u & 0xffn), Number((u >> 8n) & 0xffn), Number((u >> 16n) & 0xffn), Number((u >> 24n) & 0xffn)];
}

function imm32For(size: 8 | 4, v: bigint, ln: number): number[] {
  if (size === 8) return i32bytes(v, ln); // sign-extended imm32: must fit signed
  if (v < -0x80000000n || v > 0xffffffffn) throw new AsmError(ln, `immediate ${v} is out of range for a 32-bit operand`);
  const u = v & M32;
  return [Number(u & 0xffn), Number((u >> 8n) & 0xffn), Number((u >> 16n) & 0xffn), Number((u >> 24n) & 0xffn)];
}

function le64(v: bigint): number[] {
  const u = v & M64;
  return Array.from({ length: 8 }, (_, i) => Number((u >> BigInt(i * 8)) & 0xffn));
}
function le32(v: bigint): number[] {
  const u = v & M32;
  return [Number(u & 0xffn), Number((u >> 8n) & 0xffn), Number((u >> 16n) & 0xffn), Number((u >> 24n) & 0xffn)];
}

function emitRM(out: number[], opcs: number[], w: boolean, regField: number, rm: EReg | EMem, ln: number): void {
  const rexR = regField >= 8;
  const rexX = rm.k === "mem" && rm.index !== null && rm.index >= 8;
  const rexB = (rm.k === "reg" && rm.r >= 8) || (rm.k === "mem" && rm.base !== null && rm.base >= 8);
  out.push(...rexByte(w, rexR, rexX, rexB), ...opcs);
  if (rm.k === "reg") {
    out.push(modrm(0b11, regField, rm.r));
    return;
  }
  const hasDisp = rm.disp !== null;
  const dv = rm.disp ?? 0n;
  const wantD8 = !rm.sym && dv >= -128n && dv <= 127n;
  if (rm.base !== null && rm.index === null) {
    const b = rm.base;
    const needsSib = b === 4; // rsp/r12 as base require a SIB byte
    const rmf = needsSib ? 0b100 : b;
    const mod = !hasDisp && b !== 5 ? 0b00 : wantD8 ? 0b01 : 0b10;
    out.push(modrm(mod, regField, rmf));
    if (needsSib) out.push(sib(0, 0b100, 4));
    if (mod === 0b01) out.push(Number(dv) & 0xff);
    else if (mod === 0b10) out.push(...i32bytes(dv, ln));
  } else if (rm.base !== null && rm.index !== null) {
    const b = rm.base;
    const mod = !hasDisp && b !== 5 ? 0b00 : wantD8 ? 0b01 : 0b10;
    out.push(modrm(mod, regField, 0b100), sib(SCALE_BITS[rm.scale]!, rm.index, b));
    if (mod === 0b01) out.push(Number(dv) & 0xff);
    else if (mod === 0b10) out.push(...i32bytes(dv, ln));
  } else if (rm.index !== null) {
    // no base: SIB with base=101, mod=00 forces a disp32
    out.push(modrm(0b00, regField, 0b100), sib(SCALE_BITS[rm.scale]!, rm.index, 0b101), ...i32bytes(dv, ln));
  } else {
    // absolute [disp32]: SIB with no index, no base
    out.push(modrm(0b00, regField, 0b100), sib(0, 0b100, 0b101), ...i32bytes(dv, ln));
  }
}

function encodeInsn(r: EInsn, addr: number): number[] {
  const out: number[] = [];
  const ln = r.ln;
  const w = r.size === 8;
  const m = r.mne;
  const a0 = r.ops[0];
  const a1 = r.ops[1];
  if (m === "mov") {
    const d = a0 as EReg | EMem;
    const s = a1 as EOp;
    if (s.k === "reg") emitRM(out, [0x89], w, s.r, d, ln);
    else if (s.k === "mem") emitRM(out, [0x8b], w, (d as EReg).r, s, ln);
    else if (d.k === "reg") {
      if (s.sym) {
        out.push(...rexByte(w, false, false, d.r >= 8), 0xb8 | (d.r & 7), ...le64(s.v));
      } else if (w && s.v >= -0x80000000n && s.v <= 0x7fffffffn) {
        emitRM(out, [0xc7], true, 0, d, ln);
        out.push(...i32bytes(s.v, ln));
      } else if (w) {
        out.push(...rexByte(true, false, false, d.r >= 8), 0xb8 | (d.r & 7), ...le64(s.v));
      } else {
        if (s.v < -0x80000000n || s.v > 0xffffffffn) throw new AsmError(ln, `immediate ${s.v} is out of range for a 32-bit register`);
        out.push(...rexByte(false, false, false, d.r >= 8), 0xb8 | (d.r & 7), ...le32(s.v));
      }
    } else {
      emitRM(out, [0xc7], w, 0, d, ln);
      out.push(...imm32For(r.size, s.v, ln));
    }
  } else if (ARITH_DIGIT[m] !== undefined) {
    const t = ARITH_DIGIT[m]!;
    const d = a0 as EReg | EMem;
    const s = a1 as EOp;
    if (s.k === "reg") emitRM(out, [t.rm_r], w, s.r, d, ln);
    else if (s.k === "mem") emitRM(out, [t.r_rm], w, (d as EReg).r, s, ln);
    else {
      const b = !s.sym && s.v >= -128n && s.v <= 127n;
      emitRM(out, [b ? 0x83 : 0x81], w, t.digit, d, ln);
      out.push(...(b ? [Number(s.v) & 0xff] : imm32For(r.size, s.v, ln)));
    }
  } else if (m === "test") {
    const d = a0 as EReg | EMem;
    const s = a1 as EOp;
    if (s.k === "reg") emitRM(out, [0x85], w, s.r, d, ln);
    else if (s.k === "mem") emitRM(out, [0x85], w, (d as EReg).r, s, ln);
    else {
      emitRM(out, [0xf7], w, 0, d, ln);
      out.push(...imm32For(r.size, s.v, ln));
    }
  } else if (m === "lea") {
    emitRM(out, [0x8d], (a0 as EReg).size === 8, (a0 as EReg).r, a1 as EMem, ln);
  } else if (m === "imul") {
    if (r.ops.length === 2) {
      emitRM(out, [0x0f, 0xaf], w, (a0 as EReg).r, a1 as EReg | EMem, ln);
    } else {
      const src = a1 as EReg | EMem;
      const im = r.ops[2] as EImm;
      const b = !im.sym && im.v >= -128n && im.v <= 127n;
      emitRM(out, [b ? 0x6b : 0x69], w, (a0 as EReg).r, src, ln);
      out.push(...(b ? [Number(im.v) & 0xff] : imm32For(r.size, im.v, ln)));
    }
  } else if (m === "idiv" || m === "div") {
    emitRM(out, [0xf7], w, m === "idiv" ? 7 : 6, a0 as EReg | EMem, ln);
  } else if (m === "inc" || m === "dec") {
    emitRM(out, [0xff], w, m === "inc" ? 0 : 1, a0 as EReg | EMem, ln);
  } else if (m === "neg") {
    emitRM(out, [0xf7], w, 3, a0 as EReg | EMem, ln);
  } else if (m === "not") {
    emitRM(out, [0xf7], w, 2, a0 as EReg | EMem, ln);
  } else if (m === "shl" || m === "shr" || m === "sar") {
    const digit = m === "shl" ? 4 : m === "shr" ? 5 : 7;
    if (r.shiftCl) {
      emitRM(out, [0xd3], w, digit, a0 as EReg | EMem, ln);
    } else {
      const im = a1 as EImm;
      if (im.v < 0n || im.v > 255n) throw new AsmError(ln, `shift count ${im.v} is out of range (0-255)`);
      emitRM(out, [0xc1], w, digit, a0 as EReg | EMem, ln);
      out.push(Number(im.v));
    }
  } else if (m === "jmp" || m === "call") {
    if (r.branch) {
      const to = r.target ?? 0n; // 0n only during the length probe
      if (m === "call") out.push(0xe8, ...i32bytes(to - BigInt(addr + 5), ln));
      else if (r.width === 8) {
        const rel = to - BigInt(addr + 2);
        if (r.target !== null && (rel < -128n || rel > 127n)) throw new AsmError(ln, "internal error: jmp does not fit rel8");
        out.push(0xeb, Number(rel) & 0xff);
      } else {
        out.push(0xe9, ...i32bytes(to - BigInt(addr + 5), ln));
      }
    } else {
      emitRM(out, [0xff], false, m === "jmp" ? 4 : 2, a0 as EReg | EMem, ln);
    }
  } else if (CC[m] !== undefined) {
    const cc = CC[m]!;
    const to = r.target ?? 0n; // 0n only during the length probe
    if (r.width === 8) {
      const rel = to - BigInt(addr + 2);
      if (r.target !== null && (rel < -128n || rel > 127n)) throw new AsmError(ln, "internal error: branch does not fit rel8");
      out.push(0x70 | cc, Number(rel) & 0xff);
    } else {
      out.push(0x0f, 0x80 | cc, ...i32bytes(to - BigInt(addr + 6), ln));
    }
  } else if (m === "ret") {
    out.push(0xc3);
  } else if (m === "push") {
    const s = a0 as EOp;
    if (s.k === "reg") out.push(...rexByte(false, false, false, s.r >= 8), 0x50 | (s.r & 7));
    else if (s.k === "mem") emitRM(out, [0xff], false, 6, s, ln);
    else if (!s.sym && s.v >= -128n && s.v <= 127n) out.push(0x6a, Number(s.v) & 0xff);
    else out.push(0x68, ...imm32For(8, s.v, ln));
  } else if (m === "pop") {
    const d = a0 as EOp;
    if (d.k === "reg") out.push(...rexByte(false, false, false, d.r >= 8), 0x58 | (d.r & 7));
    else emitRM(out, [0x8f], false, 0, d as EMem, ln);
  } else if (m === "syscall") {
    out.push(0x0f, 0x05);
  } else if (m === "nop") {
    out.push(0x90);
  } else {
    throw new AsmError(ln, `internal error: cannot encode '${m}'`);
  }
  return out;
}

function execOp(r: EInsn, text: string): Op {
  const m = r.mne;
  const ops = r.ops;
  const xr = (o: EOp): XOp =>
    o.k === "reg" ? o : o.k === "mem"
      ? { k: "mem", base: o.base, index: o.index, scale: o.scale, disp: o.disp ?? 0n, size: o.size }
      : { k: "imm", v: o.v };
  const d0 = ops[0] ? xr(ops[0]) : undefined;
  const d1 = ops[1] ? xr(ops[1]) : undefined;
  const rm0 = d0 !== undefined && d0.k !== "imm" ? d0 : undefined;
  const rm1 = d1 !== undefined && d1.k !== "imm" ? d1 : undefined;
  if (m === "mov") return { t: "mov", d: rm0 as RegOp | MemOp, s: d1! };
  if (ARITH_DIGIT[m] !== undefined) {
    if (m === "cmp") return { t: "cmp", a: rm0 as RegOp | MemOp, b: d1! };
    return { t: "alu", a: m as "add" | "sub" | "and" | "or" | "xor", d: rm0 as RegOp | MemOp, s: d1! };
  }
  if (m === "test") return { t: "test", a: rm0 as RegOp | MemOp, b: d1! };
  if (m === "lea") return { t: "lea", d: d0 as RegOp, m: d1 as MemOp };
  if (m === "imul") {
    if (ops.length === 2) return { t: "imul", d: d0 as RegOp, s: d1! };
    return { t: "imul3", d: d0 as RegOp, s: d1!, imm: (ops[2] as EImm).v };
  }
  if (m === "idiv" || m === "div") return { t: m, s: d0! };
  if (m === "inc" || m === "dec" || m === "neg" || m === "not") return { t: "un", u: m, d: rm0 as RegOp | MemOp };
  if (m === "shl" || m === "shr" || m === "sar") {
    return { t: "shift", sh: m, d: rm0 as RegOp | MemOp, by: r.shiftCl ? "cl" : (d1 as ImmOp).v };
  }
  if (m === "jmp") return r.branch ? { t: "jmp", to: r.target! } : { t: "jmpind", s: d0! };
  if (CC[m] !== undefined) return { t: "jcc", cc: CC[m]!, to: r.target! };
  if (m === "call") return r.branch ? { t: "call", to: r.target! } : { t: "callind", s: d0! };
  if (m === "ret") return { t: "ret" };
  if (m === "push") return { t: "push", s: d0! };
  if (m === "pop") return { t: "pop", d: rm0 as RegOp | MemOp };
  if (m === "syscall") return { t: "syscall" };
  if (m === "nop") return { t: "nop" };
  throw new AsmError(r.ln, `internal error: no exec op for '${m}' (${text})`);
}

// ---------------------------------------------------------------------------
// program model
// ---------------------------------------------------------------------------

export interface Insn {
  addr: number;
  len: number;
  bytes: number[];
  text: string;      // statement as written (label/comment stripped)
  line: number;      // 1-based source line
  op: Op;
}

export interface Program {
  insns: Insn[];
  entry: bigint;
  textBase: number;
  textEnd: number;
  dataBase: number;
  dataEnd: number;
  data: Map<number, number>; // initial .data bytes (sparse)
  dataLabels: { name: string; addr: number }[];
}

export type AsmResult = { ok: true; program: Program } | { ok: false; line: number; message: string };

export function assemble(src: string): AsmResult {
  try {
    return { ok: true, program: assembleProgram(src) };
  } catch (e) {
    if (e instanceof AsmError) return { ok: false, line: e.line, message: e.msg };
    throw e;
  }
}

function assembleProgram(src: string): Program {
  const lines = src.split("\n");
  let sec: "text" | "data" = "text";
  const insns: RawInsn[] = [];
  const data: RawData[] = [];
  const equByName = new Map<string, RawEqu>();
  const labelByName = new Map<string, LabelDef>();

  const dup = (name: string, ln: number) => {
    if (labelByName.has(name) || equByName.has(name)) throw new AsmError(ln, `symbol '${name}' is defined more than once`);
  };

  lines.forEach((line, idx) => {
    const ln = idx + 1;
    let toks = tokenize(line, ln);
    while (toks.length >= 2 && toks[0]!.k === "id" && toks[1]!.k === "p" && toks[1]!.v === ":") {
      const name = toks[0]!.v;
      dup(name, ln);
      labelByName.set(name, { name, ln, sec, idx: sec === "text" ? insns.length : data.length });
      toks = toks.slice(2);
    }
    if (toks.length === 0) return;
    const head = toks[0]!;
    if (head.k !== "id") throw new AsmError(ln, `expected an instruction or directive, found '${tokStr(head)}'`);
    const m = head.v.toLowerCase();
    const text = line.slice(head.start, toks[toks.length - 1]!.end);
    if (m === "section") {
      const a = toks[1];
      if (a === undefined || a.k !== "id" || (a.v.toLowerCase() !== ".text" && a.v.toLowerCase() !== ".data")) {
        throw new AsmError(ln, "expected '.text' or '.data' after 'section'");
      }
      if (toks.length > 2) throw new AsmError(ln, "unexpected text after the section directive");
      sec = a.v.toLowerCase() === ".text" ? "text" : "data";
      return;
    }
    if (m === ".text" || m === ".data") {
      if (toks.length > 1) throw new AsmError(ln, `unexpected text after '${m}'`);
      sec = m === ".text" ? "text" : "data";
      return;
    }
    const second = toks[1];
    if (second !== undefined && second.k === "id" && second.v.toLowerCase() === "equ") {
      dup(head.v, ln);
      const eq: RawEqu = {
        ln, name: head.v, terms: parseExpr(toks.slice(2), ln), sec,
        idx: sec === "text" ? insns.length : data.length,
      };
      equByName.set(eq.name, eq);
      return;
    }
    if (m === "db" || m === "dq") {
      if (sec !== "data") throw new AsmError(ln, `'${m}' is only supported inside the .data section in this teaching subset`);
      const cells = splitCommas(toks.slice(1), ln).map((g): DataCell => {
        if (g.length === 1 && g[0]!.k === "str") return { ln, str: g[0]!.v };
        return { ln, terms: parseExpr(g, ln) };
      });
      if (cells.length === 0) throw new AsmError(ln, `'${m}' needs at least one value`);
      data.push({ ln, kind: m, cells });
      return;
    }
    if (sec !== "text") throw new AsmError(ln, "instructions are only supported inside the .text section");
    const groups = splitCommas(toks.slice(1), ln);
    let shiftCl = false;
    if ((m === "shl" || m === "shr" || m === "sar") && groups.length >= 1) {
      const last = groups[groups.length - 1]!;
      if (last.length === 1 && last[0]!.k === "id" && last[0]!.v.toLowerCase() === "cl") {
        shiftCl = true;
        groups.pop();
      }
    }
    const ops = groups.map((g) => parseOperand(g, ln));
    const size = validateInsn(m, ops, shiftCl, ln);
    let branchSym: string | null = null;
    let branchAbs: bigint | null = null;
    let branchTerms: Term[] | null = null;
    if (m === "jmp" || m === "call" || CC[m] !== undefined) {
      const o = ops[0]!;
      if (o.k === "imm") {
        if (o.terms.length === 1 && o.terms[0]!.kind === "sym") branchSym = o.terms[0]!.name ?? null;
        else if (o.terms.every((t) => t.kind === "num")) {
          branchAbs = o.terms.reduce((a, t) => a + BigInt(t.sign) * t.v!, 0n);
        } else if (o.terms.every((t) => t.kind === "num" || t.kind === "here")) {
          // e.g. `jmp $` (own address) or `jmp $+8` — resolved once addresses are known
          branchTerms = o.terms;
        } else {
          throw new AsmError(ln, `the target of '${m}' must be a .text label or a plain address`);
        }
      }
    }
    insns.push({ ln, text, mne: m, ops, shiftCl, size, branchSym, branchAbs, branchTerms, width: 8 });
  });

  if (insns.length === 0) throw new AsmError(1, "no instructions found — add some to the .text section");

  // data cell offsets (sizes are layout-independent)
  const dataOffsets: number[] = [0];
  for (const item of data) {
    let sz = 0;
    for (const cell of item.cells) sz += cell.str !== undefined ? cell.str.length : item.kind === "db" ? 1 : 8;
    dataOffsets.push(dataOffsets[dataOffsets.length - 1]! + sz);
  }

  // --- pass 1: branch-width relaxation (probe encodings) -------------------
  const n = insns.length;
  const widths: (8 | 32)[] = insns.map(() => 8);
  const foldNum = (terms: Term[]): bigint => terms.reduce((a, t) => a + BigInt(t.sign) * t.v!, 0n);
  const dummyOps = (raw: RawInsn): EOp[] =>
    raw.ops.map((o): EOp => {
      if (o.k === "reg") return { k: "reg", r: o.r, size: o.size };
      if (o.k === "imm") return { k: "imm", v: o.sym ? 0n : foldNum(o.terms), sym: o.sym };
      return {
        k: "mem", base: o.base, index: o.index, scale: o.scale,
        // keep the real numeric value so probe picks the same imm8/imm32,
        // disp8/disp32, C7/B8 size classes the final encode will pick
        disp: o.disp === null ? null : o.sym ? 0n : foldNum(o.disp),
        sym: o.sym, size: o.size ?? raw.size,
      };
    });
  const probeInsn = (raw: RawInsn, width: 8 | 32): EInsn => ({
    ln: raw.ln, mne: raw.mne, ops: dummyOps(raw), shiftCl: raw.shiftCl, size: raw.size,
    target: null, branch: raw.branchSym !== null || raw.branchAbs !== null || raw.branchTerms !== null, cc: CC[raw.mne] ?? null, width,
  });
  const probeBytes: number[][] = insns.map((raw, i) => encodeInsn(probeInsn(raw, widths[i]!), TEXT_BASE));
  let addrs: number[] = [];
  {
    let a = TEXT_BASE;
    for (let i = 0; i < n; i++) { addrs[i] = a; a += probeBytes[i]!.length; }
    addrs[n] = a;
  }
  for (let iter = 0; iter < n + 4; iter++) {
    let changed = false;
    // re-sweep with current widths
    let a = TEXT_BASE;
    for (let i = 0; i < n; i++) {
      addrs[i] = a;
      const b = encodeInsn(probeInsn(insns[i]!, widths[i]!), a);
      probeBytes[i] = b;
      a += b.length;
    }
    addrs[n] = a;
    const textEnd = a;
    for (let i = 0; i < n; i++) {
      const ins = insns[i]!;
      if (ins.branchSym === null && ins.branchAbs === null && ins.branchTerms === null) continue;
      let to: bigint;
      if (ins.branchSym !== null) {
        const def = labelByName.get(ins.branchSym);
        if (def === undefined) throw new AsmError(ins.ln, `unknown symbol '${ins.branchSym}'`);
        if (def.sec !== "text") throw new AsmError(ins.ln, `branch target '${ins.branchSym}' must be a label in .text`);
        to = BigInt(addrs[def.idx] ?? textEnd);
      } else if (ins.branchTerms !== null) {
        // `$` = this instruction's own address
        to = ins.branchTerms.reduce(
          (a, t) => a + BigInt(t.sign) * (t.kind === "here" ? BigInt(addrs[i]!) : t.v!), 0n,
        );
      } else {
        to = ins.branchAbs!;
      }
      const len = ins.mne === "call" ? 5 : widths[i] === 8 ? 2 : ins.mne === "jmp" ? 5 : 6;
      const rel = to - BigInt(addrs[i]! + len);
      if (widths[i] === 8 && (rel < -128n || rel > 127n)) {
        widths[i] = 32;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const textEnd = addrs[n]!;
  const dataBase = (textEnd + 15) & ~15;

  // --- pass 2: resolve symbols, encode, build exec ops ---------------------
  const textLabelAddr = (def: LabelDef): bigint => BigInt(addrs[def.idx] ?? textEnd);
  const dataLabelAddr = (def: LabelDef): bigint => BigInt(dataBase + (dataOffsets[def.idx] ?? 0));

  const equMemo = new Map<string, bigint>();
  const equBusy = new Set<string>();
  const evalTerms = (terms: Term[], ln: number, hereVal: bigint): bigint => {
    let acc = 0n;
    for (const t of terms) {
      const v = t.kind === "num" ? t.v! : t.kind === "here" ? hereVal : resolveSym(t.name!, ln);
      acc += BigInt(t.sign) * v;
    }
    return acc;
  };
  const resolveSym = (name: string, ln: number): bigint => {
    const lab = labelByName.get(name);
    if (lab !== undefined) return lab.sec === "text" ? textLabelAddr(lab) : dataLabelAddr(lab);
    const eq = equByName.get(name);
    if (eq !== undefined) {
      const memo = equMemo.get(name);
      if (memo !== undefined) return memo;
      if (equBusy.has(name)) throw new AsmError(ln, `'${name}' is defined circularly`);
      equBusy.add(name);
      const hereVal = eq.sec === "text" ? BigInt(addrs[eq.idx] ?? textEnd) : BigInt(dataBase + (dataOffsets[eq.idx] ?? 0));
      const v = evalTerms(eq.terms, eq.ln, hereVal);
      equBusy.delete(name);
      equMemo.set(name, v);
      return v;
    }
    throw new AsmError(ln, `unknown symbol '${name}'`);
  };
  const resolveOp = (o: POp, ln: number, hereVal: bigint, sizeCtx: 8 | 4): EOp => {
    if (o.k === "reg") return { k: "reg", r: o.r, size: o.size };
    if (o.k === "imm") return { k: "imm", v: evalTerms(o.terms, ln, hereVal), sym: o.sym };
    return {
      k: "mem", base: o.base, index: o.index, scale: o.scale,
      disp: o.disp !== null ? evalTerms(o.disp, ln, hereVal) : null,
      sym: o.sym, size: o.size ?? sizeCtx,
    };
  };

  const outInsns: Insn[] = insns.map((raw, i) => {
    const addr = addrs[i]!;
    const hereVal = BigInt(addr);
    const ops = raw.ops.map((o) => resolveOp(o, raw.ln, hereVal, raw.size));
    let target: bigint | null = null;
    if (raw.branchSym !== null) {
      const def = labelByName.get(raw.branchSym);
      if (def === undefined) throw new AsmError(raw.ln, `unknown symbol '${raw.branchSym}'`);
      if (def.sec !== "text") throw new AsmError(raw.ln, `branch target '${raw.branchSym}' must be a label in .text`);
      target = textLabelAddr(def);
    } else if (raw.branchTerms !== null) {
      target = evalTerms(raw.branchTerms, raw.ln, hereVal);
    } else if (raw.branchAbs !== null) {
      target = raw.branchAbs;
    }
    const einsn: EInsn = {
      ln: raw.ln, mne: raw.mne, ops, shiftCl: raw.shiftCl, size: raw.size,
      target, branch: raw.branchSym !== null || raw.branchAbs !== null || raw.branchTerms !== null, cc: CC[raw.mne] ?? null, width: widths[i]!,
    };
    const bytes = encodeInsn(einsn, addr);
    if (bytes.length !== probeBytes[i]!.length) {
      throw new AsmError(raw.ln, `internal error: encoding size changed after relaxation (${bytes.length} != ${probeBytes[i]!.length})`);
    }
    return {
      addr,
      len: bytes.length,
      bytes,
      text: raw.text,
      line: raw.ln,
      op: execOp(einsn, raw.text),
    };
  });

  // .data bytes
  const dataMap = new Map<number, number>();
  const dataLabels: { name: string; addr: number }[] = [];
  for (const def of labelByName.values()) {
    if (def.sec === "data") dataLabels.push({ name: def.name, addr: Number(dataLabelAddr(def)) });
  }
  data.forEach((item, k) => {
    let off = dataOffsets[k]!;
    for (const cell of item.cells) {
      if (cell.str !== undefined) {
        for (const ch of cell.str) dataMap.set(dataBase + off++, ch.charCodeAt(0) & 0xff);
      } else {
        const v = evalTerms(cell.terms!, cell.ln, BigInt(dataBase + off));
        if (item.kind === "db") {
          if (v < -128n || v > 255n) throw new AsmError(cell.ln, `value ${v} is out of range for db (byte)`);
          dataMap.set(dataBase + off, Number(v) & 0xff);
          off += 1;
        } else {
          const u = v & M64;
          for (let b = 0; b < 8; b++) dataMap.set(dataBase + off + b, Number((u >> BigInt(b * 8)) & 0xffn));
          off += 8;
        }
      }
    }
  });

  return {
    insns: outInsns,
    entry: BigInt(TEXT_BASE),
    textBase: TEXT_BASE,
    textEnd,
    dataBase,
    dataEnd: dataBase + dataOffsets[dataOffsets.length - 1]!,
    data: dataMap,
    dataLabels,
  };
}
