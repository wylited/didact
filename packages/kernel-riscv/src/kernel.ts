import type { Kernel } from './types';
import { RiscvSession } from './session';

/** The RV32IM kernel: pure-TypeScript assembler + interpreter, no engine
 *  download — the first `load()` is instant. */
export const riscvKernel: Kernel = {
  id: 'riscv',
  label: 'RV32IM · interpreter',
  features: { breakpoints: true },
  createSession: () => new RiscvSession(),
};
