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
6. **Under-the-hood panel** owns the right rail once attached — at most
   ONE block at a time, the last that ran/stepped. The panel **starts
   detached**: at load the right rail shows the section TOC at 264px;
   the first run/step of any block attaches the panel, the rail widens
   to `clamp(420px, 42vw, 720px)` (300ms width transition, TOC → panel
   ~160ms cross-fade; all motion disabled under
   `prefers-reduced-motion: reduce`), and the doc column's content is
   capped at ~74ch centered. Its header shows the attached block
   (`#name` or `Block N`) and kernel label, plus a **detach** button;
   while attached, field sections (registers, flags, scopes…) re-flow
   into a wrapping grid (`repeat(auto-fill, minmax(170px, 1fr))`),
   while listings and hexdumps stay single-column. Detaching — or
   switching pages — removes the panel element from the DOM and returns
   the rail to TOC mode; any later run/step re-attaches.
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
10. **Pages.** One mount renders several org documents in a three-zone
    layout: a collapsible left page rail and a dual-width right rail
    (rule 6) around the document column. The left rail's header carries
    a chevron + "Pages" toggle (`aria-expanded`); collapsed, the rail
    animates down to a 32px strip keeping only the toggle, expanded it
    is 192px — collapse state is per-session, never persisted. Page
    titles appear as links in the left rail (active underlined and
    near-black, others gray); section headings in the right-rail TOC
    (rule 11). Pages are hash-routed: each page's fragment is
    `#/<slug>` (slug = kebab-cased page title: lowercased,
    non-alphanumeric runs collapsed to single '-'). On mount the site
    reads `location.hash` and shows that page (unknown or missing hash →
    the first page); nav links are fragment hrefs, and `hashchange`
    (nav click, back/forward) switches the rendered document: the old
    page's blocks are disposed and the panel detaches until the next
    run/step.
11. **Right-rail section TOC.** The h2/h3 headings (org depth 1/2) of
    the rendered page build the right rail's table of contents while no
    panel is attached: one small gray link per heading (h3 indented),
    ids `lw-h-<n>` in document order per page, and a scroll-spy keeping
    exactly one active entry — near-black with a 2px left rule —
    starting from the first entry and reset on page switch. Entries
    smooth-scroll on click and never touch location.hash (fragments
    name pages); a page without h2/h3 headings leaves the rail empty
    until a panel attaches.
12. **Motion.** Width modulation (rails) and content cross-fades
    transition over 300ms / ~160ms respectively; all of it is disabled
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
- Layout: three zones on one grid — collapsible page rail left (192px,
  32px strip when collapsed), document center, dual-width right rail
  (section TOC 264px; panel `clamp(420px, 42vw, 720px)`), separated by
  hairline rules, sticky and internally scrolling; zones stack
  vertically < 900px. While the panel is attached the doc column's
  content is capped at ~74ch centered. Page-level chrome is limited to
  the rails' small-caps headers and the plain document title header.

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
trusted markup sections `html-panel`. Site: `nav` (left rail), `nav-item`
(one per page link), `nav-toggle` (left-rail collapse), `page` (rendered
document root), `toc` (right-rail table of contents), `toc-item` (one per
h2/h3 heading link; the active entry carries `lw-toc-active`). Vite
`base: './'`.

## Non-goals

No framework, no runtime network, no dark mode, no deprecated shims — when
something is replaced it is deleted.
