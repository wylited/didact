// sync-vendors.mjs — materialize engine assets for serving.
//
// Engines are npm dependencies of the kernel packages (versions + integrity
// pinned by pnpm-lock.yaml); the git repo carries only source and license
// texts. This script copies each engine file from the kernel's
// node_modules into apps/site/public/vendor* so Vite serves the copies
// verbatim in dev and dist; license texts come from the kernel package's
// vendor/ dir. Run automatically by `pnpm dev` / `pnpm build`; safe to run
// repeatedly (a file is skipped when its size already matches — sources are
// lockfile-pinned, so equal size means the same pinned file).
import { cpSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Served file groups: destination dir + source paths (repo-relative). */
const GROUPS = [
  {
    dest: 'apps/site/public/vendor',
    srcs: [
      'packages/kernel-asm64/node_modules/@alexaltea/unicorn-js/dist/unicorn_x86.js',
      'packages/kernel-asm64/node_modules/@alexaltea/keystone-js/dist/keystone.js',
      'packages/kernel-asm64/node_modules/@alexaltea/keystone-js/dist/keystone.wasm',
      'packages/kernel-asm64/node_modules/@alexaltea/capstone-js/dist/capstone.js',
      'packages/kernel-asm64/node_modules/@alexaltea/capstone-js/dist/capstone.wasm',
      'packages/kernel-asm64/vendor/LICENSE-capstone-js.txt',
      'packages/kernel-asm64/vendor/LICENSE-keystone-js.txt',
      'packages/kernel-asm64/vendor/LICENSE-unicorn-js.txt',
    ],
  },
  {
    dest: 'apps/site/public/vendor-c/clang',
    srcs: [
      'packages/kernel-c/node_modules/@yowasp/clang/gen/bundle.js',
      'packages/kernel-c/node_modules/@yowasp/clang/gen/llvm.core.wasm',
      'packages/kernel-c/node_modules/@yowasp/clang/gen/llvm.core2.wasm',
      'packages/kernel-c/node_modules/@yowasp/clang/gen/llvm.core3.wasm',
      'packages/kernel-c/node_modules/@yowasp/clang/gen/llvm.core4.wasm',
      'packages/kernel-c/node_modules/@yowasp/clang/gen/llvm-resources.tar',
      'packages/kernel-c/vendor/clang/LICENSE-llvm.txt',
      'packages/kernel-c/vendor/clang/LICENSE-nanotar.md',
    ],
  },
  {
    dest: 'apps/site/public/vendor-python',
    srcs: [
      'packages/kernel-python/node_modules/pyodide/pyodide.js',
      'packages/kernel-python/node_modules/pyodide/pyodide.asm.mjs',
      'packages/kernel-python/node_modules/pyodide/pyodide.asm.wasm',
      'packages/kernel-python/node_modules/pyodide/python_stdlib.zip',
      'packages/kernel-python/node_modules/pyodide/pyodide-lock.json',
    ],
  },
  {
    dest: 'apps/site/public/vendor-typst',
    srcs: [
      'packages/kernel-typst/node_modules/typst-wasm/dist/engine/engine.core.wasm',
      'packages/kernel-typst/node_modules/typst-wasm/dist/engine/engine.core2.wasm',
      'packages/kernel-typst/node_modules/typst-wasm/dist/engine/engine.core3.wasm',
      'packages/kernel-typst/node_modules/@typst-wasm/fonts/dist/files/LibertinusSerif-Regular.otf',
      'packages/kernel-typst/node_modules/@typst-wasm/fonts/dist/files/LibertinusSerif-Bold.otf',
      'packages/kernel-typst/node_modules/@typst-wasm/fonts/dist/files/LibertinusSerif-Italic.otf',
      'packages/kernel-typst/node_modules/@typst-wasm/fonts/dist/files/NewCMMath-Regular.otf',
      'packages/kernel-typst/node_modules/@typst-wasm/fonts/dist/files/DejaVuSansMono.ttf',
      'packages/kernel-typst/vendor/LICENSE-typst-wasm.txt',
      'packages/kernel-typst/vendor/LICENSE-fonts.txt',
    ],
  },
];

let failed = false;
for (const { dest: destRel, srcs } of GROUPS) {
  const destDir = resolve(root, destRel);
  for (const srcRel of srcs) {
    const src = resolve(root, srcRel);
    if (!existsSync(src)) {
      console.error(`sync-vendors: ${srcRel} missing — run pnpm install first`);
      failed = true;
      continue;
    }
    const destFile = resolve(destDir, srcRel.split('/').at(-1));
    if (existsSync(destFile) && statSync(destFile).size === statSync(src).size) continue;
    cpSync(src, destFile);
    console.log(`sync-vendors: ${srcRel} -> ${destFile.slice(root.length + 1)}`);
  }
}
if (failed) process.exitCode = 1;
