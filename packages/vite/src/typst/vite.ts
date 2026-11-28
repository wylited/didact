// vite.ts — the Vite side of the build-time Typst pipeline.
//
// `virtual:didact-typst` is a generated module whose default export is the
// complete TypstArtifacts object for the site's org pages. The browser only
// performs lookups; no Typst engine ever ships to the client.
//
// With `perPage: true` the main module instead exports empty math/diagrams
// plus a `pages` map of lazy loaders, one `virtual:didact-typst/page/<stem>`
// module per org file. Each page module carries only that page's artifacts,
// so the app entry chunk never contains every page's SVGs and a navigation
// fetches exactly the page it renders. Eager mode (the default) is unchanged.
//
// In dev the whole page directory is watched: adding, editing or deleting an
// org file invalidates the main module and every page module and triggers a
// full reload, so the next request re-runs the (memoized) prerender. In watch
// builds every `.org` file is registered via `this.addWatchFile(...)`.
// Compile failures reject the module load, which Vite surfaces with the Typst
// diagnostic's file and line.

import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';
import type { TypstArtifacts } from '@didact/core/typst';
import { configureTypstEngine } from './engine.ts';
import {
  prerenderPageFiles,
  prerenderPageFilesByPage,
} from './prerender.ts';

export const TYPST_VIRTUAL_ID = 'virtual:didact-typst';
export const TYPST_RESOLVED_ID = '\0' + TYPST_VIRTUAL_ID;

/** Prefix of the per-page virtual modules emitted by `perPage: true`. */
const PAGE_ID_PREFIX = `${TYPST_VIRTUAL_ID}/page/`;
const PAGE_RESOLVED_PREFIX = '\0' + PAGE_ID_PREFIX;

export interface DidactTypstOptions {
  /** Directory containing `.org` pages (relative to Vite root or absolute). Default: `'src/pages'`. */
  pagesDir?: string;
  /** Directory for cached `@preview/*` Typst package archives. Default: `<vite cacheDir>/didact-typst`. */
  cacheDir?: string;
  /** When `false`, `virtual:didact-typst` resolves to empty artifacts without booting Typst. Default: `true`. */
  enabled?: boolean;
  /**
   * Emit one lazy `virtual:didact-typst/page/<stem>` module per `.org` page
   * instead of inlining every page's math and diagrams into the main module.
   * The main module keeps `mathCss` and exports `pages` loaders keyed by page
   * file name (`c.org`). Default: `false` (all artifacts eager).
   */
  perPage?: boolean;
}

const EMPTY_ARTIFACTS_MODULE = `export default ${JSON.stringify({
  math: {},
  diagrams: {},
  mathCss: '',
})};\n`;

/** Serve pre-rendered Typst math and diagrams from the org pages. */
export function didactTypst(options: DidactTypstOptions = {}): Plugin {
  const enabled = options.enabled ?? true;
  let pagesDir = '';

  return {
    name: 'didact-typst',

    configResolved(config) {
      pagesDir = resolve(config.root, options.pagesDir ?? 'src/pages');
      if (enabled) {
        const defaultCacheDir = resolve(
          config.root,
          config.cacheDir,
          'didact-typst',
        );
        const requested = options.cacheDir?.trim();
        const cacheDir =
          requested !== undefined && requested !== ''
            ? resolve(config.root, requested)
            : defaultCacheDir;
        configureTypstEngine({ cacheDir });
      }
    },

    resolveId(id) {
      if (id === TYPST_VIRTUAL_ID) return TYPST_RESOLVED_ID;
      if (id.startsWith(PAGE_RESOLVED_PREFIX)) return id;
      if (enabled && id.startsWith(PAGE_ID_PREFIX)) return '\0' + id;
      return null;
    },

    async load(id) {
      if (id === TYPST_RESOLVED_ID) {
        if (!enabled) return EMPTY_ARTIFACTS_MODULE;

        const entries = await readPagesDir(pagesDir);
        registerWatchFiles(this, pagesDir, entries);

        if (options.perPage === true) {
          const pages = await prerenderPageFilesByPage(pagesDir);
          return perPageModule(pages);
        }

        const artifacts = await prerenderPageFiles(pagesDir);
        return `export default ${JSON.stringify(artifacts)};\n`;
      }

      if (id.startsWith(PAGE_RESOLVED_PREFIX)) {
        if (options.perPage !== true) {
          throw new Error(
            `didact-typst: module "${PAGE_ID_PREFIX + id.slice(PAGE_RESOLVED_PREFIX.length)}" requires the didactTypst({ perPage: true }) option`,
          );
        }
        const stem = id.slice(PAGE_RESOLVED_PREFIX.length);
        const pageId = PAGE_ID_PREFIX + stem;
        const entries = await readPagesDir(pagesDir);
        registerWatchFiles(this, pagesDir, entries);
        const pages = await prerenderPageFilesByPage(pagesDir);
        const artifacts = pages[`${stem}.org`];
        if (artifacts === undefined) {
          throw new Error(
            `didact-typst: unknown page module id "${pageId}" — no ${stem}.org in ${pagesDir}`,
          );
        }
        return `export default ${JSON.stringify(artifacts)};\n`;
      }

      return null;
    },

    configureServer(server) {
      if (!enabled) return;
      server.watcher.add(pagesDir);
      const reload = (file: string): void => {
        const path = isAbsolute(file) ? file : resolve(server.config.root, file);
        if (!isPageFile(pagesDir, path)) return;
        // A page edit changes the main module AND the page's own module; the
        // full reload below re-requests both. Invalidating every page module
        // also covers an unlinked file whose stem no longer resolves.
        for (const [id, mod] of server.moduleGraph.idToModuleMap) {
          if (id === TYPST_RESOLVED_ID || id.startsWith(PAGE_RESOLVED_PREFIX)) {
            server.moduleGraph.invalidateModule(mod);
          }
        }
        server.ws.send({ type: 'full-reload' });
      };
      for (const event of ['add', 'change', 'unlink'] as const) {
        server.watcher.on(event, reload);
      }
    },
  };
}

export default didactTypst;

/** Register every `.org` page as a build dependency of the virtual module. */
function registerWatchFiles(
  ctx: { addWatchFile(id: string): void },
  dir: string,
  entries: readonly Dirent[],
): void {
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.org')) {
      ctx.addWatchFile(join(dir, entry.name));
    }
  }
}

/**
 * The main virtual module in `perPage` mode. It carries the one shared
 * MathML stylesheet and a loader per page, keyed by page file name; all
 * per-page math and diagrams live in the page modules those loaders import.
 */
function perPageModule(pages: Record<string, TypstArtifacts>): string {
  const files = Object.keys(pages).sort((a, b) => a.localeCompare(b));
  const loaders = files.map((file) => {
    const stem = file.endsWith('.org') ? file.slice(0, -'.org'.length) : file;
    return `    ${JSON.stringify(file)}: () => import(${JSON.stringify(PAGE_ID_PREFIX + stem)}).then((m) => m.default)`;
  });
  // One stylesheet for every document compile; any page's value is the same.
  const mathCss = files.length === 0 ? '' : pages[files[0]!]!.mathCss;
  return [
    'export default {',
    '  math: {},',
    '  diagrams: {},',
    `  mathCss: ${JSON.stringify(mathCss)},`,
    '  pages: {',
    ...(loaders.length === 0 ? [] : [loaders.join(',\n')]),
    '  },',
    '};',
    '',
  ].join('\n');
}

/** True when a thrown fs error carries the given errno code. */
function hasErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === code;
}

/** Read the pages directory, explaining a missing directory actionably. */
async function readPagesDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (!hasErrnoCode(error, 'ENOENT')) throw error;
    throw new Error(
      `didact-typst: pages directory not found: ${dir} — set pagesDir in didactVite()/didactTypst() (resolved from Vite root) or create the directory`,
    );
  }
}

/** True for a `.org` file directly inside the watched pages directory. */
function isPageFile(pagesDir: string, file: string): boolean {
  if (!file.endsWith('.org')) return false;
  const rel = relative(pagesDir, file);
  // `prerenderPageFiles` reads direct children only; a nested file would
  // reload the browser without ever being compiled.
  return (
    rel !== '' &&
    !rel.startsWith('..') &&
    !isAbsolute(rel) &&
    !rel.includes('/') &&
    !rel.includes('\\')
  );
}
