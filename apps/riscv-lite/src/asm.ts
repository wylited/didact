// asm.ts — two-pass assembler for RV32I (+ M extension), pure TypeScript.
//
// Encoding reference: RISC-V Unprivileged ISA Specification v2.x,
// "RV32I Base Integer Instruction Set" chapter. Every instruction is one
// 32-bit word, stored little-endian in memory.
//
// ─── Encoding verification (bit-level derivations, re-derived next to each
//      encoder below; summary + notes in README.md "Encoding verification") ───
//
//   addi x1, x2, 4    I-type  imm=0x004 rs1=2 f3=0 rd=1 op=0x13
//                     (0x004<<20)|(2<<15)|(1<<7)|0x13          = 0x00410093
//                     bytes (LE): 93 10 41 00
//   lw   x1, 8(x2)    I-type  imm=8 rs1=2 f3=2 rd=1 op=0x03
//                     (8<<20)|(2<<15)|(2<<12)|(1<<7)|0x03      = 0x00812083
//   sw   x1, 8(x2)    S-type  imm[11:5]=0 rs2=1 rs1=2 f3=2 imm[4:0]=8 op=0x23
//                     (1<<20)|(2<<15)|(2<<12)|(8<<7)|0x23      = 0x00112423
//   beq  x1, x2, +16  B-type  imm=16 ⇒ imm[4:1]=8 (bits 11:8), rest 0
//                     (2<<20)|(1<<15)|(8<<8)|0x63             = 0x00208863
//   jal  x1, +16      J-type  imm=16 ⇒ imm[10:1]=8 (bits 30:21)
//                     (8<<21)|(1<<7)|0x6F                     = 0x010000EF
//   jalr x0, 0(x1)    = canonical `ret`: imm=0 rs1=1 f3=0 rd=0 op=0x67
//                                                          = 0x00008067
//   nop  = addi x0,x0,0 = 0x00000013     ecall  = 0x00000073
//   ebreak = 0x00100073                 fence iorw,iorw = 0x0FF0000F

/** Where `.text` is loaded in the (sparse) 32-bit address space. */
export const TEXT_BASE = 0x00001000;
/** Initial `sp`: top of usable RAM, 4-byte aligned, growing down. */
export const STACK_INIT = 0x7ffffffc;

/** Canonical ABI name for each register x0..x31 (x8 shown as s0). */
export const REG_ABI: readonly string[] = [
  "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2", "s0", "s1",
  "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7",
  "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11",
  "t3", "t4", "t5", "t6",
];

const REGISTERS: Readonly<Record<string, number | undefined>> = (() => {
  const m: Record<string, number | undefined> = {};
  for (let i = 0; i < 32; i++) m["x" + i] = i;
  REG_ABI.forEach((n, i) => (m[n] = i));
  m["fp"] = 8; // alias for s0
  return m;
})();

/** Format the low 32 bits of n as 0x-prefixed 8-digit hex. */
export function hex32(n: number): string {
  return "0x" + (n >>> 0).toString(16).padStart(8, "0");
}

// ─────────────────────────── error plumbing ───────────────────────────

/** Line-mapped assembly error (1-based source line). */
export interface AsmError {
  line: number;
  message: string;
}

/**
 * Thrown internally by parse helpers. `line` is filled by the per-statement
 * wrapper when the helper itself does not know which line it is on.
 */
class Fail {
  constructor(readonly msg: string, readonly line?: number) {}
}
function fail(msg: string): never {
  throw new Fail(msg);
}

// ─────────────────────────── instruction table ───────────────────────────

type Fmt = "R" | "I" | "SH" | "L" | "S" | "B" | "U" | "J" | "JALR" | "SYS";

interface OpInfo {
  op: number;
  f3: number;
  f7: number;
  fmt: Fmt;
}

// Real encodings only — pseudoinstructions are expanded before this table
// is consulted (see encodeStmt). opcode/funct3/funct7 values are from the
// RV32I + M instruction tables of the unprivileged spec.
const OPS: Readonly<Record<string, OpInfo | undefined>> = {
  // RV32I register-register (opcode 0x33)
  add: { op: 0x33, f3: 0, f7: 0x00, fmt: "R" },
  sub: { op: 0x33, f3: 0, f7: 0x20, fmt: "R" },
  sll: { op: 0x33, f3: 1, f7: 0x00, fmt: "R" },
  slt: { op: 0x33, f3: 2, f7: 0x00, fmt: "R" },
  sltu: { op: 0x33, f3: 3, f7: 0x00, fmt: "R" },
  xor: { op: 0x33, f3: 4, f7: 0x00, fmt: "R" },
  srl: { op: 0x33, f3: 5, f7: 0x00, fmt: "R" },
  sra: { op: 0x33, f3: 5, f7: 0x20, fmt: "R" },
  or: { op: 0x33, f3: 6, f7: 0x00, fmt: "R" },
  and: { op: 0x33, f3: 7, f7: 0x00, fmt: "R" },
  // M extension (opcode 0x33, funct7 = 0000001)
  mul: { op: 0x33, f3: 0, f7: 0x01, fmt: "R" },
  mulh: { op: 0x33, f3: 1, f7: 0x01, fmt: "R" },
  mulhsu: { op: 0x33, f3: 2, f7: 0x01, fmt: "R" },
  mulhu: { op: 0x33, f3: 3, f7: 0x01, fmt: "R" },
  div: { op: 0x33, f3: 4, f7: 0x01, fmt: "R" },
  divu: { op: 0x33, f3: 5, f7: 0x01, fmt: "R" },
  rem: { op: 0x33, f3: 6, f7: 0x01, fmt: "R" },
  remu: { op: 0x33, f3: 7, f7: 0x01, fmt: "R" },
  // immediates (opcode 0x13)
  addi: { op: 0x13, f3: 0, f7: 0, fmt: "I" },
  slti: { op: 0x13, f3: 2, f7: 0, fmt: "I" },
  sltiu: { op: 0x13, f3: 3, f7: 0, fmt: "I" },
  xori: { op: 0x13, f3: 4, f7: 0, fmt: "I" },
  ori: { op: 0x13, f3: 6, f7: 0, fmt: "I" },
  andi: { op: 0x13, f3: 7, f7: 0, fmt: "I" },
  slli: { op: 0x13, f3: 1, f7: 0x00, fmt: "SH" },
  srli: { op: 0x13, f3: 5, f7: 0x00, fmt: "SH" },
  srai: { op: 0x13, f3: 5, f7: 0x20, fmt: "SH" },
  // loads (opcode 0x03)
  lb: { op: 0x03, f3: 0, f7: 0, fmt: "L" },
  lh: { op: 0x03, f3: 1, f7: 0, fmt: "L" },
  lw: { op: 0x03, f3: 2, f7: 0, fmt: "L" },
  lbu: { op: 0x03, f3: 4, f7: 0, fmt: "L" },
  lhu: { op: 0x03, f3: 5, f7: 0, fmt: "L" },
  // stores (opcode 0x23)
  sb: { op: 0x23, f3: 0, f7: 0, fmt: "S" },
  sh: { op: 0x23, f3: 1, f7: 0, fmt: "S" },
  sw: { op: 0x23, f3: 2, f7: 0, fmt: "S" },
  // branches (opcode 0x63)
  beq: { op: 0x63, f3: 0, f7: 0, fmt: "B" },
  bne: { op: 0x63, f3: 1, f7: 0, fmt: "B" },
  blt: { op: 0x63, f3: 4, f7: 0, fmt: "B" },
  bge: { op: 0x63, f3: 5, f7: 0, fmt: "B" },
  bltu: { op: 0x63, f3: 6, f7: 0, fmt: "B" },
  bgeu: { op: 0x63, f3: 7, f7: 0, fmt: "B" },
  // upper immediates / jumps / system
  lui: { op: 0x37, f3: 0, f7: 0, fmt: "U" },
  auipc: { op: 0x17, f3: 0, f7: 0, fmt: "U" },
  jal: { op: 0x6f, f3: 0, f7: 0, fmt: "J" },
  jalr: { op: 0x67, f3: 0, f7: 0, fmt: "JALR" },
  ecall: { op: 0x73, f3: 0, f7: 0, fmt: "SYS" },
  ebreak: { op: 0x73, f3: 0, f7: 0, fmt: "SYS" },
  fence: { op: 0x0f, f3: 0, f7: 0, fmt: "SYS" },
};

const PSEUDOS = ["li", "la", "mv", "nop", "j", "jr", "ret", "beqz", "bnez", "neg", "not"];

/** All accepted mnemonics (used by the CodeMirror highlighter). */
export const MNEMONIC_SET: ReadonlySet<string> = new Set([...Object.keys(OPS), ...PSEUDOS]);

// ─────────────────────────── encoders ───────────────────────────
// Field layouts per spec Fig. 2.2 (R/I/S) and the B/U/J immediates of the
// jal/branch sections — see the worked examples in the file header.

function encR(i: OpInfo, rd: number, rs1: number, rs2: number): number {
  return (
    ((i.f7 & 0x7f) << 25) | ((rs2 & 31) << 20) | ((rs1 & 31) << 15) |
    (i.f3 << 12) | ((rd & 31) << 7) | i.op
  );
}
// I-type: imm[31:20] rs1 f3 rd op — e.g. addi x1,x2,4 → 0x00410093 (header ✓)
function encI(i: OpInfo, rd: number, rs1: number, imm: number): number {
  return ((imm & 0xfff) << 20) | ((rs1 & 31) << 15) | (i.f3 << 12) | ((rd & 31) << 7) | i.op;
}
// S-type: imm[11:5] rs2 rs1 f3 imm[4:0] op — e.g. sw x1,8(x2) → 0x00112423 (header ✓)
function encS(i: OpInfo, rs1: number, rs2: number, imm: number): number {
  const u = imm & 0xfff;
  return (
    ((u >> 5) << 25) | ((rs2 & 31) << 20) | ((rs1 & 31) << 15) | (i.f3 << 12) |
    ((u & 31) << 7) | i.op
  );
}
// B-type: imm[12|10:5] rs2 rs1 f3 imm[4:1|11] op — e.g. beq x1,x2,+16 → 0x00208863 (header ✓)
function encB(i: OpInfo, rs1: number, rs2: number, off: number): number {
  const u = off & 0x1fff;
  return (
    (((u >> 12) & 1) << 31) | (((u >> 5) & 0x3f) << 25) | ((rs2 & 31) << 20) |
    ((rs1 & 31) << 15) | (i.f3 << 12) | (((u >> 1) & 0xf) << 8) | (((u >> 11) & 1) << 7) | i.op
  );
}
function encU(i: OpInfo, rd: number, imm20: number): number {
  return ((imm20 & 0xfffff) << 12) | ((rd & 31) << 7) | i.op;
}
// J-type: imm[20|10:1|11|19:12] rd op — e.g. jal x1,+16 → 0x010000EF (header ✓)
function encJ(rd: number, off: number): number {
  const u = off & 0x1fffff;
  return (
    (((u >> 20) & 1) << 31) | (((u >> 1) & 0x3ff) << 21) | (((u >> 11) & 1) << 20) |
    (((u >> 12) & 0xff) << 12) | ((rd & 31) << 7) | 0x6f
  );
}

/** The 32-bit word as 4 little-endian bytes — RV32 memory order. */
function wordBytes(w: number): number[] {
  const u = w >>> 0;
  return [u & 255, (u >>> 8) & 255, (u >>> 16) & 255, (u >>> 24) & 255];
}

// ─────────────────────────── public types ───────────────────────────

/** One assembled instruction, with everything the UI needs. */
export interface Insn {
  addr: number;
  /** 4 bytes, little-endian (as stored in memory). */
  bytes: number[];
  /** Canonical display text, e.g. `addi sp, sp, -16` / `beq a0, zero, done`. */
  text: string;
  /** Labels defined at this exact address. */
  labels: string[];
  /** 1-based line in the block's source text. */
  sourceLine: number;
}

export interface DataChunk {
  addr: number;
  bytes: number[];
  labels: string[];
  sourceLine: number;
}

export interface Assembled {
  insns: Insn[];
  data: DataChunk[];
  textStart: number;
  /** First address past the last instruction. */
  textEnd: number;
  dataStart: number;
  dataEnd: number;
  hasData: boolean;
  entry: number;
  symbols: Map<string, number>;
  /** addr → instruction, for fetch / current-row highlighting. */
  insnAt: Map<number, Insn>;
}

export type AsmResult =
  | { ok: true; program: Assembled }
  | { ok: false; error: AsmError };

// ─────────────────────────── lexing ───────────────────────────

interface Env {
  symbols: Map<string, number>;
  equs: Map<string, number>;
}

type Body =
  | { t: "insn"; mne: string; ops: string[] }
  | { t: "data"; name: string; args: string[] }
  | { t: "section"; name: "text" | "data" };

interface Stmt {
  line: number;
  labels: string[];
  body: Body | null;
  section: "text" | "data";
}

const IDENT = "[A-Za-z_.$][A-Za-z0-9_.$]*";
const IDENT_RE = new RegExp(`^${IDENT}$`);

/** Remove a `#` comment, respecting double-quoted strings. */
function stripComment(s: string): string {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "#") return s.slice(0, i);
  }
  return s;
}

/** Split on commas that are outside "…" or '…'. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      cur += c;
      if (c === "\\") {
        if (i + 1 < s.length) cur += s[++i];
      } else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const CHAR_ESCAPES: Readonly<Record<string, number | undefined>> = {
  n: 10, t: 9, r: 13, "0": 0, "\\": 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11,
};

function parseReg(tok: string): number {
  const t = tok.trim().toLowerCase();
  const v = t === "" ? undefined : REGISTERS[t];
  if (v === undefined) {
    fail(`unknown register '${tok.trim()}' (x0–x31, or ABI names: zero ra sp gp tp t0–t6 s0–s11 fp a0–a7)`);
  }
  return v;
}

/**
 * Evaluate an immediate expression: decimal/hex/binary/char literal, equ
 * constant, or (when allowLabel) a label's address.
 */
function evalExpr(tok: string, env: Env, allowLabel = false): number {
  const t = tok.trim();
  if (t === "") fail(`expected an immediate, got nothing`);
  let m = /^([+-]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)$/.exec(t);
  if (m) {
    const low = m[2]!.toLowerCase();
    let v: number;
    if (low.startsWith("0x")) v = parseInt(low.slice(2), 16);
    else if (low.startsWith("0b")) v = parseInt(low.slice(2), 2);
    else v = parseInt(m[2]!, 10);
    if (Number.isNaN(v)) fail(`bad number '${t}'`);
    return m[1] === "-" ? -v : v;
  }
  m = /^'(\\.|[^'\\])'$/.exec(t);
  if (m) {
    const c = m[1]!;
    if (c.length === 2) {
      const v = CHAR_ESCAPES[c[1]!];
      if (v === undefined) fail(`unknown character escape '\\${c[1]}'`);
      return v;
    }
    return c.charCodeAt(0);
  }
  if (IDENT_RE.test(t)) {
    const equ = env.equs.get(t);
    if (equ !== undefined) return equ;
    const sym = env.symbols.get(t);
    if (sym !== undefined) {
      if (allowLabel) return sym;
      fail(`'${t}' is a label — load addresses with la (li takes constants only)`);
    }
    fail(`undefined symbol '${t}'`);
  }
  fail(`bad immediate '${t}'`);
}

function imm12(v: number, what: string): number {
  if (!Number.isInteger(v) || v < -2048 || v > 2047) {
    fail(`${what} immediate ${v} does not fit in 12 signed bits (-2048…2047) — load larger values with li/la into a register first`);
  }
  return v;
}

function parseShamt(v: number): number {
  if (!Number.isInteger(v) || v < 0 || v > 31) fail(`shift amount ${v} must be 0…31`);
  return v;
}

function parseMem(tok: string, env: Env): { off: number; reg: number } {
  const t = tok.trim();
  const m = /^(.*?)\s*\(\s*([^()\s]+)\s*\)$/.exec(t);
  if (m) {
    const offTok = m[1]!.trim();
    return {
      off: offTok === "" ? 0 : imm12(evalExpr(offTok, env), "offset"),
      reg: parseReg(m[2]!),
    };
  }
  return { off: 0, reg: parseReg(t) }; // `lw a0, (sp)` / `lw a0, sp`
}

/** Resolve a branch/jump label to a byte offset from pc, with range checks. */
function branchOffset(tok: string, env: Env, pc: number, kind: "branch" | "jump"): number {
  const t = tok.trim();
  if (!IDENT_RE.test(t)) fail(`${kind} target must be a label, got '${t}'`);
  const target = env.symbols.get(t);
  if (target === undefined) fail(`undefined label '${t}'`);
  const off = target - pc;
  if (kind === "branch" && (off < -4096 || off > 4094)) {
    fail(`branch to '${t}' is ${off} bytes away; branches reach ±4 KiB`);
  }
  if (kind === "jump" && (off < -(1 << 20) || off > (1 << 20) - 2)) {
    fail(`jump to '${t}' is ${off} bytes away; jal reaches ±1 MiB`);
  }
  if ((off & 1) !== 0) fail(`${kind} target '${t}' is not 2-byte aligned`);
  return off;
}

/** Decode a double-quoted C string (with escapes) into bytes; no NUL. */
function unescapeString(tok: string): number[] {
  const t = tok.trim();
  const m = /^"((?:\\.|[^"\\])*)"$/.exec(t);
  if (!m) fail(`expected a double-quoted string, got ${t === "" ? "nothing" : `'${t}'`}`);
  const body = m[1]!;
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\") {
      const esc: string | undefined = body[i + 1];
      if (esc === undefined) fail(`dangling escape at end of string`);
      i++;
      if (esc === "x") {
        const h = body.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) fail(`bad \\x escape in string`);
        bytes.push(parseInt(h, 16));
        i += 2;
        continue;
      }
      const v = CHAR_ESCAPES[esc];
      if (v === undefined) fail(`unknown string escape '\\${esc}'`);
      bytes.push(v);
      continue;
    }
    const cp = body.codePointAt(i)!;
    if (cp > 127) {
      // encode as UTF-8 so .asciz "héllo" behaves like GNU as
      if (cp > 0xffff) i++;
      const tmp = new Uint8Array(4);
      const n = new TextEncoder().encodeInto(String.fromCodePoint(cp), tmp).written;
      for (let k = 0; k < n; k++) bytes.push(tmp[k]!);
    } else bytes.push(cp);
  }
  return bytes;
}

// ─────────────────────────── pass 1: parse (line-mapped) ───────────────────────────

interface Parsed {
  stmts: Stmt[];
  equs: Map<string, number>;
}

function defineEqu(nameTok: string, valTok: string, equs: Map<string, number>): void {
  const name = nameTok.trim();
  if (!IDENT_RE.test(name)) fail(`bad equ name '${name}'`);
  if (equs.has(name)) fail(`constant '${name}' defined twice`);
  equs.set(name, evalExpr(valTok, { symbols: new Map(), equs })); // literals only
}

function parseProgram(src: string): Parsed {
  const stmts: Stmt[] = [];
  const equs = new Map<string, number>();
  let section: "text" | "data" = "text";
  const lines = src.split(/\r?\n/);

  for (let ln = 1; ln <= lines.length; ln++) {
    const rawLine = lines[ln - 1]!;
    try {
      let text = stripComment(rawLine).trim();
      if (text === "") continue;

      // peel off leading `label:` definitions (possibly several)
      const labels: string[] = [];
      for (;;) {
        const m = new RegExp(`^(${IDENT})\\s*:`).exec(text);
        if (!m) break;
        labels.push(m[1]!);
        text = text.slice(m[0].length).trim();
      }

      if (text === "") {
        stmts.push({ line: ln, labels, body: null, section });
        continue;
      }

      // bare `NAME = value` equ form (never matches mnemonics — no '=' in them)
      const eq = new RegExp(`^(${IDENT})\\s*=\\s*(.+)$`).exec(text);
      if (eq && !OPS[eq[1]!.toLowerCase()] && !PSEUDOS.includes(eq[1]!.toLowerCase())) {
        defineEqu(eq[1]!, eq[2]!, equs);
        if (labels.length) stmts.push({ line: ln, labels, body: null, section });
        continue;
      }

      if (text.startsWith(".")) {
        const m = /^\.([A-Za-z][A-Za-z0-9]*)\s*(.*)$/.exec(text);
        if (m === null) fail(`cannot parse directive '${text}'`);
        const name = m[1]!.toLowerCase();
        const rest = m[2]!.trim();
        if (name === "text" || name === "data") {
          if (rest !== "") fail(`.${name} takes no arguments (got '${rest}')`);
          stmts.push({ line: ln, labels, body: { t: "section", name }, section });
          section = name;
          continue;
        }
        if (name === "equ" || name === "eqv") {
          const args = splitArgs(rest);
          if (args.length !== 2) fail(`.${name} expects: .${name} NAME, value`);
          defineEqu(args[0]!, args[1]!, equs);
          if (labels.length) stmts.push({ line: ln, labels, body: null, section });
          continue;
        }
        if (name === "word" || name === "byte" || name === "asciz" || name === "string") {
          stmts.push({
            line: ln,
            labels,
            body: { t: "data", name, args: rest === "" ? [] : splitArgs(rest) },
            section,
          });
          continue;
        }
        fail(`unknown directive '.${name}' (supported: .text .data .word .byte .asciz .string .equ)`);
      }

      // instruction
      const m = /^(\S+)\s*(.*)$/.exec(text)!;
      const mne = m[1]!.toLowerCase();
      const rest = m[2]!.trim();
      if (!OPS[mne] && !PSEUDOS.includes(mne)) {
        fail(`unknown mnemonic '${m[1]}' — the supported set is RV32I + M plus common pseudos (see the README)`);
      }
      const ops = rest === "" ? [] : splitArgs(rest).map((o) => o.trim()).filter((o) => o !== "");
      stmts.push({ line: ln, labels, body: { t: "insn", mne, ops }, section });
    } catch (e) {
      if (e instanceof Fail) throw new Fail(e.msg, e.line ?? ln);
      throw e;
    }
  }
  return { stmts, equs };
}

// ─────────────────────────── sizing / layout ───────────────────────────

/** Byte size of a data directive's payload (symbol-independent). */
function dataSize(body: { t: "data"; name: string; args: string[] }): number {
  if (body.args.length === 0) fail(`.${body.name} needs at least one value`);
  if (body.name === "word") return 4 * body.args.length;
  if (body.name === "byte") return body.args.length;
  return body.args.reduce((n, a) => n + unescapeString(a).length + 1, 0); // asciz/string
}

/** How many real instructions this statement expands to (env may be partial). */
function expansionSize(body: { t: "insn"; mne: string; ops: string[] }, env: Env): number {
  if (body.mne !== "li" && body.mne !== "la") return 1;
  try {
    if (body.ops.length !== 2) return 2;
    parseReg(body.ops[0]!);
    return liLen(evalExpr(body.ops[1]!, env, true));
  } catch {
    return 2; // the real error is reported in pass 2
  }
}

/** Instructions `li rd, v` expands to: addi, or lui[+addi]. */
function liLen(v: number): number {
  if ((v | 0) >= -2048 && (v | 0) <= 2047) return 1;
  return s32Lo12(v) === 0 ? 1 : 2;
}

/** Signed low 12 bits of the 32-bit value v (the addi-able remainder). */
function s32Lo12(v: number): number {
  const lo = (v >>> 0) & 0xfff;
  return lo >= 0x800 ? lo - 0x1000 : lo;
}

interface Layout {
  symbols: Map<string, number>;
  textTotal: number;
  dataStart: number;
  dataEnd: number;
}

function assign(stmts: Stmt[], sizes: number[], equs: Map<string, number>): Layout {
  let textTotal = 0;
  stmts.forEach((s, i) => {
    if (s.body?.t === "insn" && s.section === "text") textTotal += sizes[i]! * 4;
  });
  const dataStart = (TEXT_BASE + textTotal + 15) & ~15;
  const symbols = new Map<string, number>();
  let tAddr = TEXT_BASE;
  let dAddr = dataStart;
  let dEnd = dataStart;
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i]!;
    const here = s.section === "text" ? tAddr : dAddr;
    for (const lbl of s.labels) {
      if (symbols.has(lbl)) throw new Fail(`label '${lbl}' defined twice`, s.line);
      if (equs.has(lbl)) throw new Fail(`label '${lbl}' collides with an equ constant of the same name`, s.line);
      symbols.set(lbl, here);
    }
    const b = s.body;
    if (b?.t === "insn") {
      if (s.section === "text") tAddr += sizes[i]! * 4;
    } else if (b?.t === "data" && s.section === "data") {
      try {
        dAddr += dataSize(b);
        dEnd = dAddr;
      } catch (e) {
        if (e instanceof Fail) throw new Fail(e.msg, s.line);
        throw e;
      }
    }
  }
  return { symbols, textTotal, dataStart, dataEnd: dEnd };
}

// ─────────────────────────── pass 2: encode ───────────────────────────

interface Part {
  word: number;
  text: string;
}

function labelDisplay(target: number, labelAt: Map<number, string>): string {
  return labelAt.get(target) ?? hex32(target);
}

/** The (1 or 2) real instructions that materialize a constant/address in rd. */
function liParts(rd: number, v: number): Part[] {
  const name = REG_ABI[rd]!;
  if ((v | 0) >= -2048 && (v | 0) <= 2047) {
    return [{ word: encI(OPS.addi!, rd, 0, v), text: `addi ${name}, zero, ${v}` }];
  }
  const vu = v >>> 0;
  const hi = (vu + 0x800) >>> 12; // round up when the low half is "negative"
  const lo = s32Lo12(vu);
  const out: Part[] = [{ word: encU(OPS.lui!, rd, hi), text: `lui ${name}, 0x${hi.toString(16)}` }];
  if (lo !== 0) {
    out.push({ word: encI(OPS.addi!, rd, rd, lo), text: `addi ${name}, ${name}, ${lo}` });
  }
  return out;
}

function encodeStmt(
  body: { t: "insn"; mne: string; ops: string[] },
  pc: number,
  env: Env,
  labelAt: Map<number, string>,
): Part[] {
  const ops = body.ops;
  const need = (n: number) => {
    if (ops.length !== n) fail(`'${body.mne}' expects ${n} operand${n === 1 ? "" : "s"}, got ${ops.length}`);
  };
  const mne = body.mne;

  // ── pseudoinstructions ──
  switch (mne) {
    case "li": {
      need(2);
      const rd = parseReg(ops[0]!);
      let v = evalExpr(ops[1]!, env);
      if (v > 0xffffffff || v < -0x80000000) fail(`li value ${v} does not fit in 32 bits`);
      return liParts(rd, v | 0);
    }
    case "la": {
      need(2);
      return liParts(parseReg(ops[0]!), evalExpr(ops[1]!, env, true) | 0);
    }
    case "mv": {
      need(2);
      const rd = parseReg(ops[0]!), rs = parseReg(ops[1]!);
      return [{ word: encI(OPS.addi!, rd, rs, 0), text: `addi ${REG_ABI[rd]!}, ${REG_ABI[rs]!}, 0` }];
    }
    case "nop":
      need(0);
      return [{ word: 0x00000013, text: "addi zero, zero, 0" }]; // canonical nop
    case "j": {
      need(1);
      const off = branchOffset(ops[0]!, env, pc, "jump");
      return [{ word: encJ(0, off), text: `jal zero, ${labelDisplay(pc + off, labelAt)}` }];
    }
    case "jal": {
      let rd: number;
      let target: string;
      if (ops.length === 1) {
        rd = 1; // `jal label` ⇒ `jal ra, label`
        target = ops[0]!;
      } else {
        need(2);
        rd = parseReg(ops[0]!);
        target = ops[1]!;
      }
      const off = branchOffset(target, env, pc, "jump");
      return [{ word: encJ(rd, off), text: `jal ${REG_ABI[rd]!}, ${labelDisplay(pc + off, labelAt)}` }];
    }
    case "jr": {
      need(1);
      const rs = parseReg(ops[0]!);
      return [{ word: encI(OPS.jalr!, 0, rs, 0), text: `jalr zero, 0(${REG_ABI[rs]!})` }];
    }
    case "ret":
      need(0);
      return [{ word: 0x00008067, text: "jalr zero, 0(ra)" }]; // canonical ret
    case "beqz":
    case "bnez": {
      need(2);
      const rs = parseReg(ops[0]!);
      const off = branchOffset(ops[1]!, env, pc, "branch");
      const real = mne === "beqz" ? OPS.beq! : OPS.bne!;
      const realName = mne === "beqz" ? "beq" : "bne";
      return [{ word: encB(real, rs, 0, off), text: `${realName} ${REG_ABI[rs]!}, zero, ${labelDisplay(pc + off, labelAt)}` }];
    }
    case "neg": {
      need(2);
      const rd = parseReg(ops[0]!), rs = parseReg(ops[1]!);
      return [{ word: encR(OPS.sub!, rd, 0, rs), text: `sub ${REG_ABI[rd]!}, zero, ${REG_ABI[rs]!}` }];
    }
    case "not": {
      need(2);
      const rd = parseReg(ops[0]!), rs = parseReg(ops[1]!);
      return [{ word: encI(OPS.xori!, rd, rs, -1), text: `xori ${REG_ABI[rd]!}, ${REG_ABI[rs]!}, -1` }];
    }
  }

  const info = OPS[mne];
  if (info === undefined) fail(`unknown mnemonic '${mne}'`);

  switch (info.fmt) {
    case "R": {
      need(3);
      const rd = parseReg(ops[0]!), rs1 = parseReg(ops[1]!), rs2 = parseReg(ops[2]!);
      return [{ word: encR(info, rd, rs1, rs2), text: `${mne} ${REG_ABI[rd]!}, ${REG_ABI[rs1]!}, ${REG_ABI[rs2]!}` }];
    }
    case "I": {
      need(3);
      const rd = parseReg(ops[0]!), rs1 = parseReg(ops[1]!);
      const imm = imm12(evalExpr(ops[2]!, env), mne);
      return [{ word: encI(info, rd, rs1, imm), text: `${mne} ${REG_ABI[rd]!}, ${REG_ABI[rs1]!}, ${imm}` }];
    }
    case "SH": {
      need(3);
      const rd = parseReg(ops[0]!), rs1 = parseReg(ops[1]!);
      const sh = parseShamt(evalExpr(ops[2]!, env));
      // funct7 rides in imm[31:25], shamt in imm[11:5] — spec §2.4 shifts
      return [{ word: encI(info, rd, rs1, (info.f7 << 5) | sh), text: `${mne} ${REG_ABI[rd]!}, ${REG_ABI[rs1]!}, ${sh}` }];
    }
    case "L": {
      need(2);
      const rd = parseReg(ops[0]!);
      const mem = parseMem(ops[1]!, env);
      return [{ word: encI(info, rd, mem.reg, mem.off), text: `${mne} ${REG_ABI[rd]!}, ${mem.off}(${REG_ABI[mem.reg]!})` }];
    }
    case "S": {
      need(2);
      const rs2 = parseReg(ops[0]!);
      const mem = parseMem(ops[1]!, env);
      return [{ word: encS(info, mem.reg, rs2, mem.off), text: `${mne} ${REG_ABI[rs2]!}, ${mem.off}(${REG_ABI[mem.reg]!})` }];
    }
    case "B": {
      need(3);
      const rs1 = parseReg(ops[0]!), rs2 = parseReg(ops[1]!);
      const off = branchOffset(ops[2]!, env, pc, "branch");
      return [{ word: encB(info, rs1, rs2, off), text: `${mne} ${REG_ABI[rs1]!}, ${REG_ABI[rs2]!}, ${labelDisplay(pc + off, labelAt)}` }];
    }
    case "U": {
      need(2);
      const rd = parseReg(ops[0]!);
      const v = evalExpr(ops[1]!, env);
      if (v > 0xfffff || v < -0x80000) fail(`${mne} immediate ${v} does not fit in the top 20 bits (0…0xFFFFF)`);
      return [{ word: encU(info, rd, v & 0xfffff), text: `${mne} ${REG_ABI[rd]!}, 0x${(v & 0xfffff).toString(16)}` }];
    }
    case "JALR": {
      let rd: number, rs1: number, imm: number;
      if (ops.length === 1) {
        rd = 1; // `jalr rs` ⇒ `jalr ra, rs, 0`
        const mem = parseMem(ops[0]!, env);
        rs1 = mem.reg;
        imm = mem.off;
      } else if (ops.length === 2) {
        rd = parseReg(ops[0]!);
        const mem = parseMem(ops[1]!, env);
        rs1 = mem.reg;
        imm = mem.off;
      } else if (ops.length === 3) {
        rd = parseReg(ops[0]!);
        rs1 = parseReg(ops[1]!);
        imm = imm12(evalExpr(ops[2]!, env), "jalr");
      } else {
        fail(`'jalr' expects 1–3 operands, got ${ops.length}`);
      }
      return [{ word: encI(info, rd, rs1, imm), text: `jalr ${REG_ABI[rd]!}, ${imm}(${REG_ABI[rs1]!})` }];
    }
    case "SYS": {
      // fixed system encodings (verified constants, see file header)
      if (mne === "ecall") {
        need(0);
        return [{ word: 0x00000073, text: "ecall" }];
      }
      if (mne === "ebreak") {
        need(0);
        return [{ word: 0x00100073, text: "ebreak" }];
      }
      // fence: always `fence iorw, iorw` = 0x0FF0000F, executed as a nop
      return [{ word: 0x0ff0000f, text: "fence" }];
    }
  }
  fail(`internal error: unhandled format '${info.fmt}' for '${mne}'`);
}

function encodeData(body: { t: "data"; name: string; args: string[] }, env: Env): number[] {
  const bytes: number[] = [];
  for (const arg of body.args) {
    if (body.name === "word") {
      const v = evalExpr(arg, env, true);
      if (v > 0xffffffff || v < -0x80000000) fail(`.word value ${v} does not fit in 32 bits`);
      const u = v >>> 0;
      bytes.push(u & 255, (u >>> 8) & 255, (u >>> 16) & 255, (u >>> 24) & 255);
    } else if (body.name === "byte") {
      const v = evalExpr(arg, env, true);
      if (v > 255 || v < -128) fail(`.byte value ${v} does not fit in a byte (-128…255)`);
      bytes.push(v & 255);
    } else {
      bytes.push(...unescapeString(arg), 0); // .asciz / .string both NUL-terminate
    }
  }
  return bytes;
}

// ─────────────────────────── top level ───────────────────────────

export function assemble(src: string): AsmResult {
  let parsed: Parsed;
  try {
    parsed = parseProgram(src);
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: { line: e.line ?? 1, message: e.msg } };
    throw e;
  }
  const { stmts, equs } = parsed;
  if (!stmts.some((s) => s.body?.t === "insn")) {
    return { ok: false, error: { line: 1, message: "no instructions found — add some code under .text" } };
  }

  // Sizing fixpoint: li/la expansion length depends on resolved values, and
  // data addresses depend on total text size — iterate to a fixed point
  // (converges within a couple of rounds; bounded as a guard).
  let sizes: number[] = stmts.map((s) => (s.body?.t === "insn" ? 2 : 0));
  let layout: Layout;
  try {
    layout = assign(stmts, sizes, equs);
    for (let iter = 0; iter < 8; iter++) {
      const env: Env = { symbols: layout.symbols, equs };
      let changed = false;
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i]!;
        if (s.body?.t !== "insn") continue;
        const n = expansionSize(s.body, env);
        if (n !== sizes[i]) {
          sizes[i] = n;
          changed = true;
        }
      }
      layout = assign(stmts, sizes, equs);
      if (!changed) break;
    }
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: { line: e.line ?? 1, message: e.msg } };
    throw e;
  }

  // Final pass: emit bytes with fully resolved symbols, mapping every
  // failure to its statement's line.
  try {
    const env: Env = { symbols: layout.symbols, equs };
    const labelAt = new Map<number, string>();
    for (const [name, addr] of layout.symbols) {
      if (!labelAt.has(addr)) labelAt.set(addr, name);
    }

    const insns: Insn[] = [];
    const data: DataChunk[] = [];
    let tAddr = TEXT_BASE;
    let dAddr = layout.dataStart;

    for (const s of stmts) {
      const b = s.body;
      if (b === null || b.t === "section") continue;
      try {
        if (b.t === "insn") {
          if (s.section !== "text") fail(`instruction '${b.mne}' is in .data — code belongs in .text`);
          const parts = encodeStmt(b, tAddr, env, labelAt);
          parts.forEach((p, k) => {
            insns.push({
              addr: tAddr,
              bytes: wordBytes(p.word),
              text: p.text,
              labels: k === 0 ? s.labels : [],
              sourceLine: s.line,
            });
            tAddr += 4;
          });
        } else {
          if (s.section !== "data") fail(`data directive '.${b.name}' is in .text — data belongs in .data`);
          const bytes = encodeData(b, env);
          if (bytes.length > 0) data.push({ addr: dAddr, bytes, labels: s.labels, sourceLine: s.line });
          dAddr += bytes.length;
        }
      } catch (e) {
        if (e instanceof Fail) throw new Fail(e.msg, e.line ?? s.line);
        throw e;
      }
    }

    const insnAt = new Map<number, Insn>();
    for (const ins of insns) insnAt.set(ins.addr, ins);

    return {
      ok: true,
      program: {
        insns,
        data,
        textStart: TEXT_BASE,
        textEnd: TEXT_BASE + layout.textTotal,
        dataStart: layout.dataStart,
        dataEnd: layout.dataEnd,
        hasData: data.length > 0,
        entry: insns[0]!.addr,
        symbols: layout.symbols,
        insnAt,
      },
    };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: { line: e.line ?? 1, message: e.msg } };
    throw e;
  }
}
