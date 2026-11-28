# Vendored third-party assets

The engine ships as npm dependencies (exact versions pinned in
`package.json` and `pnpm-lock.yaml`): `@alexaltea/unicorn-js@2.1.4`,
`@alexaltea/keystone-js@0.9.2`, `@alexaltea/capstone-js@5.0.9`.
`@didact/vite` (`didactVendors()` / `didactVite()`)
serves the payload straight from `node_modules/` in dev and emits it into the
build output under `vendor/` (the loader in `src/vendor.ts` pins every URL to
the page base so
`vite dev`, `vite build`, and `vite preview` with `base: './'` all resolve
identically; override with `createAsm64Kernel({ vendorBase })` when hosting
assets elsewhere). `vendor/` here keeps only the license texts. The manifest
below records each file's upstream source — each was byte-identical to its npm
release when pinned.

## Manifest

| File | Package | Version | Source URL | License |
|---|---|---|---|---|
| `unicorn_x86.js` | `@alexaltea/unicorn-js` | 2.1.4 | https://unpkg.com/@alexaltea/unicorn-js@2.1.4/dist/unicorn_x86.js | GPL-2.0 |
| `LICENSE-unicorn-js.txt` | `@alexaltea/unicorn-js` | 2.1.4 | https://unpkg.com/@alexaltea/unicorn-js@2.1.4/LICENSE | GPL-2.0 |
| `keystone.js` | `@alexaltea/keystone-js` | 0.9.2 | https://unpkg.com/@alexaltea/keystone-js@0.9.2/dist/keystone.js | GPL-2.0 |
| `keystone.wasm` | `@alexaltea/keystone-js` | 0.9.2 | https://unpkg.com/@alexaltea/keystone-js@0.9.2/dist/keystone.wasm | GPL-2.0 (Keystone upstream is dual GPL-2.0/commercial) |
| `LICENSE-keystone-js.txt` | `@alexaltea/keystone-js` | 0.9.2 | https://unpkg.com/@alexaltea/keystone-js@0.9.2/LICENSE | GPL-2.0 |
| `capstone.js` | `@alexaltea/capstone-js` | 5.0.9 | https://unpkg.com/@alexaltea/capstone-js@5.0.9/dist/capstone.js | BSD-3-Clause |
| `capstone.wasm` | `@alexaltea/capstone-js` | 5.0.9 | https://unpkg.com/@alexaltea/capstone-js@5.0.9/dist/capstone.wasm | BSD-3-Clause |
| `LICENSE-capstone-js.txt` | `@alexaltea/capstone-js` | 5.0.9 | https://unpkg.com/@alexaltea/capstone-js@5.0.9/LICENSE | BSD-3-Clause |

Upstream projects: Unicorn engine <https://www.unicorn-engine.org/> (GPL-2.0),
Keystone engine <https://www.keystone-engine.org/> (GPL-2.0 / commercial),
Capstone <https://www.capstone-engine.org/> (BSD-3-Clause); JS ports by
Alexandro Sanchez Bach (<https://github.com/AlexAltea>).

## How each wrapper locates its WASM (verified from the shipped sources)

- **`unicorn_x86.js`** — a classic-script UMD build defining the global
  factory `MUnicorn`. The x86 WASM binary is *embedded* in the JS itself
  (`findWasmBinary()` → `binaryDecode(...)`), so no `.wasm` fetch happens.
- **`keystone.js` / `capstone.js`** — classic-script UMD builds defining
  `MKeystone` / `MCapstone`. By default each fetches `keystone.wasm` /
  `capstone.wasm` resolved through Emscripten's `locateFile()` (which falls
  back to the script's own directory). `src/vendor.ts` passes both an
  explicit `locateFile` (pinning the URL to `<base>/vendor/`) and a
  pre-fetched `wasmBinary`, so resolution never depends on
  `document.currentScript` or the page's base path.

## GPL-2.0 opt-in guidance

Unicorn and Keystone are licensed under **GPL-2.0**. Distributing these files
(including serving them from a public website) triggers the GPL's source-code
and license-notice obligations for those components; the upstream license texts
are copied alongside as `LICENSE-unicorn-js.txt` and `LICENSE-keystone-js.txt`.

Didact core (`@didact/core`), `@didact/vite`, `@didact/cli`, and all 12
pure-TypeScript kernels are **MIT-licensed**; `@didact/kernel-asm64` is
strictly opt-in. Sites that require permissive-only distribution should omit
`@didact/kernel-asm64` — use `@didact/kernel-riscv` or `@didact/kernel-mips`
for MIT-licensed assembly lessons with zero WASM dependencies.
