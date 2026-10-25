// Loader for the typst-wasm engine (npm deps; sync-vendors copies the
// payload into the app's public/vendor-typst/ for serving).
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
  // Browser: assets live at <page-base>/vendor-typst/ (sync-vendors copies
  // them from node_modules into the app's public root). Headless
  // (bun/vitest) never uses this — see assetUrl().
  return typeof document !== 'undefined'
    ? new URL('vendor-typst/', document.baseURI).href
    : '';
}

let vendorDir = defaultBase();

/** Point the loader at a different same-origin directory for the assets. */
export function setVendorBase(url: string): void {
  vendorDir = url.endsWith('/') ? url : url + '/';
}

/** One asset's URL: served copy in the browser, npm copy headless. */
function assetUrl(name: string): string {
  if (typeof document !== 'undefined') return vendorDir + name;
  // Headless (bun/vitest): engine and fonts are separate npm packages.
  const dir = name.endsWith('.wasm')
    ? '../node_modules/typst-wasm/dist/engine/'
    : '../node_modules/@typst-wasm/fonts/dist/files/';
  return new URL(dir + name, import.meta.url).href;
}

async function readBytes(name: string): Promise<Uint8Array<ArrayBuffer>> {
  const url = assetUrl(name);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`cannot load ${name} from ${url}: HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

let enginePromise: Promise<TypstEngine> | null = null;

/** Load (once) the vendored typst compiler engine and its fonts. */
export function loadEngine(): Promise<TypstEngine> {
  enginePromise ??= (async () => {
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
        coreModules[name] = await WebAssembly.compile(await readBytes(name));
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
    const fonts = await Promise.all(FONT_FILES.map(readBytes));
    await compiler.addFonts(...fonts);
    return compiler;
  })();
  return enginePromise;
}
