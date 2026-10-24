import type { Kernel } from './types';
import { TypstSession } from './session';

/** The typst kernel backed by the vendored typst-wasm (Typst 0.15) engine. */
export const typstKernel: Kernel = {
  id: 'typst',
  label: 'Typst · wasm',
  editorSyntax: 'plain',
  features: { stepping: false },
  createSession: () => new TypstSession(),
};
