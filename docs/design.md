# didact — Design Contract

One product, kernel-extensible, textbook-styled. Binding for all packages.

## Product

An org-babel-like teaching site, 100% client-side. The page is a *literate
document*: serif prose explaining a concept, then executable code blocks the
student edits and runs. Languages are provided by **kernels** registered per
org `#+BEGIN_SRC` language tag. Each kernel contributes an **under-the-hood
view** (machine panel); the only tooltips are source-line comments on
listing rows.

Kernels: `asm` (x86-64 via Unicorn/Keystone/Capstone wasm,
`packages/kernel-asm64`), `riscv` (RV32I+M) and `mips` (MIPS32) interpreters,
`c`/`cpp` via `@yowasp/clang`, `python` via Pyodide, `typst` via its compiler
wasm, and pure-TypeScript `wasm`, `sql`, `matlab`, `lua`, `javascript`,
`regex`, `lisp`, `elisp`, `prolog`, `fortran` — seventeen ids, all registered in
`apps/site/src/main.ts`. The system must make
adding kernels a matter of implementing one package against
`docs/architecture.md`.

## Behavior

1. **No global toolbar.** Every executable block owns its controls, inline in
   its header: `▶ Run`, `⤵ Step`, `⟲` (Reset session), `↺` (Revert code),
   `⧉` (Copy code), and a monospace status text. Kernels may opt out of
   stepping (`features.stepping === false` hides the Step button
   entirely). Every block editor supports Cmd/Ctrl+Enter (Run), Shift+Enter
   (Step when supported), and Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z (or Ctrl+Y)
   undo/redo.
2. **Run** = assemble + execute to completion (kernel budget bounded); if the
   session is paused or mid-step and the editor text is unchanged, Run
   continues from that point instead of restarting. The block being executed
   gets a visible *running* highlight; when finished, status shows
   `finished · exit summary · N steps` (or `halted` when the run did not reach
   an exit; `1 step` is singular; kernels with `features.stepping === false`
   omit the `· N steps` suffix — the count is meaningless without
   instructions). Status also shows `working…`, `running…`, `stepping…`,
   `reset · ready`, and `halted · nothing left to execute`. On a breakpoint pause,
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
   `features.breakpoints`, pressing a line number in the editor gutter
   (mousedown) toggles a breakpoint on that 1-based line — a filled black square
   marker in a slim gutter, textbook style. Breakpoints are stored per
   block and mapped through document edits. Reset clears pause state but
   keeps breakpoints. Kernels without the feature get no gutter click
   behavior.
5. **Reset session vs Revert code.** `⟲` (Reset session) resets that block's
   session to its initial state, clears the current-line mark and the
   results-slot output, and forces the next Run to re-assemble from the
   current editor text; code, saved draft, and breakpoints are kept; status
   shows `reset · ready`. `↺` (Revert code) restores the org sample and drops
   the saved draft, leaving the session and its output running.
6. **Under-the-hood panel** is the third zone: a rail between the document
   and the navigation rail (the page's right edge while the navigator stays
   left) that is zero-width (and hairline-invisible) until a panel attaches, then
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
   listing row shows its kernel-supplied source-line tip on hover (`;`
   comments for asm64); rows without a tip get no tooltip. Hovering a
   register/flag row instead highlights it: pure-CSS neutral tint + gray
   2px left rule — the changed-marking language in neutral gray, so it
   can't be read as a change.
9. Machine state renders the session's current values (zeroed / idle before
   anything executes) whenever the panel attaches. The panel is mounted only
   by a run/step, a Reset, or a failed load (rule 6), so nothing is painted at
   mount.
10. **Pages.** One mount renders one org document at a time in a layout with
    a single collapsible navigation rail at either edge (left by default)
    beside the document column, plus the panel zone (rule 6) when attached.
    The rail shows one list — this page's Contents, the Pages list (rule 11),
    or live search results — never more than one. Page titles appear as links
    in the Pages list (active underlined and near-black, others gray).
    Routing defaults to hash-based (`routing: 'hash'`), with an in-memory
    mode (`routing: 'memory'`) for embedded hosts that must not touch
    `location.hash`: a page's fragment is `#/<page-slug>`, a section's is
    `#/<page-slug>/<section-slug>` (slugs kebab-cased: lowercased,
    non-alphanumeric runs collapsed to single '-'). Every nav and contents
    link is a real fragment href; on mount in hash mode the site reads
    `location.hash` and shows that page (unknown or missing page slug →
    `initialPage` or the first page, and the URL is normalized to name the
    page actually shown), and `hashchange` (nav click, contents click,
    back/forward) either switches the rendered document — disposing the old
    page's blocks and detaching the panel — or scrolls within the current
    page. A section hash scrolls to its heading — smooth within a page,
    instant after a page swap; a page-level hash (or an unknown section)
    means the top of the page.
11. **Rail contents.** The h2/h3 headings (org depth 1/2) of the
    rendered page build the navigation rail's Contents view: one
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

- **Light mode only.** Primary ink `#171717` (`--lw-ink`) and editorial body
  prose `#2b2b2b` (`--lw-prose`) on white `#ffffff` (`--lw-paper`). No accent
  color: emphasis via weight, italic, and hairline rules.
- **No rounded corners inside Didact** (`border-radius: 0` scoped to
  `.lw-site`, `.lw-block`, and `.lw-tip`, never applied globally to the host
  document).
- Fonts: prose **Atkinson Hyperlegible** (self-hosted via
  `@fontsource/atkinson-hyperlegible`, regular/italic/bold); code, status,
  machine panel: `ui-monospace, SF Mono, Menlo, monospace`.
- Code editor theme: **Ayu Light** (`ayuLight` from `thememirror`),
  overridable via `mountSite({ editorTheme })`.
- Structure: hairline `#e6e6e2` (`--lw-hairline`) and interactive `#c6c6c0`
  (`--lw-hairline-strong`) borders, `#f4f4f1` (`--lw-surface-alt`) subtle
  fills, `#6e6e68` (`--lw-gray`) metadata, generous whitespace, small-caps
  section labels. Changed registers marked with a left rule + warm tint
  (`#f6f0dc`, `--lw-tint`), not color-coded text. Status/error states: error
  text uses dark red `#991b1b` (`--lw-error`) with `#fef2f2` (`--lw-error-bg`)
  fills; success states stay ink-on-paper/tint (no green).
- Layout: at rest two zones — the collapsible navigation rail (232px,
  seesawing between the left edge and the right one on demand, or collapsing
  to `0` with a floating reveal button `⇥` / `⇤`) and the document center —
  plus a third zone, the panel rail, sliding from 0 to
  `clamp(420px, 42vw, 720px)` when attached (28vw < 1420px, where it
  would squeeze the document); while attached at 900-1199px the panel is
  `clamp(400px, 40vw, 460px)`, and below 900px it is full-width under the
  document. The rail shows **one list at a time**:
  a header bar carries a small-caps `Contents | Pages` switch, a compact side
  toggle (`←`/`→`), and a hide button (`⇤`/`⇥`); below it either this page's
  section tree or the page list renders in the same rhythm — never both, never
  split top and bottom. On a large display the reading
  **measure and the body type grow together** — wider text, bigger
  letters: 74ch at 16px, 82ch at 17px from 1600px, 90ch at 18px from
  2200px (a `ch` is 0.648em in Atkinson Hyperlegible, so 74ch is
  767px, 82ch 903px, 90ch 1050px — about 100, 111 and 122 characters
  a line); headings and spacing are em-based, so they scale with the
  prose. Tables and code blocks may run to `min(100%, 90ch)`. The
  layout frame is rail + 2 * (measure + 4.5rem) — 119.4rem at the
  base measure, 136.4rem from 1600px, 154.7rem from 2200px — so side
  padding stays a 1.5-2.25rem gutter instead of a half-empty band;
  while a panel is attached the same frame is split three ways and the
  document never narrows below 40ch (the doc's own ch, ~467px at
  18px). The text is centred in the band beside the rail by the grid
  itself (`margin-inline: auto` on the doc, no left/right offset), and
  while a panel is attached both gaps around the text are the gutter.
  The navigator's DOM order follows its side: left = rail, document,
  panel; right = document, panel, rail. The grid template matches that
  order, so the rail always keeps its 232px track and the panel never
  rides over it. At 900-1199px with a panel attached the rail moves to
  a header strip (the page list wraps horizontally; the section list stays
  a column) and document + panel stay side by side, so the panel is not
  pushed below the fold and the document keeps ~40-65ch.
  Hairline separators, rails sticky and internally scrolling (the
  one shown list — Contents, Pages, or live search results — scrolls on
  its own when the viewport is short); zones
  stack vertically < 900px, where the rail header still shows the
  Contents | Pages switch, the side toggle, and the hide toggle, the page list
  wraps horizontally, and the panel (full-width, under the document) appears
  only while attached.
  Page-level chrome is the rail's wordmark/search masthead and small-caps
  switch, the plain document title header, and the lesson footer; there
  is no global toolbar. The navigator remembers which side it
  was put on (`<prefix>nav-side`, default `didact:nav-side`) and whether it
  is collapsed (`<prefix>nav-hidden`, default `didact:nav-hidden`), and
  `mountSite` can set the initial side with `navSide` and the initial list
  with `navView` (the example site opens on Pages; the core default is
  Contents). Full token reference: [`docs/theming.md`](theming.md).

### Rail masthead, search, and completion

The rail's first block is the wordmark (a real link home) over a full-width
serif search field: 1px hairline, zero radius, ink focus-visible outline,
and a hairline under the block that doubles as the switch bar's top rule.
Live results take the rail's one scrolling slot and replace the current
Contents/Pages list; each hit is a block link with an ink title over a
gray snippet clamped to two lines, underlined on hover/focus. Results must
not overflow the 232px rail; below 900px they stay inside the stacked rail
with a bounded scroll height. The wordmark/search group is quiet chrome:
no page-level toolbar is introduced.

A completed page carries a small ink ✓ (`aria-hidden`, appended after the
link text) in the Pages rail, and `data-complete="true"` on the link; the
marker is deliberately small so titles do not visibly shift, and it is
never the only completion signal — the footer states the reading.

### Lesson footer

A hairline and a generous top margin close the article. Previous and Next
are text links in page order (ends omitted), with small-caps `Previous` /
`Next` labels supplied by `::before`; they share a row at normal widths and
stack left-aligned below 700px. The progress line (`Exercises n/m`,
`Page complete`, `Not complete`) is small-caps gray. The manual
`Mark complete` button uses the same hairline/mono language as block
header buttons; its pressed state adds an ink border and underline, not a
color change. The footer follows the document's measure (74/82/90ch) and
fills the phone column below 900px.

### Hint and solution folds

Folds are native `<details>`, closed by default, boxed by a 1px hairline
like a block, with a small-caps summary and the native disclosure triangle.
Hint and solution differ only by their label and the solution's bold
weight — no accent color. The open summary gains a hairline underneath and
the body a small padding; that padding is the only inset, so nested blocks,
result slots, tables, and further folds keep their own full width. The
summary is keyboard-operable and shows a 1px ink focus-visible outline.

### Exercise badge

The `#+EXERCISE`/`#+CHECK` badge is compact mono small-caps in a hairline
box, like the session label but styled independently. Pending and running
are gray (running a dashed rule); passed is ink with an ink border and bold
weight; failed is error ink with a dotted underline; unchecked is muted
gray with a dotted border and underline. The state word is always part of
the text, so weight, rules, and color only reinforce it — never replace it.
Passed outcomes persist; failed outcomes live only in the session.

## Org-mode compatibility (binding)

Org-first content: lessons are real `.org` files imported via Vite `?raw`,
parsed client-side by the core org-subset parser (grammar in this file).
`#+BEGIN_SRC <lang>` blocks are executable when `lang` matches a registered
kernel id (`asm`, `riscv`, `mips`, `c`, `cpp`, `fortran`, `python`, `typst`,
`wasm`, `sql`, `matlab`, `lua`, `javascript`, `regex`, `lisp`, `elisp`,
`prolog`); other languages render read-only.
The org file must remain valid org-babel source in Emacs.

### Org-subset grammar

- `*`… headings (depth = stars); `#+TITLE:`/`#+SUBTITLE:` page header.
- `#+NAME: <id>` names the next block (blank lines, comments, and other
  directives in between do not drop the promise; only another `#+NAME:`
  or EOF does); `#+CAPTION: <text>` captions the next block's figure
  (rendered as `<figcaption>` for a static diagram, which also names it
  for assistive technology).
- `#+EXERCISE: <title>` / `#+CHECK: <expected output>` promise the next
  src block an exercise check. The block carries `{ title, expected }`:
  `title` falls back to `Exercise` when only `#+CHECK:` is present and
  `expected` is null when there is no check. Both promises clear after
  that block; `#+NAME:`/`#+CAPTION:` still apply to the same block and
  neither directive changes the block's language, headers, or code.
- `#+BEGIN_HINT` … `#+END_HINT` and `#+BEGIN_SOLUTION` … `#+END_SOLUTION`
  (case-insensitive) render as closed `<details>` folds titled "Show hint"
  and "Show solution". Fold bodies recurse through this same grammar —
  they may nest and may contain `#+BEGIN_SRC`, whose executable index
  stays in document order. An unterminated fold closes at EOF.
- `#+BEGIN_COMMENT` … `#+END_COMMENT` hides every line in between,
  case-insensitively.
- `#+BEGIN_SRC <lang> [headers]` / `#+END_SRC`; babel headers are parsed
  (they distinguish the two Typst layers, below) and otherwise ignored,
  except `:session <name>` (below).
- `:session <name>` header: blocks with the same kernel and name on one
  rendered page share a single kernel session, so definitions and data
  from earlier blocks stay live (org-babel semantics; every Run continues
  the state). Sessions are page-scoped — a page switch or site dispose
  ends them. Sharing requires the kernel's optional `Session.resume(src)`;
  a kernel without it still runs its blocks, isolated, with a visible
  unsupported badge.
- `#+RESULTS:` slot replaced by live output on run (DOM only).
- `$…$` inline Typst math and `$$…$$` display math are rendered at build
  time (MathML by default, SVG fallback). `=code=` and `~verbatim~` are
  literal, so `=$v0=` is not math; `\$` is a dollar.
- `#+BEGIN_SRC typst :results svg` (or `:file x.svg`) is a **static
  diagram**: the build compiles it once and inlines the SVG. A `typst`
  block without that header is the executable in-browser kernel. Same
  language, two lifecycles; they never share a session.
- Unsupported constructs (unknown `#+` directives, stray `#+END_SRC`,
  unterminated src blocks, a `#+NAME:` promise lost to another `#+NAME:` or
  EOF, numbered lists, blockquotes,
  Markdown links, `:` output outside `#+RESULTS:`, missing `#+TITLE:`) are
  reported by `parseOrgChecked` as `{ line, severity, message }`; the site
  shows them in a banner and `didact check` reports them. Plain `# ` comments
  stay hidden.
- Paragraphs with `*bold*` `/italic/` `=code=` `~verbatim~`; `- ` bullet
  lists; `| a | b |` tables; `# ` comments hidden.
- Links: `[[file:<page>.org][label]]` (page), `[[file:<page>.org::*Heading][label]]`
  and `[[file:<page>.org::#section-slug][label]]` (page + section),
  `[[*Heading][label]]` / `[[#section-slug][label]]` (current page), and
  `[[https://…][label]]` / `[[mailto:…][label]]` (external). A bare
  `[[<page>.org::*Heading]]` works too, as org resolves a relative file
  link. Page/section names are the site's hash routes, so `<page>.org` is
  resolved by file name (a `PageSpec.file`), then file stem, then page
  slug; an unknown page, heading, or section renders inert as a
  `data-test="link-broken"` span instead of navigating.

## Pages

The site app (`apps/site`) owns no rendering: `src/main.ts` mounts core with
the kernel registry and every `.org` in `apps/site/src/pages/` (imported via
Vite `import.meta.glob('./pages/*.org', { query: '?raw', eager: true })`).
Drop a new `<name>.org` there and add its stem to the `PAGE_ORDER` list in
`main.ts` — a nav entry appears at that position, titled from the file's
`#+TITLE:` line (file name as fallback; non-ASCII or colliding titles fall
back to `page-<n>` for the URL). A globbed file missing from `PAGE_ORDER`
logs a console warning and is skipped, and a `PAGE_ORDER` stem with no
matching file is skipped the same way; zero resolvable pages is a hard
error. A block is executable when its
`#+BEGIN_SRC <lang>` language matches a registered kernel id; anything else
renders read-only.

## E2E test hooks (binding)

Per block: `block-run`, `block-step`, `block-reset`, `block-revert`,
`block-copy`, `block-status`, `block-exercise` (with `data-state`),
`block-session` (with `data-session`; unsupported kernels also carry
`lw-session-unsupported`), `editor`, `block` (root), `block-error`,
`results`; gutter line numbers
`gutter-N`, breakpoint markers `breakpoint-N`. Folds: `fold-hint`,
`fold-solution`. Panel: `uth` (root),
`uth-title`, `uth-detach`; panel sections `uth-sections`; register cells
`reg-<name>`; disassembly current row `current-instr`; console `output`;
trusted markup sections `html-panel`; the block's restore link
`restore-sample`. Site: `nav` (the navigation rail, left or right), `brand`,
`search`, `search-results` (one result link per hit),
`rail-view-contents` / `rail-view-pages` (the Contents | Pages switch
buttons, `aria-pressed`), `rail-side` (the side toggle), `rail-hide` /
`rail-show` (collapse and reveal buttons for the sidebar), `nav-list` (the
pages list, present only in the Pages view), `nav-item` (one per page link;
the active page also carries `lw-nav-active` and `aria-current="page"`),
`org-warnings` (diagnostics banner root, one `org-warning` per item), `page`
(rendered document root), `toc` (the rail's Contents container, hidden
while the Pages view shows), `toc-item` (one per h2/h3 heading deep
link; the active entry carries `lw-toc-active`), `page-footer`,
`prevnext`, `page-progress`, `page-complete`, `link-broken` (an
unresolved internal link, inert text). Vite `base: './'`.

## Non-goals

No framework, no runtime network, no dark mode, no deprecated shims — when
something is replaced it is deleted.
