import { describe, expect, it } from 'vitest';
import { cKernel, createCKernel, loadEngine, setVendorBase } from '../src/index';

describe('cKernel & createCKernel', () => {
  it('declares explicit features and creates a C kernel', () => {
    expect(cKernel.id).toBe('c');
    expect(cKernel.label).toBe('C · clang wasm');
    expect(cKernel.editorSyntax).toBe('c');
    expect(cKernel.features).toEqual({ breakpoints: false, stepping: false });

    const custom = createCKernel();
    expect(custom.id).toBe('c');
    expect(custom.features).toEqual({ breakpoints: false, stepping: false });
  });

  it('reports vendor-c/clang/ and setVendorBase hint on missing bundle and clears cache on setVendorBase', async () => {
    createCKernel({ vendorBase: 'file:///nonexistent-didact-c-v1/' });
    await expect(loadEngine()).rejects.toThrow(
      /file:\/\/\/nonexistent-didact-c-v1\/clang\/bundle\.js.*vendor-c\/clang\/.*setVendorBase/,
    );

    setVendorBase('file:///nonexistent-didact-c-v2');
    await expect(loadEngine()).rejects.toThrow(
      /file:\/\/\/nonexistent-didact-c-v2\/clang\/bundle\.js.*vendor-c\/clang\/.*setVendorBase/,
    );
  });
});
