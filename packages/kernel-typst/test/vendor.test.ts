import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTypstKernel, loadEngine, setVendorBase, typstKernel } from '../src/index';

const wa = WebAssembly as typeof WebAssembly & {
  Suspending?: unknown;
  promising?: unknown;
};

let origSuspending: unknown;
let origPromising: unknown;

beforeEach(() => {
  origSuspending = wa.Suspending;
  origPromising = wa.promising;
  if (typeof wa.Suspending !== 'function') wa.Suspending = () => undefined;
  if (typeof wa.promising !== 'function') wa.promising = () => undefined;
});

afterEach(() => {
  if (origSuspending === undefined) delete wa.Suspending;
  else wa.Suspending = origSuspending;
  if (origPromising === undefined) delete wa.promising;
  else wa.promising = origPromising;
  vi.unstubAllGlobals();
});

describe('typstKernel & createTypstKernel', () => {
  it('declares explicit features and creates a Typst kernel', () => {
    expect(typstKernel.id).toBe('typst');
    expect(typstKernel.label).toBe('Typst · wasm');
    expect(typstKernel.editorSyntax).toBe('typst');
    expect(typstKernel.features).toEqual({ breakpoints: false, stepping: false });

    const custom = createTypstKernel();
    expect(custom.id).toBe('typst');
    expect(custom.features).toEqual({ breakpoints: false, stepping: false });
  });
});

describe('kernel-typst vendor loader', () => {
  it('clears enginePromise after a transient failure so retries run again', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url);
      return { ok: false, status: 503 } as Response;
    });

    setVendorBase('http://typst.invalid/v1');
    await expect(loadEngine()).rejects.toThrow(
      /cannot load engine\.core.*http:\/\/typst\.invalid\/v1\/.*HTTP 503.*setVendorBase/,
    );
    const afterFirst = requested.length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // Without clearing enginePromise on rejection, a retry would reuse the dead promise
    // and never call fetch again.
    await expect(loadEngine()).rejects.toThrow(/HTTP 503/);
    expect(requested.length).toBeGreaterThan(afterFirst);
  });

  it('setVendorBase and createTypstKernel({ vendorBase }) reset and re-target asset URLs', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url);
      return { ok: false, status: 404 } as Response;
    });

    setVendorBase('http://typst.invalid/first');
    await expect(loadEngine()).rejects.toThrow(/http:\/\/typst\.invalid\/first\//);

    createTypstKernel({ vendorBase: 'http://typst.invalid/second' });
    await expect(loadEngine()).rejects.toThrow(/http:\/\/typst\.invalid\/second\//);

    expect(requested.some((u) => u.startsWith('http://typst.invalid/first/'))).toBe(true);
    expect(requested.some((u) => u.startsWith('http://typst.invalid/second/'))).toBe(true);
  });

  it('loads file:// assets headlessly via node:fs/promises instead of fetch()', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('fetch must not be called for file:// URLs');
    });

    setVendorBase('file:///nonexistent-didact-typst-vendor/');
    await expect(loadEngine()).rejects.toThrow(/ENOENT|no such file/i);
  });
});
