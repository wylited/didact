// tsdown.config.ts — the publish build for @didact/* packages.
//
// Workspace development always consumes `src/**/*.ts` (every package keeps
// `main`/`exports` on source). This config produces the `dist/` tree that
// `publishConfig` in each package.json points at, because Node refuses to
// strip TypeScript types inside node_modules.
//
// Entries are derived from each manifest: every `exports`/`main`/`bin` value
// that names a `.ts` file becomes one bundled ESM entry (local imports
// inlined, declared dependencies external). Non-TypeScript exports (the
// theme CSS, `client.d.ts`) are copied next to the build output.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { defineConfig, type UserConfig } from 'tsdown';

interface Manifest {
  name: string;
  main?: string;
  types?: string;
  bin?: Record<string, string>;
  exports?: Record<string, string | Record<string, string>>;
}

const packagesDir = join(import.meta.dirname, 'packages');

// Vite's `?raw` asset suffix has no bundler meaning outside Vite; the Python
// kernel's toolkit is imported that way. Inline the file's text instead.
const rawText = {
  name: 'didact-raw-text',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('?raw') || importer === undefined) return null;
    return `\0didact-raw:${resolve(dirname(importer), source.slice(0, -'?raw'.length))}`;
  },
  load(id: string) {
    if (!id.startsWith('\0didact-raw:')) return null;
    return `export default ${JSON.stringify(readFileSync(id.slice('\0didact-raw:'.length), 'utf8'))};`;
  },
};

const sourceSpecifiers = (manifest: Manifest): string[] => {
  const found = new Set<string>();
  if (manifest.main !== undefined) found.add(manifest.main);
  for (const bin of Object.values(manifest.bin ?? {})) found.add(bin);
  for (const target of Object.values(manifest.exports ?? {})) {
    for (const value of typeof target === 'string' ? [target] : Object.values(target)) {
      found.add(value);
    }
  }
  return [...found].map((p) => p.replace(/^\.\//, '')).filter((p) => p.startsWith('src/'));
};

const entryName = (source: string): string =>
  relative('src', source).replace(/\.ts$/, '').replaceAll('\\', '/');

const packageConfig = (dir: string, manifest: Manifest): UserConfig => {
  const entries: Record<string, string> = {};
  const copy: string[] = [];
  for (const source of sourceSpecifiers(manifest)) {
    if (source.endsWith('.ts') && !source.endsWith('.d.ts')) {
      entries[entryName(source)] = source;
    } else if (existsSync(join(packagesDir, dir, source))) {
      copy.push(source);
    }
  }
  const isNode = manifest.bin !== undefined || manifest.name === '@didact/vite';
  return {
    cwd: join(packagesDir, dir),
    name: manifest.name,
    entry: entries,
    outDir: 'dist',
    format: ['esm'],
    platform: isNode ? 'node' : 'neutral',
    target: 'node22',
    dts: true,
    clean: true,
    copy,
    plugins: [rawText],
    // CSS is a host concern: the theme (and @fontsource faces) stay as
    // side-effect imports for the consuming bundler, with theme.css copied
    // to dist so `@didact/core/theme.css` still resolves after publish.
    css: false,
    deps: { neverBundle: [/\.css$/] },
    outExtensions: () => ({ js: '.js' }),
  };
};

const manifests = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const file = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(file)) return undefined;
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
    return { dir: entry.name, manifest };
  })
  .filter((m): m is { dir: string; manifest: Manifest } => m !== undefined)
  .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));

export default defineConfig(manifests.map(({ dir, manifest }) => packageConfig(dir, manifest)));
