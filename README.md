# literate-website

Drop `.org` files in, get a running literate site — entirely in the browser.
A page is prose plus executable code blocks; running a block also drives an
under-the-hood view of the machine (registers, disassembly, memory, console)
with hover tooltips explaining every element. No server, no runtime network:
parsing, assembly, execution, and stepping are all client-side.

## Quickstart

```sh
pnpm install
pnpm dev
```

Open the printed URL. (If pnpm blocks esbuild's install script, run
`pnpm approve-builds` once.)

`pnpm build` emits a fully static site to `apps/site/dist` — `base` is
`'./'`, so host it anywhere, at any path. `pnpm preview` checks the build.

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
mov rdi, 0
exit
#+END_SRC

#+RESULTS:
```

Output replaces the block's `#+RESULTS:` slot when it runs. Lessons stay
valid org-babel documents in Emacs; the full grammar (headings, `#+NAME:`,
markup, lists, tables) is in [`docs/design.md`](docs/design.md).

## Kernels

| id | label | editor syntax | package | vendor assets |
| --- | --- | --- | --- | --- |
| `asm` | x86-64 · Unicorn | `asm-intel` | `packages/kernel-asm64` | `public/vendor/` (~8.6 MB, unicorn/keystone/capstone wasm) |
| `riscv` | RV32IM · interpreter | `asm-riscv` | `packages/kernel-riscv` | none (pure TypeScript CPU) |
| `mips` | MIPS32 · interpreter | `asm-mips` | `packages/kernel-mips` | none (pure TypeScript CPU) |
| `c` | C · clang wasm | `c` | `packages/kernel-c` | `public/vendor-c/` (~83 MB, clang → wasm32-wasi) |
| `python` | Python · Pyodide | `python` | `packages/kernel-python` | `public/vendor-python/` (~13 MB, CPython 3.14 wasm) |
| `typst` | Typst · wasm | `plain` | `packages/kernel-typst` | `public/vendor-typst/` (~25 MB, compiler wasm + fonts) |

To add a kernel, see the recipe in [`AGENTS.md`](AGENTS.md) and the
Kernel/Session/Panel contract in [`docs/architecture.md`](docs/architecture.md).

## Tests & quality

- `pnpm test` — vitest suite plus kernel smoke scripts (bun)
- `pnpm lint` — eslint across the repo
- `pnpm typecheck` — `tsc --noEmit` covering all packages

## History

The v0.1 prototypes (`x64-unicorn`, `x64-lite`, `riscv-lite`) are preserved
at git tag `v0.1`.
