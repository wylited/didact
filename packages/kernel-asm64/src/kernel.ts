import type { Kernel } from './types';
import { Asm64Session } from './session';
import { setVendorBase } from './vendor';

/** Create an x86-64 kernel, optionally configuring where the vendored assets are served. */
export function createAsm64Kernel(opts?: { vendorBase?: string }): Kernel {
  if (opts?.vendorBase !== undefined) setVendorBase(opts.vendorBase);
  return {
    id: 'asm',
    label: 'x86-64 · Unicorn',
    editorSyntax: 'asm-intel',
    features: { breakpoints: true, stepping: true },
    createSession: () => new Asm64Session(),
  };
}

/** The x86-64 kernel backed by vendored Unicorn/Keystone/Capstone WASM. */
export const asm64Kernel: Kernel = createAsm64Kernel();
