import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Asm64Session,
  asm64Kernel,
  createAsm64Kernel,
  loadEngine,
  loadEngines,
  setVendorBase,
} from '../src/index';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('kernel-asm64 in Node (no DOM)', () => {
  it('imports safely when document is undefined', () => {
    expect(typeof document).toBe('undefined');
    expect(asm64Kernel.id).toBe('asm');
    expect(asm64Kernel.label).toBe('x86-64 · Unicorn');
    expect(asm64Kernel.editorSyntax).toBe('asm-intel');
    expect(asm64Kernel.features).toEqual({ breakpoints: true, stepping: true });
    expect(loadEngine).toBe(loadEngines);
  });

  it('createAsm64Kernel sets features and optionally configures vendorBase', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url);
      return { ok: false, status: 404 } as Response;
    });

    const kernel = createAsm64Kernel({ vendorBase: 'http://asm64.invalid/custom' });
    expect(kernel.id).toBe('asm');
    expect(kernel.features).toEqual({ breakpoints: true, stepping: true });

    await expect(loadEngine()).rejects.toThrow(/http:\/\/asm64\.invalid\/custom\/.*setVendorBase/);
    expect(requested).toContain('http://asm64.invalid/custom/keystone.wasm');
  });

  it('setVendorBase clears cached engine state and re-targets subsequent loads', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url);
      return { ok: false, status: 503 } as Response;
    });

    setVendorBase('http://asm64.invalid/v1');
    await expect(loadEngines()).rejects.toThrow(/http:\/\/asm64\.invalid\/v1\/.*HTTP 503.*setVendorBase/);

    setVendorBase('http://asm64.invalid/v2/');
    await expect(loadEngines()).rejects.toThrow(/http:\/\/asm64\.invalid\/v2\/.*HTTP 503.*setVendorBase/);

    expect(requested).toContain('http://asm64.invalid/v1/keystone.wasm');
    expect(requested).toContain('http://asm64.invalid/v2/keystone.wasm');
  });

  it('Asm64Session.load omits line on engine-boot failure', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404 } as Response));
    setVendorBase('http://asm64.invalid/missing');

    const session = new Asm64Session();
    const result = await session.load('mov rax, 1\nret\n');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBeUndefined();
      expect('line' in result).toBe(false);
      expect(result.message).toContain('failed to load the emulator engines');
      expect(result.message).toContain('http://asm64.invalid/missing/');
      expect(result.message).toContain('setVendorBase');
    }
  });
});
