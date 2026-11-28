# Theming and Styling

Didact ships a single textbook-light visual theme in `packages/core/src/theme.css`
(also exported as `@didact/core/theme.css`). It is pure white paper, crisp
hairline rules, zero border radius, and no accent color — emphasis comes from
type weight, italic, and rules.

## CSS scoping guarantees

Didact styles are scoped so you can embed a site inside an existing web app
without affecting surrounding chrome:

- **No global resets.** `theme.css` never styles `html` or `body` and never
  applies a global `* { border-radius: 0 !important }`.
- **Scoped containers.** Zero-radius and `box-sizing: border-box` apply only
  inside `.lw-site`, `.lw-block`, and `.lw-tip`.
- **Direct stylesheet import.** `mountSite()` imports `theme.css` automatically.
  If you render standalone blocks or want explicit CSS load ordering, import
  `@didact/core/theme.css` directly.

## CSS custom properties (`--lw-*`)

Override any token on `:root` (for the whole page) or on `.lw-site` (for one
embedded instance).

### Color and typography tokens (defined on `:root`)

| Token | Default | Role |
| --- | --- | --- |
| `--lw-ink` | `#171717` | Headings, active controls, primary borders and ink |
| `--lw-prose` | `#2b2b2b` | Body prose text |
| `--lw-paper` | `#ffffff` | Primary background across rails, document, blocks, and panels |
| `--lw-surface-alt` | `#f4f4f1` | Inline code background, active navigation item fill |
| `--lw-hairline` | `#e6e6e2` | Structural hairline dividers and resting borders |
| `--lw-hairline-strong` | `#c6c6c0` | Interactive borders, link underlines, hover emphasis |
| `--lw-tint` | `#f6f0dc` | Changed-field highlight, current-line highlight, passed exercise tint |
| `--lw-gray` | `#6e6e68` | Muted metadata, inactive navigation items, section labels (WCAG AA) |
| `--lw-hover` | `#f5f5f2` | Neutral hover background for list items, controls, and fields |
| `--lw-error` | `#991b1b` | Error ink: failed status, error banner items, broken links |
| `--lw-error-bg` | `#fef2f2` | Error line highlight, failed exercise badge, error box fill |
| `--lw-serif` | `"Atkinson Hyperlegible", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` | Prose, navigation rail, headings, and tooltips |
| `--lw-mono` | `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace` | Code editors, read-only listings, results, controls, and panels |

### Layout and measure tokens (defined on `.lw-site`, `.lw-doc`, `.lw-page-footer`)

| Token | Default | Responsive progression | Role |
| --- | --- | --- | --- |
| `--lw-frame` | `119.4rem` | `136.4rem` (≥ 1600px), `154.7rem` (≥ 2200px) | Maximum width of the 3-zone grid |
| `--lw-gutter` | `1.5rem` | `1.75rem` (≥ 900px), `2rem` (≥ 1600px), `2.25rem` (≥ 2200px) | Horizontal padding inside the document column |
| `--lw-rail-w` | `232px` | — (`.lw-nav-hidden` sets `width: 0` directly on `.lw-rail-nav`) | Width of the navigation rail |
| `--lw-doc-measure` | `74ch` | `82ch` (≥ 1600px), `90ch` (≥ 2200px) | Maximum line measure for prose and lesson footer |

Example — customize a mounted site's paper tint, font, and rail width without
touching the rest of your host page:

```css
#my-course.lw-site {
  --lw-paper: #fcfbf8;
  --lw-surface-alt: #f1efe9;
  --lw-rail-w: 256px;
  --lw-serif: "Newsreader", Georgia, serif;
}
```

## Custom CodeMirror themes and extensions

Executable blocks use CodeMirror 6 with **Ayu Light** (`thememirror`) by
default. Pass `editorTheme`, `editorExtensions`, or `editorLanguages` to
`mountSite()` to customize every block editor:

```ts
import { EditorView } from '@codemirror/view';
import { mountSite } from '@didact/core';

const customTheme = EditorView.theme({
  '&': { backgroundColor: '#fcfbf8', fontSize: '0.88rem' },
  '.cm-gutters': { backgroundColor: '#fcfbf8', borderRightColor: '#e6e6e2' },
});

mountSite({
  root,
  kernels,
  pages,
  editorTheme: customTheme,
  editorExtensions: [EditorView.lineWrapping],
});
```

- `editorTheme` replaces the default `ayuLight` theme extension.
- `editorExtensions` appends arbitrary CodeMirror 6 extensions to every block
  (for example `EditorView.lineWrapping`, custom keymaps, or bracket matching).
- `editorLanguages` overrides syntax highlighting per Org `#+BEGIN_SRC <lang>`
  tag (`Record<string, Extension>`).

## Font loading (`fonts: false`)

By default, importing `@didact/core` bundles **Atkinson Hyperlegible** (400,
400 italic, 700) via `@fontsource/atkinson-hyperlegible` with zero external
network requests.

Pass `fonts: false` to `mountSite()` in headless tests or when you supply your
own prose typeface:

```ts
mountSite({
  root,
  kernels,
  pages,
  fonts: false,
});
```

Setting `fonts: false` adds `.lw-no-fonts` to the root element, switching
`.lw-doc` and `.lw-tip` to `Georgia, "Times New Roman", serif`. Override
`--lw-serif` and `--lw-mono` on `.lw-site` to substitute any custom fonts.

## Brand wordmark (`.lw-brand` vs `a.lw-brand`)

`.lw-brand` styles the layout and typography for the wordmark at the top of the
navigation rail in both link and non-link modes. When `brandHref` is a link
(the default), it renders as `<a class="lw-brand">`, and `a.lw-brand` adds the
underline, the subtle `home` label via `a.lw-brand::after`, and hover/focus
styles. Setting `brandHref: null` renders a plain `<span class="lw-brand">`
without those link affordances.

## Responsive breakpoints

| Breakpoint | Behavior |
| --- | --- |
| `≤ 640px` | Block headers (`.lw-block-head`) wrap controls onto a second row. |
| `< 700px` | Footer Previous / Next links stack left-aligned. |
| `< 900px` | 3-zone grid collapses to a single column: navigation rail sits on top, document in the middle, and an attached inspector panel renders full-width beneath the document. |
| `900px – 1199px` | At rest, rail + document sit side by side. When an inspector panel attaches, the navigation rail moves to a top header strip so the document and panel (`clamp(400px, 40vw, 460px)`) stay side by side. |
| `1200px – 1419px` | Full 3-column layout; attached inspector panel uses `clamp(420px, 28vw, 460px)`. |
| `≥ 1420px` | Full 3-column layout; attached inspector panel expands to `clamp(420px, 42vw, 720px)`. |
| `≥ 1600px` | Reading measure and type grow together: `82ch` at `17px` (`1.0625rem`), frame `136.4rem`. |
| `≥ 2200px` | Wide display measure: `90ch` at `18px` (`1.125rem`), frame `154.7rem`. |
| `prefers-reduced-motion: reduce` | All rail and panel transitions/animations are disabled immediately. |
