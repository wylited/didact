# Getting Started — Building a Site with Didact

Didact is a browser-only literate-programming framework. You write lessons as
plain Org-mode (`.org`) files, register the language kernels you want, and Vite
builds a static site that runs completely client-side.

Requires **Node 24+** and **Vite**.

## 1. Install packages

Install `@didact/core`, `@didact/vite`, and whichever kernels your lessons use:

```sh
pnpm add @didact/core @didact/kernel-javascript @didact/kernel-python
pnpm add -D @didact/vite vite
```

Optionally install `@didact/cli` to lint pages and verify `#+RESULTS:` /
`#+CHECK:` blocks in CI:

```sh
pnpm add -D @didact/cli
```

## 2. Configure Vite (`vite.config.ts`)

`@didact/vite` provides `didactVite()`, which wires up build-time Typst
prerendering (`didactTypst()`) and handles WASM engine payloads
(`didactVendors()`): in dev it serves them straight from `node_modules`, and on
build it emits them into `dist/` (it never writes to `public/`):

```ts
import { defineConfig } from 'vite';
import { didactVite } from '@didact/vite';

export default defineConfig({
  base: './',
  plugins: [
    didactVite({
      pagesDir: 'src/pages',
      kernels: ['python'], // list any WASM kernels you use (pure-TS kernels need no assets)
    }),
  ],
});
```

If you need finer control, you can pass `typst: { perPage: true }` to
code-split pre-rendered math and diagrams into one lazy chunk per page, or
compose `didactTypst({ pagesDir })` and `didactVendors({ kernels })`
individually as Vite plugins instead of `didactVite()`. Pure-TypeScript kernels
require no vendor assets at all; if your site only uses pure-TS kernels and no
Typst math/diagrams, no plugin is required.

## 3. Add `index.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My Course</title>
</head>
<body>
  <div id="root"></div>
  <noscript>This site requires JavaScript to run interactive code blocks.</noscript>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

## 4. Mount the site (`src/env.d.ts` and `src/main.ts`)

If you use TypeScript, add `src/env.d.ts` so `import.meta.glob` and
`virtual:didact-typst` typecheck without `TS2307`:

```ts
/// <reference types="vite/client" />
/// <reference types="@didact/vite/client" />
```

Then create `src/main.ts`, using Vite's `import.meta.glob` with
`resolvePages()` from `@didact/core` to resolve your `.org` files in explicit
navigation order, and call `mountSite()`:

```ts
import { mountSite, resolvePages } from '@didact/core';
import { jsKernel } from '@didact/kernel-javascript';
import { pythonKernel } from '@didact/kernel-python';
import typstArtifacts from 'virtual:didact-typst';

const PAGE_ORDER = ['intro'] as const;

const sources = import.meta.glob('./pages/*.org', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const pages = resolvePages(sources, PAGE_ORDER);

mountSite({
  root: document.getElementById('root')!,
  kernels: [jsKernel, pythonKernel],
  pages,
  brand: 'My Course',
  navView: 'pages',
  typst: { artifacts: typstArtifacts },
});
```

`resolvePages(sources, order)` extracts each page's title from its `#+TITLE:`
directive (falling back to the file stem), attaches `file: '<stem>.org'` so
cross-page `[[file:…]]` links and progress keys stay stable, and logs a console
warning for any missing or unlisted file instead of crashing.

If your lessons do not use Typst math (`$…$`) or static diagrams (`:results svg`),
omit the `virtual:didact-typst` import and the `typst` option.

## 5. Write a lesson and run it (`src/pages/intro.org`)

Create `src/pages/intro.org`:

```org
#+TITLE: Welcome

#+BEGIN_SRC javascript
console.log('Hello from Didact!');
#+END_SRC
```

Start the dev server or build a static bundle into `dist/`:

```sh
pnpm vite
pnpm vite build
```

## 6. Choosing kernels and licensing

Didact core, `@didact/vite`, `@didact/cli`, and all **12 pure-TypeScript
kernels** are **MIT-licensed**, require zero static WASM assets, and boot
instantly:

| Kernel id | Export | Package | Vendor assets | License |
| --- | --- | --- | --- | --- |
| `riscv` | `riscvKernel` | `@didact/kernel-riscv` | None (pure TS) | MIT |
| `mips` | `mipsKernel` | `@didact/kernel-mips` | None (pure TS) | MIT |
| `fortran` | `fortranKernel` | `@didact/kernel-fortran` | None (pure TS) | MIT |
| `wasm` | `wasmKernel` | `@didact/kernel-wasm` | None (pure TS) | MIT |
| `sql` | `sqlKernel` | `@didact/kernel-sql` | None (pure TS) | MIT |
| `matlab` | `matlabKernel` | `@didact/kernel-matlab` | None (pure TS) | MIT |
| `lua` | `luaKernel` | `@didact/kernel-lua` | None (pure TS) | MIT |
| `javascript` | `jsKernel` | `@didact/kernel-javascript` | None (pure TS) | MIT |
| `regex` | `regexKernel` | `@didact/kernel-regex` | None (pure TS) | MIT |
| `lisp` | `lispKernel` | `@didact/kernel-lisp` | None (pure TS) | MIT |
| `elisp` | `elispKernel` | `@didact/kernel-elisp` | None (pure TS) | MIT |
| `prolog` | `prologKernel` | `@didact/kernel-prolog` | None (pure TS) | MIT |
| `c` | `cKernel` | `@didact/kernel-c` | `vendor-c/clang/` (~105 MB, lazy) | Apache-2.0 WITH LLVM-exception / MIT / ISC |
| `cpp` | `cppKernel` | `@didact/kernel-cpp` | shares `vendor-c/clang/` with `c` | Apache-2.0 WITH LLVM-exception / MIT / ISC |
| `typst` | `typstKernel` | `@didact/kernel-typst` | `vendor-typst/` (~25 MB, lazy) | MIT + Apache-2.0 + SIL OFL 1.1 / GUST / Bitstream Vera |
| `python` | `pythonKernel` | `@didact/kernel-python` | `vendor-python/` (~13 MB, lazy) | MPL-2.0 + PSF-2.0 |
| `asm` | `asm64Kernel` | `@didact/kernel-asm64` | `vendor/` (~8.6 MB, lazy) | **GPL-2.0** (opt-in) + BSD-3-Clause |

WASM payloads load lazily on the first block run — visiting a page that only
uses pure-TS kernels never downloads a WASM engine.

> **GPL-2.0 note:** `@didact/kernel-asm64` bundles Unicorn and Keystone under
> GPL-2.0 and is strictly opt-in. If your site requires permissive-only
> distribution, omit `@didact/kernel-asm64` (use `@didact/kernel-riscv` or
> `@didact/kernel-mips` for MIT-licensed assembly lessons).

## 7. Configuring WASM `vendorBase`

Every WASM kernel exports both a default singleton and a factory that accepts
`{ vendorBase?: string }` when you host vendor directories at a custom URL or
path prefix:

- `createAsm64Kernel({ vendorBase })` (default: `<base>/vendor/`)
- `createCKernel({ vendorBase })` (default: `<base>/vendor-c/`; expects a `clang/` subdirectory at `${vendorBase}clang/bundle.js`)
- `createCppKernel({ vendorBase })` (default: `<base>/vendor-c/`; expects a `clang/` subdirectory at `${vendorBase}clang/bundle.js`)
- `createPythonKernel({ vendorBase })` (default: `<base>/vendor-python/`)
- `createTypstKernel({ vendorBase })` (default: `<base>/vendor-typst/`)

```ts
import { createPythonKernel } from '@didact/kernel-python';

const pythonKernel = createPythonKernel({
  vendorBase: '/assets/pyodide/',
});
```

## 8. Multi-site and embedded usage

Didact's CSS is scoped under `.lw-site` (it does not alter `body` or reset
`border-radius` globally), so you can mount it inside an existing application
or mount multiple independent courses on the same origin:

```ts
const site = mountSite({
  root: container,
  kernels: [jsKernel],
  pages,
  brand: 'CS 101',
  brandHref: null,                // plain wordmark, not a link
  storagePrefix: 'cs101:',        // isolate drafts, progress, and nav state
  routing: 'memory',              // never read or write location.hash
  initialPage: 'loops',           // index, slug, or file name
  documentTitle: false,           // leave the host page's <title> untouched
  showOrgWarnings: false,         // hide syntax-warning banner in production
  onNavigate: ({ slug, section }) => console.log('viewed', slug, section),
  onExerciseResult: (outcome) => reportScore(outcome),
});
```

Pass `storage: null` to disable persistence completely, or pass a custom
`StorageLike` (`{ getItem, setItem, removeItem }`) to store drafts and progress
in your own backend or session storage. `storagePrefix` automatically appends
`':'` if it does not already end with a delimiter (`:`, `/`, `_`, `.`, or `-`)
and is not `''` (so `'cs101'` normalizes to `'cs101:'`).

## 9. API reference

### `MountOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `root` | `HTMLElement` | required | Mount container (children are replaced). |
| `kernels` | `readonly Kernel[]` | required | Registered kernels matched against `#+BEGIN_SRC <lang>`. |
| `pages` | `readonly PageSpec[]` | required | Lesson pages in navigation order. |
| `brand` | `string` | `'Didact'` | Wordmark text at the top of the navigation rail. |
| `brandHref` | `string \| null` | `'#/<first-slug>'` | Wordmark link target; `null` renders a non-link `<span>`. |
| `navSide` | `'left' \| 'right'` | `'left'` | Initial rail edge (overridden by saved preference). |
| `navView` | `'contents' \| 'pages'` | `'contents'` | Initial list shown in the navigation rail. |
| `routing` | `'hash' \| 'memory'` | `'hash'` | Sync navigation with `location.hash`, or keep state in memory. |
| `initialPage` | `number \| string` | `0` | Starting page (0-based index, slug, or filename) in memory mode or when the hash is empty/unknown. |
| `storagePrefix` | `string` | `'didact:'` | Prefix for all persisted keys (`code:`, `progress:`, `nav-side`, `nav-hidden`). Automatically normalized with a trailing `:` unless `''` or already ending in `:`, `/`, `_`, `.`, or `-`. |
| `storage` | `StorageLike \| null` | `localStorage` | Custom persistence backend, or `null` to disable persistence. |
| `documentTitle` | `false \| ((page, brand) => string)` | `` `${page.title} · ${brand}` `` | Controls `document.title` updates; restored on `dispose()`. |
| `typst` | `TypstRenderOptions` | — | Build-time `{ artifacts, math? }` for prose math and `:results svg` diagrams. |
| `fonts` | `boolean` | `true` | Set `false` to skip Atkinson Hyperlegible (`lw-no-fonts` class). |
| `showOrgWarnings` | `boolean` | `true` | Show the unsupported-Org diagnostics banner above pages with warnings. |
| `onNavigate` | `(info) => void` | — | Fired after every page/section navigation (`{ index, slug, section, page }`). |
| `onExerciseResult` | `(outcome) => void` | — | Fired after every checked exercise finishes (`{ id, title, passed, actual, pageKey, pageIndex }`). |
| `editorTheme` | `Extension` | Ayu Light | Custom CodeMirror 6 theme applied to every block editor. |
| `editorExtensions` | `readonly Extension[]` | — | Additional CodeMirror 6 extensions appended to every block editor. |
| `editorLanguages` | `Record<string, Extension>` | — | Per-language CodeMirror 6 extension overrides keyed by org language tag. |

### `SiteHandle`

Returned by `mountSite()`:

| Member | Type | Description |
| --- | --- | --- |
| `blocks` | `readonly BlockRuntime[]` | Executable block runtimes on the active page, in document order. |
| `panel` | `PanelHost` | The under-the-hood inspector panel host. |
| `activeIndex` | `number` | 0-based index of the currently rendered page. |
| `activeSlug` | `string` | URL slug of the currently rendered page. |
| `navSide` | `'left' \| 'right'` | Current edge of the navigation rail. |
| `navView` | `'contents' \| 'pages'` | Active list in the navigation rail. |
| `navHidden` | `boolean` | Whether the navigation rail is currently collapsed. |
| `show(index)` | `(index: number) => void` | Switch to page `index`, disposing the previous page's blocks. |
| `navigate(page, section?)` | `(page: number \| string, section?: string) => void` | Navigate to a page (by index, slug, or filename) and optional section slug. |
| `setNavSide(side)` | `(side: NavSide) => void` | Move the rail to `'left'` or `'right'` and persist the choice. |
| `setNavView(view)` | `(view: NavView) => void` | Switch the rail between `'contents'` and `'pages'`. |
| `setNavHidden(hidden)` | `(hidden: boolean) => void` | Collapse or expand the navigation rail and persist the choice. |
| `dispose()` | `() => void` | Unmount listeners, blocks, sessions, and restore `document.title`. |

### Subpath exports of `@didact/core`

If you only need a piece of `@didact/core` (for build tooling, custom renderers,
or headless scripts), import the lighter subpaths directly:

- `@didact/core/org` — `parseOrg`, `parseOrgChecked`, `ORG_DIRECTIVE`, `normalizeOrgKeyword`
- `@didact/core/typst` — `collectTypstSources`, `isTypstDiagram`, `mathKey`, `diagramKey`, `normalizeTypst`, `splitTypstMath`
- `@didact/core/babel` — `parseBabelHeaders`
- `@didact/core/kernel` — `Kernel`, `Session`, `Panel`, `Field`, `ListingRow`, `LoadResult`, `RunResult` types
- `@didact/core/theme.css` — the textbook-light stylesheet

## Next steps

- Write lessons: [`docs/authoring.md`](authoring.md)
- Customize colors, typography, and editors: [`docs/theming.md`](theming.md)
- Lint and verify lessons in CI: [`docs/check.md`](check.md)
