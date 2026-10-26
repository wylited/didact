# AGENTS.md — working in this repo

pnpm monorepo. TypeScript strict, no UI framework, Vite only at the app layer.
Packages ship **source TS** (`main: src/index.ts`); only `apps/site` builds —
one `tsc --noEmit` + `vite build` covers everything. No per-package build step.

## Repo map

- `packages/core` — `@didact/core`: org parser, block runtime, panel host, theme.
- `packages/kernel-asm64` — `@didact/kernel-asm64`: x86-64 kernel on vendored Unicorn/Keystone/Capstone wasm.
- `packages/kernel-riscv` — `@didact/kernel-riscv`: RV32IM interpreter kernel (pure TypeScript).
- `packages/kernel-mips` — `@didact/kernel-mips`: MIPS32 interpreter kernel (SPIM/MARS-style, pure TypeScript).
- `packages/kernel-c` — `@didact/kernel-c`: C kernel on the clang wasm engine.
- `packages/kernel-cpp` — `@didact/kernel-cpp`: C++ kernel on the same clang wasm engine (libc++, c++20, no exceptions).
- `packages/kernel-javascript` — `@didact/kernel-javascript`: JavaScript teaching-subset interpreter kernel (pure TypeScript).
- `packages/kernel-lisp` — `@didact/kernel-lisp`: Scheme-flavored Lisp interpreter kernel with cons-heap panels (pure TypeScript).
- `packages/kernel-python` — `@didact/kernel-python`: Python kernel on vendored Pyodide.
- `packages/kernel-typst` — `@didact/kernel-typst`: Typst kernel on typst wasm + fonts.
- `packages/kernel-wasm` — `@didact/kernel-wasm`: WebAssembly WAT-subset stack-machine interpreter kernel (pure TypeScript).
- `packages/kernel-sql` — `@didact/kernel-sql`: SQL teaching engine with per-row plan panels (pure TypeScript).
- `packages/kernel-matlab` — `@didact/kernel-matlab`: MATLAB-flavored matrix interpreter with column-major memory panels (pure TypeScript).
- `packages/kernel-lua` — `@didact/kernel-lua`: Lua teaching-subset interpreter kernel (pure TypeScript).
- `packages/kernel-regex` — `@didact/kernel-regex`: Thompson-NFA regex engine with state-set panels (pure TypeScript).
- `packages/kernel-prolog` — `@didact/kernel-prolog`: SLD-resolution Prolog engine with choice-point panels (pure TypeScript).
- `apps/site` — `@didact/site`: the website; `src/pages/*.org` + kernel registration only.

## Kernel contract

The rendering↔execution interface lives in `packages/core/src/kernel.ts`
(`Kernel`, `Panel`, `Field`, `ListingRow`, `LoadResult`). Read it and
`docs/architecture.md` before touching how blocks run or render panels.

## Recipe: add a kernel

1. Create `packages/kernel-<name>/` with `package.json` — `private: true`,
   `main: "src/index.ts"`, `types: "src/index.ts"` (copy any existing
   `packages/kernel-*/package.json` as a pattern). Add a local
   `src/types.ts` mirror of the `Kernel`/`Session` contract so the package
   typechecks standalone (see `packages/kernel-mips/src/types.ts` for the
   pattern); it MUST stay byte-identical to `packages/core/src/kernel.ts`
   (enforced by `packages/core/test/mirror.test.ts`).
2. Implement the `Kernel` interface in `src/kernel.ts` and export it from
   `src/index.ts` (see the contract in `packages/core/src/kernel.ts`). The
   kernel's `id` must match the org `#+BEGIN_SRC <lang>` word; declare
   `editorSyntax` with one of the ids supported in
   `packages/core/src/languages.ts` (`asm-intel`, `asm-riscv`, `asm-mips`,
   `c`, `cpp`, `javascript`, `python`, `scheme`, `plain`;
   missing/unknown → plain text).
3. Declare the wasm engine as an npm dependency of the kernel package
   (exact version, no caret) and record licenses in `THIRD-PARTY.md`;
   keep license texts under `packages/kernel-<name>/vendor/`. Add the
   `node_modules → public` file mapping to `GROUPS` in
   `scripts/sync-vendors.mjs`; it copies the files into
   `apps/site/public/vendor-<name>/` automatically on `pnpm dev`/`pnpm
   build` (git-ignored build inputs). Engine payload never lives in git —
   `pnpm-lock.yaml` pins versions and integrity.
4. Add `"@didact/kernel-<name>": "workspace:*"` to `apps/site/package.json`
   dependencies.
5. Add `@didact/kernel-<name>` → `../../packages/kernel-<name>/src` to
   both `apps/site/tsconfig.json` `paths` and `apps/site/vite.config.ts`
   `resolve.alias`.
6. Register it in `apps/site/src/main.ts`: import the kernel and add it to
   the `kernels` array passed to `mountSite`.

## Recipe: add a page

1. Drop `<name>.org` into `apps/site/src/pages/` with a `#+TITLE:` line
   (the title falls back to the file stem).
2. Add the file stem to the `PAGE_ORDER` array in `apps/site/src/main.ts` —
   that array defines the nav order. A globbed `.org` missing from
   `PAGE_ORDER` logs a console warning and is skipped; an entry whose file
   is missing logs a warning and is skipped too; the mount only hard-errors
   when zero pages resolve.
3. Content: org-mode prose with `#+BEGIN_SRC <lang>` blocks; a block is
   executable when `lang` matches a registered kernel id.

## Style

- Textbook-light visual language: white background, no border radius, no
  accent color. Atkinson Hyperlegible for text, a mono face for code
  (`packages/core/src/theme.css` owns the tokens).
- Three-rail site chrome: left page-nav rail, center document, right rail
  hosting the page TOC — which yields to the machine panel while a block's
  panel is attached (`packages/core/src/site.ts`).
- DOM hooks for tests/tools use `data-test` attributes
  (e.g. `data-test="results"` on results slots, `.lw-block-slot` mounts).
- No UI framework; hand-written DOM in `packages/core/src/*.ts`.

## Gates

Run from the repo root before handing off:

```
pnpm typecheck   # apps/site tsc --noEmit, covers all packages
pnpm build       # apps/site production build
pnpm test        # vitest run (packages/*/test)
pnpm lint        # eslint .
```

If pnpm blocks a postinstall (e.g. esbuild), run `pnpm approve-builds --all -y`.

## Test policy

Tests are behavioral: assert exact nodes, exact bytes/addresses, exact error
lines and messages — never snapshots of implementation details or tautologies.
A failing test must explain the regression from its diff alone. Tests
needing DOM opt in per file with `// @vitest-environment happy-dom`; default
environment is node. The assembler tests inject a deterministic fake
`KeystoneFacade` so layout/resolution logic is asserted without wasm.

## Vendor policy

Runtime assets are npm dependencies pinned by `pnpm-lock.yaml`;
`scripts/sync-vendors.mjs` materializes them as static files under the
app's `public/` at build time. Licenses are recorded in each package's
`THIRD-PARTY.md`, with texts under `vendor/`. No CDN and no network
requests at runtime beyond same-origin asset fetches.
