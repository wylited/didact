import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeBase, resolveVendorFiles } from '../src/vendors';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = resolve(HERE, '../../../apps/site');

const tempDirs: string[] = [];

function makeEmptyTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'didact-vendors-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('resolveVendorFiles', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('resolves x86-64 assembly runtime binaries and licenses', () => {
    const groups = resolveVendorFiles(['asm'], SITE_DIR);
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.dest).toBe('vendor');
    expect(group.files.map((f) => f.filename)).toEqual([
      'unicorn_x86.js',
      'keystone.js',
      'keystone.wasm',
      'capstone.js',
      'capstone.wasm',
      'LICENSE-capstone-js.txt',
      'LICENSE-keystone-js.txt',
      'LICENSE-unicorn-js.txt',
    ]);
    for (const file of group.files) {
      expect(existsSync(file.src)).toBe(true);
    }
  });

  it('resolves clang assets for c and cpp and deduplicates when both are requested', () => {
    const cOnly = resolveVendorFiles(['c'], SITE_DIR);
    const cppOnly = resolveVendorFiles(['cpp'], SITE_DIR);
    const both = resolveVendorFiles(['c', 'cpp'], SITE_DIR);

    expect(cOnly).toHaveLength(1);
    expect(cppOnly).toHaveLength(1);
    expect(both).toHaveLength(1);

    const expectedFiles = [
      'bundle.js',
      'llvm.core.wasm',
      'llvm.core2.wasm',
      'llvm.core3.wasm',
      'llvm.core4.wasm',
      'llvm-resources.tar',
      'LICENSE-llvm.txt',
      'LICENSE-nanotar.md',
    ];
    for (const group of [cOnly[0]!, cppOnly[0]!, both[0]!]) {
      expect(group.dest).toBe('vendor-c/clang');
      expect(group.files.map((f) => f.filename)).toEqual(expectedFiles);
      for (const file of group.files) {
        expect(existsSync(file.src)).toBe(true);
      }
    }
  });

  it('resolves Python (Pyodide) runtime assets', () => {
    const groups = resolveVendorFiles(['python'], SITE_DIR);
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.dest).toBe('vendor-python');
    expect(group.files.map((f) => f.filename)).toEqual([
      'pyodide.js',
      'pyodide.asm.mjs',
      'pyodide.asm.wasm',
      'python_stdlib.zip',
      'pyodide-lock.json',
      'THIRD-PARTY.md',
    ]);
    for (const file of group.files) {
      expect(existsSync(file.src)).toBe(true);
    }
  });

  it('resolves Typst WASM engine, fonts, and licenses', () => {
    const groups = resolveVendorFiles(['typst'], SITE_DIR);
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.dest).toBe('vendor-typst');
    expect(group.files.map((f) => f.filename)).toEqual([
      'engine.core.wasm',
      'engine.core2.wasm',
      'engine.core3.wasm',
      'LibertinusSerif-Regular.otf',
      'LibertinusSerif-Bold.otf',
      'LibertinusSerif-Italic.otf',
      'NewCMMath-Regular.otf',
      'DejaVuSansMono.ttf',
      'LICENSE-fonts.txt',
      'LICENSE-typst-wasm.txt',
    ]);
    for (const file of group.files) {
      expect(existsSync(file.src)).toBe(true);
    }
  });

  it('auto-detects all installed WASM kernels and deduplicates c + cpp', () => {
    const groups = resolveVendorFiles(undefined, SITE_DIR);
    expect(groups.map((g) => g.dest)).toEqual([
      'vendor',
      'vendor-c/clang',
      'vendor-python',
      'vendor-typst',
    ]);
  });

  it('returns an empty list when auto-detecting in a directory with no kernels', () => {
    const emptyDir = makeEmptyTempDir();
    expect(resolveVendorFiles(undefined, emptyDir)).toEqual([]);
  });

  it('throws a clear error when an explicitly requested kernel package is missing', () => {
    const emptyDir = makeEmptyTempDir();
    expect(() => resolveVendorFiles(['asm'], emptyDir)).toThrow(
      /could not resolve package "@alexaltea\/unicorn-js"/,
    );
  });
});

describe('normalizeBase', () => {
  it.each([
    ['', '/'],
    ['./', '/'],
    ['.', '/'],
    ['/', '/'],
    ['/docs', '/docs/'],
    ['docs', '/docs/'],
    ['https://cdn.example.com', '/'],
    ['https://cdn.example.com/docs', '/docs/'],
    ['https://cdn.example.com/docs/', '/docs/'],
    ['http://cdn.example.com/a?b=1', '/a/'],
  ])('normalizes %j to %j', (base, expected) => {
    expect(normalizeBase(base)).toBe(expected);
  });
});
