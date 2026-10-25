import type { Kernel } from './types';
import { CppSession } from './session';

/** The C++ kernel: real clang++ (vendored YoWASP LLVM 22 wasm build, the
 * same engine as the C kernel) compiles the block to a wasm32-wasip1 module
 * in the tab, linked against the vendored libc++; the module runs on the
 * raw WebAssembly API through a hand-written WASI shim. */
export const cppKernel: Kernel = {
  id: 'cpp',
  label: 'C++ · clang wasm',
  editorSyntax: 'cpp',
  features: { stepping: false, breakpoints: false },
  createSession: () => new CppSession(),
};
