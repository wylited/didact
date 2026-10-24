// asm.ts — minimal kernel-neutral Intel-syntax assembly highlighter for the
// block editor. Kernels never ship CodeMirror extensions, so core provides
// this default language: it emits standard highlight tags (comment, string,
// number, keyword, …) that thememirror's ayuLight HighlightStyle colors.

import { StreamLanguage } from '@codemirror/language';
import type { StringStream } from '@codemirror/language';

interface AsmState {
  /** True while the next word starts a statement (mnemonic/label/directive). */
  atStatementStart: boolean;
}

const REGISTERS: Record<string, true> = {
  // 64-bit + 32/16/8-bit low names
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

/** Operand-size qualifiers like `qword ptr [rax]`. */
const SIZE_QUALIFIERS: Record<string, true> = {
  ptr: true, byte: true, word: true, dword: true, qword: true, oword: true, abs: true, rel: true,
};

/**
 * Stream language for Intel-syntax assembly (`;` comments, `0x` hex numbers,
 * `"…"`/`'…'` strings, `.`-directives, `label:` definitions, mnemonics and
 * registers). Tag names are the ones ayuLight styles: keyword/directive
 * `#fa8d3e`, number `#ffaa33`, string `#86b300`, comment `#787b8099`,
 * register/label `#55b4d4`.
 */
export const intelAsm = StreamLanguage.define<AsmState>({
  name: 'intel-asm',
  startState: () => ({ atStatementStart: true }),
  token(stream: StringStream, state: AsmState): string | null {
    if (stream.sol()) state.atStatementStart = true;
    if (stream.eatSpace()) return null;

    if (stream.match(/;[^\n]*/)) return 'comment';
    if (stream.match(/^"([^"\\\n]|\\.)*"?/)) return 'string';
    if (stream.match(/^'([^'\\\n]|\\.)*'?/)) return 'string';
    if (stream.match(/^(0[xX][0-9a-fA-F]+|[0-9][0-9a-fA-F]*[hH]|\d+)/)) return 'number';

    if (stream.match(/^[._A-Za-z][._A-Za-z0-9]*/)) {
      const word = stream.current();
      if (stream.match(/^\s*:/, false)) {
        // `label:` definition (colon styled below)
        state.atStatementStart = false;
        return 'labelName';
      }
      if (word.startsWith('.')) return 'keyword'; // .text, .data, .asciz, …
      const lower = word.toLowerCase();
      if (lower in SIZE_QUALIFIERS) return 'modifier';
      if (lower in REGISTERS) return 'typeName';
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
  languageData: { commentTokens: { line: ';' } },
});
