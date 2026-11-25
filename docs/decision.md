# Technology Decision

Date: 2026-10-23 · Inputs: `docs/research/*.md` (4 agent surveys) · Contract: `docs/design.md`

## Chosen architecture (all prototypes)

- Own lightweight block system (no notebook platform) — R4 verdict: nothing
  surveyed exposes step/pause/inspect hooks; our engine *is* the kernel.
- CodeMirror 6 editor (MIT, mobile-OK, line decorations for current
  instruction) — R4 verdict.
- Org-first content: real `.org` lessons parsed client-side (user requirement).
- Vite + TypeScript + vanilla DOM per `docs/design.md`.

## Prototypes evaluated (2026-10-23; the prototype dirs were later removed)

| # | Prototype dir (removed) | Execution tech | Why it's in the set |
|---|---------|----------------|---------------------|
| 1 | `apps/x64-unicorn` | Real x86-64 emulation: `@alexaltea/unicorn-js` (Unicorn 2 wasm) + `@alexaltea/keystone-js` assembler + `@alexaltea/capstone-js` disassembler | The "real CPU" option: genuine encodings, syscall interception, step via `emu_start(count=1)`. R2 pick. |
| 2 | `apps/x64-lite` | Custom x86-64-subset assembler + interpreter in pure TypeScript (~1–1.5k LOC) | The "teaching-first" option: zero heavy deps, source-line stepping, line-mapped errors, permissive licensing, tiny bundle. |
| 3 | `apps/riscv-lite` | Custom RV32I(+M) assembler + simulator in pure TypeScript, venus-style ecalls | The "clean ISA" option (R3 verdict: write own core; @specy/risc-v only as oracle). Proves the framework generalizes beyond x86. |

Prototype 1 became `packages/kernel-asm64` (id `asm`), prototype 3 became
`packages/kernel-riscv` (id `riscv`), and prototype 2 (`x64-lite`) was not
shipped. `apps/` now holds only `apps/site`.

### Known tradeoffs accepted

- **Keystone has no labels/directives.** P1 must implement its own two-pass
  label resolution: parse labels/`.data` itself, assemble instructions
  individually via keystone (pass 1 for lengths → addresses, pass 2 re-encode
  branches with resolved numeric targets).
- **Unicorn/Keystone/Capstone wasm are GPL-2.0 (Capstone BSD-3).** The
  shipped `asm` kernel serves them, so the GPL source-availability obligation
  travels with the site; licenses and vendor texts are recorded in
  `packages/kernel-asm64/THIRD-PARTY.md` and `apps/site/public/vendor/`.
  P2/P3 (pure-TypeScript) remains the permissive-licence path.
- **P2/P3 are subsets** — in-app documentation of the supported instruction
  set is mandatory; anything unsupported must produce a line-mapped error,
  never silent misbehavior.
- **C/C++ lessons shipped.** `@yowasp/clang@22.0.0-git20542-10` (Apache-2.0,
  ~105 MB) backs `packages/kernel-c` (id `c`) and `packages/kernel-cpp`
  (id `cpp`), vendored to `apps/site/public/vendor-c/`; tcc-wasm was not used.

## Explicitly rejected

- v86/JSLinux/qemu-wasm — no usable instruction-stepping/debug API (R2).
- Adopting JupyterLite/Starboard/etc. — run-to-completion kernels, no step
  hooks; heavy (R4).
- Vendoring venus/RARS/VisUAL cores — not embeddable or stale (R3).
