# Typst on the web: content layer vs kernel

Two implementations of Typst ship in this repo. They share a language name and
nothing else: different packages, different engines, different lifetimes.

| | content pipeline | executable kernel |
|---|---|---|
| code | `apps/site/typst/{engine,prerender,vite,cli}.ts` | `packages/kernel-typst` |
| runs | Node, once at build/dev | browser, per block, on Run |
| output | `virtual:didact-typst` → `TypstArtifacts` | SVG page in the block panel |
| state | one serialized compiler for the whole build | one `Session` per block |
| shipped engine | none | 24 MB wasm, JSPI |

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
class="lw-diagram">` with the SVG; otherwise the block goes through the normal
`isExecutable` path. The kernel never imports `typst-source.ts`, and the
pipeline never imports the kernel.

## Artifact contract

Produced by `prerenderOrgPages` in `apps/site/typst/prerender.ts`, typed in
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
| `mathCss` | none, one string | unique `<style>` payloads from HTML compiles |

`normalizeTypst` is `src.trim()` only. Keys must not collapse inner whitespace:
two blocks can differ only inside a string literal (`#text("a  b")` vs
`#text("a b")`) and collapsing would make the second figure silently reuse the
first one's SVG. Both sides call the same function, never reimplement it.

Lookup and fallback (`packages/core/src/render.ts`):

| site | found | missing |
|---|---|---|
| inline/display math (`appendText`) | `span.lw-math` gets `mathml`, or `svg` when `typst.math === 'svg'` or the browser lacks `MathMLElement` | `span.lw-math.lw-math-missing` with literal `$src$` (display: `$$src$$`) |
| diagram (`renderDocument`) | `figure.lw-figure.lw-diagram` with the SVG, plus `figcaption` when the block has `#+CAPTION:` | `pre.lw-diagram-missing` reading `Figure unavailable.` and a `console.error` carrying the key |

`mathCss` is injected once per mounted document by `packages/core/src/site.ts`
as a `<style data-test="typst-math-css">`; formulas are unstyled but readable
without it. `engine.ts` collects one copy per unique payload, and compiles a
trivial `$ x $` if a page set has no math at all.

## Package policy

Any `@preview/name:version` import in a **diagram** block resolves from
packages.typst.org at build time. There is no allowlist, no vendor copy, and
no rejecting loader in `engine.ts`; the loader is Typst's real fetch.
Versions are pinned in the org source (`@preview/fletcher:0.5.8`,
`@preview/lilaq:0.6.0` in `apps/site/src/pages/typst.org`) — they are part of
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

Package archives are cached on disk at `apps/site/.typst-cache/` (git-ignored).
One file per archive URL, named from the URL path, so
`https://packages.typst.org/preview/fletcher-0.5.8.tar.gz` becomes
`preview_fletcher-0.5.8.tar.gz`. A hit is served as an in-memory gzip response;
a miss is fetched, written, and returned. Only `res.ok` responses are stored, a
file without gzip magic counts as a miss, and a failing read/write logs one
warning instead of failing the build. Concurrent requests for the same URL
share one download.

| variable | effect |
|---|---|
| `TYPST_PACKAGE_BASE_URL` | mirror base for archives and `packageBaseUrl` (default `https://packages.typst.org`) |
| `TYPST_NO_PACKAGE_CACHE=1` | skip cache reads and writes; the fetch wrapper and in-flight dedupe stay |

Delete the directory to force a refetch. The cache is keyed by URL, not by
version constraint: bumping `#import "@preview/foo:0.2.0"` to `0.3.0` fetches a
new archive, while replaying `0.2.0` never touches the network. Formula and
diagram memoization is separate and lives only in the process (see
`prerender.ts`); it is not persisted.

Measured on this page set (22 gallery diagrams + 3 demo diagrams, 4 formulas):
cold **5.2 s**, warm **4.5 s**. The difference is the package downloads; the
rest is 25 sequential document compiles, so a larger page set scales with
compiles, not with the cache.

## Artifact delivery and size

`virtual:didact-typst` is one static module, so every page's artifacts land in
the entry chunk: measured 25 diagrams ≈ 561 KB, 4 MathML ≈ 1.2 KB, 4 SVG math
fallbacks ≈ 41 KB (the fallbacks alone are 33× the MathML they back up), plus
the 1.5 KB layout CSS — 648 KB raw, ≈ 99 KB gzip. Visiting the x86 page still
downloads the gallery's figures.

The next step, if size matters, is one artifact module per page selected on
navigation (Vite code-splits the dynamic import), or emitting each diagram as
a standalone `.svg` asset. Dropping the SVG math fallback is the cheap win:
it only serves browsers without `MathMLElement`.

## Authoring rules

| syntax | meaning |
|---|---|
| `$…$` | inline math, compiled at build time |
| `$$…$$` | display math, its own line |
| `=code=` / `~verbatim~` | literal; a `$` inside never becomes math |
| `\$` | literal dollar |
| unmatched `$`, `$ x $` (space inside) | literal text, no compile |
| `#+CAPTION: text` | `<figcaption>` for the next static diagram (org's caption convention) |
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
all: every gallery and demo block relies on the prepend, and only the margin
override block adds `#set page(margin: 18pt)` — a set rule merges, so width and
height stay `auto`. `#set text(size: …)` is the one line worth keeping when
labels need to be smaller or larger.
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

## Diagram gallery (review surface)

`apps/site/src/pages/typst-gallery.org` holds one figure per supported pattern.
Open the page after `pnpm build` (or in `pnpm dev`) and check each row; the
source is directly above its figure. Every block carries a `#+CAPTION:` line,
so each figure has a `<figcaption>` and therefore an accessible name. The build compiles all of them on every
build, so the page is also a regression suite: a broken block fails with
`typst diagram in typst-gallery.org:<line> (source line):` and Typst's own
`file:line` diagnostic.

| # | figure | expected result |
|---|---|---|
| 1 | pipeline (fletcher) | four rounded boxes, solid arrows, labelled dashed retry loop |
| 2 | decision branch | diamond with `no`/`yes` exits; arrowheads stop short of the box borders |
| 3 | shape vocabulary | pill, hexagon, parallelogram, circle; four distinct outlines |
| 4 | two series (lilaq) | boxed legend, solid curve plus dashed comparison curve |
| 5 | scatter | seven markers whose size follows the `size:` list |
| 6 | bars + reference line | four bars, dashed budget line between the third and first bar |
| 7 | stem | stems from the baseline with a marker at each tip |
| 8 | filled band | translucent band between two bounds, solid centre line |
| 9 | box plots | two boxes with medians, whiskers, one outlier |
| 10 | wide plot | `width="100%"` on the `<svg>`; shrinks with the column past 680 px |
| 11 | right triangle (cetz) | grid, closed triangle, square right-angle marker, labels outside |
| 12 | circle geometry | tangent at the radius endpoint (perpendicular to it), dashed radius, base ray, centre dot, angle arc, no label collisions |
| 13 | cubic Bézier | smooth curve, dashed control polygon, control points marked |
| 14 | filled polygon | translucent fill under the outline, grid visible through it |
| 15 | matrix equation | display math as outlines — a diagram, not MathML |
| 16 | commutative square | four formula nodes, four labelled arrows |
| 17 | default margin | no `#set page` in the block; 6 pt gutter from the prepend |
| 18 | margin override | 18 pt gutter, visibly wider than figure 17 |
| 19 | text-only | words only, no shapes; Typst outlines text, so the gate passes it via `<use>` |
| 20 | tall flow | vertical stack, intrinsic width, not hit by the responsive rule |
| 21 | gradient fill | smooth teal-to-white ramp inside the shape |
| 22 | unicode math | Greek letters, subscripts, and an arrow with no fallback boxes |
| 23 | C++ build pipeline | eight boxes in two rows, left-to-right then right-to-left arrows, executable highlighted |

The gallery is content, not a second pipeline: adding a figure is adding an org
block. Keep new figures deterministic (no `datetime.today()`, no `random`) so
two builds agree and the memoized SVG stays valid.

The structural gate (`apps/site/typst/check.ts`, unit tests in
`apps/site/typst/check.test.ts`) runs on every compiled diagram before it is
cached. It rejects a missing `<svg>` root, a non-finite `viewBox`, zero
drawables, and zero real geometry — while ignoring Typst's white page
background, which is a `path` from the origin or a full-canvas `rect`. A
`text` element alone counts as ink, but Typst exports text as glyph outlines,
so figure 19 passes through the `<use>` rule rather than the `<text>` one. It
only warns (never throws) when the intrinsic width falls outside 20–1400 px.

## Would HTML export be better?

Per `~/research/typst/html-pdf-dual-target.md` §3–4 (ignore census and
`html.frame`): Typst's HTML export is good for prose —
MathML, real text, selectable and accessible, and it reflows with CSS.
Drawings and figures drop out of HTML output unless wrapped in `html.frame`,
which pins layout to a box.

Hence this split: prose math uses the HTML compile (MathML), diagrams never
try to be HTML and stay self-rendered SVG from a normal page compile. HTML
export would not remove the SVG path, and would not reproduce arbitrary
`#set page` / absolute placement; treating it as a replacement would silently
lose diagrams.

## Failure modes and verification

| symptom | cause | what you see |
|---|---|---|
| build/module load fails | unknown package, invalid Typst | `typst diagram in <page>.org:<line> (source line):` then `file:line: message` plus `hint:` lines |
| diagram rejected | blank page, zero-size shapes, no drawables | `typst diagram rejected: <reason>` with the same page prefix |
| formula renders as `$…$` | artifact missing (stale dev server, skipped build) | `span.lw-math-missing` |
| diagram renders as source in a `pre` | artifact missing | `lw-diagram-missing` with "run pnpm build" |
| page works but kernel block errors | browser lacks JSPI | kernel load error; content layer is unaffected |

Checks:

```sh
pnpm build                                      # sync vendors + Vite build (runs the plugin + gate)
node apps/site/typst/cli.ts apps/site/src/pages # per-page counts + total ms
node apps/site/typst/cli.ts apps/site/src/pages --out /tmp/svg  # also write every diagram
pnpm vitest run apps/site/typst                 # gate unit tests
```

The CLI reads every `*.org` in the directory, prints
`<page>: N math, M diagrams` per file and one total line with key counts, CSS
size, and compile time. It uses the same `prerenderOrgPages` as the plugin, so
a clean CLI run and a clean build agree. Compiling and passing the gate are
silent, so exit code 0 together with the counts means every diagram passed;
a failure throws with the page, line, and reason. `--out <dir>` additionally
writes each diagram as `<page>-<n>.svg` and prints its intrinsic size, which is
how you inspect a figure without running the site. `--help` prints usage.
