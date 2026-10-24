// Loader for the vendored Pyodide distribution shipped in vendor/.
//
// What the browser fetches at engine boot (verified by reading pyodide.js
// from pyodide 314.0.7): the UMD entry `pyodide.js` (a classic script that
// defines the global `loadPyodide`), which then pulls, all resolved against
// `indexURL`:
//   - pyodide.asm.mjs     — Emscripten JS glue, dynamically imported
//   - pyodide.asm.wasm    — CPython 3.14 compiled to WebAssembly
//   - python_stdlib.zip   — the standard library, mounted at boot
//   - pyodide-lock.json   — package index used by pyodide.loadPackage
// Exactly those five files are vendored; nothing is ever fetched from a CDN
// and no other network access happens at runtime.
//
// The app copies vendor/ into its public root; the default base
// <page-base>/vendor-python/ resolves under Vite dev/build/preview with
// base './'. If the app serves the assets elsewhere it calls
// setVendorBase() before creating a session. The engine boots lazily on
// the first `load()` of a python block — never at page import — and
// concurrent loads share one promise.

import type { PyodideInterface } from 'pyodide';

declare global {
  interface Window {
    loadPyodide?: (options: { indexURL: string }) => Promise<PyodideInterface>;
  }
}

// `document` is absent when the module is imported outside the browser
// (e.g. the node smoke test); the placeholder keeps import cheap and inert.
const pageBase = typeof document !== 'undefined' ? document.baseURI : 'file:///';

let vendorDir = new URL('vendor-python/', pageBase).href;

/** Point the loader at a different same-origin directory for the assets. */
export function setVendorBase(url: string): void {
  vendorDir = url.endsWith('/') ? url : url + '/';
}

function loadScript(src: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const existing = document.querySelector<HTMLScriptElement>(`script[data-vendor="${src}"]`);
  if (existing && existing.dataset.loaded === '1') return Promise.resolve();
  if (existing) {
    existing.addEventListener('load', () => resolve());
    existing.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
    return promise;
  }
  const s = document.createElement('script');
  s.src = src;
  s.dataset.vendor = src;
  s.addEventListener('load', () => {
    s.dataset.loaded = '1';
    resolve();
  });
  s.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
  document.head.appendChild(s);
  return promise;
}

let enginePromise: Promise<PyodideInterface> | null = null;

/** Load (once) the vendored Pyodide engine; shared by every python block. */
export function loadEngine(): Promise<PyodideInterface> {
  if (!enginePromise) {
    enginePromise = (async () => {
      await loadScript(vendorDir + 'pyodide.js');
      const boot = window.loadPyodide;
      if (!boot) {
        throw new Error('pyodide.js loaded but defines no loadPyodide global');
      }
      return boot({ indexURL: vendorDir });
    })();
    enginePromise.catch(() => {
      enginePromise = null; // allow a retry after a transient fetch failure
    });
  }
  return enginePromise;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Serialize engine use. One Python exec at a time, so stdout/stderr routing
 * and namespace snapshots never interleave between concurrently-run blocks.
 */
export function serialized<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.then(() => undefined, () => undefined);
  return next;
}
