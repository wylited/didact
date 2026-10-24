# Literate Website — Design Contract (v0.2 refactor)

One product, kernel-extensible, textbook-styled. Binding for all packages.

## Product

An org-babel-like teaching site, 100% client-side. The page is a *literate
document*: serif prose explaining a concept, then executable code blocks the
student edits and runs. Languages are provided by **kernels** registered per
org `#+BEGIN_SRC` language tag. Each kernel contributes an **under-the-hood
view** (machine panel) with hover tooltips explaining what is going on.

First kernel: x86-64 assembly via Unicorn/Keystone/Capstone WASM (from v0.1
`apps/x64-unicorn`). The system must make adding kernels (python, typst, …)
a matter of implementing one package against `docs/architecture.md`.

## Behavior

1. **No global toolbar.** Every executable block owns its controls, inline in
   its header: `▶ Run`, `⤵ Step`, `⟲ Reset`, and a monospace status text.
2. **Run** = assemble + execute to completion (kernel budget bounded). The
   block being executed gets a visible *running* highlight; when finished,
   status shows `finished · exit summary · N steps`. Load errors: red status
   + line-mapped message under the block; nothing executes.
3. **Step** = assemble if needed, then execute exactly ONE unit (instruction).
   The executed line is highlighted in the block's editor; the corresponding
   listing row in the under-the-hood view is highlighted and scrolled to.
4. **Block Reset** restores that block's machine to its just-assembled state
   and clears its output; code is kept.
5. **Under-the-hood panel** is a single right-hand pane attached to at most
   ONE block at a time — the last block that ran/stepped. Its header shows
   the attached block (`#name` or `Block N`) and kernel label, plus a
   **detach** button that disconnects the panel from any block (panel goes
   idle-empty; blocks keep running independently; next run/step re-attaches).
6. **Output.** Program output renders in the block's results slot (`#+RESULTS:`
   convention) and in the panel's console when attached.
7. **Tooltips.** Every meaningful element in the under-the-hood view
   (registers, flags, panel sections, listing rows) and block status carries
   a short teaching explanation on hover (`data-tip`). Plain CSS/JS tooltip,
   no dependency.
8. Machine state UI renders even before first run (zeroed / idle states).

## Visual language — "textbook, light"

- **Light mode only.** Prose: near-black `#1a1a1a` on white `#ffffff`.
  No accent color: emphasis via weight, italic, and hairline rules.
- **No rounded corners anywhere** (`border-radius: 0` globally).
- Fonts: prose **Atkinson Hyperlegible** (self-hosted via
  `@fontsource/atkinson-hyperlegible`, regular/italic/bold); code, status,
  machine panel: `ui-monospace, SF Mono, Menlo, monospace`.
- Code editor theme: **Ayu Light** (use `thememirror`'s ayu theme; if its
  export name differs, hand-roll the small Ayu Light tag palette — verify
  against installed package, do not ship a guess).
- Structure: hairline `#d0d0d0` borders, generous whitespace, small-caps
  section labels. Changed registers marked with a left rule + tint, not
  color-coded text. Status/error states: error text may use dark red
  `#8b1a1a`; success states stay black-on-white (no green).
- Layout: two panes — lesson left (~55%), under-the-hood panel right (~45%),
  sticky, internally scrolling; panes stack vertically < 900px. No page-level
  chrome beyond a plain document title header.

## Org-mode compatibility (binding, unchanged from v0.1)

Org-first content: lessons are real `.org` files imported via Vite `?raw`,
parsed client-side by the core org-subset parser (grammar in this file).
`#+BEGIN_SRC <lang>` blocks are executable when `lang` matches a registered
kernel id (`asm` for the x86-64 kernel); other languages render read-only.
The org file must remain valid org-babel source in Emacs.

### Org-subset grammar

- `*`… headings (depth = stars); `#+TITLE:`/`#+SUBTITLE:` page header.
- `#+NAME: <id>` names the next block.
- `#+BEGIN_SRC <lang> [headers]` / `#+END_SRC`; babel headers parsed+ignored.
- `#+RESULTS:` slot replaced by live output on run (DOM only).
- Paragraphs with `*bold*` `/italic/` `=code=` `~verbatim~`; `- ` bullet
  lists; `| a | b |` tables; `# ` comments hidden.

## E2E test hooks (binding)

Per block: `block-run`, `block-step`, `block-reset`, `block-status`,
`editor`, `block` (root), `block-error`, `results`. Panel: `uth` (root),
`uth-title`, `uth-detach`; panel sections `uth-sections`; register cells
`reg-<name>`; disassembly current row `current-instr`; console `output`.
Vite `base: './'`.

## Non-goals

No framework, no runtime network, no dark mode, no deprecated shims — when
something is replaced it is deleted.
