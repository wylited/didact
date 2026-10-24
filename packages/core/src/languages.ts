// languages.ts — maps a kernel's declared `editorSyntax` to a CodeMirror
// language extension for the block editor. Assembly dialects live in
// asm.ts; c/python come from @codemirror/legacy-modes. 'plain' (and any
// unknown id) gets no language extension — plain text, still Ayu Light.

import { StreamLanguage } from '@codemirror/language';
import { c } from '@codemirror/legacy-modes/mode/clike';
import { python } from '@codemirror/legacy-modes/mode/python';
import type { Extension } from '@codemirror/state';
import { intelAsm, mipsAsm, riscvAsm } from './asm';
import type { Kernel } from './kernel';

const LANGUAGES: Record<NonNullable<Kernel['editorSyntax']>, Extension | null> = {
  'asm-intel': intelAsm,
  'asm-riscv': riscvAsm,
  'asm-mips': mipsAsm,
  c: StreamLanguage.define(c),
  python: StreamLanguage.define(python),
  plain: null,
};

/** Editor language extension for a kernel's syntax declaration. */
export function editorLanguage(
  syntax: Kernel['editorSyntax'],
): Extension | null {
  if (syntax === undefined) return null;
  return LANGUAGES[syntax] ?? null;
}
