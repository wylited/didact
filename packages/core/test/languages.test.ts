import { describe, expect, it } from 'vitest';
import { editorLanguage } from '../src/languages';
import type { Kernel } from '../src/kernel';

describe('editorLanguage: syntax → CM6 extension mapping', () => {
  it('returns a real extension for every supported non-plain syntax id', () => {
    const supported = ['asm-intel', 'asm-riscv', 'asm-mips', 'c', 'python'] as const;
    for (const syntax of supported) {
      expect(editorLanguage(syntax), syntax).not.toBeNull();
    }
  });

  it('returns null for undefined (kernel default) and explicit plain', () => {
    expect(editorLanguage(undefined)).toBeNull();
    expect(editorLanguage('plain')).toBeNull();
  });

  it('returns null for unknown ids instead of crashing or reusing a dialect', () => {
    const unknown = 'asm-pdp11' as NonNullable<Kernel['editorSyntax']>;
    expect(editorLanguage(unknown)).toBeNull();
  });

  it('gives each assembly dialect its own distinct extension instance', () => {
    const intel = editorLanguage('asm-intel');
    const riscv = editorLanguage('asm-riscv');
    const mips = editorLanguage('asm-mips');
    expect(intel).not.toBe(riscv);
    expect(riscv).not.toBe(mips);
    expect(intel).not.toBe(mips);
  });
});
