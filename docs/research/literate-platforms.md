# Research: client-side literate-coding platforms & code-editor libraries

Date: 2026-10-23. Purpose: inform architecture for a fully client-side "literate website" (prose + executable code blocks, no server). First lesson type: assembly with register views and single-stepping; later compiled languages (C/C++) via client-side compilers.

Method: official docs/repos + live npm registry and GitHub API data (downloads, last publish, last push, license) collected 2026-10-23. Bundle sizes from official bundling docs/issues unless noted.

---

## Part 1 — Platforms

### Comparison table

| Platform | Fully client-side? | Build step? | How executable blocks are declared/run | License | Maintenance (2026-10) | Custom WASM kernel pluggable? |
|---|---|---|---|---|---|---|
| **JupyterLite** | Yes at runtime (server emulation in browser) | Yes — `jupyter lite build` (Python CLI) emits static assets | Standard `.ipynb`; kernels are JupyterLab-style plugins; Pyodide kernel runs in a Web Worker, JS kernel in sandboxed iframe; Jupyter messaging protocol; files persist to IndexedDB | BSD-3-Clause | **Active** (repo pushed 2026-10-22; 4.9k stars) | **Yes, first-class** — kernels are plugins (pyodide-kernel, JS, p5, Lua/WASM exist), but you must ship the whole JupyterLab frontend |
| **Starboard** | Yes, zero backend | No build needed (runtime from CDN/self-host) | Plain-text notebook with `# %% [cell-type]` markers; JS/HTML/CSS/MD native, Python via Pyodide plugin; central `runtime` object; plugins register new cell types; LocalStorage/file persistence | MPL-2.0 | **Dormant** — last npm publish 2022-06 (v0.15.7), last repo push 2024-03; ~144 dl/wk | Yes by design (cell-type plugin registry), but ecosystem is dead |
| **Observable Runtime** (`@observablehq/runtime`) | Yes — embeddable reactive DAG evaluator, no server, no build | None (runtime embeds directly); **Observable Framework** adds a Node SSG build + build-time data loaders | Cells are JS functions; runtime infers a dependency graph from top-level variable references and re-executes dependents reactively (spreadsheet semantics) | ISC | **Active** (runtime 6.0.1, 2026-09-16, ~11.4k dl/wk; Framework repo pushed 2026-05) | No kernel concept; cells are JS — you can manually instantiate WASM inside a cell, but reactive re-run model doesn't fit imperative stepping |
| **LiveCodes** | Yes at runtime; not fully offline (toolchains/packages fetched from CDNs on demand) | No build for embedding (SDK/web component); self-hostable as static assets | Fenced markdown blocks with metadata (``` ```js livecodes ```, `render=button/link`) replaced by embedded playground via remark/markdown-it/marked plugins; compilers run in browser; results in sandboxed iframe | MIT | **Active** (pushed 2026-10-22; 1.5k stars; npm 0.14.1, 2026-05) | **No runtime hook** — adding a language means forking and registering a `LanguageSpecs` (compiler/runtime) in source |
| **Runno** | Yes | None (web components) | `<runno-run runtime="python" editor controls>…</runno-run>` Web Components; `@runno/wasi` is a WASI Preview-1 host (in-memory FS, stdio callbacks) that runs **any** WASI binary; needs COOP/COEP headers (SharedArrayBuffer) | MIT | **Active but tiny / single-maintainer** (775 stars; @runno/runtime 0.10.0, 2025-05; ~92 dl/wk; repo pushed 2026-08) | **Yes, first-class** — any WASI binary via `<runno-wasi src>`; but run-to-completion only, no step hooks |
| **Iodide** (Mozilla) | Was client-side | — | `jsmd` (JSON) notebook; Pyodide born here; plugin cell types | MPL-2.0 | **Dead** — Mozilla wound it down ~2020; repo idle since 2023-01; README says unmaintained, points to Starboard | Was plugin-based; moot |
| **Org-Press** (orgp.dev) | Mostly (Vite SSG; blocks run in browser) | Yes — Vite build | Org markup `#+begin_src` blocks (JS/TS/TSX/CSS) executed in browser, inline results | No recognized SPDX license on GitHub; 13 stars, pushed 2026-02 — **early, tiny, license unclear** | n/a | Languages are compile-time supported set; no kernel API |
| Adjacent: **Thebe** (ExecutableBooks) | **No** — needs a real Jupyter server/Binder | Docs build only | Turns static-doc code cells into notebook cells against a remote kernel | BSD-3 | Active | Server-side kernels only |

Other org-babel-inspired web projects surveyed: **md-babel** (executable markdown blocks, editor/desktop-oriented, not a web runtime), **org-web** (org-mode in the browser, no execution). Nothing else ships a browser-native babel equivalent; Org-Press is the only direct one and is too early-stage/license-unclear to build on.

### Per-platform notes & lessons for us

**JupyterLite** — The most mature fully client-side notebook stack. Key ideas worth stealing: (1) run the execution engine in a **Web Worker** so long/infinite programs never freeze the UI — critical for a stepping debugger; (2) **IndexedDB** for persistence; (3) kernels as **plugins behind a narrow message protocol**. What to avoid: the payload (JupyterLab frontend is multi-MB; Pyodide ~10 MB core before packages) and the Jupyter protocol itself — it has no pause/step semantics, so single-stepping would mean inventing custom comm messages anyway. It is a notebook *app*, not an embeddable block system.

**Starboard** — Architecturally the closest to what we want: plain-text format (`# %%` markers), runtime object with a **cell-type registry** for extension, no build step, everything in-browser. But MPL-2.0 (file-level copyleft) plus an effectively abandoned codebase (last release 2022) rules out adoption; it's a design reference, not a dependency.

**Observable Runtime/Framework** — Beautiful, actively maintained, permissive (ISC). The reactive DAG ("cell = value; dependents re-run automatically") is a great fit for *derived views* (e.g., a memory/register panel that re-renders when the machine state changes) and could be borrowed later for lesson widgets. But it is philosophically opposite to a stepping debugger: it hides control flow and re-executes declaratively; wrapping an imperative interpreter/stepper inside it fights the model. Framework itself is a Node SSG — a build step we don't need.

**LiveCodes** — The best UX pattern for *our docs*: fenced-code metadata convention (` ```asm run ` style) with static fallback (`render=button` keeps the block, adds an action). SDK + web component + framework wrappers; sandboxed iframe results; MIT. But it's a *playground* (full multi-pane IDE per block, iframe-isolated), heavy for an inline teaching block, has no debugger/step hooks, and custom execution engines require forking. Internally it uses both CodeMirror and Monaco — evidence that CM6 is the embeddable-editor default.

**Runno** — The most directly relevant *mechanism*: `@runno/wasi` is a small MIT WASI host that runs arbitrary WASI binaries with in-memory FS and stdio callbacks. Our future C/C++ lessons could compile with a browser clang/wasi-sdk chain and run through a vendored WASI host. Single-maintainer risk → vendor and pin. Remember COOP/COEP headers early if we ever need SharedArrayBuffer. No stepping support (run-to-completion), so our assembly engine still needs to be a custom interpreter with step hooks.

**Iodide** — Cautionary tale: the platform died, but Pyodide (spun out of it) thrived. Lesson: keep the execution engine decoupled, vendorable, and independently useful; never depend on a hosted service for core functionality.

---

## Part 2 — Editors for an embedded teaching editor

Hard requirements: highlight the **current instruction line while single-stepping** (decoration that moves under program control, ideally surviving user edits), small bundle, works on touch devices.

### Comparison table

| Editor | Bundle size (gzip) | Mobile / touch | Line-highlight (stepping) API | License | npm health (2026-10) |
|---|---|---|---|---|---|
| **CodeMirror 6** | ~75 kB minimal … ~100–135 kB with basicSetup + one language (official bundling example); fully tree-shakeable, languages lazy-loadable | **Best** — CM6 was redesigned around native mobile selection/input | `Decoration.line({class: "cm-currentLine"})` via `StateField` + `StateEffect`; RangeSet auto-maps positions through user edits; gutter extension for step/breakpoint markers; `EditorView.theme` for styling | MIT | `@codemirror/view` 6.43.15 (2026-10-19), **~9.0M dl/wk**; `@codemirror/state` ~8.9M; umbrella `codemirror` ~6.3M — extremely healthy |
| **Monaco** | Facade package looks small (190 kB min) but real deployments ship features + web workers: **~1.5+ MB minified even minimized configs** (their own issue #2730), typically multi-MB | **Officially unsupported** (project FAQ: mobile browsers/mobile web frameworks = no) | `editor.createDecorationsCollection([{range, options: {isWholeLine: true, className, overviewRuler}}])` (legacy `deltaDecorations`); imperative collections | MIT | `monaco-editor` 0.57.0 (2026-09-24), ~5.6M dl/wk, 46.9k stars — very healthy (Microsoft) |
| **Ace** | Single-file build ~350–500 kB min (~130–160 kB gzip); monolithic, modes as separate files | Usable, historically OK touch support, but dated vs CM6 | `session.addMarker(new Range(row, 0, row, 1), "step-marker", "fullLine")` or built-in `setHighlightActiveLine`; imperative, manual bookkeeping | BSD-3-Clause | `ace-builds` 1.45.2 (2026-10-21), ~728k dl/wk, 27k stars — active. ⚠️ the `ace` npm package is stale (1.3.0, 2016); use `ace-builds`/`ace-code` |
| **Plain `<textarea>`** | 0 | Perfect | None — must overlay divs/CSS yourself (re-inventing a bad CM); no syntax highlighting, no line numbers | n/a | n/a |

### Pros / cons

**CodeMirror 6**
- ✅ Smallest real-world footprint; pay-per-feature; per-language lazy loading (only assembly parser needed at first)
- ✅ Only mainstream editor with a first-class mobile story
- ✅ Decorations are the *core* abstraction: line decorations + mark decorations (e.g., annotate operands), positioned via state effects so the current-instruction highlight **re-maps automatically when the student edits code mid-step**; gutters give current-IP/breakpoint markers; viewport-based decoration keeps it fast
- ✅ Huge ecosystem (`lezer` grammars — can write a small assembly grammar), MIT, active
- ❌ Composition model (State/Transaction/Extension) has a learning curve; you assemble line numbers/highlighting yourself (basicSetup helps)

**Monaco**
- ✅ VS Code-grade editing, built-in C/C++ syntax, IntelliSense for TS/JS if we ever build a desktop "IDE mode"
- ❌ Multi-MB payload + web-worker plumbing — disproportionate for inline teaching blocks
- ❌ Mobile explicitly unsupported — disqualifying if lessons must work on phones/tablets
- ❌ Imperative decoration collections; heavyweight API surface

**Ace**
- ✅ Simple imperative API, mature, BSD-3, actively released
- ❌ Dated architecture and theming; weaker composition (harder to build a tight step/highlight loop); all-or-nothing bundle; npm package naming trap (`ace` vs `ace-builds`)

**Plain textarea / `<pre>`**
- ✅ Right choice for **read-only, non-stepped** code snippets in prose (use static highlighting at site build time)
- ❌ Wrong choice for interactive blocks: current-line highlighting, gutter markers, and edit-remapping are exactly what a real editor gives you

---

## Verdicts

### (a) Build our own lightweight block system — do not adopt a platform

Rationale: our differentiator (register views + single-stepping) requires **step/pause/inspect hooks in the execution engine**. Every surveyed platform assumes run-to-completion (Jupyter protocol, WASI, playground iframes) or declarative re-run (Observable's reactive DAG) — none expose stepping, so we'd be fighting the host. Our assembly interpreter *is* the kernel; a kernel abstraction adds weight without capability. Platform-specific risks reinforce this: Starboard dormant (MPL-2.0), Iodide dead, Runno single-maintainer, LiveCodes requires a fork per engine, JupyterLite drags in multi-MB JupyterLab.

What to build: a small fenced-block convention (``` ```asm step ```-style metadata, static fallback) driving a worker-isolated engine with a typed message protocol (run/step/read-registers), content stored as plain markdown for git-friendliness.

What to borrow: cell-type registry + plain-text format (Starboard); worker isolation + IndexedDB (JupyterLite); fenced-block metadata UX with static degradation (LiveCodes); vendored `@runno/wasi` as the WASI host when compiled-language lessons arrive (Runno); reactive derived views only if lesson widgets need them later (Observable Runtime).

### (b) Editor: **CodeMirror 6**

MIT, ~75–135 kB gzip, best (and for mobile, effectively the only) touch support, and decorations are its core abstraction — `Decoration.line` + `StateEffect` gives a current-instruction highlight that tracks student edits while stepping, plus gutter markers for the instruction pointer/breakpoints. npm health is outstanding (~9M dl/wk across core packages, releases within weeks). Monaco only if a future desktop-only IDE mode needs real IntelliSense; Ace is a workable but dated fallback; plain textarea only for non-interactive read-only snippets.
