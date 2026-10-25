// languages.ts — maps a kernel's declared `editorSyntax` to a CodeMirror
// language extension for the block editor. Assembly dialects live in
// asm.ts; c/python/scheme come from @codemirror/legacy-modes;
// javascript/cpp from their Lezer grammars. 'plain' (and any unknown id)
// gets no language extension — plain text, still Ayu Light.

import { cpp } from '@codemirror/lang-cpp';
import { javascript } from '@codemirror/lang-javascript';
import { StreamLanguage } from '@codemirror/language';
import { c } from '@codemirror/legacy-modes/mode/clike';
import { python } from '@codemirror/legacy-modes/mode/python';
import { scheme } from '@codemirror/legacy-modes/mode/scheme';
import type { Extension } from '@codemirror/state';
import { intelAsm, mipsAsm, riscvAsm } from './asm';
import type { Kernel } from './kernel';

const LANGUAGES: Record<NonNullable<Kernel['editorSyntax']>, Extension | null> = {
  'asm-intel': intelAsm,
  'asm-riscv': riscvAsm,
  'asm-mips': mipsAsm,
  c: StreamLanguage.define(c),
  cpp: cpp(),
  javascript: javascript(),
  python: StreamLanguage.define(python),
  scheme: StreamLanguage.define(scheme),
  plain: null,
};

/** Editor language extension for a kernel's syntax declaration. */
export function editorLanguage(
  syntax: Kernel['editorSyntax'],
): Extension | null {
  if (syntax === undefined) return null;
  return LANGUAGES[syntax] ?? null;
}
