# Architecture (v0.2) — kernel-extensible literate system

pnpm monorepo, TypeScript strict everywhere, no UI framework, Vite only at
the app layer. Packages export **source TS** (`main: src/index.ts`); the app
typechecks and bundles them — no per-package build step, no dist artifacts.

```
packages/core              @didact/core             org parser, block runtime, panel host, theme
packages/kernel-asm64      @didact/kernel-asm64      x86-64 via Unicorn/Keystone/Capstone wasm
packages/kernel-riscv      @didact/kernel-riscv      RV32IM interpreter (pure TypeScript)
packages/kernel-mips       @didact/kernel-mips       MIPS32 interpreter (pure TypeScript)
packages/kernel-c          @didact/kernel-c          C via vendored clang wasm (wasm32-wasi)
packages/kernel-cpp        @didact/kernel-cpp        C++ via the same clang engine (libc++, -fno-exceptions)
packages/kernel-javascript @didact/kernel-javascript JavaScript teaching-subset interpreter (pure TypeScript)
packages/kernel-lisp       @didact/kernel-lisp       Scheme-flavored Lisp interpreter, cons-heap panels (pure TypeScript)
packages/kernel-python     @didact/kernel-python     Python via vendored Pyodide
packages/kernel-typst      @didact/kernel-typst      Typst via vendored compiler wasm + fonts
apps/site                  @didact/site             the website (src/pages/*.org + kernel registration)
```

Wiring: app aliases `@didact/core` and each `@didact/kernel-*` →
`../../packages/*/src` (tsconfig `paths` + vite `resolve.alias`); one
`tsc --noEmit` in `apps/site` covers all packages (include
`../../packages/*/src`).

## Kernel contract (owned by core)

The single source of truth is `packages/core/src/kernel.ts`: `Kernel`,
`Session`, and the five `Panel` kinds (`fields`, `listing`, `hexdump`,
`console`, `html`), plus `Field`, `ListingRow`, `LoadResult`, `RunResult`.
Read that file before touching how blocks run or render panels.

Every kernel package keeps a byte-identical mirror at `src/types.ts` (so it
typechecks standalone); `packages/core/test/mirror.test.ts` fails on drift.

Rules: sessions are single-tenant (one per block); `state()` must be cheap
and complete (core re-renders the whole panel from it); async signatures
today so pyodide-style kernels need no contract change later.

## Core responsibilities (`@didact/core`)


- `parseOrg(src): OrgDoc` — grammar per `docs/design.md`.
- `mountSite({ root, fonts?, kernels, pages })` → renders the nav bar +
  active page document, block runtimes, panel host. Handle exposes
  `blocks`, `panel`, `activeIndex`, `show(index)`, `dispose()`.
- Block runtime: CodeMirror 6 editor (Ayu Light), per-block controls +
  status + error box + results slot; running/attached highlights; current
  line decoration on step and breakpoint pause; gutter breakpoints when
  `features.breakpoints` (Step button hidden when `features.stepping ===
  false`); `data-test` hooks.
- Panel host: renders `Session.state()` panels (generic renderers for the
  five Panel kinds, `html` via trusted `innerHTML`), attach/detach
  (detach unmounts the panel and collapses the layout), global tooltip
  engine for `[data-tip]` — comment-only tooltips on listing rows.
- Styles: the textbook-light theme (CSS custom properties, no radius,
  Atkinson Hyperlegible via @fontsource import, mono stack for code/panel,
  nav bar + detached single-column state).

## kernel-asm64 responsibilities

- unicorn/keystone/capstone wasm come from npm deps (`@alexaltea/*`,
  licenses in THIRD-PARTY.md + `vendor/` texts), copied to
  `apps/site/public/vendor/` for serving by `scripts/sync-vendors.mjs`
  (run automatically by `pnpm dev`/`pnpm build`); load via ES imports the
  app can code-split; loading must stay fetch-free where possible.
- Two-pass keystone label resolution, syscall interception, budget,
  stepping (HOOK_CODE), context restore — shaped to `Kernel`/`Session`.
- Panel data: registers fields, EFLAGS fields, disassembly listing
  (row `tip` = the source line's trailing `;` comment), .data hexdump,
  console.
- Exports `asm64Kernel: Kernel` (id `'asm'`, editorSyntax `'asm-intel'`).

## apps/site responsibilities

- Thin composition: glob `src/pages/*.org` raw, order them by the
  `PAGE_ORDER` array in `src/main.ts` (stems of the page files; the nav
  title comes from each file's `#+TITLE:` line), register
  `[asm64Kernel, riscvKernel, mipsKernel, cKernel, cppKernel,
  pythonKernel, jsKernel, lispKernel, typstKernel]`, mount with `pages`.
- `src/pages/*.org`: one lesson per kernel (`x86-64-assembly`, `riscv`,
  `mips`, `c`, `cpp`, `python`, `javascript`, `lisp`, `typst`), with
  per-block controls, breakpoints, panel attach/detach, pages.
- index.html (noscript in body), favicon optional, title plain text.
