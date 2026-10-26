# didact — Design Contract (v0.2 refactor)

One product, kernel-extensible, textbook-styled. Binding for all packages.

## Product

An org-babel-like teaching site, 100% client-side. The page is a *literate
document*: serif prose explaining a concept, then executable code blocks the
student edits and runs. Languages are provided by **kernels** registered per
org `#+BEGIN_SRC` language tag. Each kernel contributes an **under-the-hood
view** (machine panel); the only tooltips are source-line comments on
listing rows.

Kernels: x86-64 assembly via Unicorn/Keystone/Capstone WASM (from v0.1
`apps/x64-unicorn`), RV32IM and MIPS32 interpreters, C via clang wasm,
Python via Pyodide, and Typst via its compiler wasm. The system must make
adding kernels a matter of implementing one package against
`docs/architecture.md`.

## Behavior

1. **No global toolbar.** Every executable block owns its controls, inline in
   its header: `▶ Run`, `⤵ Step`, `⟲ Reset`, and a monospace status text.
   Kernels may opt out of stepping (`features.stepping === false` hides the
   Step button entirely).
2. **Run** = assemble + execute to completion (kernel budget bounded). The
   block being executed gets a visible *running* highlight; when finished,
   status shows `finished · exit summary · N steps` (kernels with
   `features.stepping === false` omit the `· N steps` suffix — the count
   is meaningless without instructions). On a breakpoint pause,
   status shows `paused · line N` (mono, normal ink — not error red), the
   paused line gets the current-line decoration, and the panel shows the
   paused machine state. Load errors: red status + line-mapped message
   under the block; nothing executes.
3. **Step** = assemble if needed, then execute exactly ONE unit
   (instruction); it continues one instruction from a breakpoint pause.
   The executed line is highlighted in the block's editor; the
   corresponding listing row in the under-the-hood view is highlighted
   and scrolled to.
4. **Breakpoints.** In blocks whose kernel declares
   `features.breakpoints`, clicking a line number in the editor gutter
   toggles a breakpoint on that 1-based line — a filled black square
   marker in a slim gutter, textbook style. Breakpoints are stored per
   block and mapped through document edits. Reset clears pause state but
   keeps breakpoints. Kernels without the feature get no gutter click
   behavior.
5. **Block Reset** restores that block's machine to its just-assembled
   state and clears its output; code and breakpoints are kept.
6. **Under-the-hood panel** is the third zone: a right rail that is
   zero-width (and hairline-invisible) until a panel attaches, then
   slides wide to `clamp(420px, 42vw, 720px)` over 300ms (all motion
   disabled under `prefers-reduced-motion: reduce`). At most ONE panel
   at a time — the last block that ran/stepped. Its header shows the
   attached block (`#name` or `Block N`) and kernel label, plus a
   **detach** button; while attached, field sections (registers,
   flags, scopes…) re-flow into a wrapping grid
   (`repeat(auto-fill, minmax(170px, 1fr))`), while listings and
   hexdumps stay single-column. Detaching — or switching pages —
   removes the panel element from the DOM and collapses the rail back
   to zero; any later run/step re-attaches.
7. **Output.** Program output renders in the block's results slot
   (`#+RESULTS:` convention) and in the panel's console when attached.
   Trusted kernel-generated markup (`html` panels, e.g. rendered SVG)
   renders in the panel and alongside console output in the results slot.
8. **Tooltips are comments only.** No hardcoded teaching tooltips:
   registers, flags, section titles, status, and controls carry none. A
   listing row shows its source line's trailing `;` comment on hover
   (kernel-supplied); rows without a comment get no tooltip. Hovering a
   register/flag row instead highlights it: pure-CSS neutral tint + gray
   2px left rule — the changed-marking language in neutral gray, so it
   can't be read as a change.
9. Machine state UI renders zeroed / idle states before first execution
   (visible once the panel is attached).
10. **Pages.** One mount renders several org documents in a two-zone
    layout at rest — a left navigation rail (contents above, rule 11;
    pages below) around the document column — plus the panel zone
    (rule 6) when attached. Page titles appear as links in the rail's
    Pages section (active underlined and near-black, others gray).
    Routing is hash-based and uniform: a page's fragment is
    `#/<page-slug>`, a section's is `#/<page-slug>/<section-slug>`
    (slugs kebab-cased: lowercased, non-alphanumeric runs collapsed
    to single '-'). Every nav and contents link is a real fragment
    href; on mount the site reads `location.hash` and shows that page
    (unknown or missing page slug → the first page, and the URL is
    normalized to name the page actually shown), and `hashchange`
    (nav click, contents click, back/forward) either switches the
    rendered document — disposing the old page's blocks and detaching
    the panel — or scrolls within the current page. A section hash
    scrolls to its heading — smooth within a page, instant after a
    page swap; a page-level hash (or an unknown section) means the
    top of the page.
11. **Left-rail contents.** The h2/h3 headings (org depth 1/2) of the
    rendered page build the navigation rail's Contents section: one
    small gray link per heading (h3 indented), each a real deep link
    `#/<page-slug>/<section-slug>` with the heading's id
    `lw-h-<section-slug>` (slugged, deduplicated with `-2` suffixes,
    ASCII-less headings fall back to `section-<n>` — so anchors
    survive insertions above them). A scroll-spy keeps exactly one
    active entry — near-black with a 2px left rule — starting from
    the first entry and reset on page switch; it never writes the
    hash. A page without h2/h3 headings leaves the section empty.
12. **Motion.** The panel rail's width modulation transitions over
    300ms; the panel content fades in ~160ms; all of it is disabled
    under `prefers-reduced-motion: reduce` (no transitions, no
    animations).

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
- Layout: at rest two zones — navigation rail left (232px: Contents
  above, Pages below, hairline between), document center (content
  capped at ~74ch, centered) — and a third zone, the panel rail,
  sliding from 0 to `clamp(420px, 42vw, 720px)` when attached.
  Hairline separators, rails sticky and internally scrolling (each
  rail section scrolls on its own when the viewport is short); zones
  stack vertically < 900px, where Contents hides, Pages wrap
  horizontally, and the panel (full-width, under the document)
  appears only while attached. Page-level chrome is limited to the
  rail's small-caps headers and the plain document title header.

## Org-mode compatibility (binding, unchanged from v0.1)

Org-first content: lessons are real `.org` files imported via Vite `?raw`,
parsed client-side by the core org-subset parser (grammar in this file).
`#+BEGIN_SRC <lang>` blocks are executable when `lang` matches a registered
kernel id (`asm`, `riscv`, `mips`, `c`, `python`, `typst`); other languages
render read-only.
The org file must remain valid org-babel source in Emacs.

### Org-subset grammar

- `*`… headings (depth = stars); `#+TITLE:`/`#+SUBTITLE:` page header.
- `#+NAME: <id>` names the next block.
- `#+BEGIN_SRC <lang> [headers]` / `#+END_SRC`; babel headers parsed+ignored.
- `#+RESULTS:` slot replaced by live output on run (DOM only).
- Paragraphs with `*bold*` `/italic/` `=code=` `~verbatim~`; `- ` bullet
  lists; `| a | b |` tables; `# ` comments hidden.

## Pages

The site app (`apps/site`) owns no rendering: `src/main.ts` mounts core with
the kernel registry and every `.org` in `apps/site/src/pages/` (imported via
Vite `import.meta.glob('./pages/*.org', { query: '?raw', eager: true })`).
Drop a new `<name>.org` there and add its stem to the `PAGE_ORDER` list in
`main.ts` — a nav entry appears at that position, titled from the file's
`#+TITLE:` line (file name as fallback). A globbed file missing from
`PAGE_ORDER` logs a console warning and is skipped; zero resolvable pages
is a hard error. A block is executable when its
`#+BEGIN_SRC <lang>` language matches a registered kernel id; anything else
renders read-only.

## E2E test hooks (binding)

Per block: `block-run`, `block-step`, `block-reset`, `block-status`,
`editor`, `block` (root), `block-error`, `results`; gutter line numbers
`gutter-N`, breakpoint markers `breakpoint-N`. Panel: `uth` (root),
`uth-title`, `uth-detach`; panel sections `uth-sections`; register cells
`reg-<name>`; disassembly current row `current-instr`; console `output`;
trusted markup sections `html-panel`. Site: `nav` (left rail),
`nav-item` (one per page link), `page` (rendered document root), `toc`
(the rail's Contents section), `toc-item` (one per h2/h3 heading deep
link; the active entry carries `lw-toc-active`). Vite `base: './'`.

## Non-goals

No framework, no runtime network, no dark mode, no deprecated shims — when
something is replaced it is deleted.
