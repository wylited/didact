# Vendored third-party assets

The engine is the `@yowasp/clang@22.0.0-git20542-10` npm dependency
(pinned in `package.json` and `pnpm-lock.yaml`) — the same vendored
toolchain as `@didact/kernel-c`; this package serves its own copy.
`scripts/sync-vendors.mjs` copies the payload from `node_modules/` into
the app's public root under `vendor-cpp/` (`src/vendor.ts` imports
`<vendor-base>/clang/bundle.js`, and the bundle resolves every sibling
asset relative to its own URL — no CDN is contacted at runtime). Loading
is lazy: nothing is fetched until the first C++ block runs.

## Manifest

| File | Bytes | Source | License |
|---|---:|---|---|
| `bundle.js` | 253,926 | `@yowasp/clang@22.0.0-git20542-10` npm tarball, `gen/bundle.js` (byte-identical) | Apache-2.0 WITH LLVM-exception (LLVM); ISC (@yowasp/runtime); MIT (nanotar) |
| `llvm.core.wasm` | 75,532,134 | same tarball, `gen/llvm.core.wasm` (byte-identical) | Apache-2.0 WITH LLVM-exception |
| `llvm.core2.wasm` | 37,626 | same tarball (byte-identical) | Apache-2.0 WITH LLVM-exception |
| `llvm.core3.wasm` | 5,458 | same tarball (byte-identical) | Apache-2.0 WITH LLVM-exception |
| `llvm.core4.wasm` | 787 | same tarball (byte-identical) | Apache-2.0 WITH LLVM-exception |
| `llvm-resources.tar` | 29,665,280 | same tarball, `gen/llvm-resources.tar` (byte-identical, unmodified) | Apache-2.0 WITH LLVM-exception (clang resource headers, libc++/libc++abi); wasi-libc multi-licensed Apache-2.0-LLVM / Apache-2.0 / MIT |
| `LICENSE-llvm.txt` | 15,141 | https://raw.githubusercontent.com/llvm/llvm-project/main/LICENSE.TXT | Apache-2.0 WITH LLVM-exception |
| `LICENSE-nanotar.md` | 1,078 | `nanotar@0.2.0` npm tarball, `LICENSE` | MIT |

**Total engine payload: 105,495,211 bytes (≈ 105.5 MB)** — the upstream
package unpacked as-is, identical to what `@didact/kernel-c` vendors.

Upstream: `@yowasp/clang` on npm (https://www.npmjs.com/package/@yowasp/clang),
canonical repository https://codeberg.org/YoWASP/clang (whitequark's automated
LLVM→WebAssembly packaging, LLVM 22.1.0-era, built 2026-03).

## Notes

- The sysroot inside the tar is wasi-libc plus LLVM's libc++/libc++abi
  build for wasm32-wasip1. The libc++abi in this build has NO exception
  support (no `__cxa_throw`/`__cxa_allocate_exception` symbols — verified
  with the bundle's own llvm-nm), which is why the kernel compiles with
  `-fno-exceptions`; wasi-libc is multi-licensed under Apache-2.0 WITH
  LLVM-exception, Apache-2.0, or MIT (it incorporates musl, MIT).
- `bundle.js` is the upstream esbuild bundle of `@yowasp/runtime` (ISC) +
  `nanotar` (MIT, https://github.com/unjs/nanotar) + the generated YoWASP
  resource module; it is shipped unmodified.
