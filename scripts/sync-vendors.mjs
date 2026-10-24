// sync-vendors.mjs — one source of truth for engine assets.
//
// packages/kernel-<name>/vendor/** is canonical (git-tracked); the copies
// under apps/site/public/vendor* are build inputs only (git-ignored) so the
// ~130 MB of wasm never lives twice in the repository. Vite serves/copy
// public/ verbatim, so the site needs the copies present — this script
// makes them. Run automatically by `pnpm dev` / `pnpm build`; safe to run
// repeatedly (skips up-to-date files by size+mtime).
import { cpSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** [package vendor dir, site public dir] — canonical → served copy. */
const PAIRS = [
  ['packages/kernel-asm64/vendor', 'apps/site/public/vendor'],
  ['packages/kernel-c/vendor', 'apps/site/public/vendor-c'],
  ['packages/kernel-python/vendor', 'apps/site/public/vendor-python'],
  ['packages/kernel-typst/vendor', 'apps/site/public/vendor-typst'],
];

const upToDate = (src, dest) => {
  if (!existsSync(dest)) return false;
  const a = statSync(src), b = statSync(dest);
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
};

for (const [srcRel, destRel] of PAIRS) {
  const src = resolve(root, srcRel), dest = resolve(root, destRel);
  if (!existsSync(src)) {
    console.warn(`sync-vendors: ${srcRel} missing — skipped`);
    continue;
  }
  if (upToDate(src, dest)) continue;
  cpSync(src, dest, { recursive: true });
  console.log(`sync-vendors: ${srcRel} -> ${destRel}`);
}
