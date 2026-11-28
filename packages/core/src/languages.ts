// languages.ts — lazily maps a kernel's declared `editorSyntax` to a
// CodeMirror language extension for the block editor. Assembly dialects
// live in asm.ts, the syntaxes legacy-modes does not cover (sql, regex,
// WAT, Typst, Prolog) in modes.ts; c/lua/octave/python/scheme come from
// @codemirror/legacy-modes; javascript/cpp from their Lezer grammars.
// 'plain' (and any unknown id) gets no language extension — plain text,
// still Ayu Light. Every id of `Kernel['editorSyntax']` resolves here
// except 'plain'; languages.test.ts pins that.
//
// No mode package is imported at module load: each loader dynamically
// imports its mode on first use, so the initial browser chunk carries no
// grammar/mode tables. Successful loads are memoized per syntax id, so a
// second call returns the same promise — and therefore the same Extension
// instance — without re-importing.
//
// Legacy stream modes are preferred over Lezer grammars for c/lua/octave/
// python only because they already ship in @codemirror/legacy-modes —
// adding @codemirror/lang-c, lang-lua, lang-sql or lang-wast would mean a
// new dependency for incremental highlighting a lesson block does not need.

import { StreamLanguage } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { Kernel } from './kernel';

type Syntax = NonNullable<Kernel['editorSyntax']>;

type Loader = () => Promise<Extension | null>;

const LOADERS: Partial<Record<Syntax, Loader>> = {
  'asm-intel': async () => (await import('./asm')).intelAsm,
  'asm-riscv': async () => (await import('./asm')).riscvAsm,
  'asm-mips': async () => (await import('./asm')).mipsAsm,
  c: async () => {
    const { c } = await import('@codemirror/legacy-modes/mode/clike');
    return StreamLanguage.define(c);
  },
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  fortran: async () => {
    const { fortran } = await import('@codemirror/legacy-modes/mode/fortran');
    return StreamLanguage.define(fortran);
  },
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  lua: async () => {
    const { lua } = await import('@codemirror/legacy-modes/mode/lua');
    return StreamLanguage.define(lua);
  },
  octave: async () => {
    const { octave } = await import('@codemirror/legacy-modes/mode/octave');
    return StreamLanguage.define(octave);
  },
  python: async () => {
    const { python } = await import('@codemirror/legacy-modes/mode/python');
    return StreamLanguage.define(python);
  },
  prolog: async () => (await import('./modes')).prologMode,
  regexp: async () => (await import('./modes')).regexpMode,
  scheme: async () => {
    const { scheme } = await import('@codemirror/legacy-modes/mode/scheme');
    return StreamLanguage.define(scheme);
  },
  sql: async () => (await import('./modes')).sqlMode,
  typst: async () => (await import('./modes')).typstMode,
  wat: async () => (await import('./modes')).watMode,
};

/** Resolved (or in-flight) loaders, keyed by syntax id. */
const PENDING = new Map<Syntax, Promise<Extension | null>>();

const PLAIN: Promise<Extension | null> = Promise.resolve(null);

/** Editor language extension for a kernel's syntax declaration. Loads the
 *  mode on first use and memoizes it; `undefined`, `'plain'`, and unknown
 *  ids resolve to `null`. */
export function loadEditorLanguage(
  syntax: Kernel['editorSyntax'],
): Promise<Extension | null> {
  if (syntax === undefined || syntax === 'plain') return PLAIN;
  const loader = LOADERS[syntax];
  if (loader === undefined) return PLAIN;
  let pending = PENDING.get(syntax);
  if (pending === undefined) {
    // A rejected import (offline blip, chunk 404) must not poison the syntax
    // for the rest of the session: drop it so the next mount retries.
    pending = loader().catch((error: unknown) => {
      PENDING.delete(syntax);
      throw error;
    });
    PENDING.set(syntax, pending);
  }
  return pending;
}
