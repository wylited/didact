# Languages: syntax modes, sessions, and panel depth

A per-kernel reference covering (1) how the block editor highlights each
language, (2) whether `:session <name>` shared state is supported, and (3) what
the under-the-hood inspector panel teaches when a block runs or steps.

## 1. Syntax modes and `:session` support

`Kernel['editorSyntax']` maps to the CodeMirror 6 extension returned by
`loadEditorLanguage()` in `packages/core/src/languages.ts` (loaded lazily on
first editor mount). Lezer = grammar
package; Stream = `StreamLanguage` over a legacy mode or a dedicated mode in
`asm.ts` / `modes.ts`.

| kernel | editorSyntax | underlying mode | `:session` (`resume()`) | notes |
| --- | --- | --- | --- | --- |
| `asm` | `asm-intel` | Stream (`asm.ts` `defineAsm`) | no | registers, `;` comments, mnemonics, `.data`, sizes |
| `riscv` | `asm-riscv` | Stream (`asm.ts`) | no | ABI + `x0..x31`, `#` comments |
| `mips` | `asm-mips` | Stream (`asm.ts`) | no | `$` registers, `#` comments |
| `c` | `c` | Stream (legacy `clike/c`) | no | C keywords, types, strings |
| `cpp` | `cpp` | Lezer `@codemirror/lang-cpp` | no | full C++ grammar |
| `fortran` | `fortran` | Stream (legacy `fortran`) | **yes** | free-form F90 keywords, types, `!` comments, `.and.`/`.eq.` operators |
| `javascript` | `javascript` | Lezer `@codemirror/lang-javascript` | **yes** | full JavaScript grammar |
| `python` | `python` | Stream (legacy `python`) | **yes** | Python 3 keywords, decorators, strings |
| `lua` | `lua` | Stream (legacy `lua`) | **yes** | Lua 5.x keywords, long strings/comments |
| `matlab` | `octave` | Stream (legacy `octave`) | **yes** | M-file syntax shared with Octave |
| `lisp` | `scheme` | Stream (legacy `scheme`) | **yes** | Scheme-flavored Lisp, quasi-quote |
| `elisp` | `scheme` | Stream (legacy `scheme`) | **yes** | quote/backquote/comma and `;;` comments |
| `sql` | `sql` | Stream (`modes.ts` `sqlMode`) | **yes** | SQLite keywords/types, `''` escaping, `--` and `/* */` |
| `regex` | `regexp` | Stream (`modes.ts` `regexpMode`) | no | metacharacters, `[]`/`[^]` classes, `{n,m}`, `#` comments; test-input lines stay plain |
| `wasm` | `wat` | Stream (`modes.ts` `watMode`) | no | `(module`/`(func`, `i32.*` opcodes, `$names`, `;;`/`(; ;)` |
| `typst` | `typst` | Stream (`modes.ts` `typstMode`) | no | headings, lists, `*strong*`, `_emph_`, `$math$`, `#set`/`#let`, `#{}` code |
| `prolog` | `prolog` | Stream (`modes.ts` `prologMode`) | **yes** | `%` and `/* */` comments, strings, variables, necks `:-`/`?-`/`-->`, operators, builtins |

Nine of the seventeen kernels implement `Session.resume(src)` to share live
state across `:session <name>` blocks on a page: **`python`**, **`fortran`**,
**`sql`**, **`matlab`**, **`elisp`**, **`prolog`**, **`lisp`**, **`lua`**, and
**`javascript`**. The remaining eight (`asm`, `riscv`, `mips`, `c`, `cpp`,
`wasm`, `regex`, `typst`) run `:session` blocks isolated with an unsupported
badge in the block header.

Verification: `packages/core/test/languages.test.ts` scans every
`packages/kernel-*/src/kernel.ts` for `editorSyntax:`, asserts each id is in
the union and resolves to a non-null extension, and drives each custom mode's
token function over representative lines asserting exact token classes.

## 2. Panel depth reference

Teaching value of `Session.state()` when a block runs or steps: fields with
`tip` text, listings with source-line mapping and row tips, and panels for the
control-flow/state story of that language.

| # | kernel | depth | what it shows | future opportunity |
| --- | --- | --- | --- | --- |
| 1 | `asm` | deep | registers (changed flag + signed decimal), EFLAGS, disassembly w/ source lines + `;` comment tips, `.data` hexdump, console | per-step "what changed" trace |
| 2 | `regex` | deep | NFA listing (live states), state set as meaning, input caret/brackets, captures | per-transition epsilon closure explanation |
| 3 | `lisp` | deep | cons heap (fresh cells), env frames w/ chain titles, control stack (continuation text), output | mutating GC visualization |
| 4 | `javascript` | deep | scopes (kind tip), call stack, event loop (micro/macro), console | closure captured-variable view |
| 5 | `wasm` | deep | instructions (opcode bytes, source lines), operand stack, locals/globals (changed), call stack, memory | `br`/`return` target explanation |
| 6 | `sql` | deep | plan with seen/passed/emitted counters + tips, current row fields, tables, results | index-vs-scan choice |
| 7 | `riscv` | deep | 32 registers (changed), `pc`, branch panel (operands + taken), listing, `.data`, console | pipeline/cycle cost |
| 8 | `mips` | good | 32 ABI registers with signed sub, `hi`/`lo`/`pc`, listing, `.data`, console | trap cause / `hi-lo` detail |
| 9 | `lua` | deep | **Values** (assigned names with integer/float/local/`_G`/nil type tags + tips), locals, globals (`_G`), tables, call stack, console | metatable `__index` chain walk |
| 10 | `matlab` | deep | workspace (+tip), **Columns** (innermost loop variable, current column, walked matrix shape, column-major start offset, `while` pass count), Matrices (column-major addr + tips), call stack | copy-on-write value semantics |
| 11 | `prolog` | deep | goal stack (clause cursor), choice points, bindings, **Search** (last SLD transition with tip, next clause line, choice-point depth), output | substitution trail view |
| 12 | `c` | basic | console (clang diagnostics), exit/size/compile fields, wasm hexdump | compiled-module disassembly with DWARF line map |
| 13 | `cpp` | basic | same as `c` | same as `c` |
| 14 | `python` | deep | **Progress**, **Trace · executed lines** (counts, source text, failure row, flow sentence), **Call stack**, **Traceback**, **Variables · grouped** (scalars/collections/functions/classes, previews + lengths), **Locals · failing frame**, **Types · declared vs observed**, console (lesson frames only); see §4 | per-line "what changed" trace |
| 15 | `typst` | basic | rendered page (`html`), diagnostics/warnings console, page count + compile time | layout boxes via Typst query API |
| 16 | `elisp` | good | control stack, buffer fields/text, lexical and dynamic environments, Lisp-2 symbol cells, hooks, keymaps, output | dynamic vs lexical closure comparison; macro expansion is steppable |
| 17 | `fortran` | deep | workspace with declared type/shape, module variables, **Arrays** (last write, column-major flat addresses, lower bounds), loops, call stack, console | `ALLOCATE`/`DEALLOCATE` allocation map |

Fortran limits are intentionally teaching-sized: arrays cap at 1,000,000
elements, `CHARACTER` values and lengths at 100,000 characters, `CHARACTER`
array payloads at 4,000,000 characters, and a procedure frame at 2,000,000
scalar slots; runs stop after 500,000 statements. Hitting one is a line-mapped
error, not a hang.

## 3. Deferred enhancements (need a new dependency or engine hook)

- C/C++ disassembly panel: needs a wasm decoder (`@webassemblyjs/disasm` or
  vendored `wabt` `wasm2wat`) plus a DWARF source-map sidecar from `clang -g`
  to line-map rows.
- Typst layout boxes: needs Typst's query API exposed from the existing wasm
  engine, not a new package.

## 4. Python x-ray panel architecture

`packages/kernel-python` installs a `sys.monitoring`/`sys.settrace` hook over
the block's own file and returns one rich snapshot per run:

| section | kind | what it says |
| --- | --- | --- |
| **Progress · running / last run** | `fields` | how many top-level statements the run covered, the line range, percent |
| **Trace · executed lines** | `html` | one row per line: hit count, the source text, the failing row marked, plus a flow sentence (`42 lines executed · loop at line 2: 5 iterations`) |
| **Call stack** | `listing` | frames while paused/at failure, innermost marked |
| **Traceback** | `listing` | failure story with the failing frame marked |
| **Variables · grouped** | `fields` | scalars / collections (`list · len 3 · 3 items`) / functions / classes / modules, in a fixed order, changed marking, previews that keep the length (not a bare `…`) |
| **Locals · failing frame** | `fields` | the innermost frame's locals at the exception |
| **Types · declared vs observed** | `fields` | annotations vs `type(value)`, mismatches marked (`n: int → float`) — the Python analogue of "this register changed" |
| **Console** | `console` | stdout/stderr verbatim, traceback appended once |

Engine side: `src/toolkit.py` (installed into the engine's global namespace as
`lw_*` entry points over `_lw_*` internals; verified against a host CPython in
`test/toolkit.test.ts`); rendering logic in `src/xray.ts`, unit-tested from
plain data in `test/panel.test.ts`. Nothing in this list is a separate console:
the program's own stdout/stderr stays one copyable block, so progress and
traceback chrome live in `fields`/`listing` panels. The block's source is
registered in `linecache` under `lesson.py`, which is what lets CPython put the
source line in a frame; the console traceback is formatted from the lesson's own
frames, so pyodide's `_base.py` internals do not appear in it.

Not done, deliberately: **single-stepping**. CPython's only external pause
points are code-object boundaries, and Pyodide is single-threaded, so a true
line stepper needs a worker + `setInterruptBuffer`/`Atomics` pause-resume.
The honest alternative — exec'ing one top-level statement per engine job —
changes line events and is all-or-nothing at statement granularity. `step()`
stays a no-op and `features.stepping` stays false.
