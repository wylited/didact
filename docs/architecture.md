# Architecture — kernel-extensible literate system

pnpm monorepo, TypeScript strict everywhere, no UI framework, Vite only at
the app layer. Packages export **source TS** (`main: src/index.ts`); the app
typechecks and bundles them — no per-package build step, no dist artifacts.

```
packages/core              @didact/core             org parser, block runtime, panel host, theme, resolvePages
packages/cli               @didact/cli              Node 24 native `didact check` CLI (lint + RESULTS/CHECK verification)
packages/vite              @didact/vite             reusable Vite plugins (`didactVite`, `didactTypst`, `didactVendors`) + Typst build pipeline
packages/kernel-asm64      @didact/kernel-asm64      x86-64 via Unicorn/Keystone/Capstone wasm (GPL-2.0 opt-in)
packages/kernel-riscv      @didact/kernel-riscv      RV32IM interpreter (pure TypeScript)
packages/kernel-mips       @didact/kernel-mips       MIPS32 interpreter (pure TypeScript)
packages/kernel-c          @didact/kernel-c          C via vendored clang wasm (wasm32-wasip1)
packages/kernel-cpp        @didact/kernel-cpp        C++ via the same clang engine (libc++, -fno-exceptions)
packages/kernel-fortran    @didact/kernel-fortran    Fortran 90/95/2003 teaching interpreter, column-major array panels (pure TypeScript)
packages/kernel-wasm       @didact/kernel-wasm       WebAssembly WAT-subset stack machine (pure TypeScript)
packages/kernel-python     @didact/kernel-python     Python via vendored Pyodide
packages/kernel-sql        @didact/kernel-sql        SQL engine with per-row plan panels (pure TypeScript)
packages/kernel-matlab     @didact/kernel-matlab     MATLAB-flavored matrix interpreter, column-major panels (pure TypeScript)
packages/kernel-lua        @didact/kernel-lua        Lua teaching-subset interpreter (pure TypeScript)
packages/kernel-javascript @didact/kernel-javascript JavaScript teaching-subset interpreter (pure TypeScript)
packages/kernel-regex      @didact/kernel-regex      Thompson-NFA regex engine, state-set panels (pure TypeScript)
packages/kernel-lisp       @didact/kernel-lisp       Scheme-flavored Lisp interpreter, cons-heap panels (pure TypeScript)
packages/kernel-elisp      @didact/kernel-elisp      Emacs Lisp: Lisp-2 cells, dynamic/lexical binding, buffers, hooks, keymaps (pure TypeScript)
packages/kernel-prolog     @didact/kernel-prolog     SLD-resolution Prolog, choice-point panels (pure TypeScript)
packages/kernel-typst      @didact/kernel-typst      Typst via vendored compiler wasm + fonts
apps/site                  @didact/site             the showcase website (17 src/pages/*.org lessons, kernel registration, @didact/vite)
```

Wiring: packages resolve via pnpm workspace dependencies (`workspace:*`) and
their `package.json` `exports` pointing directly at `src/*.ts` (no
`tsconfig.json` `paths` or Vite `resolve.alias`). One `tsc --noEmit` in
`apps/site` covers all DOM packages (`include: ["src", "../../packages/*/src"]`,
excluding `../../packages/vite/src`), and a second
`tsc -p tsconfig.typst.json` typechecks the Node-side Typst build pipeline in
`packages/vite/src/typst/`.

## Kernel contract (owned by core)

The single source of truth is `packages/core/src/kernel.ts`: `Kernel`,
`Session`, and the five `Panel` kinds (`fields`, `listing`, `hexdump`,
`console`, `html`), plus `Field`, `ListingRow`, `LoadResult`, `RunResult`.
Read that file before touching how blocks run or render panels.

Every kernel package keeps a mirror at `src/types.ts` (so it typechecks
standalone): from `/** One rendered under-the-hood section. */` to EOF it is
byte-identical to core, and `packages/core/test/mirror.test.ts` fails on drift.

Rules: sessions are single-tenant (one per block), except for org-babel
named sessions — `#+BEGIN_SRC <lang> :session <name>` — where every block
on a rendered page with the same kernel id and session name shares one
`Session` instance (see `SharedSession` in `block.ts`). `state()` must be
cheap and complete (core re-renders the whole panel from it); async
signatures today so pyodide-style kernels need no contract change later.

Sessions are optional in the contract: a kernel may implement
`resume(src)` to continue a session's live definitions and data with
another block's source. Kernels without it are still valid; their
`:session` blocks fall back to isolated `load(src)` runs and the block
head shows an unsupported badge (console-warned once). Sessions created
for a page are disposed when the page switches or the site is disposed;
`BlockRuntime` only disposes sessions it created itself (normal blocks),
never a host-supplied named session.

## Core responsibilities (`@didact/core`)

- `parseOrg(src): OrgDoc` / `parseOrgChecked(src)` — grammar per `docs/design.md`.
- `resolvePages(sources, order): PageSpec[]` — turns globbed `.org` files + an
  explicit page order into ordered `PageSpec` entries (with `file: '<stem>.org'`).
- Subpath exports: `@didact/core/org`, `@didact/core/typst`, `@didact/core/babel`,
  `@didact/core/kernel`, and `@didact/core/theme.css`.
- `mountSite(opts)` → renders the collapsible navigation rail + active page
  document, block runtimes, panel host. Accepts `root`, `kernels`, `pages`,
  `fonts?`, `navSide?`, `navView?`, `brand?`, `brandHref?`, `typst?`,
  `storagePrefix?`, `storage?`, `routing?` (`'hash' | 'memory'`),
  `initialPage?`, `documentTitle?`, `onNavigate?`, `onExerciseResult?`,
  `showOrgWarnings?`, `editorTheme?`, `editorExtensions?`, `editorLanguages?`.
  `SiteHandle` exposes `blocks`, `panel`, `activeIndex`, `activeSlug`,
  `navSide`, `navView`, `navHidden`, `show(index)`, `navigate(page, section?)`,
  `setNavSide(side)`, `setNavView(view)`, `setNavHidden(hidden)`, `dispose()`.
- Block runtime: CodeMirror 6 editor (Ayu Light default, Cmd/Ctrl+Z undo/redo),
  per-block controls + status + error box + results slot; running highlight
  (panel attachment is the site-root `lw-panel-attached` layout state); current
  line decoration on step and breakpoint pause; gutter breakpoints when
  `features.breakpoints` (Step button hidden when `features.stepping ===
  false`); `data-test` hooks.
- Panel host: renders `Session.state()` panels (generic renderers for the
  five Panel kinds, `html` via trusted `innerHTML`), attach/detach
  (detach unmounts the panel and collapses the layout), global tooltip
  engine for `[data-tip]` — comment-only tooltips on listing rows.
- Styles: the textbook-light theme scoped under `.lw-site` / `.lw-block` /
  `.lw-tip` (CSS custom properties, zero radius, Atkinson Hyperlegible via
  `@fontsource` import, mono stack for code/panel, collapsible nav rail +
  detached single-column state; see `docs/theming.md`).

## Block identity, persistence, and completion

**Block identity.** Every page has a storage key: `PageSpec.file` when the
page names its source file, otherwise its URL slug. Executable blocks are
numbered in document order with fold bodies flattened in place. A block
whose `#+NAME:` occurs exactly once on the page (folds included) gets
`<page-key>:n:<name>`; any other executable block gets
`<page-key>:h:<fnv1a-base36>:<occurrence>`, where the hash is over the
block's sample code and `occurrence` counts earlier blocks with the same
hash. That id keys the saved draft, exercise results, and progress. Named
blocks survive reordering; unnamed blocks are content-addressed, so
editing their sample starts a new identity. Renaming a block also starts
a new identity; old drafts/results are left behind rather than silently
reused.

**Saved code.** On editor changes the block writes
`<storagePrefix>code:<id>` (default `didact:code:<id>`) = current source, and
removes the key when the source matches the sample again; Revert code restores
the sample and clears the key. On mount a saved draft beats the org sample.
Reads and writes go through the configured `storage` backend (default
`localStorage`, `null` disables persistence) and are error-guarded: absent,
denied, quota-full, or throwing storage never breaks a block; the text is just
not persisted.

**Progress.** `<storagePrefix>progress:<page-key>` (default
`didact:progress:<page-key>`) holds
`{ "passed": [<block id>…], "manual": boolean }`. It is read once per page
(per mount) and cached. Malformed JSON, a foreign shape, or denied storage
starts from a clean slate; a failed write is ignored, so the outcome still
applies to the live session. Only passing exercise outcomes are written —
a failure is session-local, never stored. `manual` is used only on pages
with no checked exercises. Navigator side (`<storagePrefix>nav-side`) and
collapse state (`<storagePrefix>nav-hidden`) persist through the same store.

**Completion.** A page's checked exercises are its executable blocks with
`#+CHECK:` expected output, deduplicated by block id. `passed` counts those
ids present in stored progress; complete means `passed === total`. A page
without checked exercises is complete when `manual` is true. The footer
re-renders from this state, and page links in the rail get
`data-complete="true"`, an `aria-hidden` ✓, and an accessible
`aria-label` of `<title> (complete)` (removed again when incomplete) so
the state is announced rather than only drawn.

**Exercise checks.** `#+EXERCISE:` supplies a title, `#+CHECK:` the expected
console output; a block promised only `#+EXERCISE:` is unchecked and can
never pass or fail. Run sets the badge to running, then compares the
console text with the expected text after the run finishes or errors: CRLF
becomes LF, trailing spaces/tabs on each line are stripped, and trailing
blank lines are dropped. A paused run (breakpoint or mid-step) is not
judged. Load errors, kernel throws, and output mismatches publish `failed`;
a match publishes `passed` and is persisted.

**Folds.** `#+BEGIN_HINT`/`#+BEGIN_SOLUTION` parse into recursive fold
nodes. Rendering uses native `<details>`, closed by default, with a
`<summary>` and a `.lw-fold-body`; the body recurses through the same
grammar, so folds may nest and contain executable blocks. Executable
indices, block-id assignment, and search all flatten fold bodies in place,
keeping document order. An unterminated fold closes at EOF.

**Search index.** Built once from the parsed pages: each page contributes
an intro chunk (title plus prose before the first h2/h3) and one chunk per
h2/h3 section. Folds are walked in place — their headings open sections and
their prose joins the surrounding chunk — and prose, list items, table
cells, headings, and code are all searchable. A query of at least two
trimmed characters is split on whitespace; every token must occur
(case-insensitively) in a chunk, and the first ten matching chunks win.
Each hit links to `#/<page>` or `#/<page>/<section>`, using the same
slugger and rendered heading text as the Contents rail. A hit's snippet
collapses whitespace and is cut to 140 characters around the first token.
While a live search is active it replaces both nav lists; clearing it
restores the current Contents/Pages view.

**Named-session caveats.** One `Session` is created per
`(kernel id, :session name)` on a page. Kernels exposing `resume()` share
that instance across the group; kernels without it get the first block
isolated on the instance and later blocks on separate instances, with the
unsupported badge (console-warned once per mount). Sessions are
page-scoped: a page switch or `dispose()` disposes them.

A supported shared session is one mutable machine, so its member blocks
form a serialized queue: `run()` and `step()` each take a turn on
`SharedSession.queue`, and only one turn per shared group runs at a time —
a sibling waits instead of interleaving loads and runs. `busy` still
stops a block re-entering itself within its own turn. `loadedSource` is
the group's program identity: Step/Run continues a mid-flight session
only while it still holds this block's source, since a sibling's turn may
have replaced it. Reset from any block in a shared group resets the
session once and applies `applySharedReset()` to
every member: results and the current-line mark clear, an in-flight
exercise badge falls back to its last judged verdict, and nothing is
loaded (`loadedSource = null`), so earlier blocks must be re-run to
rebuild their definitions. Unsupported (resume-less) kernels never share
a turn: every block after the first gets its own fresh session and runs
isolated, so one reset can never invalidate another block's output.

## kernel-asm64 responsibilities

- unicorn/keystone/capstone wasm come from npm deps (`@alexaltea/*`,
  licenses in THIRD-PARTY.md + `vendor/` texts), served from `node_modules`
  at `<base>/vendor/` in dev and emitted into `dist/vendor/` on build by
  `@didact/vite` (`didactVendors()` / `didactVite()`); `loadEngines()` injects
  classic-script tags and passes a pre-fetched `wasmBinary` for
  Keystone/Capstone (Unicorn's wasm is embedded in its JS), so runtime
  network use stays same-origin static-asset fetches only.
- Two-pass keystone label resolution, syscall interception, budget,
  stepping (HOOK_CODE), context restore — shaped to `Kernel`/`Session`.
- Panel data: registers fields, EFLAGS fields, disassembly listing
  (row `tip` = the source line's trailing `;` comment), .data hexdump,
  console.
- Exports `asm64Kernel: Kernel` (id `'asm'`, editorSyntax `'asm-intel'`) and
  `createAsm64Kernel({ vendorBase })` (all 5 WASM kernels follow this
  singleton + factory pattern: `createAsm64Kernel`, `createCKernel`,
  `createCppKernel`, `createPythonKernel`, `createTypstKernel`).

## Typst content layer (build time, `@didact/vite`)

Website content never compiles in the browser. Two layers share the `typst`
language name but no session, engine, or code path:

| layer | code | runs |
|---|---|---|
| content pipeline | `packages/vite/src/typst/*.ts` (Node only) | once at build/dev via `didactTypst()` / `didactVite()`, emits `virtual:didact-typst` |
| typst kernel | `packages/kernel-typst` | per block, on Run, in the page |

Header rule (`isTypstDiagram` in `packages/core/src/typst-source.ts`): a
`#+BEGIN_SRC typst` block with `:results svg` or `:file <path>` is a static
diagram; a plain `typst` block stays a kernel block.
`apps/site/src/main.ts` imports the generated artifacts and passes them as
`mountSite({ typst: { artifacts } })`.

- Contract: `TypstArtifacts { math, diagrams, mathCss }`. Math is keyed by
  `mathKey` = `I:`/`D:` + normalized source; diagrams by `diagramKey` =
  normalized block source. Normalization is `trim` only in `normalizeTypst`
  (inner whitespace is significant); the pipeline and renderer must use the
  same function. `TypstArtifacts` also has an optional `pages` map of lazy
  loaders keyed by page file name (`'c.org'`); when present, a page's own
  `math`/`diagrams` are loaded on demand and the top-level maps are only the
  fallback.
- Pipeline: `packages/vite/src/typst/prerender.ts` parses pages with the core
  org parser, `collectTypstSources` dedupes, `packages/vite/src/typst/engine.ts`
  compiles sequentially through one `typst-wasm` JSPI instance (module-level
  promise + promise chain): MathML plus an SVG fallback per formula, one SVG
  per diagram. Results are memoized at module scope; the Vite plugin watches
  `pagesDir` (`src/pages`) and full-reloads page changes.
- Split chunks: `didactTypst({ perPage: true })` (used by `apps/site`) emits
  `virtual:didact-typst` with empty `math`/`diagrams`, the shared `mathCss`,
  and a `pages` map of `() => import('virtual:didact-typst/page/<stem>')`
  loaders. Each `virtual:didact-typst/page/<stem>` module exports only that
  page's `{ math, diagrams, mathCss }`; an unknown stem fails the build with
  the offending module id. The app entry therefore never contains page SVGs
  and a navigation fetches exactly one page's chunk. `perPage: false` (the
  default) stays byte-identical to the eager single-module output.
- Lazy routing: `mountSite` keeps the current page visible while a page's
  loader runs, marks the document pane busy (`aria-busy`, root class
  `lw-loading`), and applies the route — render, canonical hash write,
  `onNavigate` — only after the artifacts are cached. A newer navigation
  cancels the older route; `SiteHandle.ready` resolves after the initial
  route (including its artifact load) and `idle` after the current pending
  route. Mount-time indices (heading slugs, search, link labels) use the
  eager artifacts, so in split mode a heading formula's slug falls back to
  its org source text. Eager artifacts remain the fallback whenever a page
  has no loader.
- Packages: every `@preview/name:version` import resolves from
  packages.typst.org during the build — no allowlist, versions pinned in the
  org source. The content browser path receives only the resulting strings:
  no content engine and no package fetch.
- Failure: an unknown package or invalid Typst aborts the build with the
  page, the block's first non-prelude code line, then `file:line` and hints;
  every failing block is listed in one error. A blank diagram is rejected by
  `packages/vite/src/typst/check.ts`; a missing artifact renders the literal
  source (`$src$`, or `$$src$$` for display math) or `Figure unavailable.` in
  `pre.lw-diagram-missing` (diagram), never a hole.
- Verification: static diagrams live inline across all lesson pages where each
  concept is taught (with `apps/site/src/pages/typst.org` demonstrating
  `fletcher`, `lilaq`, and `cetz` alongside prose math and interactive Typst
  blocks). The structural gate's unit tests live in `packages/vite/test/`;
  `pnpm typst:check` compiles every page and runs the same gate.
- JSPI is required by the build engine only; content pages work in browsers
  without JSPI (the interactive kernel still needs it).

Authoring rules, package policy, HTML-export trade-off, and verification:
`docs/typst-web.md`.

## apps/site responsibilities

- Thin composition: glob `src/pages/*.org` raw, resolve them with
  `resolvePages(sources, PAGE_ORDER)` (the nav title comes from each file's
  `#+TITLE:` line), register all seventeen kernels
  `[asm64Kernel, riscvKernel, mipsKernel, cKernel, cppKernel, fortranKernel,
  wasmKernel, pythonKernel, sqlKernel, matlabKernel, jsKernel, regexKernel,
  lispKernel, elispKernel, prologKernel, luaKernel, typstKernel]`, and mount
  with `mountSite()`.
- `src/pages/*.org`: one lesson per kernel (`x86-64-assembly`, `riscv`,
  `mips`, `c`, `cpp`, `fortran`, `wasm`, `python`, `sql`, `matlab`, `lua`,
  `javascript`, `regex`, `lisp`, `elisp`, `prolog`, `typst`), with per-block
  controls, breakpoints, panel attach/detach, and cross-page links.
- `vite.config.ts` wires `@didact/vite` (`didactVite()`).
- `index.html` (noscript in body), favicon optional, title plain text.
