import type { Kernel } from './types';
import { Asm64Session } from './session';

/** The x86-64 kernel backed by vendored Unicorn/Keystone/Capstone WASM. */
export const asm64Kernel: Kernel = {
  id: 'asm',
  label: 'x86-64 · Unicorn',
  createSession: () => new Asm64Session(),
};
