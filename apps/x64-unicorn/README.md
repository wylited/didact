# x64-unicorn — literate assembly with real Unicorn-engine emulation

One of three sibling prototypes (`apps/x64-unicorn`, `apps/x64-lite`,
`apps/riscv-lite`) for the client-side "literate assembly" teaching website.
This variant executes *real* x86-64 code: [Unicorn 2](https://www.unicorn-engine.org/)
compiled to WebAssembly assembles nothing itself — [Keystone](https://www.keystone-engine.org/)
assembles the student's instructions, [Capstone](https://www.capstone-engine.org/)
disassembles them for the machine panel, and Unicorn runs them instruction by
instruction with `write`/`exit` syscalls intercepted.

Everything happens in the browser. There is no server, no network at runtime,
and no telemetry.

## Run it

```sh
pnpm install          # from the repo root or from apps/x64-unicorn
pnpm dev              # dev server
pnpm build            # tsc --noEmit && vite build  → dist/
pnpm preview          # serve dist/ (works from any static path; base is './')
```

The build is fully self-contained: the engine wrappers and their `.wasm`
binaries are vendored under `public/vendor/` and loaded at runtime from
`<base>/vendor/` (see "Vendored assets" below).

## Layout

```
index.html                 toolbar + lesson pane + machine panel skeleton
vite.config.ts             base: './' so dist/ relocates anywhere
src/main.ts                bootstrap: engines, toolbar, panel rendering
src/lesson.org             the literate lesson (valid org-babel source)
src/org.ts                 org-subset parser (docs/design.md grammar)
src/render.ts              lesson DOM, CodeMirror blocks, results slots
src/asm.ts                 two-pass assembler front-end over Keystone
src/machine.ts             Unicorn wrapper: load/step/run/reset, syscalls
src/highlight.ts           Intel-asm StreamLanguage, line highlights
src/vendor.ts              engine loader + typed wrappers for the wasm builds
styles.css                 dark theme (shared visual language)
public/vendor/             unicorn_x86.js, keystone.{js,wasm}, capstone.{js,wasm}
```

## How execution works

- **Assembling** (`src/asm.ts`): Keystone has no labels, directives or
  sections, so the app parses those itself (`;` comments, labels, `section
  .text/.data`, `db/dw/dd/dq`, `equ`, `$`), then iterates: encode every
  instruction from its current address (labels substituted as absolute hex),
  re-layout, repeat until byte sizes are stable — Keystone picks the short
  `rel8` form whenever a branch target is in range, so sizes shrink
  monotonically and the loop converges. Bare decimal literals are pinned to
  explicit `0x…` because this Keystone build reads bare numbers as hex.
- **Memory map**: code at `0x401000`, `.data` at `0x601000` (64 KiB each),
  stack at `0x7f0000000000` (1 MiB, `rsp = 0x7f00000ff000`). A `jmp $` trap
  byte follows the program so translation-block tails can never execute zero
  padding as instructions.
- **Stepping**: `emu_start` must be called with `timeout=0, count=0` in this
  wasm build (nonzero values crash it), and `until=0` executes nothing, so a
  run targets an unreachable sentinel address while a `HOOK_CODE` callback
  stops emulation just before the second instruction — exactly one
  instruction executes per Step, whatever its control flow.
- **Run to completion**: one `emu_start` with a `HOOK_CODE` instruction
  budget of 1,000,000 (exceeding it stops with a friendly error).
- **Syscalls**: `HOOK_INSN` + `X86_INS_SYSCALL`; `write` (rax=1, also 2)
  decodes the buffer at rsi and appends UTF-8 text to the console, `exit`
  (rax=60/231) stops the machine; anything else returns `-ENOSYS` with a note.
- **Reset**: `context_save`/`context_restore` plus rewriting the code/data
  images (a context restores registers, not guest memory). A *new* Unicorn
  instance is created per program load — QEMU TCG caches translated blocks
  and does not invalidate them when memory is rewritten.

## Supported assembly (Intel syntax)

Labels (`name:`, NASM-style `.local:`), `section .text` / `section .data`,
`db/dw/dd/dq` (numbers, `'c'` chars, quoted strings with escapes), `equ`/`=`
constants, `$`, integer expressions (`+ - * /`, parens, `0x`/`0b`), `;`
comments, memory operands like `[digits+1]` / `byte [x]` / `[rax+8]`, and any
instruction Keystone accepts. Errors are reported on the exact source line.
The disassembly panel shows immediates the way Capstone does: hexadecimal
without a `0x` prefix.

## E2E hooks (docs/design.md)

`data-test` attributes: `run`, `step`, `reset` (toolbar), `status` (chip),
`reg-rax`…`reg-r15` and `reg-rip` (register cells), `output` (console),
`current-instr` (disassembly current row), `block-run` (per-block run
button), `editor` (CodeMirror host).

## Vendored assets & licensing

See `THIRD-PARTY.md` for the full manifest (file, version, source URL,
license). Summary:

- `unicorn_x86.js` — **GPL-2.0** (Unicorn engine; wasm embedded in the JS).
- `keystone.js` / `keystone.wasm` — **GPL-2.0** (Keystone; upstream is dual
  GPL-2.0/commercial).
- `capstone.js` / `capstone.wasm` — **BSD-3-Clause**.
- CodeMirror 6 — MIT (installed from npm, not vendored).

These are prototype-grade choices accepted in `docs/decision.md`: shipping
the Unicorn/Keystone wasm blobs publicly is distribution under the GPL, so
the corresponding source availability obligations apply. The permissively
licensed prototypes (`x64-lite`, `riscv-lite`) are the path if the final
product cannot carry GPL components.
