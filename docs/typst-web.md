# Typst on the web: content layer vs kernel

Two implementations of Typst ship in this repo. They share a language name and
nothing else: different packages, different engines, different lifetimes.

| | content pipeline | executable kernel |
|---|---|---|
| code | `packages/vite/src/typst/{engine,prerender,check,vite,cli}.ts` | `packages/kernel-typst` |
| runs | Node, once at build/dev (`didactTypst()` / `didactVite()`) | browser, per block, on Run |
| output | `virtual:didact-typst` → `TypstArtifacts` | SVG page in the block panel |
| state | one serialized compiler for the whole build | one `Session` per block |
| shipped engine | none | 22.8 MB wasm + five fonts, JSPI |

The content layer is described in `docs/architecture.md` under "Typst content
layer (build time)". This file is the authoring and operations reference.

## Which layer does a block get?

`isTypstDiagram` in `packages/core/src/typst-source.ts` decides, from the
`#+BEGIN_SRC typst` header line only:

| header | owner |
|---|---|
| `:results svg` | static diagram, build pipeline |
| `:file <path>` | static diagram, build pipeline (same handling) |
| neither | kernel block (editor + Run) |
| any other language | untouched by the Typst layer |

`renderDocument` sees `isTypstDiagram` + artifacts and emits a `<figure
class="lw-figure lw-diagram">` with the SVG; otherwise the block goes through the normal
`isExecutable` path. The kernel never imports `typst-source.ts`, and the
pipeline never imports the kernel.

## Artifact contract

Produced by `prerenderOrgPages` in `packages/vite/src/typst/prerender.ts`, typed in
`packages/core/src/typst-source.ts`:

```ts
interface TypstArtifacts {
  math: Record<string, TypstMathArtifact>; // TypstMathArtifact = { mathml, svg }
  diagrams: Record<string, string>;        // self-contained <svg>
  mathCss: string;                         // Typst's MathML layout CSS
}
```

| artifact | key | value |
|---|---|---|
| `math` | `mathKey(src, display)` = `"I:"`/`"D:"` + `normalizeTypst(src)` | `{ mathml, svg }` |
| `diagrams` | `diagramKey(src)` = `normalizeTypst(block code)` | `<svg>…</svg>` |
| `mathCss` | none, one string | Typst's MathML layout CSS, taken from the first HTML compile |

`normalizeTypst` is `src.trim()` only. Keys must not collapse inner whitespace:
two blocks can differ only inside a string literal (`#text("a  b")` vs
`#text("a b")`) and collapsing would make the second figure silently reuse the
first one's SVG. Both sides call the same function, never reimplement it.

Lookup and fallback (`packages/core/src/render.ts`):

| site | found | missing |
|---|---|---|
| inline/display math (`appendText`) | `span.lw-math` gets `mathml`, or `svg` when `typst.math === 'svg'` or the browser lacks `MathMLElement` | `span.lw-math.lw-math-missing` with literal `$src$` (display: `$$src$$`) |
| diagram (`renderDocument`) | `figure.lw-figure.lw-diagram` with the SVG, plus `figcaption` when the block has `#+CAPTION:` | `pre.lw-diagram-missing` reading `Figure unavailable.` and a `console.error` naming the block's first line |

`mathCss` is injected once per mounted document by `packages/core/src/site.ts`
as a `<style data-test="typst-math-css">`; formulas are unstyled but readable
without it. `engine.ts` keeps the first non-empty payload, and compiles a trivial
`$ x $` if a page set has no math at all.

## Package policy

Any `@preview/name:version` import in a **diagram** block resolves from
packages.typst.org at build time. There is no allowlist, no vendor copy, and
no rejecting loader in `engine.ts`; the loader is Typst's real fetch.
Versions are pinned in the org source (`@preview/fletcher:0.5.8`,
`@preview/lilaq:0.6.0`, `@preview/cetz:0.5.2` in `apps/site/src/pages/typst.org`) — they are part of
the page text, not a lockfile.

Measured build cost (one engine, one page set): cold package fetch
1.2–2.0 s for the first package-using compile, warm 6–70 ms. Compiles are
serialized through a module-level promise chain because the compiler instance
is stateful; `prerender.ts` additionally memoizes artifacts at module scope,
so a Vite dev reload only pays for changed formulas/diagrams.

The browser makes no package fetch for content. It receives MathML/SVG
strings in the virtual module. The interactive kernel is stricter still: its
loader is `fetch: () => Promise.reject(...)`, so an executable block that
imports `@preview/*` fails offline. Package imports are a content-layer
feature.

## Build cache and mirrors

Package archives are cached on disk at `<vite cacheDir>/didact-typst` by
default in Vite builds (or the `cacheDir` passed to `didactTypst()` /
`didactVite()`, e.g. `apps/site/vite.config.ts` shares `../../.typst-cache`),
and at `<cwd>/.typst-cache` for the standalone CLI. One file per archive URL,
named from the URL path, so
`https://packages.typst.org/preview/fletcher-0.5.8.tar.gz` becomes
`preview_fletcher-0.5.8.tar.gz`. A hit is served as an in-memory gzip response;
a miss is fetched, written, and returned. Only `res.ok` responses are stored, a
cached file that does not decompress as a complete gzip stream counts as a miss
(replaced by the network copy), writes are atomic (temp file plus rename), and
a failing read/write logs one warning instead of failing the build. A package
download failure throws with the URL and HTTP status, after one retry for 5xx
and network errors. Concurrent requests for the same URL
share one download.

| variable | effect |
|---|---|
| `TYPST_PACKAGE_BASE_URL` | mirror base for archives and `packageBaseUrl` (default `https://packages.typst.org`) |
| `TYPST_NO_PACKAGE_CACHE=1` | skip cache reads and writes; the fetch wrapper and in-flight dedupe stay |

Delete the cache directory and restart the build to force a refetch: artifacts
are memoized in the process, so a running dev server does not recompile
unchanged blocks. The cache is keyed by URL, not by version constraint: bumping
`#import "@preview/foo:0.2.0"` to `0.3.0` fetches a new archive, while
replaying `0.2.0` never touches the network. Formula and diagram memoization is
separate and lives only in the process (see `prerender.ts`); it is not
persisted.

## Artifact delivery and size

By default, `virtual:didact-typst` is one static module, so every page's
pre-rendered math and diagram strings land in the entry chunk (both MathML and
an SVG fallback per formula, plus each compiled SVG diagram and Typst's MathML
layout CSS). Visiting any page avoids runtime compilation completely, at the
cost of bundling the site's static figures up front.

For multi-page sites, pass `typst: { perPage: true }` to `didactVite()` (or
`didactTypst({ perPage: true })`), as `apps/site/vite.config.ts` does. In
per-page mode, `virtual:didact-typst` keeps only `mathCss` and a `pages` map of
lazy loaders importing `virtual:didact-typst/page/<stem>` on navigation, so the
entry chunk stays small and each page loads only its own pre-rendered math and
diagrams.

## Authoring rules

| syntax | meaning |
|---|---|
| `$…$` | inline math, compiled at build time; recognised in the title, subtitle, headings, paragraphs, list items, table cells, and `#+CAPTION:` |
| `$$…$$` | display math (a convention: the renderer gives it a block wrapper wherever it appears) |
| `=code=` / `~verbatim~` | literal; a `$` inside never becomes math |
| `\$` | literal dollar |
| unmatched `$`, `$ x $` (space inside) | literal text, no compile |
| `$x$s`, `$x$_1`, `$x $-` | literal: the closing `$` must follow a non-space, non-`,`/`.` character and be followed by space, end of line, or punctuation/bracket/quote |
| `#+CAPTION: text` | attached to the next `#+BEGIN_SRC` block of any language; rendered as `<figcaption>` only for static diagrams |
| `:results svg` | static diagram |
| `:file x.svg` | static diagram (the path is otherwise ignored) |
| `#+BEGIN_COMMENT` … `#+END_COMMENT` | hides every line between the markers at parse time; markers are case-insensitive, and the block may contain anything, including `#+BEGIN_SRC` |
| `// …` / `/* … */` | Typst line and block comments inside a `#+BEGIN_SRC typst` block |

Use the comment block for page prose you want to keep in the source but hide
from the rendered page: drafts, notes, a removed section. It is a parse-time
cut, so nothing inside is parsed or rendered, and `#+BEGIN_SRC` inside it stays
inert. An unterminated `#+BEGIN_COMMENT` hides the rest of the page — a missing
`#+END_COMMENT` silently empties everything after it.

Inside a `#+BEGIN_SRC typst` block, comment the code with Typst syntax, not org
syntax: `// …` to the end of the line, `/* … */` across lines. A line starting
with `#` there is Typst code, not an org comment, and usually a syntax error.

A diagram block owns its own layout. `compileDiagram` prepends

```typ
#set page(width: auto, height: auto, margin: 6pt)
```

so a block that says nothing is tightly cropped. Examples need no page setup at
all: every diagram block relies on the prepend. Widen the gutter with
`#set page(margin: 18pt)` only when a figure needs air — a set rule merges, so
width and height stay `auto`. `#set text(size: …)` is the one line worth
keeping when labels need to be smaller or larger. A block must produce exactly
one page: a `#pagebreak()` fails the build with
`typst produced N SVG pages for one figure`.
The formula SVG fallback uses the same auto-size rule with `margin: 0pt` and
`fill: none`, and removes Typst's page-sized white background path.

Responsive rule (identical in `engine.ts` and `packages/kernel-typst`): the
SVG width in points is converted at 96 dpi (`pt * 4/3`); above **680 px** the
`width`/`height` attributes are replaced with `width="100%"` and
`style="height:auto"`. Narrow diagrams keep their intrinsic size.

Package APIs are not wrapped, so check the package's own conventions when a
shape lands in the wrong place. Two that cost real time here: fletcher
`node(…)` positions are relative units (about 1 cm), and `width:` fixes the box
so a long body wraps to more lines instead of widening the node; cetz
`arc(position, …)` takes a point *on* the arc, while `circle(centre, radius:)`
takes the centre — mixing them draws the arc around the wrong point.

## Figures across the lesson pages

Static diagrams live directly inside the lessons where each mechanism is
explained — there is no separate gallery page. `apps/site/src/pages/typst.org`
introduces both layers side by side with three representative static figures
(`@preview/fletcher` lifecycle flow, `@preview/lilaq` damped oscillation plot,
and `@preview/cetz` unit-circle geometry), inline and display prose math, and
three interactive live Typst blocks. Every static diagram carries a
`#+CAPTION:` line so each figure has a `<figcaption>` and therefore an
accessible name.

Adding a figure is adding a `#+BEGIN_SRC typst :results svg` block to the
section it belongs to. Keep figures deterministic (no `datetime.today()`, no
`random`) so repeated builds agree and the memoized SVG stays valid.

The structural gate (`packages/vite/src/typst/check.ts`, unit tests in
`packages/vite/test/`) runs on every compiled diagram before it is cached. It
rejects a missing `<svg>` root, a missing or malformed `viewBox`, a `viewBox`
without positive area, zero drawables, and zero real geometry. It ignores the
contents of `defs`/`clipPath`/`mask`/`pattern`/`symbol`/`marker`, invisible
elements (`display:none`, `visibility:hidden`, zero opacity, `fill:none`
without stroke), and Typst's white page background — a `path` from the origin
or a full-canvas `rect`. A `text` element alone counts as ink, and Typst's
outlined glyphs pass through the `<use>` rule. It warns (never throws) only
for diagrams narrower than 20 px; the 1400 px upper bound is unreachable
because `compileDiagram` has already rewritten wider pages to `width="100%"`.

## Would HTML export be better?

Typst's HTML export works well for prose math — producing real, selectable,
accessible MathML that reflows with CSS — whereas drawings and figures drop
out of HTML output unless pinned inside `html.frame` boxes. Keeping prose math
on HTML/MathML export and static diagrams on normal single-page SVG export
gives accessible math without losing vector graphics or arbitrary page layout.

## Failure modes and verification

| symptom | cause | what you see |
|---|---|---|
| build/module load fails | unknown package, invalid Typst | `typst diagram in <page>.org:<line> (\`<code line>\`):` (math failures say `typst math in …`), then `file:line: message` plus `hint:` lines; all failing blocks are listed in one error |
| diagram rejected | blank page, zero-size shapes, no drawables | `typst diagram rejected: <reason>` with the same page prefix |
| formula renders as `$…$` | artifact missing (stale dev server, skipped build) | `span.lw-math-missing`, plus one `console.error` naming the formula source |
| figure reads `Figure unavailable.` | artifact missing | `pre.lw-diagram-missing`, plus one `console.error` carrying the block's first line |
| page works but kernel block errors | browser lacks JSPI | kernel load error; content layer is unaffected |

Checks:

```sh
pnpm build                                   # Vite build (runs plugin, gate, and vendor emit)
pnpm typst:check                             # compiles all pages and runs the structural gate
node packages/vite/src/typst/cli.ts apps/site/src/pages
node packages/vite/src/typst/cli.ts apps/site/src/pages -o /tmp/svg   # also write every diagram
pnpm vitest run packages/vite                # plugin + gate unit tests
```

These commands run TypeScript directly, which needs Node 24.

The CLI reads every `*.org` in the given directory (default `<cwd>/src/pages`,
with no fallback), prints `<page>: N math, M diagrams`
per file and one total line with key counts, CSS size, and compile time. It
uses the same `prerenderOrgPages` as the plugin, so a clean CLI run and a
clean build agree. Compiling and passing the gate are silent, so exit code 0
together with the counts means every diagram passed; a failure throws with
the page, line, and reason. `--out <dir>` additionally writes each diagram as
`<page>-<n>.svg` and prints its intrinsic size, which is how you inspect a
figure without running the site. `--help` prints usage.
