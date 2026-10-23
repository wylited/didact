# Literate Assembly Website — Shared Design Contract

All prototypes MUST implement this contract so the three are comparable on
execution technology, not on UI divergence. Deviations allowed only where the
ISA requires it (register names, flags, syscall convention).

## Concept

An org-babel/Jupyter-like teaching page, 100% client-side. The page is a
*literate document*: prose explains a concept, then an executable code block
lets the student edit and run real assembly. A persistent "machine" panel shows
CPU state and supports single-stepping instruction by instruction.

No server. Everything (assembling, executing, stepping) happens in the browser.

## Layout

Two-pane, full viewport, no page scroll on desktop (panes scroll internally).

```
┌──────────────────────────────┬──────────────────────────┐
│  Toolbar: ▶ Run  ⤵ Step  ⟲ Reset        [status chip]  │
├──────────────────────────────┼──────────────────────────┤
│                              │  Registers (grid)        │
│  Lesson document             │  Flags (row of chips)    │
│  ─ prose, headings           │  Disassembly (scroll)    │
│  ─ executable code block     │  Memory (hex viewer)     │
│    (CodeMirror 6, editable)  │  Output (console)        │
│  ─ inline result/output      │                          │
│                              │                          │
└──────────────────────────────┴──────────────────────────┘
```

- Left pane ~55%: the literate lesson. Multiple executable blocks allowed;
  the "active" block (last focused/run) is what the machine panel reflects.
- Right pane ~45%: sticky machine panel, sections stacked, each with a
  monospace body and small uppercase section label.

## Behavior (all prototypes)

1. **Assemble on Run.** `▶ Run` assembles the active block. On success:
   machine state initialized, program loaded, PC set to entry, disassembly
   listing populated, status chip shows "loaded · N instructions".
   On error: status chip red, offending line highlighted in the editor with
   the error message (line number + reason) shown inline under the block.
2. **Step.** `⤵ Step` executes exactly ONE instruction, then: registers,
   flags, memory, output, disassembly current-line marker, and editor line
   highlight all update. Registers that changed since the previous step are
   visually marked (accent color). Editor + disassembly auto-scroll to the
   current instruction.
3. **Run to completion.** A second click of `▶ Run` (or a separate control)
   executes until program end (exit syscall/ret from entry), animating no
   per-step updates required — final state shown, output console streams
   everything the program wrote.
4. **Reset.** `⟲ Reset` restores initial state, clears output, keeps code.
5. **Output.** Programs print via the ISA's convention (x86-64: `syscall`
   with rax=1/write; RISC-V: `ecall`); bytes are appended to the output
   console as UTF-8 text.
6. **Step when not loaded** = assemble then execute first instruction.
7. Machine state UI must always render even before first run (zeroed).

## Visual language

- Dark theme, high contrast, teaching-friendly. Font: system UI for prose;
  `ui-monospace/SF Mono/Menlo/monospace` for code, registers, memory.
- Colors via CSS custom properties (`--bg`, `--fg`, `--muted`, `--accent`,
  `--changed`, `--error`) so siblings look like one family.
- Register grid: 16–17 cells (GPRs + PC), each `name` over `hex value`
  (`0x0000000000000042`-style, ISA-appropriate width) with signed decimal
  subtitle. Changed registers get accent left-border + tinted background
  until next step.
- Flags: chips `ZF CF SF OF` (+ `PF AF` for x86), lit when set.
- Disassembly: `addr | bytes | mnemonic operands`; current row highlighted.
- Memory viewer: hex dump of a fixed region around `.data` (or a `dump`
  register choice), 16 bytes/row, ASCII column.
- Executable code block: subtle border, "▶ Run" button top-right of block,
  output area appears beneath the block after run (duplicated in right-pane
  console is fine and expected).

## Sample lesson content (per prototype)

Each prototype ships one real lesson with ≥2 executable blocks:

1. **Hello**: write a string via syscall/ecall → proves output plumbing.
2. **Sum/Fibonacci loop**: initialize, loop with compare+branch, accumulate
   in a register → proves stepping shows register evolution, flags changing,
   and program exit.

Blocks are editable; samples are restorable via a "Reset code" link on the
block (restore default sample).

## Scaffolding rules

- Vite + TypeScript, vanilla DOM (no UI framework), CodeMirror 6 editor.
- App fully self-contained after build: `vite build` output must work from a
  static file server with no network (wasm assets bundled/vendored locally).
- No telemetry, no external fonts/CDNs at runtime.

## Org-mode compatibility (binding requirement)

The system is org-first: lesson content is authored as **Emacs org-mode
text** and rendered by the site. Each prototype embeds its lesson as a real
`.org` document (Vite `?raw` import of `src/lesson.org`) parsed client-side.
The org file must stay valid org-babel source in Emacs (headings, prose,
`#+BEGIN_SRC` blocks, `#+NAME:`, `#+RESULTS:`), so authors can edit the same
file in Emacs later.

### Org-subset grammar all prototypes implement (identical behavior)

- `*`, `**`, … line starts → headings, depth = star count.
- `#+TITLE:` / `#+SUBTITLE:` → page header.
- `#+NAME: <id>` → names the immediately-following block (id for focus/deep-link).
- `#+BEGIN_SRC <lang> [headers…]` / `#+END_SRC` → executable block when
  `<lang>` is the app's asm language (`asm` for x86 prototypes, `asm-riscv`
  for the RISC-V one); other languages render read-only. Babel headers
  (`:results`, `:exports`, `:var`, …) are parsed and ignored for now, never
  rejected.
- `#+RESULTS:` → a following block/paragraph is the canned results slot;
  on run, live output replaces its rendered content (document DOM only —
  we never mutate the authored org text in memory).
- Paragraphs = blank-line-separated text; inline markup: `*bold*`,
  `/italic/`, `=code=`, `~verbatim~`.
- `- item` → bullet list; org table rows (`| a | b |`) → HTML table.
- `# comment` (no `#+`) → hidden.

Implementation: a small hand-written org-subset parser (~150–250 LOC TS)
inside each app — no unified/ecosystem dependency — validated against the
sample lesson. Parser behavior is part of the shared contract: same lesson
org text renders identically (modulo ISA-specific blocks) in all prototypes.
