// Loader for the typst-wasm engine (npm deps; @didact/vite didactVendors()
// serves the payload from node_modules at vendor-typst/ in dev and emits it
// into dist/ on build).
//
// Engine choice: `typst-wasm` 1.0.0 (MIT) — JS bindings around the real
// Typst 0.15.0 compiler compiled to WebAssembly. It compiles a document to
// SVG page strings in one step (no separate renderer wasm), reports
// diagnostics with 1-based `line` numbers, and takes its wasm modules as
// caller-built `WebAssembly.Module`s, so nothing is ever fetched from a CDN.
//
// What is loaded lazily on the first `load()` (page load stays fast):
//  - engine.core{,2,3}.wasm — the compiler (core2/core3 are 159/121-byte
//    companion modules the engine instantiates alongside core).
//  - the minimum font set Typst's defaults need (see FONT_FILES; without a
//    font nothing compiles, and these five cover the default text, bold,
//    italic, math and raw faces — exact list in THIRD-PARTY.md).
//
// Backend: the engine is instantiated in-page through WebAssembly JSPI
// (`WebAssembly.Suspending`/`promising`), so no Worker, SharedArrayBuffer or
// COOP/COEP cross-origin isolation is required. JSPI is feature-detected and
// missing support surfaces as a clear load error. All network fetches the
// library might perform (typst package imports, URL files) are stubbed out:
// this kernel is strictly offline.

import { createTypstCompiler } from 'typst-wasm';

/** A typst diagnostic as surfaced by the engine (subset we consume). */
export interface TypstDiagnostic {
  message: string;
  severity: 'error' | 'warning' | string;
  file?: string;
  line?: number;
  column?: number;
  hints: string[];
}

export interface TypstSvgPage {
  page: number;
  output: string;
}

/** The narrow engine surface the session uses (fakeable in tests). */
export interface TypstEngine {
  addSource(path: string, text: string): Promise<void>;
  compile(opts: {
    main: string;
    format: 'svg';
  }): Promise<{ pages: TypstSvgPage[]; diagnostics: TypstDiagnostic[] }>;
}

/** Vendored engine wasm modules (names are fixed by typst-wasm). */
const ENGINE_FILES = [
  'engine.core.wasm',
  'engine.core2.wasm',
  'engine.core3.wasm',
] as const;

/** Minimum font set for Typst's default families, in load order. */
export const FONT_FILES = [
  'LibertinusSerif-Regular.otf', // default text face ('Libertinus Serif')
  'LibertinusSerif-Bold.otf',    // headings / *strong*
  'LibertinusSerif-Italic.otf',  // /emphasis/
  'NewCMMath-Regular.otf',       // default math face ($...$)
  'DejaVuSansMono.ttf',          // default raw/code face
] as const;

function defaultBase(): string {
  // Browser: assets live at <page-base>/vendor-typst/ (@didact/vite
  // didactVendors() serves them from node_modules in dev and emits them into
  // dist/ on build). Headless
  // (bun/vitest) never uses this — see assetUrl().
  return typeof document !== 'undefined'
    ? new URL('vendor-typst/', document.baseURI).href
    : '';
}

let vendorDir = defaultBase();
let enginePromise: Promise<TypstEngine> | null = null;

/** Point the loader at a different same-origin directory for the assets. */
export function setVendorBase(url: string): void {
  vendorDir = url.endsWith('/') ? url : url + '/';
  enginePromise = null; // re-resolve on the next load
}

/** Headless npm resolution: prefer import.meta.resolve (works when hoisted). */
function resolveHeadlessAsset(name: string): string {
  const isWasm = name.endsWith('.wasm');
  // Built from parts so Vite cannot rewrite headless npm paths into dead browser assets.
  const spec = isWasm
    ? ['typst-wasm', 'engine', name].join('/')
    : ['@typst-wasm', 'fonts', name].join('/');
  if (typeof import.meta.resolve === 'function') {
    try {
      return import.meta.resolve(spec);
    } catch {
      // fall back to sibling node_modules layout below
    }
  }
  const dir = isWasm
    ? '../node_modules/typst-wasm/dist/engine/'
    : '../node_modules/@typst-wasm/fonts/dist/files/';
  return new URL(dir + name, import.meta.url).href;
}

/** One asset's URL: served copy in the browser, npm copy headless (unless overridden). */
function assetUrl(name: string, base: string): string {
  if (typeof document !== 'undefined' || base !== '') return base + name;
  return resolveHeadlessAsset(name);
}

/** Read a local file:// URL via node:fs/promises (Node 24 fetch rejects file://). */
async function readFileUrl(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const fsSpec = ['node', 'fs/promises'].join(':');
  const urlSpec = ['node', 'url'].join(':');
  const [{ readFile }, { fileURLToPath }] = (await Promise.all([
    import(/* @vite-ignore */ fsSpec),
    import(/* @vite-ignore */ urlSpec),
  ])) as [typeof import('node:fs/promises'), typeof import('node:url')];
  const buf = await readFile(fileURLToPath(url));
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

async function readBytes(name: string, base: string): Promise<Uint8Array<ArrayBuffer>> {
  const url = assetUrl(name, base);
  if (typeof document === 'undefined' && url.startsWith('file:')) {
    try {
      return await readFileUrl(url);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `cannot load ${name} from ${url}: ${detail} — verify typst-wasm/@typst-wasm/fonts or call setVendorBase()`,
      );
    }
  }
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `cannot load ${name} from ${url}: ${detail} — serve the vendored typst assets there or call setVendorBase()`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `cannot load ${name} from ${url}: HTTP ${res.status} — serve the vendored typst assets there or call setVendorBase()`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Load (once) the vendored typst compiler engine and its fonts. */
export function loadEngine(): Promise<TypstEngine> {
  if (!enginePromise) {
    const base = vendorDir;
    const pending = (async () => {
      // JSPI is standardized but not yet in the TS DOM lib.
      const wa = WebAssembly as typeof WebAssembly & {
        Suspending?: unknown;
        promising?: unknown;
      };
      if (typeof wa.Suspending !== 'function' || typeof wa.promising !== 'function') {
        throw new Error(
          'this browser has no WebAssembly JSPI (WebAssembly.promising); ' +
            'the Typst engine needs Chrome/Edge 137+, Firefox 153+ or Safari 27+',
        );
      }
      // Compile asynchronously and in parallel. `new WebAssembly.Module`
      // is synchronous and stock Chromium refuses sync compilation of
      // buffers larger than 8 MB on the main thread (engine.core.wasm is
      // ~22.8 MB); `WebAssembly.compile` has no size limit and hands the
      // engine the same `WebAssembly.Module` it would have built.
      const coreModules = {} as Record<(typeof ENGINE_FILES)[number], WebAssembly.Module>;
      await Promise.all(
        ENGINE_FILES.map(async (name) => {
          coreModules[name] = await WebAssembly.compile(await readBytes(name, base));
        }),
      );
      const compiler = await createTypstCompiler({
        coreModules,
        backend: 'jspi',
        packageCache: false,
        // Strictly offline: any typst package/URL import fails as a fetch
        // error instead of reaching the network.
        fetch: () => Promise.reject(new Error('offline kernel: no network fetches')),
      });
      const fonts = await Promise.all(FONT_FILES.map((name) => readBytes(name, base)));
      await compiler.addFonts(...fonts);
      return compiler;
    })();
    enginePromise = pending;
    pending.catch(() => {
      if (enginePromise === pending) enginePromise = null; // allow a retry after a transient failure
    });
  }
  return enginePromise;
}
