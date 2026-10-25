// The Kernel/Session contract is duplicated into every kernel package as
// src/types.ts so packages typecheck standalone (see AGENTS.md). Duplicated
// contracts drift — this file pins each mirror byte-for-byte to
// packages/core/src/kernel.ts, the single source of truth.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(HERE, '../..');

const ANCHOR = '/** One rendered under-the-hood section. */';

/** The contract text: everything from the Panel doc comment to EOF. */
function contractOf(path: string): string {
  const src = readFileSync(path, 'utf8');
  const at = src.indexOf(ANCHOR);
  if (at < 0) throw new Error(`contract anchor missing from ${path}`);
  return src.slice(at);
}

const coreContract = contractOf(resolve(HERE, '../src/kernel.ts'));

const kernels = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith('kernel-'))
  .map((d) => d.name)
  .filter((name) => existsSync(join(PACKAGES, name, 'src/types.ts')));

describe('kernel contract mirrors', () => {
  it('found the nine kernel packages', () => {
    // Guards the test itself: a silent zero-match glob would pass vacuously.
    expect(kernels.sort()).toEqual([
      'kernel-asm64', 'kernel-c', 'kernel-cpp', 'kernel-javascript',
      'kernel-lisp', 'kernel-mips', 'kernel-python', 'kernel-riscv',
      'kernel-typst',
    ]);
  });

  for (const name of kernels) {
    it(`${name}/src/types.ts matches packages/core/src/kernel.ts verbatim`, () => {
      expect(contractOf(join(PACKAGES, name, 'src/types.ts'))).toBe(coreContract);
    });
  }
});
