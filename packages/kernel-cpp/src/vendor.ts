// Loader for the C++ engine. Adapted from packages/kernel-c/src/vendor.ts;
// the engine is shared, not forked:
//
//   @yowasp/clang 22.0.0-git20542-10 (real clang++ + wasm-ld + wasi-libc and
//   libc++ sysroots, built for WebAssembly by the YoWASP project), an npm
//   dependency of this package. kernel-c and kernel-cpp pin the same
//   version, so sync-vendors serves ONE copy under public/vendor-c/clang/
//   and this loader points at it — no duplicate ~105 MB download.
//
// How the engine finds its assets (verified by reading bundle.js): every
// resource — llvm.core.wasm … llvm.core4.wasm and llvm-resources.tar (the
// sysroot, clang resource headers, and the libc++/libc++abi archives) — is
// resolved with `new URL("./<file>", import.meta.url)`, i.e. RELATIVE TO
// bundle.js itself. So this loader only has to dynamically import bundle.js
// from the right place; the engine's own runtime then fetches its siblings,
// untars the sysroot, and instantiates the toolchain. No CDN is contacted.
//
// First use lazily fetches ~105 MB from the vendor base (the site serves
// vendor-c/ as plain static files, shared with kernel-c); repeat visits
// are served from the HTTP cache, and the imported module is cached in
// `enginePromise`.

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

/** The bundle's URL: served copy in the browser, npm copy headless. */
function bundleUrl(): string {
  if (typeof document !== 'undefined') return `${vendorBase}clang/bundle.js`;
  // Headless (bun): the engine is the @yowasp/clang npm dependency. Built
  // from parts so Vite cannot rewrite it into a dead emitted asset.
  const dir = '../node_modules/@yowasp/clang/gen/';
  return new URL(dir + 'bundle.js', import.meta.url).href;
}

/** Load (once) the clang engine — bundle.js resolves its siblings itself. */
export function loadEngine(): Promise<ClangBundle> {
  if (!enginePromise) {
    const url = bundleUrl();
    enginePromise = import(/* @vite-ignore */ url).then(
      (mod: { runClang?: unknown }) => {
        if (typeof mod.runClang !== 'function') {
          throw new Error(`clang bundle at ${url} does not export runClang`);
        }
        return mod as ClangBundle;
      },
    );
    enginePromise.catch(() => {
      enginePromise = null; // allow a retry after a transient fetch failure
    });
  }
  return enginePromise;
}
