// asm.ts — assembly editor highlighters for the block editor, one per
// assembly-flavored kernel syntax. Kernels never ship CodeMirror
// extensions: they declare `editorSyntax`, core maps it to a language.
// All variants emit standard highlight tags (comment, string, number,
// keyword, …) that thememirror's ayuLight HighlightStyle colors.

import { StreamLanguage } from '@codemirror/language';
import type { StringStream } from '@codemirror/language';

interface AsmState {
  /** True while the next word starts a statement (mnemonic/label/directive). */
  atStatementStart: boolean;
}

/** x86-64 Intel names (64/32/16/8-bit). */
const INTEL_REGISTERS: Record<string, true> = {
  rax: true, rbx: true, rcx: true, rdx: true, rsi: true, rdi: true, rbp: true, rsp: true, rip: true,
  eax: true, ebx: true, ecx: true, edx: true, esi: true, edi: true, ebp: true, esp: true, eip: true,
  ax: true, bx: true, cx: true, dx: true, si: true, di: true, bp: true, sp: true, ip: true,
  al: true, bl: true, cl: true, dl: true, ah: true, bh: true, ch: true, dh: true,
  sil: true, dil: true, spl: true, bpl: true,
  r8: true, r9: true, r10: true, r11: true, r12: true, r13: true, r14: true, r15: true,
  r8d: true, r9d: true, r10d: true, r11d: true, r12d: true, r13d: true, r14d: true, r15d: true,
  r8w: true, r9w: true, r10w: true, r11w: true, r12w: true, r13w: true, r14w: true, r15w: true,
  r8b: true, r9b: true, r10b: true, r11b: true, r12b: true, r13b: true, r14b: true, r15b: true,
  eflags: true, rflags: true,
};

/** RV32I ABI names + x0..x31 numeric names. */
const RISCV_REGISTERS: Record<string, true> = {
  zero: true, ra: true, sp: true, gp: true, tp: true,
  t0: true, t1: true, t2: true, t3: true, t4: true, t5: true, t6: true,
  s0: true, s1: true, s2: true, s3: true, s4: true, s5: true, s6: true, s7: true,
  s8: true, s9: true, s10: true, s11: true,
  a0: true, a1: true, a2: true, a3: true, a4: true, a5: true, a6: true, a7: true,
  ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`x${i}`, true as const])),
};

/** MIPS `$`-names: ABI + numeric ($0..$31). Keys include the `$`. */
const MIPS_REGISTERS: Record<string, true> = {
  $zero: true, $at: true, $v0: true, $v1: true,
  $a0: true, $a1: true, $a2: true, $a3: true,
  $t0: true, $t1: true, $t2: true, $t3: true, $t4: true, $t5: true, $t6: true, $t7: true,
  $s0: true, $s1: true, $s2: true, $s3: true, $s4: true, $s5: true, $s6: true, $s7: true,
  $t8: true, $t9: true, $k0: true, $k1: true, $gp: true, $sp: true, $fp: true, $ra: true,
  ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`$${i}`, true as const])),
};

/** Operand-size qualifiers like `qword ptr [rax]` (Intel only). */
const INTEL_QUALIFIERS: Record<string, true> = {
  ptr: true, byte: true, word: true, dword: true, qword: true, oword: true, abs: true, rel: true,
};

interface AsmDialect {
  name: string;
  lineComment: ';' | '#';
  registers: Record<string, true>;
  sizeQualifiers?: Record<string, true>;
  /** Allow `$` as a word character (MIPS register prefix). */
  dollarWords?: boolean;
}

function defineAsm(dialect: AsmDialect): StreamLanguage<AsmState> {
  return StreamLanguage.define<AsmState>({
    name: dialect.name,
    startState: () => ({ atStatementStart: true }),
    token(stream: StringStream, state: AsmState): string | null {
      if (stream.sol()) state.atStatementStart = true;
      if (stream.eatSpace()) return null;

      if (stream.match(dialect.lineComment === '#' ? /#[^\n]*/ : /;[^\n]*/)) return 'comment';
      if (stream.match(/^"([^"\\\n]|\\.)*"?/)) return 'string';
      if (stream.match(/^'([^'\\\n]|\\.)*'?/)) return 'string';
      if (stream.match(/^(0[xX][0-9a-fA-F]+|[0-9][0-9a-fA-F]*[hH]|\d+)/)) return 'number';

      const wordStart = dialect.dollarWords === true ? /^[$._A-Za-z][$._A-Za-z0-9]*/ : /^[._A-Za-z][._A-Za-z0-9]*/;
      if (stream.match(wordStart)) {
        const word = stream.current();
        if (stream.match(/^\s*:/, false)) {
          // `label:` definition (colon styled below)
          state.atStatementStart = false;
          return 'labelName';
        }
        if (word.startsWith('.') && !word.startsWith('$')) return 'keyword'; // .text, .data, .asciiz, …
        const lower = word.toLowerCase();
        if (dialect.sizeQualifiers !== undefined && lower in dialect.sizeQualifiers) return 'modifier';
        if (lower in dialect.registers) return 'typeName';
        if (state.atStatementStart) {
          state.atStatementStart = false;
          return 'keyword'; // mnemonic: mov, add, syscall, …
        }
        return null; // bare symbol references stay plain
      }

      if (stream.match(/,/)) return 'separator';
      if (stream.eat(':')) return 'punctuation';
      // brackets, +, -, *, and any other single operator char
      stream.next();
      return 'operator';
    },
    languageData: { commentTokens: { line: dialect.lineComment } },
  });
}

/** x86-64 Intel syntax: `;` comments, `mov rax, 60`, `.asciz`. */
export const intelAsm = defineAsm({
  name: 'intel-asm',
  lineComment: ';',
  registers: INTEL_REGISTERS,
  sizeQualifiers: INTEL_QUALIFIERS,
});

/** RISC-V syntax: `#` comments, `addi t0, zero, 10`, `.data`. */
export const riscvAsm = defineAsm({
  name: 'riscv-asm',
  lineComment: '#',
  registers: RISCV_REGISTERS,
});

/** MIPS32 syntax: `#` comments, `$`-registers, `lw $t0, 0($sp)`. */
export const mipsAsm = defineAsm({
  name: 'mips-asm',
  lineComment: '#',
  registers: MIPS_REGISTERS,
  dollarWords: true,
});
