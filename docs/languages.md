# Languages: syntax modes and panel depth

A per-kernel audit of (1) how the block editor highlights each language and
(2) how much the machine panel teaches when a block runs or steps.
Status: 2026-11-20. `packages/kernel-python`'s panels are described in §5 —
its x-ray (trace, frames, grouped variables, annotation mismatches) landed in
the same change.

## 1. Syntax matrix

`Kernel['editorSyntax']` → the CodeMirror extension `editorLanguage()` returns
(`packages/core/src/languages.ts`). Lezer = grammar package; Stream =
`StreamLanguage` over a legacy mode or one written in `asm.ts`/`modes.ts`.

| kernel | editorSyntax | underlying mode | verdict | reason |
| --- | --- | --- | --- | --- |
| `asm` | `asm-intel` | Stream (`asm.ts` `defineAsm`) | good | registers, `;` comments, mnemonics, `.data`, sizes |
| `riscv` | `asm-riscv` | Stream (`asm.ts`) | good | ABI + `x0..x31`, `#` comments |
| `mips` | `asm-mips` | Stream (`asm.ts`) | good | `$` registers, `#` comments |
| `c` | `c` | Stream (legacy `clike/c`) | good | C keywords/types/strings cover lesson C |
| `cpp` | `cpp` | Lezer `@codemirror/lang-cpp` | good | full grammar |
| `javascript` | `javascript` | Lezer `@codemirror/lang-javascript` | good | full grammar |
| `python` | `python` | Stream (legacy `python`) | good | no Lezer python dependency available offline; adequate |
| `lua` | `lua` | Stream (legacy `lua`) | good | Lua 5.x keywords, long strings/comments |
| `matlab` | `octave` | Stream (legacy `octave`) | good | the M-file grammar is shared with Octave |
| `lisp` | `scheme` | Stream (legacy `scheme`) | good | the kernel is Scheme-flavoured; quasi-quote reads right |
| `elisp` | `scheme` | Stream (legacy `scheme`) | good | no Emacs Lisp mode is vendored; Scheme reads quote/backquote/comma and `;;` comments correctly |
| `sql` | `sql` | Stream (`modes.ts` `sqlMode`) | good | the id existed but was wired to the legacy multi-dialect `sql({})`, which knows no types and reads `[` in comments; now dialect-specific (SQLite keywords/types, `''` escaping, `--` and `/* */`) |
| `regex` | `regexp` | Stream (`modes.ts` `regexpMode`) | good | *was `plain`*: now metacharacters, `[]`/`[^]` classes, `{n,m}`, `#` comment lines; test-input lines stay plain |
| `wasm` | `wat` | Stream (`modes.ts` `watMode`) | good | *was `scheme`* (highlighted as Lisp): nodes `(module`/`(func`, `i32.*` opcodes, `$names`, `;;`/`(; ;)` |
| `typst` | `typst` | Stream (`modes.ts` `typstMode`) | good | *was `plain`*: headings, list markers, `*strong*`, `_emph_`, `$math$`, `#set`/`#let`, `#{}` code |
| `prolog` | `prolog` | Stream (`modes.ts` `prologMode`) | good | *was `plain`*: `%` and `/* */` comments, `'atom'`/`"string"`/`` `string` ``, variables, numbers, necks `:-`/`?-`/`-->`, operators `->`/`;`/`!`/`\+`, builtins; plain atoms stay plain |

Superseded ids: the README/AGENTS list of supported syntaxes was stale
(`lua`/`octave` absent). They are listed now, alongside the four new ids.
The union gained `prolog`, `regexp`, `typst`, `wat` and lost nothing; all sixteen
`packages/*/src/types.ts` mirrors were re-synced with `packages/core/src/kernel.ts`.

Verification: `packages/core/test/languages.test.ts` scans every
`packages/kernel-*/src/kernel.ts` for `editorSyntax:`, asserts each id is in
the union and resolves to a non-null extension, and drives each written mode's
token function over representative lines asserting the exact token classes.

## 2. Panel depth ranking

Teaching value of `Session.state()` when a block runs/steps: fields with
`tip` text, listings with source-line mapping and row tips, and a panel for
the control-flow/state story *of that language*.

| # | kernel | depth | what it shows | what would make it useful |
| --- | --- | --- | --- | --- |
| 1 | `asm` | deep | registers (+tip), EFLAGS, disassembly w/ source lines + `;` comment tips, `.data` hexdump, console | unit: a per-step "what changed" trace |
| 2 | `regex` | deep | NFA listing (live states), state set as meaning, input caret/brackets, captures | unit: per-transition epsilon closure explanation |
| 3 | `lisp` | deep | cons heap (fresh cells), env frames w/ chain titles, control stack (continuation text), output | unit: put mutating GC on the map |
| 4 | `javascript` | deep | scopes (kind tip), call stack, event loop (micro/macro), console | unit: closure captured-variable view |
| 5 | `wasm` | deep | instructions (opcode bytes, source lines), operand stack, locals/globals (changed), call stack, memory | unit: br/return target explanation |
| 6 | `sql` | deep | plan with seen/passed/emitted counters + tips, current row fields, tables, results | unit: index-vs-scan choice |
| 7 | `riscv` | deep | 32 registers (changed), pc, *branch panel* (operands + taken), listing, `.data`, console | unit: pipeline/cycle cost |
| 8 | `mips` | good | 32 ABI registers with signed sub, hi/lo/pc, listing, `.data`, console | unit: trap cause / `hi-lo` coroutine |
| 9 | `lua` | good → better | **Values** (new), locals, globals (_G), tables, call stack, console | unit: metatable `__index` chain walk |
| 10 | `matlab` | good → better | workspace (+tip), **Columns** (new), Matrices (column-major addr + tips), call stack | unit: copy-on-write value semantics |
| 11 | `prolog` | good → better | goal stack (clause cursor), choice points, bindings, **Search** (new), output | unit: substitution trail view |
| 12 | `c` | mediocre | console (clang diagnostics), exit/size/compile fields, wasm hexdump | missing: a disassembly listing of the compiled module with source-line mapping (no decoder offline); at least a globals/data hexdump |
| 13 | `cpp` | mediocre | same as `c` | same as `c` |
| 14 | `python` | deep | **Progress** (new), **Trace · executed lines** (counts, source text, failure row, flow sentence), **Call stack**, **Traceback**, **Variables · grouped** (scalars/collections/functions/classes, previews + lengths), **Locals · failing frame**, **Types · declared vs observed**, console (traceback: the lesson's frames only) | unit: per-line "what changed" (needs a resumable run); see §5 |
| 15 | `typst` | shallow | rendered page (html), diagnostics, page count | unit: layout boxes; it is a compiler, so "fetch/compile/render" is its story |
| 16 | `elisp` | good | control stack, buffer fields/text, lexical and dynamic environments, Lisp-2 symbol cells, hooks, keymaps, output | unit: dynamic vs lexical closure; macro expansion is steppable |

## 3. Implemented this round

| kernel | panel | files | why it was the highest-value cheap addition |
| --- | --- | --- | --- |
| `prolog` | **Search** (`fields`): last transition (resolve/mismatch/backtrack/redo/cut/builtin/solution/no) with a tip per kind, the clause line the cursor tries next, choice-point depth | `packages/kernel-prolog/src/session.ts` | SLD's story is *the transition*; the goal stack shows state but never says what just happened. Uses `Machine.lastKind`/`nextClauseLine()` that existed but were unshown |
| `lua` | **Values** (`fields`): every assigned name, block order, with type tag (integer vs float, local vs _G key, assigned-nil, scope ended) and a tip per type | `packages/kernel-lua/src/state-panel.ts` (pure builder), `interp.ts` (`assignments` map fed at `local`/`=`), `session.ts` | dynamic typing is the language's story; Locals/Globals split by scope, not by type, so `1/2 → 0.5` and "global = _G key" were invisible |
| `matlab` | **Columns** (`fields`): innermost loop variable, current column of `k`, walked matrix shape, where that column starts in column-major memory, `while` pass count | `packages/kernel-matlab/src/columns-panel.ts` (pure builder), `interp.ts` (`LoopState`/`loopSource`), `session.ts` | `for v = M` walking COLUMNS is MATLAB's named trap; Matrices shows layout, nothing showed iteration |

Coordination: no shared helper went into core — the Lua and MATLAB builders
are package-local (they present different data), Prolog's lives in its session.

Tests added (behavioural, deterministic; builders also unit-tested from plain
data):
- `packages/kernel-prolog/test/search-panel.test.ts` — grandparent SLD trace
  step by step, exhaustion, breakpoint line, tip coverage.
- `packages/kernel-lua/test/values-panel.test.ts` — builder over plain data +
  session wiring (local/global, float division, assigned nil, scope end).
- `packages/kernel-matlab/test/columns-panel.test.ts` — builder over plain
  data + interpreter loop tracking (three columns of a 2x3, `while` passes).
- `packages/core/test/languages.test.ts` — extended (mode resolution for every
  registered kernel, exact token classes for sql/regexp/wat/typst/prolog).

## 4. Deferred / needs a dependency

- C/C++ disassembly panel: needs a wasm decoder; add
  `@webassemblyjs/disasm@1.14.1` (or vendor `wabt`'s `wasm2wat`) and a
  source-map sidecar from clang (`-g` DWARF parse) to line-map rows.
- Typst layout boxes: needs Typst's query API exposure from the existing wasm
  engine, not a new package.

## 5. Python: the x-ray (what "not much useful information" turned into)

`packages/kernel-python` no longer reports "no stepping, so just a console".
A run now installs a `sys.monitoring`/`sys.settrace` hook over the block's own
file and returns one rich snapshot:

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
