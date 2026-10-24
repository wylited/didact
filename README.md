# literate-website

A fully client-side, org-babel-style literate teaching site. A lesson is a
real Emacs org-mode file rendered in the browser: serif prose explaining a
concept, then executable code blocks the student edits and runs. No server,
no runtime network, no telemetry — parsing, assembly, execution, and
stepping all happen in the browser.

Every executable block owns its controls inline — **Run**, **Step**,
**Reset**, plus a monospace status line. **Run** executes to completion
(budget-bounded); **Step** advances exactly one instruction, highlighting
the executed line in the editor and the matching row in the under-the-hood
view; **Reset** restores that block's machine to its just-assembled state
(code is kept). Load errors are line-mapped under the block; output renders
in the block's `#+RESULTS:` slot. Machine state UI renders even before the
first run.

The **under-the-hood panel** is a right-hand pane attached to at most one
block — the last that ran or stepped — showing registers, flags,
disassembly, a `.data` hexdump, and a console. Every meaningful element
(registers, flags, listing rows, panel sections, statuses) carries a hover
tooltip explaining what is going on, and a **detach** button disconnects
the panel while blocks keep running independently; the next run or step
re-attaches.

Visual language is "textbook, light": light mode only, near-black on
white, hairline rules, no rounded corners, Atkinson Hyperlegible prose and
a monospace stack for code and machine state.

## Architecture

pnpm monorepo, TypeScript strict, no UI framework. Packages export source
TS (`main: src/index.ts`); `apps/site` typechecks and bundles everything —
no per-package build step.

```
packages/core            @literate/core          org parser, block runtime, panel host, textbook-light theme
packages/kernel-asm64    @literate/kernel-asm64  x86-64 kernel via Unicorn/Keystone/Capstone wasm
apps/site                @literate/site          the website (lesson.org + kernel registration)
```

Kernels plug in through the **Kernel / Session / Panel** contract owned by
core (`packages/core/src/kernel.ts`, reproduced in
[`docs/architecture.md`](docs/architecture.md)): a `Kernel` has an org
language `id` and creates single-tenant per-block `Session`s
(`load`/`run`/`step`/`reset`/`state`); `state()` returns a full `Panel[]`
snapshot — fields, listing, hexdump, or console sections — which core
renders generically.

### Adding a kernel

1. Implement `Kernel` and `Session` from the contract (`packages/kernel-asm64`
   is a worked example).
2. Register it in `apps/site/src/main.ts`:
   `mountSite({ root, orgSource, kernels: [asm64Kernel, yourKernel] })`.

Session methods are async today, so pyodide-style kernels need no contract
change later. The binding design contract — behavior, org grammar, theme —
is [`docs/design.md`](docs/design.md).

## Run

Requires pnpm.

```sh
pnpm install                        # from the repo root
# pnpm ≥12: if esbuild's install script is blocked, run: pnpm approve-builds
pnpm --dir apps/site dev            # dev server
pnpm --dir apps/site build          # tsc --noEmit && vite build → apps/site/dist
```

`apps/site/dist` is self-contained (`vite.config.ts` sets `base: './'`) —
serve it from any static file server or path; the only runtime fetches are
the vendored engine files.

**Vendored wasm.** The Unicorn/Keystone/Capstone engine files live in
`packages/kernel-asm64/vendor/` and are served as static assets from
`apps/site/public/vendor/`; if you update the vendor directory, copy it
over again. Licensing (Unicorn/Keystone GPL-2.0, Capstone BSD-3-Clause) is
documented in
[`packages/kernel-asm64/THIRD-PARTY.md`](packages/kernel-asm64/THIRD-PARTY.md).

## Org compatibility

Lessons are real org files that remain valid org-babel source in Emacs,
imported via Vite `?raw` and parsed client-side by the core org-subset
parser. The grammar (headings, `#+NAME:`, `#+BEGIN_SRC`/`#+END_SRC`,
`#+RESULTS:`, markup, lists, tables) is specified in
[`docs/design.md`](docs/design.md). A `#+BEGIN_SRC <lang>` block is
executable when `lang` matches a registered kernel id — `asm` for the
x86-64 kernel; other languages render read-only.

## History

The v0.1 prototypes (`x64-unicorn`, `x64-lite`, `riscv-lite`) are deleted
from the tree but preserved at git tag `v0.1`.
