import type { Kernel } from './types';
import { CSession } from './session';

/** The C kernel: real clang (vendored YoWASP LLVM 22 wasm build) compiles the
 * block to a wasm32-wasip1 module in the tab; the module runs on the raw
 * WebAssembly API through a hand-written WASI shim. */
export const cKernel: Kernel = {
  id: 'c',
  label: 'C · clang wasm',
  features: { stepping: false },
  createSession: () => new CSession(),
};
