# Vendored third-party assets

The engine and fonts ship as npm dependencies (pinned in `package.json`
and `pnpm-lock.yaml`): `typst-wasm@1.0.0` (engine) and
`@typst-wasm/fonts@1.0.0` (faces). `scripts/sync-vendors.mjs` copies the
payload from `node_modules/` into the app's `public/vendor-typst/` (see
`src/vendor.ts`; the loader pins every URL to the page base so `vite dev`,
`vite build` and `vite preview` with `base: './'` all resolve identically —
or call `setVendorBase()` before creating a session); `vendor/` here keeps
only the license texts. Each payload file is byte-identical to its npm
release (verified by shasum at conversion). Nothing is fetched from a CDN:
the engine takes its wasm as caller-built `WebAssembly.Module`s and its
fonts as byte arrays, and every fetch the library might perform for typst
packages or URL imports is stubbed out.

## Engine

**typst-wasm 1.0.0** (MIT) — promise-based JS bindings around the real
Typst **0.15.0** compiler compiled to WebAssembly. Chosen over
`@myriaddreamin/typst.ts` (Apache-2.0, Typst core team, excellent) because
it compiles straight to **SVG page strings in one wasm** with diagnostics
that carry 1-based `line` numbers, while typst.ts needs a compiler wasm
(28.3 MB) *plus* a renderer wasm (1.0 MB) to produce SVG; typst-wasm is
also ~9 MB smaller overall. Trade-off: its in-page backend uses
**WebAssembly JSPI** (`WebAssembly.Suspending`/`promising`; no Worker, no
SharedArrayBuffer, no COOP/COEP), which needs Chrome/Edge 137+,
Firefox 153+ or Safari 27+; `src/vendor.ts` feature-detects it and a
missing engine surfaces as a clear block error instead of a crash.

| File | Bytes | Package | Source URL | License |
|---|---|---|---|---|
| `engine.core.wasm` | 22,795,811 | `typst-wasm` 1.0.0 | https://registry.npmjs.org/typst-wasm/-/typst-wasm-1.0.0.tgz (`dist/engine/engine.core.wasm`) | MIT (wraps typst, Apache-2.0) |
| `engine.core2.wasm` | 159 | `typst-wasm` 1.0.0 | same tarball (`dist/engine/engine.core2.wasm`) | MIT |
| `engine.core3.wasm` | 121 | `typst-wasm` 1.0.0 | same tarball (`dist/engine/engine.core3.wasm`) | MIT |
| `LICENSE-typst-wasm.txt` | 1,065 | `typst-wasm` 1.0.0 | same tarball (`LICENSE`) | MIT |

## Fonts

Typst's defaults are `Libertinus Serif` (text), `New Computer Modern Math`
(math) and `DejaVu Sans Mono` (raw/code); a document cannot compile
without at least one font. The minimum set below covers those three
families and the variants our lessons use (headings and `*strong*` need
the bold face, `/emphasis/` the italic one). All from
`@typst-wasm/fonts` 1.0.0 (`dist/files/…`), byte-identical:

| File | Bytes | Family / role | License |
|---|---|---|---|
| `LibertinusSerif-Regular.otf` | 337,132 | default text face | SIL OFL 1.1 |
| `LibertinusSerif-Bold.otf` | 293,908 | headings / `*strong*` | SIL OFL 1.1 |
| `LibertinusSerif-Italic.otf` | 332,312 | `/emphasis/` | SIL OFL 1.1 |
| `NewCMMath-Regular.otf` | 1,306,384 | default `$math$` face | GUST Font License 1.0 |
| `DejaVuSansMono.ttf` | 340,712 | default raw/code face | Bitstream Vera / Arev (see notice) |
| `LICENSE-fonts.txt` | 76,850 | upstream `NOTICE` with all font licenses | — |

Totals: engine 22,796,091 B + fonts 2,610,448 B = **25,406,539 B
(≈24.2 MiB)**, loaded lazily on the first `load()` of any typst block.

## Headless smoke (bun)

The JSPI backend runs in bun, so the vendored engine can be exercised
without a browser:

```sh
cd packages/kernel-typst
bun -e 'import("./src/vendor.ts").then(async (v) => {
  const engine = await v.loadEngine();
  await engine.addSource("main.typ", "#set page(width: auto, height: auto, margin: 1em)\n$x^2 + y^2 = z^2$");
  const r = await engine.compile({ main: "main.typ", format: "svg" });
  console.log(r.pages.length, r.pages[0].output.startsWith("<svg"));
})'
```

prints `1 true`. Node needs `--experimental-wasm-jspi` (V8 flag) for the
same result.
