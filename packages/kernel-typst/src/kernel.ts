import type { Kernel } from './types';
import { TypstSession } from './session';
import { setVendorBase } from './vendor';

/** Create a Typst kernel, optionally configuring where the vendored assets are served. */
export function createTypstKernel(opts?: { vendorBase?: string }): Kernel {
  if (opts?.vendorBase !== undefined) setVendorBase(opts.vendorBase);
  return {
    id: 'typst',
    label: 'Typst · wasm',
    editorSyntax: 'typst',
    features: { breakpoints: false, stepping: false },
    createSession: () => new TypstSession(),
  };
}

/** The typst kernel backed by the vendored typst-wasm (Typst 0.15) engine. */
export const typstKernel: Kernel = createTypstKernel();
