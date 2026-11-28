import type { Kernel } from './types';
import { CppSession } from './session';
import { setVendorBase } from './vendor';

/** Create a C++ kernel, optionally configuring where the vendored clang toolchain is served. */
export function createCppKernel(opts?: { vendorBase?: string }): Kernel {
  if (opts?.vendorBase !== undefined) setVendorBase(opts.vendorBase);
  return {
    id: 'cpp',
    label: 'C++ · clang wasm',
    editorSyntax: 'cpp',
    features: { breakpoints: false, stepping: false },
    createSession: () => new CppSession(),
  };
}

/** The C++ kernel: real clang++ (vendored YoWASP LLVM 22 wasm build, the
 * same engine as the C kernel) compiles the block to a wasm32-wasip1 module
 * in the tab, linked against the vendored libc++; the module runs on the
 * raw WebAssembly API through a hand-written WASI shim. */
export const cppKernel: Kernel = createCppKernel();
