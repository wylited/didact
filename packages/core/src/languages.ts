// languages.ts — maps a kernel's declared `editorSyntax` to a CodeMirror
// language extension for the block editor. Assembly dialects live in
// asm.ts, the syntaxes legacy-modes does not cover (sql, regex, WAT, Typst,
// Prolog) in modes.ts; c/lua/octave/python/scheme come from
// @codemirror/legacy-modes; javascript/cpp from their Lezer grammars.
// 'plain' (and any unknown id) gets no language extension — plain text,
// still Ayu Light. Every id of `Kernel['editorSyntax']` resolves here
// except 'plain'; languages.test.ts pins that.
//
// Legacy stream modes are preferred over Lezer grammars for c/lua/octave/
// python only because they already ship in @codemirror/legacy-modes —
// adding @codemirror/lang-c, lang-lua, lang-sql or lang-wast would mean a
// new dependency for incremental highlighting a lesson block does not need.

import { cpp } from '@codemirror/lang-cpp';
import { javascript } from '@codemirror/lang-javascript';
import { StreamLanguage } from '@codemirror/language';
import { c } from '@codemirror/legacy-modes/mode/clike';
import { fortran } from '@codemirror/legacy-modes/mode/fortran';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { octave } from '@codemirror/legacy-modes/mode/octave';
import { python } from '@codemirror/legacy-modes/mode/python';
import { scheme } from '@codemirror/legacy-modes/mode/scheme';
import type { Extension } from '@codemirror/state';
import { intelAsm, mipsAsm, riscvAsm } from './asm';
import type { Kernel } from './kernel';
import { prologMode, regexpMode, sqlMode, typstMode, watMode } from './modes';

const LANGUAGES: Record<NonNullable<Kernel['editorSyntax']>, Extension | null> = {
  'asm-intel': intelAsm,
  'asm-riscv': riscvAsm,
  'asm-mips': mipsAsm,
  c: StreamLanguage.define(c),
  cpp: cpp(),
  fortran: StreamLanguage.define(fortran),
  javascript: javascript(),
  lua: StreamLanguage.define(lua),
  octave: StreamLanguage.define(octave),
  python: StreamLanguage.define(python),
  prolog: prologMode,
  regexp: regexpMode,
  scheme: StreamLanguage.define(scheme),
  sql: sqlMode,
  typst: typstMode,
  wat: watMode,
  plain: null,
};

/** Editor language extension for a kernel's syntax declaration. */
export function editorLanguage(
  syntax: Kernel['editorSyntax'],
): Extension | null {
  if (syntax === undefined) return null;
  return LANGUAGES[syntax] ?? null;
}
