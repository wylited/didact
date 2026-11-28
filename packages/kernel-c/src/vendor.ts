// Loader for the C engine: @yowasp/clang 22.0.0-git20542-10 (real clang +
// wasm-ld + wasi-libc sysroot, built for WebAssembly by the YoWASP project),
// an npm dependency of this package; @didact/vite (didactVendors()) serves it
// from node_modules at vendor-c/clang/ in dev and emits it into dist/ on build.
//
// How the engine finds its assets (verified by reading bundle.js): every
// resource — llvm.core.wasm … llvm.core4.wasm and llvm-resources.tar (the
// sysroot + clang resource headers) — is resolved with
// `new URL("./<file>", import.meta.url)`, i.e. RELATIVE TO bundle.js itself.
// So this loader only has to dynamically import bundle.js from the right
// place; the engine's own runtime then fetches its siblings, untars the
// sysroot, and instantiates the toolchain. No CDN is contacted.
//
// First use lazily fetches ~105 MB from the vendor base (the site serves
// vendor-c/ as plain static files); repeat visits are served from the HTTP
// cache, and the imported module is cached in `enginePromise`.

/** File-tree values accepted/returned by the YoWASP API. */
export type Tree = { [name: string]: Tree | string | Uint8Array };

export interface RunOptions {
  stdout?: ((bytes: Uint8Array | null) => void) | null;
  stderr?: ((bytes: Uint8Array | null) => void) | null;
}

/** The subset of the vendored bundle's exports that this kernel uses. */
export interface ClangBundle {
  runClang(args: string[], files: Tree, options: RunOptions): Promise<Tree>;
}

function defaultVendorBase(): string {
  if (typeof document !== 'undefined') {
    return new URL('vendor-c/', document.baseURI).href;
  }
  return ''; // headless runs import the npm dependency directly
}

let vendorBase = defaultVendorBase();
let enginePromise: Promise<ClangBundle> | null = null;

/** Point the loader at a different directory for the vendored toolchain. */
export function setVendorBase(url: string): void {
  vendorBase = url.endsWith('/') ? url : url + '/';
  enginePromise = null; // re-resolve on the next load
}

/** The bundle's URL: served copy in the browser, npm copy headless (unless overridden). */
function bundleUrl(): string {
  if (typeof document !== 'undefined' || vendorBase !== '') {
    return `${vendorBase}clang/bundle.js`;
  }
  // Headless (Node/Bun): resolve @yowasp/clang via import.meta.resolve so
  // hoisted node_modules layouts work, falling back to the package-local
  // node_modules path. Built from parts so Vite cannot rewrite it into a
  // dead emitted asset.
  if (typeof import.meta.resolve === 'function') {
    try {
      return import.meta.resolve(['@yowasp', 'clang'].join('/'));
    } catch {
      // fall back to sibling node_modules layout below
    }
  }
  const dir = '../node_modules/@yowasp/clang/gen/';
  return new URL(dir + 'bundle.js', import.meta.url).href;
}

/** Load (once) the clang engine — bundle.js resolves its siblings itself. */
export function loadEngine(): Promise<ClangBundle> {
  if (!enginePromise) {
    const url = bundleUrl();
    const pending = import(/* @vite-ignore */ url).then(
      (mod: { runClang?: unknown }) => {
        if (typeof mod.runClang !== 'function') {
          throw new Error(
            `clang bundle at ${url} does not export runClang — verify vendor-c/clang/ assets or call setVendorBase()`,
          );
        }
        return mod as ClangBundle;
      },
      (cause: unknown) => {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `failed to load clang bundle at ${url}: ${detail} — serve the vendored toolchain under vendor-c/clang/ or call setVendorBase()`,
        );
      },
    );
    enginePromise = pending;
    pending.catch(() => {
      if (enginePromise === pending) enginePromise = null; // allow a retry after a transient fetch failure
    });
  }
  return enginePromise;
}
