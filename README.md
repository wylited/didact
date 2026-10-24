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

Copy your `.org` file into `apps/site/src/pages/` — it appears in the nav,
titled from its `#+TITLE:`. A block is executable when its
`#+BEGIN_SRC <lang>` language matches a registered kernel; other languages
render read-only.

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

- **`asm`** — x86-64 assembly, emulated via Unicorn/Keystone/Capstone WASM
  (`packages/kernel-asm64`).

To add a kernel (python, typst, …), see the recipe in
[`AGENTS.md`](AGENTS.md) and the Kernel/Session/Panel contract in
[`docs/architecture.md`](docs/architecture.md).

## Tests & quality

- `pnpm test` — vitest suite
- `pnpm lint` — eslint across the repo
- `pnpm typecheck` — `tsc --noEmit` covering all packages

## History

The v0.1 prototypes (`x64-unicorn`, `x64-lite`, `riscv-lite`) are preserved
at git tag `v0.1`.
