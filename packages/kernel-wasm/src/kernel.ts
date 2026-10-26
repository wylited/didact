import type { Kernel } from './types';
import { WasmSession } from './session';

/** The WebAssembly teaching kernel: a pure-TypeScript interpreter for the
 *  i32 core of the wasm spec. WAT-subset source → flat stack-machine
 *  instructions you can single-step, with the operand stack, locals,
 *  globals, call stack and linear memory all on show. */
export const wasmKernel: Kernel = {
  id: 'wasm',
  label: 'WebAssembly · interpreter',
  editorSyntax: 'scheme',
  features: { breakpoints: true, stepping: true },
  createSession: () => new WasmSession(),
};
