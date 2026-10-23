# literate-website

Prototypes for a fully client-side, org-babel-style literate teaching site.
A lesson is a real Emacs org-mode file rendered in the browser: prose, then
executable code blocks the student can edit, run, and single-step, with a
persistent machine panel (registers, flags, disassembly, memory, output).
There is no server, no runtime network, no telemetry — assembling, executing,
and stepping all happen in the browser.

The first lesson type is assembly (x86-64 and RISC-V). Lessons are authored
as org-mode text (`src/lesson.org` in each app, valid org-babel source) and
parsed client-side; the org-subset grammar all prototypes implement is
specified in [`docs/design.md`](docs/design.md).

This repo holds three sibling prototypes that share one UI/behavior contract
(`docs/design.md`) and differ only in execution technology — the point of the
comparison. The choice rationale lives in [`docs/decision.md`](docs/decision.md).

## The three prototypes

| App | Execution tech | x86-64 semantics | Bundle weight | Licensing | Best for |
|---|---|---|---|---|---|
| `apps/x64-unicorn` | Unicorn 2 (wasm) emulation + Keystone assembler + Capstone disassembler, vendored under `public/vendor/` | Real: any instruction Keystone accepts, real encodings, syscall interception | Vendored engine files total ~8.7 MB (unicorn_x86.js 896 KB with embedded wasm, keystone.wasm 4.2 MB, capstone.wasm 3.2 MB — measured on disk; THIRD-PARTY.md lists versions/licenses, not sizes) | Unicorn & Keystone **GPL-2.0** (public serving = distribution, source-availability obligations); Capstone BSD-3-Clause | The "real CPU" experience: genuine x86-64, full instruction set |
| `apps/x64-lite` | Custom two-pass assembler + step-exact interpreter, pure TypeScript (~1–1.5k LOC) | Deliberate subset (no 8/16-bit ops, rip-relative, string/FPU/SSE; everything else errors loudly with the source line); encodings are real x86-64 | Tiny: CodeMirror 6 is the only runtime dependency family | No GPL components; app's own license not declared in-repo | Teaching-first: line-mapped errors, source-mapped stepping, permissive licensing |
| `apps/riscv-lite` | Custom RV32I(+M) assembler + simulator, pure TypeScript | (RISC-V, not x86) full RV32I + M per spec, real encodings decoded back for execution; venus-style ecalls | Tiny: CodeMirror 6 family only | No GPL components; app's own license not declared in-repo | Proving the framework generalizes beyond x86; clean ISA teaching |

### Tradeoffs, per prototype

**x64-unicorn**
- Genuine emulation: any Keystone-accepted instruction, real control flow, exact stepping via `HOOK_CODE`.
- Keystone has no labels/directives — the app implements its own two-pass label resolution and section handling.
- Heavy: multi-MB vendored wasm blobs; Unicorn/Keystone are GPL-2.0, acceptable for prototypes but not a permissively licensed product.
- Workarounds needed: `emu_start` count/timeout quirks in this wasm build; new Unicorn instance per load (QEMU TCG block caching).

**x64-lite**
- Zero heavy dependencies, tiny bundle, deterministic behavior (e.g. flags defined where hardware leaves them undefined).
- Every error is line-mapped; steps map to source lines; real x86-64 encodings shown in the disassembly panel.
- Subset only: unsupported constructs must error (and do), never silently misbehave; no self-modifying code (`.text` stores error out).
- Memory viewer shows a window around `.data`/stack, not the full address space; only `write`/`exit` syscalls.

**riscv-lite**
- Full RV32I(+M) with pseudoinstructions and real bit-level encodings; simulator decodes the emitted words, so encoder bugs surface as illegal instructions.
- Lesson programs run unmodified in venus/RARS; no flags register — the panel shows a branch-context line instead (allowed design deviation).
- Subsets by design: unsupported mnemonics/directives are line-mapped errors; misaligned access allowed, no memory bounds checks.
- `li`/`la` expand minimally, so disassembly shows `lui`/`addi` pairs rather than the pseudo.

## Run

Requires pnpm; the apps are a pnpm workspace (`apps/*`).

```sh
pnpm install                 # from the repo root
# pnpm ≥12: if esbuild's install script is blocked, run: pnpm approve-builds
pnpm dev:x64-unicorn         # or dev:x64-lite / dev:riscv-lite
pnpm --dir apps/<name> dev   # equivalent, per-app
pnpm build                   # all apps: tsc --noEmit && vite build
```

Each `apps/*/dist` is self-contained (`vite.config.ts` sets `base: './'`) —
serve it from any static file server or path, no network needed at runtime.

## Roadmap

- Compiled-language lessons (C/C++) via `@yowasp/clang` (Apache-2.0, ~105 MB),
  or tcc-wasm (~0.8 MB) for intro C — surveyed in
  [`docs/research/wasm-compilers.md`](docs/research/wasm-compilers.md).
- Org compatibility goals (valid org-babel source, babel headers parsed,
  `#+RESULTS:` slots, `#+NAME:` deep links) are binding requirements in
  [`docs/design.md`](docs/design.md).

## Repo map

```
docs/design.md        shared UI/behavior/org contract all prototypes implement
docs/decision.md      technology choice + accepted tradeoffs
docs/research/*.md    surveys: browser emulators, teaching sims,
                      literate platforms, wasm compilers
apps/x64-unicorn/     real-unicorn prototype (see its README + THIRD-PARTY.md)
apps/x64-lite/        pure-TS x86-64-subset prototype
apps/riscv-lite/      pure-TS RV32I(+M) prototype
branches proto/*      each prototype also lives on its own proto/<name> branch
```
