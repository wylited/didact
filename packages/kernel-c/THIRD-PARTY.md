# Vendored third-party assets

All vendored files live in `vendor/clang/` inside this package and are
served as plain static files (the site copies `packages/kernel-c/vendor/`
into its public root under `vendor-c/`; `src/vendor.ts` imports
`<vendor-base>/clang/bundle.js`, and the bundle resolves every sibling
asset relative to its own URL — no CDN is contacted at runtime). Loading is
lazy: nothing is fetched until the first C block runs.

## Manifest

| File | Bytes | Source | License |
|---|---:|---|---|
| `bundle.js` | 253,926 | `@yowasp/clang@22.0.0-git20542-10` npm tarball, `gen/bundle.js` (byte-identical) | Apache-2.0 WITH LLVM-exception (LLVM); ISC (@yowasp/runtime); MIT (nanotar) |
| `llvm.core.wasm` | 75,532,134 | same tarball, `gen/llvm.core.wasm` (byte-identical) | Apache-2.0 WITH LLVM-exception |
| `llvm.core2.wasm` | 37,626 | same tarball (byte-identical) | Apache-2.0 WITH LLVM-exception |
| `llvm.core3.wasm` | 5,458 | same tarball (byte-identical) | Apache-2.0 WITH LLVM-exception |
| `llvm.core4.wasm` | 787 | same tarball (byte-identical) | Apache-2.0 WITH LLVM-exception |
| `llvm-resources.tar` | 10,638,336 | same tarball, `gen/llvm-resources.tar`, **trimmed** (see below) | Apache-2.0 WITH LLVM-exception (clang resource headers); wasi-libc multi-licensed Apache-2.0-LLVM / Apache-2.0 / MIT |
| `LICENSE-llvm.txt` | 15,141 | https://raw.githubusercontent.com/llvm/llvm-project/main/LICENSE.TXT | Apache-2.0 WITH LLVM-exception |
| `LICENSE-nanotar.md` | 1,078 | `nanotar@0.2.0` npm tarball, `LICENSE` | MIT |

**Total vendored: 86,468,267 bytes (≈ 86.5 MB) of engine assets** — within
the ~90 MB budget for this kernel. Untrimmed, the upstream package unpacks
to ~105.5 MB.

Upstream: `@yowasp/clang` on npm (https://www.npmjs.com/package/@yowasp/clang),
canonical repository https://codeberg.org/YoWASP/clang (whitequark's automated
LLVM→WebAssembly packaging, LLVM 22.1.0-era, built 2026-03).

## Trimming of `llvm-resources.tar`

The original tar (29,665,280 bytes, 2466 entries) carries the full C++
toolchain. The vendored copy is a rebuilt tar (bare directory names, ustar)
that keeps 545 entries and **removes only**:

- `include/c++/v1/**`, `share/libc++/**` — libc++ headers and module maps
- `lib/wasm32-wasip1/libc++*.a`, `libc++abi.a`, `libc++experimental.a`,
  `libc-printscan-*.a` — C++ runtime libraries and optional printf/scanf
  variants
- `lib/wasm32-wasip1/*.so` — dynamic-linking stubs (this kernel always
  links statically)

Everything a C compilation touches is kept: all 2292 clang resource headers,
the wasm32-wasip1 wasi-libc headers, `crt1.o`, `libc.a`, `libm.a`, and
`libclang_rt.builtins.a`. Consequence: **C compiles as upstream; C++
(`clang++`) is out of scope** for size reasons. Verified by compiling and
running `puts`/`printf`, a 1..10 sum loop and a recursive factorial with the
trimmed sysroot.

## Notes

- The sysroot inside the tar is wasi-libc, multi-licensed under Apache-2.0
  WITH LLVM-exception, Apache-2.0, or MIT (it incorporates musl, MIT); the
  libc++ parts that were removed were Apache-2.0 WITH LLVM-exception.
- `bundle.js` is the upstream esbuild bundle of `@yowasp/runtime` (ISC) +
  `nanotar` (MIT, https://github.com/unjs/nanotar) + the generated YoWASP
  resource module; it is shipped unmodified.
