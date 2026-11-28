# AGENTS.md — working in this repo

pnpm monorepo. TypeScript strict, no UI framework, Vite only at the app layer.
Packages ship **source TS** (`main: src/index.ts`); only `apps/site` builds —
one DOM `tsc --noEmit`, one Node `tsc -p apps/site/tsconfig.typst.json` for the
build pipeline, and `vite build` cover everything. No per-package build step
for development.

Publishing the packages needs compiled output, because Node never strips types
inside `node_modules`: `pnpm build:packages` (`tsdown.config.ts`) derives one
bundled ESM entry per manifest `exports`/`main`/`bin` target and emits
`packages/*/dist` (declared dependencies stay external; `?raw` imports are
inlined). Each manifest's `publishConfig` points `main`/`types`/`exports`/`bin`
at `dist/`, and `files` ships `dist` (plus `vendor/` license texts where they
exist); `pnpm publish` applies those overrides and rewrites `workspace:*`.
`apps/site` is private and never published.

## Repo map

- `packages/core` — `@didact/core`: org parser, block runtime, panel host, theme, `resolvePages`.
- `packages/cli` — `@didact/cli`: Node 24 native `didact check` CLI for linting `.org` pages and verifying `#+RESULTS:` / `#+CHECK:` blocks.
- `packages/vite` — `@didact/vite`: reusable Vite plugins (`didactVite`, `didactTypst`, `didactVendors`) and the Node build-time Typst prerender pipeline (`src/typst/`).
- `packages/kernel-asm64` — `@didact/kernel-asm64`: x86-64 kernel on vendored Unicorn/Keystone/Capstone wasm (GPL-2.0 opt-in).
- `packages/kernel-riscv` — `@didact/kernel-riscv`: RV32IM interpreter kernel (pure TypeScript).
- `packages/kernel-mips` — `@didact/kernel-mips`: MIPS32 interpreter kernel (SPIM/MARS-style, pure TypeScript).
- `packages/kernel-c` — `@didact/kernel-c`: C kernel on the clang wasm engine.
- `packages/kernel-cpp` — `@didact/kernel-cpp`: C++ kernel on the same clang wasm engine (libc++, c++20, no exceptions).
- `packages/kernel-fortran` — `@didact/kernel-fortran`: Fortran 90/95/2003 teaching interpreter (free-form source, column-major array panels; pure TypeScript).
- `packages/kernel-javascript` — `@didact/kernel-javascript`: JavaScript teaching-subset interpreter kernel (pure TypeScript).
- `packages/kernel-lisp` — `@didact/kernel-lisp`: Scheme-flavored Lisp interpreter kernel with cons-heap panels (pure TypeScript).
- `packages/kernel-elisp` — `@didact/kernel-elisp`: Emacs Lisp teaching kernel (Lisp-2, dynamic/lexical binding, macros, simulated buffers/hooks/keymaps; pure TypeScript).
- `packages/kernel-python` — `@didact/kernel-python`: Python kernel on vendored Pyodide.
- `packages/kernel-typst` — `@didact/kernel-typst`: Typst kernel on typst wasm + fonts.
- `packages/kernel-wasm` — `@didact/kernel-wasm`: WebAssembly WAT-subset stack-machine interpreter kernel (pure TypeScript).
- `packages/kernel-sql` — `@didact/kernel-sql`: SQL teaching engine with per-row plan panels (pure TypeScript).
- `packages/kernel-matlab` — `@didact/kernel-matlab`: MATLAB-flavored matrix interpreter with column-major memory panels (pure TypeScript).
- `packages/kernel-lua` — `@didact/kernel-lua`: Lua teaching-subset interpreter kernel (pure TypeScript).
- `packages/kernel-regex` — `@didact/kernel-regex`: Thompson-NFA regex engine with state-set panels (pure TypeScript).
- `packages/kernel-prolog` — `@didact/kernel-prolog`: SLD-resolution Prolog engine with choice-point panels (pure TypeScript).
- `apps/site` — `@didact/site`: the showcase website — 17 lesson pages (`src/pages/*.org`, one per kernel including `fortran.org`), kernel registration in `src/main.ts`, `vite.config.ts` (wired via `@didact/vite`), `index.html`.

## Kernel contract

The rendering↔execution interface lives in `packages/core/src/kernel.ts`
(`Kernel`, `Panel`, `Field`, `ListingRow`, `LoadResult`). Read it and
`docs/architecture.md` before touching how blocks run or render panels.

## Recipe: add a kernel

1. Create `packages/kernel-<name>/` with `package.json` — `"type": "module"`,
   `"main": "src/index.ts"`, `"types": "src/index.ts"`, and
   `"exports": { ".": "./src/index.ts" }` (copy any existing
   `packages/kernel-*/package.json` as a pattern; workspace packages are
   publishable, not `private: true`). Add a local `src/types.ts` mirror of
   the `Kernel`/`Session` contract so the package typechecks standalone (see
   `packages/kernel-mips/src/types.ts` for the pattern); the contract text
   from `/** One rendered under-the-hood section. */` to EOF MUST stay
   byte-identical to `packages/core/src/kernel.ts` (each mirror keeps its
   own short header; enforced by `packages/core/test/mirror.test.ts`).
2. Implement the `Kernel` interface in `src/kernel.ts` and export it from
   `src/index.ts` (see the contract in `packages/core/src/kernel.ts`). The
   kernel's `id` must match the org `#+BEGIN_SRC <lang>` word; declare
   `editorSyntax` with one of the ids supported in
   `packages/core/src/languages.ts` (`asm-intel`, `asm-riscv`, `asm-mips`,
   `c`, `cpp`, `fortran`, `javascript`, `lua`, `octave`, `python`, `prolog`,
   `regexp`, `scheme`, `sql`, `typst`, `wat`, `plain`; missing/unknown →
   plain text).
3. For WASM kernels, declare the engine as an npm dependency of the kernel
   package (exact version, no caret) and record licenses in `THIRD-PARTY.md`;
   keep upstream license texts under `packages/kernel-<name>/vendor/` when
   the upstream ships them. Add the asset group to `@didact/vite`
   (`packages/vite/src/vendors.ts`), which serves the files directly from
   `node_modules` in dev and emits them into `dist/vendor-<name>/` on build
   (never writing to `public/`; asm64 keeps the historical `vendor/`, c/cpp
   share `vendor-c/clang/`). Export a `create<Name>Kernel({ vendorBase })`
   factory alongside the default singleton. Engine payload never lives in
   git — `pnpm-lock.yaml` pins versions and integrity.
4. Add `"@didact/kernel-<name>": "workspace:*"` to `apps/site/package.json`
   dependencies (pnpm workspace `exports` wire up both TypeScript and Vite
   automatically — no `tsconfig.json` `paths` or `vite.config.ts`
   `resolve.alias` needed). If it is a WASM kernel, also add its id to
   `kernels` in `apps/site/vite.config.ts`.
5. Register it in `apps/site/src/main.ts`: import the kernel and add it to
   the `kernels` array passed to `mountSite`.
6. Add `test/` (vitest; the root config globs `packages/*/test/**`) and, for
   headless-capable kernels, `test/smoke.ts` plus a
   `bun packages/kernel-<name>/test/smoke.ts` clause in the root
   `test:smoke` script (all pure-TS kernels including `kernel-elisp`, plus
   headless WASM kernels `kernel-python`, `kernel-c`, `kernel-cpp`).

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
- Site chrome: one navigation rail (left by default, movable to the right
  with the header's side toggle, remembered in localStorage), the document,
  and the panel rail beside the document (the page's right edge while the
  navigator stays left), which goes wide while a block's panel is attached.
  The navigation rail shows ONE list at a time — the page's contents, the
  page list, or live search results — chosen by the `Contents | Pages`
  switch in its header; both lists stay tree-shaped and share one rhythm
  (`packages/core/src/site.ts`, `theme.css`).
- DOM hooks for tests/tools use `data-test` attributes
  (e.g. `data-test="results"` on results slots) and `.lw-*` classes for
  mount points (`.lw-block-slot`).
- No UI framework; hand-written DOM in `packages/core/src/*.ts`.

## Gates

Run from the repo root before handing off:

```
pnpm typecheck   # apps/site tsc --noEmit (DOM) + tsconfig.typst.json (Node)
pnpm build       # apps/site production build
pnpm test        # vitest run (packages/*/test) then test:smoke (needs bun; includes kernel-elisp)
pnpm check       # org lesson linter via @didact/cli (didact check)
pnpm verify      # org linter + Python #+RESULTS:/#+CHECK: verification (didact check --run)
pnpm lint        # eslint .
pnpm typst:check # typst content gate (packages/vite/src/typst/cli.ts)
```

esbuild's build script is pre-approved in `pnpm-workspace.yaml`; if pnpm asks
about another postinstall, run `pnpm approve-builds`.

## Test policy

Tests are behavioral: assert exact nodes, exact bytes/addresses, exact error
lines and messages — never snapshots of implementation details or tautologies.
A failing test must explain the regression from its diff alone. Tests
needing DOM opt in per file with `// @vitest-environment happy-dom`; default
environment is node. The assembler tests inject a deterministic fake
`KeystoneFacade` so layout/resolution logic is asserted without wasm.

## Vendor policy

Runtime assets are npm dependencies pinned by `pnpm-lock.yaml`;
`@didact/vite` (`didactVendors()` / `didactVite()`) serves them straight from
`node_modules` during `pnpm dev` and emits them into `dist/` on `pnpm build`
(never writing to `public/`). Licenses for vendored engines are recorded in
that package's `THIRD-PARTY.md` (`kernel-asm64`, `kernel-c`, `kernel-cpp`,
`kernel-python`, `kernel-typst`), with upstream license texts under `vendor/`
where the package ships one (`kernel-python` links them by URL instead). No
CDN and no network requests at runtime beyond same-origin asset fetches.
