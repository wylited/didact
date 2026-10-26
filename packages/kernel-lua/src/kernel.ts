import type { Kernel } from './types';
import { LuaSession } from './session';

/** The Lua teaching kernel: a pure-TypeScript lexer/parser/evaluator with
 *  statement-level stepping, a heap-style Tables panel, and metatable
 *  __index chains as the inheritance story. */
export const luaKernel: Kernel = {
  id: 'lua',
  label: 'Lua · interpreter',
  editorSyntax: 'lua',
  features: { breakpoints: true, stepping: true },
  createSession: () => new LuaSession(),
};
