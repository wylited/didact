import type { Kernel } from './types';
import { MipsSession } from './session';

/** The MIPS32 teaching kernel: hand-written assembler + fetch/decode/execute
 *  interpreter in pure TypeScript, no vendored engine. */
export const mipsKernel: Kernel = {
  id: 'mips',
  label: 'MIPS32 · interpreter',
  features: { breakpoints: true },
  createSession: () => new MipsSession(),
};
