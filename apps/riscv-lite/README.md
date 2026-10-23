# riscv-lite — RISC-V RV32I(+M) literate assembly prototype

Prototype 3 of the literate-assembly website: org-mode lessons whose
`asm-riscv` code blocks are assembled and executed **entirely in the
browser** by a custom two-pass assembler and RV32I simulator written in pure
TypeScript. No emulator library, no server, no runtime network.

## Run

```sh
pnpm install                 # from the repo root (pnpm workspace)
pnpm dev:riscv-lite          # vite dev server → http://localhost:5174
pnpm --dir apps/riscv-lite build    # tsc --noEmit && vite build → dist/
pnpm --dir apps/riscv-lite preview  # serve the built bundle
```

`vite.config.ts` sets `base: "./"`, so `dist/` works from any static path.

## File map

| File | Role |
|------|------|
| `src/lesson.org` | The lesson (real org-mode, imported via Vite `?raw`) |
| `src/org.ts` | Org-subset parser (headings, tables, lists, `#+NAME`, `#+RESULTS`, src blocks, inline markup) |
| `src/asm.ts` | Two-pass RV32I(+M) assembler: real encodings, pseudos, sections, directives, line-mapped errors |
| `src/cpu.ts` | Simulator: decode-and-execute of the real words, venus-style ecalls, branch-context tracking |
| `src/render.ts` | DOM rendering: lesson, CodeMirror 6 editors, machine panel (registers / disassembly / memory / console) |
| `src/main.ts` | Wiring: run/step/reset flows, chunked run-to-end, per-block machine state, status chip |
| `styles.css` | Dark theme via CSS custom properties (shared visual language) |

Only runtime dependencies are the CodeMirror 6 family (`codemirror`,
`@codemirror/state`, `@codemirror/view`, `@codemirror/language`).

## Supported instruction set

Everything is RV32I as specified in the RISC-V unprivileged spec, plus the
M extension. Anything else is a **line-mapped error**, never silent
misbehavior.

- **U/I/S/R/B/J encodings**: `lui auipc jal jalr` · `beq bne blt bge bltu
  bgeu` · `lb lh lw lbu lhu` · `sb sh sw` · `addi slti sltiu xori ori andi
  slli srli srai` · `add sub sll slt sltu xor srl sra or and` · `ecall
  ebreak fence` · `mul mulh mulhsu mulhu div divu rem remu`.
- **Pseudoinstructions**: `li` (addi, or lui+addi — the minimal sequence),
  `la`, `mv`, `nop`, `j`, `jal label` (ra implied), `jr`, `ret`,
  `beqz`/`bnez`, `neg`, `not`.
- **Registers**: `x0`–`x31` and all ABI names (`zero ra sp gp tp t0–t6
  s0–s11 fp a0–a7`). `x0` is hard-wired to zero.
- **Directives**: `.text`, `.data`, `.word`, `.byte`, `.asciz`/`.string`
  (C escapes incl. `\xHH` and UTF-8), `.equ`/`NAME = value`.
- **Immediates**: decimal, `0x…`, `0b…`, char literals (`'\n'`), and `.equ`
  constants. 12-bit immediates are range-checked with a helpful message
  ("…use li/la into a register first").

## Machine model

- `.text` loads at `0x00001000`; `.data` follows immediately above it
  (16-byte aligned); the stack starts at `0x7ffffffc` and grows down.
- Memory is a sparse byte map; little-endian; loads/stores sign- or
  zero-extend per width; **misaligned access is allowed** (teaching choice).
- Arithmetic wraps mod 2³². Division: `div` by 0 → −1, `rem` by 0 →
  dividend, `MIN_INT / −1` → `MIN_INT` (RISC-V semantics, no traps).
  `mulh` is signed×signed high 32, `mulhu` unsigned, `mulhsu` mixed.
- `fence` is encoded as `fence iorw, iorw` (0x0FF0000F) and executes as a
  nop on this single-hart machine.
- No flags register exists in RISC-V, so the machine panel shows a
  **branch context** line instead (allowed deviation, docs/design.md):
  the operands and outcome of the most recent branch, e.g.
  `beq t0, t1 · t0=1, t1=10 · not taken`.

### Ecall convention (venus/RARS-style)

| `a7` | Service | Effect |
|------|---------|--------|
| 1 | print int | `a0` as signed decimal |
| 4 | print string | NUL-terminated bytes at `a0` (decoded as UTF-8) |
| 11 | print char | low byte of `a0` as a character |
| 10 | exit | stop cleanly |
| 93 | exit | same as 10 (Linux convention) |

Both lesson programs assemble and run unmodified in venus/RARS.

## Encoding verification

The assembler emits real RV32I encodings (the disassembly "bytes" column is
the actual loaded machine code, and the simulator **decodes those words
back** to execute — encoder bugs surface as illegal instructions rather than
mystery behavior). Worked bit-level derivations live in the header of
`src/asm.ts`; the key cross-checks:

| Instruction | Encoding | Derivation |
|-------------|----------|------------|
| `addi x1, x2, 4` | `0x00410093` | I-type: `(0x004<<20)\|(2<<15)\|(1<<7)\|0x13` |
| `lw x1, 8(x2)` | `0x00812083` | I-type load: `(8<<20)\|(2<<15)\|(2<<12)\|(1<<7)\|0x03` |
| `sw x1, 8(x2)` | `0x00112423` | S-type: `(1<<20)\|(2<<15)\|(2<<12)\|(8<<7)\|0x23` |
| `beq x1, x2, +16` | `0x00208863` | B-type: imm=16 ⇒ `imm[4:1]=8` at bits 11:8 |
| `jal x1, +16` | `0x010000EF` | J-type: imm=16 ⇒ `imm[10:1]=8` at bits 30:21 |
| `jalr x0, 0(x1)` (= `ret`) | `0x00008067` | canonical encoding |
| `nop` / `ecall` / `ebreak` | `0x00000013` / `0x00000073` / `0x00100073` | fixed system encodings |

During development these vectors plus `li`-expansion, M-extension edge
cases, misaligned composite loads, error line-mapping, and both lesson
programs were exercised by a scratch harness (all green) before delivery.

## E2E hooks (`data-test`)

`run`, `step`, `reset`, `status`, `reg-<abi>` for all 32 registers plus
`reg-pc`, `output`, `current-instr` (disassembly current row), `block-run`
and `editor` (per executable block), plus `memory`, `branch-context`,
`disassembly`, `registers`, `results`.

Behavior notes: first `▶ Run` assembles + loads (status `loaded · N
instructions`); a second click (unchanged code) runs to completion under a
1,000,000-instruction budget; the per-block `▶ Run` always assembles fresh
and runs. `⤵ Step` assembles when needed, then executes exactly one
instruction; changed registers keep an accent until the next step; editor
and disassembly auto-scroll to the current instruction. `⟲ Reset` restores
initial state, clears output, keeps the code. `#+RESULTS:` slots are
replaced with live output on run (the authored org text is never mutated).
Deep-link with `#hello` / `#sum-loop` to jump to a named block.

## Tradeoffs (accepted)

- Subsets by design (docs/decision.md): unsupported mnemonics/directives
  produce line-mapped errors; this README documents the supported set.
- Misaligned access allowed; no memory bounds checks (sparse map reads 0).
- `li`/`la` expansion is the minimal 1–2 instruction sequence; the
  disassembly therefore shows the real `lui`/`addi` pair, not the pseudo.
- Data addresses depend on `.text` size; the assembler iterates its sizing
  pass to a fixpoint so forward references and `la` are always exact.
