# didact

A browser-only literate-programming framework. Write lessons in Org mode
(`.org`) with runnable, steppable code blocks that drive a live inspector
(registers, memory, query plans, call stacks, console output, and more). No
backend, and no runtime network requests beyond same-origin vendor assets.

Live examples: **[wylited.github.io/didact](https://wylited.github.io/didact/)**

Seventeen kernels ship out of the box: x86-64, RV32IM, MIPS32, C, C++,
Fortran, WebAssembly, Python, SQL, MATLAB, Lua, JavaScript, regex, Lisp,
Emacs Lisp, Prolog, and Typst. Parsing, assembly, execution, and stepping
are all client-side.

## Quickstart

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
| `asm` | x86-64 · Unicorn | `asm-intel` | `packages/kernel-asm64` | `public/vendor/` (~8.6 MB, unicorn/keystone/capstone wasm) |
| `riscv` | RV32IM · interpreter | `asm-riscv` | `packages/kernel-riscv` | none (pure TypeScript CPU) |
| `mips` | MIPS32 · interpreter | `asm-mips` | `packages/kernel-mips` | none (pure TypeScript CPU) |
| `c` | C · clang wasm | `c` | `packages/kernel-c` | `public/vendor-c/` (~105 MB, clang → wasm32-wasip1) |
| `cpp` | C++ · clang wasm | `cpp` | `packages/kernel-cpp` | shares `public/vendor-c/` with `c` (same clang engine) |
| `fortran` | Fortran · interpreter | `fortran` | `packages/kernel-fortran` | none (pure TypeScript interpreter) |
| `python` | Python · Pyodide | `python` | `packages/kernel-python` | `public/vendor-python/` (~13 MB, CPython 3.14 wasm) |
| `wasm` | WebAssembly · interpreter | `wat` | `packages/kernel-wasm` | none (pure TypeScript interpreter) |
| `sql` | SQL · query engine | `sql` | `packages/kernel-sql` | none (pure TypeScript engine) |
| `matlab` | MATLAB · interpreter | `octave` | `packages/kernel-matlab` | none (pure TypeScript interpreter) |
| `lua` | Lua · interpreter | `lua` | `packages/kernel-lua` | none (pure TypeScript interpreter) |
| `javascript` | JavaScript · interpreter | `javascript` | `packages/kernel-javascript` | none (pure TypeScript interpreter) |
| `regex` | Regex · NFA engine | `regexp` | `packages/kernel-regex` | none (pure TypeScript Thompson NFA) |
| `lisp` | Lisp · interpreter | `scheme` | `packages/kernel-lisp` | none (pure TypeScript interpreter) |
| `elisp` | Emacs Lisp · interpreter | `scheme` | `packages/kernel-elisp` | none (pure TypeScript interpreter) |
| `prolog` | Prolog · interpreter | `prolog` | `packages/kernel-prolog` | none (pure TypeScript SLD engine) |
| `typst` | Typst · wasm | `typst` | `packages/kernel-typst` | `public/vendor-typst/` (~25 MB, compiler wasm + fonts) |

Syntax modes: each `editorSyntax` id maps to a CodeMirror mode in
`packages/core/src/languages.ts` (assembly dialects in `asm.ts`, the
sql/regexp/WAT/Typst/Prolog modes in `packages/core/src/modes.ts`, the rest
from `@codemirror/legacy-modes` or Lezer grammars); `plain` is the no-mode
fallback, but no kernel currently declares it. The full matrix, with each
kernel's panel depth, is in [`docs/languages.md`](docs/languages.md).

Engine payloads are npm dependencies pinned by `pnpm-lock.yaml`;
`scripts/sync-vendors.mjs` copies them into `public/` on `pnpm dev`/`pnpm build` — the
repository itself is source-only.

## Authoring a page

Drop your `.org` file into `apps/site/src/pages/` and add its file stem to
the `PAGE_ORDER` array in `apps/site/src/main.ts` — the file appears in the
nav at that position, titled from its `#+TITLE:` (file stem as fallback).
A `.org` file in `pages/` that is missing from `PAGE_ORDER` logs a console
warning and is skipped; if `PAGE_ORDER` names a file that doesn't exist,
that also warns and is skipped; the site only fails hard when no pages
resolve at all. A block is executable when its `#+BEGIN_SRC <lang>`
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
`[[file:python.org::*Loops leave their variable in scope][loops]]`;
`[[*Heading]]` links within the current page and `[[https://…]]` links out.
The full grammar (headings, `#+NAME:`, markup, links, lists, tables) is in
[`docs/design.md`](docs/design.md). Unsupported org constructs are reported
in a banner on the page and by `didact check`.

## Learner features

- **Saved edits.** Every executable block mirrors its editor text into
  best-effort `localStorage` and restores it next visit. Drafts follow the
  block, not its position on the page.
- **Reset machine vs Revert code.** `⟲ Reset machine` resets that block's
  session and clears its output but keeps the editor text; `↺ Revert code`
  restores the org sample and drops the saved draft but leaves the session
  and its output untouched.
- **Keys and clipboard.** Cmd/Ctrl+Enter runs the block, Shift+Enter steps
  one unit where the kernel supports stepping, and `⧉ Copy Code` copies
  the current editor text.
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
never breaks a block; that state simply does not survive a reload.

| key | value |
| --- | --- |
| `didact:code:<id>` | one block's edited source (removed again when it matches the sample) |
| `didact:progress:<page-file-or-slug>` | one page's `{ "passed": [<block id>…], "manual": boolean }` |
| `didact:nav-side` | the navigator side (`left` / `right`) chosen with the rail's side toggle |

`<id>` is the page key (`PageSpec.file` when present, else the URL slug)
plus either `:n:<name>` for a block whose `#+NAME:` is unique on the page,
or `:h:<content-hash>:<occurrence>` for an unnamed or duplicated block.
Renaming a block or editing its org sample therefore starts a fresh
identity.

The learner-facing org directives are all optional: `#+BEGIN_HINT` …
`#+END_HINT`, `#+BEGIN_SOLUTION` … `#+END_SOLUTION`, `#+EXERCISE: <title>`,
and `#+CHECK: <expected output>` (the two promises apply to the next src
block and clear after it). The full grammar remains in
[`docs/design.md`](docs/design.md).

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
- `pnpm lint` — eslint across the repo
- `pnpm typecheck` — two `tsc --noEmit` runs: the apps/site DOM config
  (covers `packages/*/src`) and `tsconfig.typst.json` (build pipeline)
- `pnpm typst:check` — compiles every page's Typst math/diagrams and runs
  the structural gate
