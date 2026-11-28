// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PyodideInterface } from 'pyodide';
import { createPythonKernel } from '../src/kernel';
import { loadEngine, setVendorBase } from '../src/vendor';

afterEach(() => {
  vi.restoreAllMocks();
  for (const el of document.head.querySelectorAll('script[data-vendor]')) el.remove();
  delete window.loadPyodide;
});

describe('kernel-python vendor loader (DOM)', () => {
  it('removes a failed pyodide.js script tag on error so a retry succeeds instead of hanging', async () => {
    const origAppend = document.head.appendChild.bind(document.head);
    const appended: string[] = [];
    let failFirst = true;

    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        node.type = 'application/x-didact-test';
        origAppend(node);
        appended.push(node.dataset.vendor ?? '');
        queueMicrotask(() => {
          if (failFirst) {
            failFirst = false;
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

    const fakePy = {} as PyodideInterface;
    const bootUrls: string[] = [];
    window.loadPyodide = async ({ indexURL }) => {
      bootUrls.push(indexURL);
      return fakePy;
    };

    setVendorBase('http://python-dom.test/v1');
    await expect(loadEngine()).rejects.toThrow(
      /failed to load http:\/\/python-dom\.test\/v1\/pyodide\.js.*setVendorBase/,
    );
    expect(
      document.querySelector('script[data-vendor="http://python-dom.test/v1/pyodide.js"]'),
    ).toBeNull();

    // Retrying appends a fresh script tag and resolves cleanly.
    const py = await loadEngine();
    expect(py).toBe(fakePy);
    expect(appended).toEqual([
      'http://python-dom.test/v1/pyodide.js',
      'http://python-dom.test/v1/pyodide.js',
    ]);
    expect(bootUrls).toEqual(['http://python-dom.test/v1/']);
  });

  it('setVendorBase and createPythonKernel({ vendorBase }) clear cached enginePromise', async () => {
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

    const bootUrls: string[] = [];
    window.loadPyodide = async ({ indexURL }) => {
      bootUrls.push(indexURL);
      return {} as PyodideInterface;
    };

    setVendorBase('http://python-dom.test/a');
    await loadEngine();

    createPythonKernel({ vendorBase: 'http://python-dom.test/b' });
    await loadEngine();

    expect(bootUrls).toEqual([
      'http://python-dom.test/a/',
      'http://python-dom.test/b/',
    ]);
  });
});
