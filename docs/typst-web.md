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

`normalizeTypst` is `src.trim().replace(/\s+/g, ' ')`. Keys are stable across
whitespace/newline edits; both sides call the same function, never reimplement
it.

Lookup and fallback (`packages/core/src/render.ts`):

| site | found | missing |
|---|---|---|
| inline/display math (`appendText`) | `span.lw-math` gets `mathml`, or `svg` when `typst.math === 'svg'` or the browser lacks `MathMLElement` | `span.lw-math.lw-math-missing` with literal `$src$` (display: `$$src$$`) |
| diagram (`renderDocument`) | `figure.lw-figure.lw-diagram` with the SVG | `pre.lw-diagram-missing` reading `typst diagram not pre-rendered (run pnpm build)` + block source |

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

## Authoring rules

| syntax | meaning |
|---|---|
| `$…$` | inline math, compiled at build time |
| `$$…$$` | display math, its own line |
| `=code=` / `~verbatim~` | literal; a `$` inside never becomes math |
| `\$` | literal dollar |
| unmatched `$`, `$ x $` (space inside) | literal text, no compile |
| `:results svg` | static diagram |
| `:file x.svg` | static diagram (the path is otherwise ignored) |

A diagram block owns its own layout. `compileDiagram` prepends

```typ
#set page(width: auto, height: auto, margin: 6pt)
```

so a block that says nothing is tightly cropped; a later `#set page(...)` in
the block overrides it (both demos set `margin: 8pt` and `text(size: 10pt)`).
The formula SVG fallback uses the same auto-size rule with `margin: 0pt` and
`fill: none`, and removes Typst's page-sized white background path.

Responsive rule (identical in `engine.ts` and `packages/kernel-typst`): the
SVG width in points is converted at 96 dpi (`pt * 4/3`); above **680 px** the
`width`/`height` attributes are replaced with `width="100%"` and
`style="height:auto"`. Narrow diagrams keep their intrinsic size.

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
| build/module load fails | unknown package, invalid Typst | `file:line: message` plus `hint:` lines from `formatDiagnostic` |
| formula renders as `$…$` | artifact missing (stale dev server, skipped build) | `span.lw-math-missing` |
| diagram renders as source in a `pre` | artifact missing | `lw-diagram-missing` with "run pnpm build" |
| page works but kernel block errors | browser lacks JSPI or COOP/COEP | kernel load error; content layer is unaffected |

Checks:

```sh
pnpm build                                      # sync vendors + Vite build (runs the plugin)
node apps/site/typst/cli.ts apps/site/src/pages # per-page math/diagram counts + total ms
```

The CLI reads every `*.org` in the directory, prints
`<page>: N math, M diagrams` per file and one total line with key counts, CSS
size, and compile time. It uses the same `prerenderOrgPages` as the plugin, so
a clean CLI run and a clean build agree.
