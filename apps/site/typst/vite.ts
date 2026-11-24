// vite.ts — the Vite side of the build-time Typst pipeline.
//
// `virtual:didact-typst` is a generated module whose default export is the
// complete TypstArtifacts object for apps/site/src/pages. The browser only
// performs lookups; no Typst engine ever ships to the client.
//
// In dev the whole page directory is watched: adding, editing or deleting an
// org file invalidates the virtual module and triggers a full reload, so the
// next request re-runs the (memoized) prerender. Compile failures reject the
// module load, which Vite surfaces with the Typst diagnostic's file and line.

import { isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { prerenderPageFiles } from './prerender.ts';

export const TYPST_VIRTUAL_ID = 'virtual:didact-typst';
export const TYPST_RESOLVED_ID = '\0' + TYPST_VIRTUAL_ID;

/** Serve pre-rendered Typst math and diagrams from the org pages. */
export default function typstPlugin(): Plugin {
  let pagesDir = '';

  return {
    name: 'didact-typst',

    configResolved(config) {
      pagesDir = resolve(config.root, 'src/pages');
    },

    resolveId(id) {
      return id === TYPST_VIRTUAL_ID ? TYPST_RESOLVED_ID : null;
    },

    async load(id) {
      if (id !== TYPST_RESOLVED_ID) return null;
      const artifacts = await prerenderPageFiles(pagesDir);
      return `export default ${JSON.stringify(artifacts)};\n`;
    },

    configureServer(server) {
      server.watcher.add(pagesDir);
      const reload = (file: string): void => {
        const path = isAbsolute(file) ? file : resolve(server.config.root, file);
        if (!isPageFile(pagesDir, path)) return;
        const mod = server.moduleGraph.getModuleById(TYPST_RESOLVED_ID);
        if (mod !== undefined) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      for (const event of ['add', 'change', 'unlink'] as const) {
        server.watcher.on(event, reload);
      }
    },
  };
}

/** True for a `.org` file directly inside the watched pages directory. */
function isPageFile(pagesDir: string, file: string): boolean {
  if (!file.endsWith('.org')) return false;
  const rel = relative(pagesDir, file);
  // `prerenderPageFiles` reads direct children only; a nested file would
  // reload the browser without ever being compiled.
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    && !rel.includes('/') && !rel.includes('\\');
}
