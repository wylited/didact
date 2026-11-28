# didact

A browser-only literate-programming framework. Write lessons in Org mode
(`.org`) with runnable, steppable code blocks that drive a live inspector
(registers, memory, query plans, call stacks, console output, and more). No
backend, and no runtime network requests beyond same-origin vendor assets.

Live examples: **[wylited.github.io/didact](https://wylited.github.io/didact/)**

Guides: [**Getting started**](docs/getting-started.md) · [**Authoring lessons**](docs/authoring.md) · [**Theming**](docs/theming.md) · [**`didact check`**](docs/check.md) · [**Architecture**](docs/architecture.md)

Seventeen kernels ship out of the box: x86-64, RV32IM, MIPS32, C, C++,
Fortran, WebAssembly, Python, SQL, MATLAB, Lua, JavaScript, regex, Lisp,
Emacs Lisp, Prolog, and Typst. Parsing, assembly, execution, and stepping
are all client-side.

## Using Didact in your own site

Install `@didact/core`, the kernels you want, and `@didact/vite` + `vite`, add
`didactVite()` to `vite.config.ts`, write `.org` lessons under `src/pages/`,
and mount them with `mountSite()` + `resolvePages()`:

```sh
pnpm add @didact/core @didact/kernel-javascript @didact/kernel-python
pnpm add -D @didact/vite vite
```

Follow the copy-paste walkthrough in [`docs/getting-started.md`](docs/getting-started.md)
for the full `vite.config.ts`, `index.html`, `src/env.d.ts`, `src/main.ts`,
and starter `.org` page.

## Running the showcase monorepo locally

Requires Node 24+ and pnpm 12 (pinned in `package.json`: `engines`,
`packageManager`).

```sh
pnpm install
pnpm dev
```

Open the printed URL. (esbuild's build script is pre-approved in
`pnpm-workspace.yaml`; if pnpm asks anyway, run `pnpm approve-builds` once.)

`pnpm build` emits a fully static site to `apps/site/dist` — `base` is
`'./'`, so it hosts anywhere, at any path. `pnpm preview` checks the build.

## Kernels

| id | label | editor syntax | package | vendor assets |
| --- | --- | --- | --- | --- |
| `asm` | x86-64 · Unicorn | `asm-intel` | `packages/kernel-asm64` | `vendor/` (~8.6 MB, unicorn/keystone/capstone wasm) |
| `riscv` | RV32IM · interpreter | `asm-riscv` | `packages/kernel-riscv` | none (pure TypeScript CPU) |
| `mips` | MIPS32 · interpreter | `asm-mips` | `packages/kernel-mips` | none (pure TypeScript CPU) |
| `c` | C · clang wasm | `c` | `packages/kernel-c` | `vendor-c/clang/` (~105 MB, clang → wasm32-wasip1) |
| `cpp` | C++ · clang wasm | `cpp` | `packages/kernel-cpp` | shares `vendor-c/clang/` with `c` (same clang engine) |
| `fortran` | Fortran · interpreter | `fortran` | `packages/kernel-fortran` | none (pure TypeScript interpreter) |
| `python` | Python · Pyodide | `python` | `packages/kernel-python` | `vendor-python/` (~13 MB, CPython 3.14 wasm) |
| `wasm` | WebAssembly · interpreter | `wat` | `packages/kernel-wasm` | none (pure TypeScript interpreter) |
| `sql` | SQL · query engine | `sql` | `packages/kernel-sql` | none (pure TypeScript engine) |
| `matlab` | MATLAB · interpreter | `octave` | `packages/kernel-matlab` | none (pure TypeScript interpreter) |
| `lua` | Lua · interpreter | `lua` | `packages/kernel-lua` | none (pure TypeScript interpreter) |
| `javascript` | JavaScript · interpreter | `javascript` | `packages/kernel-javascript` | none (pure TypeScript interpreter) |
| `regex` | Regex · NFA engine | `regexp` | `packages/kernel-regex` | none (pure TypeScript Thompson NFA) |
| `lisp` | Lisp · interpreter | `scheme` | `packages/kernel-lisp` | none (pure TypeScript interpreter) |
| `elisp` | Emacs Lisp · interpreter | `scheme` | `packages/kernel-elisp` | none (pure TypeScript interpreter) |
| `prolog` | Prolog · interpreter | `prolog` | `packages/kernel-prolog` | none (pure TypeScript SLD engine) |
| `typst` | Typst · wasm | `typst` | `packages/kernel-typst` | `vendor-typst/` (~25 MB, compiler wasm + fonts) |

Syntax modes: each `editorSyntax` id maps to a CodeMirror mode in
`packages/core/src/languages.ts` (assembly dialects in `asm.ts`, the
sql/regexp/WAT/Typst/Prolog modes in `packages/core/src/modes.ts`, the rest
from `@codemirror/legacy-modes` or Lezer grammars); `plain` is the no-mode
fallback, but no kernel currently declares it. The full matrix, with each
kernel's panel depth, is in [`docs/languages.md`](docs/languages.md).

Engine payloads are npm dependencies pinned by `pnpm-lock.yaml` — the
repository itself is source-only. `@didact/vite` (`didactVite()` /
`didactVendors()`) serves required WASM assets straight from `node_modules` in
dev and emits them into `dist/` on build (never writing to `public/`). Every
WASM kernel exports both a default singleton and a
`create<Name>Kernel({ vendorBase })` factory for custom asset URLs.

Nine kernels support org-babel `:session <name>` shared state across blocks on
a page: `python`, `fortran`, `sql`, `matlab`, `elisp`, `prolog`, `lisp`, `lua`,
and `javascript`.

## Authoring a page

Drop your `.org` file into `apps/site/src/pages/` and add its file stem to
the `PAGE_ORDER` array in `apps/site/src/main.ts` — the file appears in the
nav at that position, titled from its `#+TITLE:` (file stem as fallback).
`resolvePages(sources, order)` in `@didact/core` resolves globbed `.org` files
against an explicit page order, logging a console warning for any missing or
unlisted file. A block is executable when its `#+BEGIN_SRC <lang>`
language matches a registered kernel; other languages render read-only.

```org
#+TITLE: Hello, registers
#+SUBTITLE: one instruction at a time

The =mov= instruction copies a value into a register.

* Try it

Step through this block and watch =rax= change:

#+NAME: hello
#+BEGIN_SRC asm
; put a value in rax, then exit cleanly
mov rax, 42
mov rax, 60
mov rdi, 0
syscall
#+END_SRC

#+RESULTS:
```

Output replaces the block's `#+RESULTS:` slot when it runs. Lessons stay
valid org-babel documents in Emacs. Cross-page prose uses org's file-link
syntax, `[[file:python.org][Python]]` or a section of another lesson with
`[[file:python.org::*Execution traces and loop-variable scope][loops]]`;
`[[*Heading]]` links within the current page and `[[https://…]]` links out.
See [`docs/authoring.md`](docs/authoring.md) for the complete authoring guide
(and [`docs/design.md`](docs/design.md) for the binding spec). Unsupported org
constructs are reported in a banner on the page and by `didact check`.

## Learner features

- **Saved edits.** Every executable block mirrors its editor text into
  best-effort `localStorage` and restores it next visit. Drafts follow the
  block, not its position on the page.
- **Block controls.** Each executable block header carries `▶ Run`, `⤵ Step`
  (when the kernel supports stepping), `⟲` (Reset session — resets the block's
  session and clears output while keeping editor text), `↺` (Revert code —
  restores the org sample and drops the saved draft while leaving the session
  and output untouched), and `⧉` (Copy code).
- **Keys and undo/redo.** Cmd/Ctrl+Enter runs the block, Shift+Enter steps
  one unit where the kernel supports stepping, and Cmd/Ctrl+Z /
  Cmd/Ctrl+Shift+Z (or Ctrl+Y) undo and redo edits in every block editor.
- **Hints and solutions.** `#+BEGIN_HINT` and `#+BEGIN_SOLUTION` folds
  start closed and may hold prose, lists, tables, and executable blocks.
- **Exercises.** `#+EXERCISE` titles a drill and `#+CHECK` gives the
  expected console output. Run checks the output; the badge reads
  pending/running/passed/failed, or unchecked when the block has no check.
- **Search.** The field above the rail's Contents/Pages switch searches
  page titles and prose — including fold bodies and code — and replaces the
  nav list with at most ten hits.
- **Lesson navigation and completion.** The page footer links Previous and
  Next in page order and reports `Exercises n/m`. Pages without checked
  exercises get a manual Mark complete toggle; completed pages carry a ✓
  in the Pages rail.

## Storage keys and lesson directives

Storage is best-effort: private mode, a sandboxed frame, or a full quota
never breaks a block; that state simply does not survive a reload. Every key
uses `storagePrefix` (default `'didact:'` in `mountSite`), so multiple sites
on one origin can isolate their state with distinct prefixes (or disable
persistence with `storage: null`).

| key | value |
| --- | --- |
| `<prefix>code:<id>` (default `didact:code:<id>`) | one block's edited source (removed again when it matches the sample) |
| `<prefix>progress:<page-file-or-slug>` (default `didact:progress:…`) | one page's `{ "passed": [<block id>…], "manual": boolean }` |
| `<prefix>nav-side` (default `didact:nav-side`) | the navigator side (`left` / `right`) chosen with the rail's side toggle |
| `<prefix>nav-hidden` (default `didact:nav-hidden`) | `'1'` while the navigation sidebar is collapsed (removed when shown) |

`<id>` is the page key (`PageSpec.file` when present, else the URL slug)
plus either `:n:<name>` for a block whose `#+NAME:` is unique on the page,
or `:h:<content-hash>:<occurrence>` for an unnamed or duplicated block.
Renaming a block or editing its org sample therefore starts a fresh
identity.

The learner-facing org directives are all optional: `#+BEGIN_HINT` …
`#+END_HINT`, `#+BEGIN_SOLUTION` … `#+END_SOLUTION`, `#+EXERCISE: <title>`,
and `#+CHECK: <expected output>` (`#+EXERCISE:` and `#+CHECK:` apply to the
next src block and clear after it). See [`docs/authoring.md`](docs/authoring.md)
for examples and details.

## Adding a kernel

Follow the recipe in [`AGENTS.md`](AGENTS.md) — package layout, vendored
wasm assets, and registration in `apps/site`. The Kernel/Session/Panel
contract those steps implement is specified in
[`docs/architecture.md`](docs/architecture.md) and
[`packages/core/src/kernel.ts`](packages/core/src/kernel.ts).

## Deploy to GitHub Pages

The repo ships [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml),
which builds and publishes the site on every push to `main` (and on manual
`workflow_dispatch`). One-time
setup: repo Settings → Pages → Build and deployment → Source:
**GitHub Actions**. The site then lives at
`https://<owner>.github.io/didact/`; no other config needed.

## Tests & quality

- `pnpm test` — vitest suite plus kernel smoke scripts (the smokes need
  [bun](https://bun.sh) on PATH)
- `pnpm check` — lints every `.org` lesson page via `@didact/cli` (`didact check`)
- `pnpm verify` — lints and executes Python blocks against canned `#+RESULTS:`
  and `#+CHECK:` expectations (`didact check --run`)
- `pnpm lint` — eslint across the repo
- `pnpm typecheck` — two `tsc --noEmit` runs: the apps/site DOM config
  (covers `packages/*/src`) and `tsconfig.typst.json` (build pipeline)
- `pnpm typst:check` — compiles every page's Typst math/diagrams and runs
  the structural gate

## License & Third-Party Engines

Didact itself (`@didact/core`, `@didact/vite`, `@didact/cli`, and all 12
pure-TypeScript kernels) is licensed under the **[MIT License](LICENSE)**.

The 5 optional WASM kernels load third-party engines lazily at runtime; each
package ships a `THIRD-PARTY.md` manifest:

| Kernel(s) | Engine | Payload | License |
| --- | --- | --- | --- |
| 12 pure-TS kernels (`riscv`, `mips`, `fortran`, `wasm`, `sql`, `matlab`, `lua`, `javascript`, `regex`, `lisp`, `elisp`, `prolog`) | Pure TypeScript | 0 B | MIT |
| `c`, `cpp` | `@yowasp/clang` (shared) | ~105 MB | Apache-2.0 WITH LLVM-exception / MIT / ISC |
| `typst` | `typst-wasm` + fonts | ~25 MB | MIT + Apache-2.0 + SIL OFL 1.1 / GUST / Bitstream Vera |
| `python` | Pyodide (CPython 3.14) | ~13 MB | MPL-2.0 + PSF-2.0 |
| `asm` *(opt-in)* | Unicorn + Keystone + Capstone | ~8.6 MB | **GPL-2.0** (Unicorn, Keystone) + BSD-3-Clause (Capstone) |

Sites that require permissive-only licensing can omit `@didact/kernel-asm64`
(and `@didact/kernel-python` if avoiding MPL-2.0) — the 12 pure-TS MIT kernels
plus `c`, `cpp`, and `typst` carry no copyleft dependencies.
