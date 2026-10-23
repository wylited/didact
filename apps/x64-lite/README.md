# x64-lite — a literate x86-64 teaching machine

One of three sibling prototypes for the literate-assembly website. Where
`x64-unicorn` delegates to a real emulator, this app is the *teaching-first*
option: a custom two-pass assembler and a step-exact x86-64 interpreter, both
in pure TypeScript, so every error is line-mapped, every step is source-mapped,
and the whole thing is tiny and dependency-light (CodeMirror 6 is the only
runtime dependency family).

The lesson itself is a real org-mode file (`src/lesson.org`, loaded via Vite
`?raw` and parsed client-side), so it stays editable in Emacs as org-babel
source.

## Run it

```sh
pnpm --dir apps/x64-lite install
pnpm --dir apps/x64-lite dev        # dev server
pnpm --dir apps/x64-lite build      # tsc --noEmit && vite build
pnpm --dir apps/x64-lite preview    # serve dist/
```

`vite build` output is fully self-contained (`base: './''`): serve `dist/`
from any static path, no network needed at runtime.

## What the machine looks like

| Region  | Address          | Notes                                    |
|---------|------------------|------------------------------------------|
| `.text` | `0x401000`       | instructions, read-only at runtime       |
| `.data` | above `.text` (16-byte aligned) | `db`/`dq` data, writable        |
| stack   | `0x7ffffffff000` growing down | `rsp` starts at the top; a return |

Registers are exact 64-bit BigInts (`rax`…`r15` + `rip`). Writing a 32-bit
register (`eax`…) zero-extends into the full 64-bit register, like real
hardware. Execution starts at the first `.text` instruction; `ret` from the
outermost frame or `syscall` rax=60 finishes the program. Run-to-completion is
capped at 1,000,000 instructions (overrunning it is reported as an error).

### Syscalls

| rax | meaning | arguments |
|-----|---------|-----------|
| 1   | `write` | `rdi` = fd (1 stdout / 2 stderr), `rsi` = buffer, `rdx` = length; bytes are appended to the output console; returns the byte count in `rax` |
| 60  | `exit`  | `rdi` = exit status; stops execution |

Anything else raises a line-mapped runtime error — never silent misbehavior.

## Assembler: the exact supported subset

Intel/NASM-style syntax, case-insensitive mnemonics, registers and directives;
labels are case-sensitive; `;` starts a comment. Everything outside this list
produces an error carrying the source line number.

**Directives**

| Directive | Meaning |
|-----------|---------|
| `.text` / `.data` (or `section .text`) | switch sections (default `.text`) |
| `db` | bytes: numbers (−128…255) and quoted ASCII strings with `\n \t \r \0 \a \b \\ \' \"` escapes, comma-separated — `.data` only |
| `dq` | 64-bit values — `.data` only |
| `name equ expr` | constant; `expr` is `±`-separated numbers, character literals (`'A'`, `'\n'`), labels, or `$` (current position) |

**Instructions** (64-bit register forms unless noted; 32-bit forms work with
`eax`-style registers and zero-extend):

| Instruction | Forms |
|-------------|-------|
| `mov` | r64/32 ↔ r64/32, r ← `[mem]`, `[mem]` ← r, r ← imm (64-bit imm encoded as `B8+r` imm64), `[mem]` ← imm |
| `lea` | r ← `[mem]` |
| `add` `sub` `and` `or` `xor` | r/m ← r, r ← r/m, r/m ← imm |
| `imul` | r, r · r, [mem] · r, r/m, imm |
| `idiv` `div` | r/m (dividend `rdx:rax`, remainder in `rdx`) |
| `inc` `dec` `neg` `not` | r/m |
| `shl` `shr` `sar` | r/m, imm · r/m, `cl` |
| `cmp` `test` | r/m ↔ r/m/imm |
| `jmp` | label / plain address / r64 / `[mem]` |
| `je jne jl jle jg jge jb jbe ja jae js jns` (aliases `jz jnz jc jnc jnz`…) | label (encoded rel8/rel32, chosen by a relaxation pass) |
| `call` `ret` | label / r64 / `[mem]` |
| `push` `pop` | r64, `[mem]`, imm (push) |
| `syscall` `nop` | — |

**Addressing** (64-bit registers only inside `[…]`): `[r64]`, `[r64+disp]`,
`[r64+r64*scale]` (scale 1/2/4/8, `rsp` cannot be the index), `[label]`,
`[label+disp]`, with optional `qword`/`dword` size specifier; `[label]` is an
absolute address (SIB/disp32 encoding). Immediates: decimal, `0x` hex,
negative, character literals.

**Deliberate subset boundaries** (all reported as line-mapped errors):
8/16-bit registers and operands; rip-relative addressing; memory-to-memory
moves; `movsb`-style string ops; FPU/SSE; `ret imm`; multiple instructions per
line. Memory operands without a register or size specifier default to qword.

`cqo`/`cdq` are not in the subset: for a negative dividend, sign-extend by
hand (e.g. `mov rdx, -1`) before `idiv`. `idiv`/`div` guard against
divide-by-zero and the INT64_MIN/−1 overflow with `#DE`-style runtime errors.

Encodings are real x86-64: the disassembly panel shows the computed address
and the actual emitted bytes (REX + opcode + ModRM/SIB + disp + imm), branches
relax between rel8/rel32, and `mov r64, imm` picks `C7 /0 imm32` when the
value fits signed-32 (sign-extending like NASM) and `B8+r imm64` otherwise.
Stores into `.text` raise a runtime error (the interpreter executes the
assembled program, not re-decoded bytes).

## Flag semantics (what the chips mean)

`add` / `sub` / `cmp` / `neg` / `inc` / `dec` operate at the instruction's
operand size (64 or 32 bits):

| Flag | add | sub / cmp | neg | inc / dec |
|------|-----|-----------|-----|-----------|
| ZF | set if result = 0 | set if result = 0 | set if result = 0 | set if result = 0 |
| CF | carry out of the top bit | unsigned borrow (a < b) | set if operand ≠ 0 | unchanged |
| SF | sign of the result | sign of the result | sign of the result | sign of the result |
| OF | signed overflow (operands share a sign, result differs) | signed overflow (operand signs differ, result sign ≠ minuend) | set if operand = INT_MIN | set on wraparound |
| PF | even parity of the low 8 result bits | same | same | same |
| AF | carry/borrow out of bit 3 | same | same | same |

- `and` / `or` / `xor` / `test`: CF = OF = 0, ZF/SF/PF from the result, AF
  cleared (undefined on hardware — we clear it deterministically).
- `shl` / `shr` / `sar`: count masked to 63 (64-bit ops) or 31 (32-bit ops);
  count 0 changes nothing; CF = last bit shifted out; ZF/SF/PF from the
  result; OF defined for count = 1 (shl: ≠ CF of the new top bit; shr: old top
  bit; sar: 0), cleared otherwise; AF cleared.
- `imul`: CF = OF = 1 when the signed product does not fit the low half;
  ZF/SF/PF/AF unchanged (undefined on hardware).
- `idiv` / `div`: flags unchanged (undefined on hardware); divide-by-zero and
  quotient overflow raise `#DE`-style runtime errors.

## Architecture

```
src/org.ts      org-subset parser (headings, markup, lists, tables, blocks)
src/asm.ts      two-pass assembler: tokenize → parse → relax branch widths →
                resolve symbols/equs → real x86-64 encoding + exec ops
src/cpu.ts      BigInt interpreter: registers, ZF/CF/SF/OF/PF/AF, sparse byte
                memory, stack, write/exit syscalls, 1-step / run-to-end
src/render.ts   DOM chrome: toolbar, register grid, flags, disassembly,
                memory hex viewer (.data / stack), output console, document
src/asm-lang.ts CodeMirror 6 StreamLanguage + dark HighlightStyle
src/main.ts     wiring: editors per block, active-block state, Run/Step/Reset
```

E2E hooks (per `docs/design.md`): `data-test` on `run`, `step`, `reset`,
`status`, `reg-rax` … `reg-r15`, `reg-rip`, `output`, `current-instr`,
`block-run` (per block), `editor` (per block host).

## Known tradeoffs

- The interpreter executes the *assembler's* structured ops, not the emitted
  bytes; bytes are real and displayed, but self-modifying code is impossible
  (`.text` stores error out instead of silently diverging).
- The memory viewer shows 256 bytes around `.data` (toggleable to the stack
  top), not the full sparse address space.
- Only the two Linux syscalls a first lesson needs are implemented; everything
  else is a loud, line-mapped error.
