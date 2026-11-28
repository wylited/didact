import { defineConfig } from 'vite';
import { didactVite } from '@didact/vite';

// Thin reference Vite config: @didact/vite pre-renders build-time Typst math
// and diagrams from src/pages/*.org, serves WASM kernel assets in dev, and
// copies them into dist/ on build.
export default defineConfig({
  base: './',
  plugins: [
    didactVite({
      pagesDir: 'src/pages',
      // Shared with `pnpm typst:check` (which defaults to `<cwd>/.typst-cache`).
      cacheDir: '../../.typst-cache',
      // One lazy chunk per lesson: the entry keeps only mathCss and loaders.
      typst: { perPage: true },
      kernels: ['asm', 'c', 'cpp', 'python', 'typst'],
    }),
  ],
});
