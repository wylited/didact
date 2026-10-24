# AGENTS.md — working in this repo

pnpm monorepo. TypeScript strict, no UI framework, Vite only at the app layer.
Packages ship **source TS** (`main: src/index.ts`); only `apps/site` builds —
one `tsc --noEmit` + `vite build` covers everything. No per-package build step.

## Repo map

- `packages/core` — `@literate/core`: org parser, block runtime, panel host, theme.
- `packages/kernel-asm64` — `@literate/kernel-asm64`: x86-64 kernel on vendored Unicorn/Keystone/Capstone wasm.
- `apps/site` — `@literate/site`: the website; lesson.org + kernel registration only.

## Kernel contract

The rendering↔execution interface lives in `packages/core/src/kernel.ts`
(`Kernel`, `Panel`, `Field`, `ListingRow`, `LoadResult`). Read it and
`docs/architecture.md` before touching how blocks run or render panels.

## Recipe: add a kernel

1. `packages/kernel-<name>/package.json` — `private: true`, `main: "src/index.ts"`,
   `types: "src/index.ts"` (copy `packages/kernel-asm64/package.json` as a pattern).
2. Implement the `Kernel` interface from `@literate/core` in
   `src/kernel.ts` (language id, engine loading, `assemble`/step via the
   contract in `packages/core/src/kernel.ts`); export it from `src/index.ts`.
   Vendor any wasm engines under `vendor/` and record licenses in `THIRD-PARTY.md`.
3. Register it in `apps/site/src/main.ts`: add the kernel to the `kernels`
   array passed to `mountSite`.
4. Write the lesson content as org-mode `#+BEGIN_SRC <lang>` blocks in
   `apps/site/src/lesson.org` (or a lesson package of your own).

## Recipe: add a page

1. New app under `apps/<name>` (copy `apps/site/package.json`, point the
   workspace deps at the packages you use).
2. `index.html` with a `#root` div; `src/main.ts` that imports the lesson
   (`.org?raw`) and calls `mountSite({ root, orgSource, kernels })`.
3. Alias `@literate/*` → `../../packages/*/src` in tsconfig `paths` and vite
   `resolve.alias` (see `apps/site`).
4. Root script: `"dev:<name>": "pnpm --dir apps/<name> dev"`.

## Style

- Textbook-light visual language: white background, no border radius, no
  accent color. Atkinson Hyperlegile for text, a mono face for code
  (`packages/core/src/theme.css` owns the tokens).
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

All runtime assets are local static files under `vendor/` (served by the app's
`public/`). Licenses recorded in each package's `THIRD-PARTY.md`. No CDN and
no network requests at runtime beyond same-origin asset fetches.
