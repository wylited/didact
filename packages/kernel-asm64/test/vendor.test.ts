// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadEngine,
  setVendorBase,
  type CapstoneModule,
  type KeystoneModule,
  type UnicornModule,
} from '../src/vendor';

function installFakeGlobals(): void {
  const fakeUnicorn = {} as UnicornModule;
  const fakeKeystone = {} as KeystoneModule;
  const fakeCapstone = {} as CapstoneModule;
  window.MUnicorn = async () => fakeUnicorn;
  window.MKeystone = async () => fakeKeystone;
  window.MCapstone = async () => fakeCapstone;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const el of document.head.querySelectorAll('script[data-vendor]')) el.remove();
  delete window.MUnicorn;
  delete window.MKeystone;
  delete window.MCapstone;
});

describe('kernel-asm64 vendor loader (DOM)', () => {
  it('removes a failed script tag on error so a retry succeeds instead of hanging', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(4),
    } as Response));

    const origAppend = document.head.appendChild.bind(document.head);
    const appended: string[] = [];
    let failKeystoneOnce = true;

    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        // Prevent happy-dom from attempting real external script loading.
        node.type = 'application/x-didact-test';
        origAppend(node);
        const src = node.dataset.vendor ?? '';
        appended.push(src);
        queueMicrotask(() => {
          if (failKeystoneOnce && src.endsWith('keystone.js')) {
            failKeystoneOnce = false;
            node.dispatchEvent(new Event('error'));
          } else {
            node.dispatchEvent(new Event('load'));
          }
        });
        return node;
      }
      origAppend(node);
      return node;
    });

    installFakeGlobals();
    setVendorBase('http://asm64-dom.test/v1');

    // First attempt fails when keystone.js errors; its dead <script> tag must be removed.
    await expect(loadEngine()).rejects.toThrow(
      /failed to load http:\/\/asm64-dom\.test\/v1\/keystone\.js.*setVendorBase/,
    );
    expect(
      document.querySelector('script[data-vendor="http://asm64-dom.test/v1/keystone.js"]'),
    ).toBeNull();

    // Retry appends a fresh keystone.js <script> tag and resolves cleanly.
    const engines = await loadEngine();
    expect(engines.unicorn).toBeDefined();
    expect(engines.keystone).toBeDefined();
    expect(engines.capstone).toBeDefined();
    expect(
      appended.filter((s) => s === 'http://asm64-dom.test/v1/keystone.js'),
    ).toHaveLength(2);
  });

  it('setVendorBase clears a cached enginesPromise so the next load fetches from the new base', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(4),
      } as Response;
    });

    const origAppend = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        node.type = 'application/x-didact-test';
        origAppend(node);
        queueMicrotask(() => node.dispatchEvent(new Event('load')));
        return node;
      }
      origAppend(node);
      return node;
    });

    installFakeGlobals();
    setVendorBase('http://asm64-dom.test/a');
    await loadEngine();
    expect(fetched).toEqual([
      'http://asm64-dom.test/a/keystone.wasm',
      'http://asm64-dom.test/a/capstone.wasm',
    ]);

    // Changing vendorBase must discard the cached promise and fetch from /b/.
    setVendorBase('http://asm64-dom.test/b');
    await loadEngine();
    expect(fetched).toEqual([
      'http://asm64-dom.test/a/keystone.wasm',
      'http://asm64-dom.test/a/capstone.wasm',
      'http://asm64-dom.test/b/keystone.wasm',
      'http://asm64-dom.test/b/capstone.wasm',
    ]);
  });
});
