// kernel.test.ts — the exported kernel's identity and the Session contract
// surface. No engine involved: the fake-bundle behavioral coverage lives in
// session.test.ts, the real toolchain in test/smoke.ts.
import { describe, expect, it } from 'vitest';

import { cppKernel } from '../src/kernel';
import { CppSession } from '../src/session';
import type { Session } from '../src/types';

describe('cppKernel', () => {
  it('registers as the cpp org tag with the clang wasm label', () => {
    expect(cppKernel.id).toBe('cpp');
    expect(cppKernel.label).toBe('C++ · clang wasm');
  });

  it('uses the cpp editor syntax', () => {
    expect(cppKernel.editorSyntax).toBe('cpp');
  });

  it('opts out of stepping and breakpoints (whole-program compile+run)', () => {
    expect(cppKernel.features).toEqual({ stepping: false, breakpoints: false });
  });

  it('createSession() returns a CppSession implementing the Session contract', () => {
    const s: Session = cppKernel.createSession();
    expect(s).toBeInstanceOf(CppSession);
    for (const method of ['load', 'run', 'step', 'reset', 'state', 'dispose'] as const) {
      expect(typeof s[method]).toBe('function');
    }
  });
});
