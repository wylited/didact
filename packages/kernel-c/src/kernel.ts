import type { Kernel } from './types';
import { CSession } from './session';
import { setVendorBase } from './vendor';

/** Create a C kernel, optionally configuring where the vendored clang toolchain is served. */
export function createCKernel(opts?: { vendorBase?: string }): Kernel {
  if (opts?.vendorBase !== undefined) setVendorBase(opts.vendorBase);
  return {
    id: 'c',
    label: 'C · clang wasm',
    editorSyntax: 'c',
    features: { breakpoints: false, stepping: false },
    createSession: () => new CSession(),
  };
}

/** The C kernel: real clang (vendored YoWASP LLVM 22 wasm build) compiles the
 * block to a wasm32-wasip1 module in the tab; the module runs on the raw
 * WebAssembly API through a hand-written WASI shim. */
export const cKernel: Kernel = createCKernel();
