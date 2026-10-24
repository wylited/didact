// Loader for the vendored C engine: @yowasp/clang 22.0.0-git20542-10
// (real clang + wasm-ld + wasi-libc sysroot, built for WebAssembly by the
// YoWASP project), vendored verbatim under vendor/clang/.
//
// How the engine finds its assets (verified by reading bundle.js): every
// resource — llvm.core.wasm … llvm.core4.wasm and llvm-resources.tar (the
// sysroot + clang resource headers) — is resolved with
// `new URL("./<file>", import.meta.url)`, i.e. RELATIVE TO bundle.js itself.
// So this loader only has to dynamically import `${base}clang/bundle.js`
// from the right base; the engine's own runtime then fetches its siblings,
// untars the sysroot, and instantiates the toolchain. No CDN is contacted.
//
// First use lazily fetches ~86 MB from the vendor base (the site serves
// vendor/ as plain static files); repeat visits are served from the HTTP
// cache, and the imported module is cached in `enginePromise`.
//
// What was trimmed for the size budget (see THIRD-PARTY.md): the C++ stdlib
// (libc++.a/libc++abi.a, include/c++/v1, libc++ module maps), the optional
// libc-printscan variants and the .so stub libraries were removed from
// llvm-resources.tar. C compilation is unaffected; C++ is out of scope.

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
  // Headless runs (bun) resolve the package's own vendor/ directory.
  return new URL('../vendor/', import.meta.url).href;
}

let vendorBase = defaultVendorBase();
let enginePromise: Promise<ClangBundle> | null = null;

/** Point the loader at a different directory for the vendored toolchain. */
export function setVendorBase(url: string): void {
  vendorBase = url.endsWith('/') ? url : url + '/';
  enginePromise = null; // re-resolve on the next load
}

/** Load (once) the vendored clang engine from the vendor base. */
export function loadEngine(): Promise<ClangBundle> {
  if (!enginePromise) {
    enginePromise = import(/* @vite-ignore */ `${vendorBase}clang/bundle.js`).then(
      (mod: { runClang?: unknown }) => {
        if (typeof mod.runClang !== 'function') {
          throw new Error(`vendored clang bundle at ${vendorBase}clang/bundle.js does not export runClang`);
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
