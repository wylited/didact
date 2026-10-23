// asm-lang.ts — CodeMirror 6 syntax support for the Intel-syntax teaching
// subset: a StreamLanguage plus a dark HighlightStyle driven by the CSS custom
// properties defined in styles.css.

import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { REG32, REG64 } from "./asm";

const REGISTERS: Record<string, boolean> = {};
for (const r of [...REG64, ...REG32,
  "al", "bl", "cl", "dl", "sil", "dil", "bpl", "spl", "ah", "bh", "ch", "dh",
  "r8b", "r9b", "r10b", "r11b", "r12b", "r13b", "r14b", "r15b",
  "ax", "bx", "cx", "dx", "si", "di", "bp", "sp",
  "r8w", "r9w", "r10w", "r11w", "r12w", "r13w", "r14w", "r15w"]) REGISTERS[r] = true;

const DIRECTIVES: Record<string, boolean> = { db: true, dq: true, equ: true, section: true };

const MNEMONICS: Record<string, boolean> = {
  mov: true, lea: true, add: true, sub: true, imul: true, idiv: true, div: true,
  inc: true, dec: true, neg: true, and: true, or: true, xor: true, not: true,
  shl: true, shr: true, sar: true, cmp: true, test: true, jmp: true,
  je: true, jne: true, jl: true, jle: true, jg: true, jge: true,
  jb: true, jbe: true, ja: true, jae: true, js: true, jns: true,
  jz: true, jnz: true, jc: true, jnc: true,
  call: true, ret: true, push: true, pop: true, syscall: true, nop: true,
};

export const asmLanguage = StreamLanguage.define({
  name: "x86asm",
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.peek() === ";") {
      stream.skipToEnd();
      return "asm-comment";
    }
    if (stream.match(/^\.text\b/i) !== null) return "asm-dir";
    if (stream.match(/^\.data\b/i) !== null) return "asm-dir";
    if (stream.sol() && stream.match(/^[A-Za-z_.$?][A-Za-z0-9_.$?]*\s*:/) !== null) return "asm-label";
    if (stream.match(/^0[xX][0-9a-fA-F]+/) !== null) return "asm-num";
    if (stream.match(/^\d+/) !== null) return "asm-num";
    if (stream.match(/^'(\\.|[^'\\])'/) !== null) return "asm-num";
    if (stream.match(/^"(\\.|[^"\\])*"/) !== null) return "asm-str";
    // regex patterns can never return the `boolean` half of StringStream.match's
    // union — only string patterns do — so this cast just reclaims the real type
    const m = stream.match(/^[A-Za-z_.$?][A-Za-z0-9_.$?]*/) as RegExpMatchArray | null;
    if (m !== null) {
      const w = m[0]!.toLowerCase();
      if (DIRECTIVES[w] === true) return "asm-dir";
      if (MNEMONICS[w] === true) return "asm-mne";
      if (REGISTERS[w] === true) return "asm-reg";
      return "asm-sym";
    }
    stream.next();
    return null;
  },
  tokenTable: {
    "asm-comment": t.comment,
    "asm-dir": t.meta,
    "asm-mne": t.keyword,
    "asm-num": t.number,
    "asm-str": t.string,
    "asm-reg": t.operator,
    "asm-label": t.labelName,
    "asm-sym": t.variableName,
  },
  languageData: { commentTokens: { line: ";" } },
});

export const asmHighlighting: Extension = syntaxHighlighting(HighlightStyle.define([
  { tag: t.comment, color: "var(--cmt)", fontStyle: "italic" },
  { tag: t.keyword, color: "var(--mne)", fontWeight: "600" },
  { tag: t.meta, color: "var(--dir)" },
  { tag: t.number, color: "var(--num)" },
  { tag: t.string, color: "var(--str)" },
  { tag: t.operator, color: "var(--regc)" },
  { tag: t.labelName, color: "var(--lbl)", fontWeight: "600" },
  { tag: t.variableName, color: "var(--fg)" },
]));
