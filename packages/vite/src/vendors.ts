// vendors.ts — Vite plugin for WASM kernel vendor assets.
//
// Each WASM-backed Didact kernel (@didact/kernel-asm64, -c, -cpp, -python,
// -typst) declares its upstream engine binaries as exact-pinned npm
// dependencies. At runtime in the browser, kernels fetch those binaries from
// predictable sibling directories (`vendor/`, `vendor-c/clang/`,
// `vendor-python/`, `vendor-typst/`) relative to the page base — never from a
// CDN.
//
// In dev, `didactVendors()` serves those files straight from `node_modules`
// with the right Content-Type. In build, it copies them into `outDir`
// (skipping unchanged equal-size files). No manual sync script required.

import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

export type VendorKernelId = 'asm' | 'c' | 'cpp' | 'python' | 'typst';

export interface VendorFile {
  /** Destination filename inside `group.dest` (e.g. `'keystone.wasm'`). */
  filename: string;
  /** Absolute path to the resolved source file on disk. */
  src: string;
}

export interface VendorGroup {
  /** Destination subdirectory relative to site base / build outDir (e.g. `'vendor'`, `'vendor-c/clang'`). */
  dest: string;
  /** Resolved source files to serve/copy into `dest`. */
  files: VendorFile[];
}

export interface DidactVendorsOptions {
  /**
   * Which WASM kernels to serve/emit vendor assets for.
   * When omitted, auto-detects whichever of the 5 WASM `@didact/kernel-*`
   * packages are resolvable from Vite's `config.root`.
   */
  kernels?: readonly VendorKernelId[];
}

const ALL_KERNELS: readonly { id: VendorKernelId; pkg: string }[] = [
  { id: 'asm', pkg: '@didact/kernel-asm64' },
  { id: 'c', pkg: '@didact/kernel-c' },
  { id: 'cpp', pkg: '@didact/kernel-cpp' },
  { id: 'python', pkg: '@didact/kernel-python' },
  { id: 'typst', pkg: '@didact/kernel-typst' },
];

/** A `NodeRequire` plus the directory its module resolution is anchored at. */
interface VendorAnchor {
  req: NodeRequire;
  dir: string;
}

/** Create a `NodeRequire` anchored at a directory or file path. */
function anchorRequire(resolveFrom?: string): VendorAnchor {
  const resolved = resolve(resolveFrom ?? process.cwd());
  if (existsSync(resolved)) {
    const isDir = statSync(resolved).isDirectory();
    return {
      req: createRequire(isDir ? join(resolved, 'package.json') : resolved),
      dir: isDir ? resolved : dirname(resolved),
    };
  }
  if (/\.(?:[cm]?[jt]s|json)$/i.test(resolved)) {
    return { req: createRequire(resolved), dir: dirname(resolved) };
  }
  return { req: createRequire(join(resolved, 'package.json')), dir: resolved };
}

/**
 * Whether `pkgName` is physically installed in `node_modules` of `dir` or one
 * of its ancestors. Guards against Node's global resolution paths (NODE_PATH),
 * which would otherwise let unrelated directories resolve monorepo packages.
 */
function isInstalledUnder(dir: string, pkgName: string): boolean {
  const segments = pkgName.split('/');
  let current = dir;
  for (;;) {
    if (existsSync(join(current, 'node_modules', ...segments))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Locate the root directory of an installed npm package using `anchor`.
 * Works even when the package's `exports` map omits `./package.json` or `.`.
 * Resolution is restricted to the anchor directory and its ancestors.
 */
function findPackageRoot(
  anchor: VendorAnchor,
  pkgName: string,
  probeSubpath?: string,
): string | null {
  if (!isInstalledUnder(anchor.dir, pkgName)) return null;
  const options = { paths: [anchor.dir] };

  try {
    return dirname(anchor.req.resolve(`${pkgName}/package.json`, options));
  } catch {
    // Package `exports` may not expose `./package.json`.
  }

  let resolved: string;
  try {
    resolved = anchor.req.resolve(
      probeSubpath !== undefined ? `${pkgName}/${probeSubpath}` : pkgName,
      options,
    );
  } catch {
    return null;
  }

  let dir = dirname(resolved);
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: unknown;
        };
        if (parsed.name === pkgName) return dir;
      } catch {
        // Keep walking up if a nested manifest is unreadable.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolve a package directory across a prioritized chain of anchors. */
function requirePackageRoot(
  anchors: readonly VendorAnchor[],
  pkgName: string,
  probeSubpath?: string,
): string {
  for (const anchor of anchors) {
    const dir = findPackageRoot(anchor, pkgName, probeSubpath);
    if (dir !== null) return dir;
  }
  throw new Error(
    `didact-vendors: could not resolve package "${pkgName}" (is the corresponding @didact/kernel-* package installed?)`,
  );
}

/** Resolve one or more files inside a required npm package. */
function packageFiles(
  anchors: readonly VendorAnchor[],
  pkgName: string,
  relPaths: readonly string[],
  probeSubpath?: string,
): { pkgDir: string; files: VendorFile[] } {
  const pkgDir = requirePackageRoot(anchors, pkgName, probeSubpath);
  const files: VendorFile[] = [];
  for (const rel of relPaths) {
    const src = join(pkgDir, rel);
    if (!existsSync(src)) {
      throw new Error(
        `didact-vendors: missing "${rel}" in package "${pkgName}" (${pkgDir})`,
      );
    }
    files.push({ filename: basename(rel), src });
  }
  return { pkgDir, files };
}

/** Collect optional matching files (e.g. LICENSE texts) from a directory, sorted. */
function collectMatchingFiles(
  dir: string,
  predicate: (name: string) => boolean,
): VendorFile[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((filename) => ({ filename, src: join(dir, filename) }));
}

/** Resolve vendor assets for the x86-64 assembly kernel (`vendor/`). */
function resolveAsmGroup(base: VendorAnchor): VendorGroup {
  const kernelDir = findPackageRoot(base, '@didact/kernel-asm64');
  const anchors =
    kernelDir !== null ? [anchorRequire(kernelDir), base] : [base];

  const files: VendorFile[] = [
    ...packageFiles(anchors, '@alexaltea/unicorn-js', ['dist/unicorn_x86.js'])
      .files,
    ...packageFiles(anchors, '@alexaltea/keystone-js', [
      'dist/keystone.js',
      'dist/keystone.wasm',
    ]).files,
    ...packageFiles(anchors, '@alexaltea/capstone-js', [
      'dist/capstone.js',
      'dist/capstone.wasm',
    ]).files,
  ];

  if (kernelDir !== null) {
    files.push(
      ...collectMatchingFiles(join(kernelDir, 'vendor'), (name) =>
        /^LICENSE-.*\.txt$/.test(name),
      ),
    );
  }

  return { dest: 'vendor', files };
}

/**
 * Resolve shared clang toolchain assets for C and/or C++ (`vendor-c/clang/`).
 * Deduplicated: requesting both `'c'` and `'cpp'` emits this group once.
 */
function resolveClangGroup(
  base: VendorAnchor,
  preferred: 'c' | 'cpp',
): VendorGroup {
  const pkgOrder =
    preferred === 'cpp'
      ? ['@didact/kernel-cpp', '@didact/kernel-c']
      : ['@didact/kernel-c', '@didact/kernel-cpp'];

  const kernelDirs: string[] = [];
  const anchors: VendorAnchor[] = [];
  for (const pkg of pkgOrder) {
    const dir = findPackageRoot(base, pkg);
    if (dir !== null) {
      kernelDirs.push(dir);
      anchors.push(anchorRequire(dir));
    }
  }
  anchors.push(base);

  const files: VendorFile[] = [
    ...packageFiles(anchors, '@yowasp/clang', [
      'gen/bundle.js',
      'gen/llvm.core.wasm',
      'gen/llvm.core2.wasm',
      'gen/llvm.core3.wasm',
      'gen/llvm.core4.wasm',
      'gen/llvm-resources.tar',
    ]).files,
  ];

  for (const kernelDir of kernelDirs) {
    const licenses = collectMatchingFiles(
      join(kernelDir, 'vendor', 'clang'),
      (name) => name.startsWith('LICENSE-'),
    );
    if (licenses.length > 0) {
      files.push(...licenses);
      break;
    }
  }

  return { dest: 'vendor-c/clang', files };
}

/** Resolve vendor assets for the Python kernel (`vendor-python/`). */
function resolvePythonGroup(base: VendorAnchor): VendorGroup {
  const kernelDir = findPackageRoot(base, '@didact/kernel-python');
  const anchors =
    kernelDir !== null ? [anchorRequire(kernelDir), base] : [base];

  const { pkgDir, files } = packageFiles(anchors, 'pyodide', [
    'pyodide.js',
    'pyodide.asm.mjs',
    'pyodide.asm.wasm',
    'python_stdlib.zip',
    'pyodide-lock.json',
  ]);

  const license = join(pkgDir, 'LICENSE');
  if (existsSync(license)) {
    files.push({ filename: 'LICENSE', src: license });
  } else if (kernelDir !== null) {
    // Pyodide ships no LICENSE; the kernel carries the bundled notices.
    const thirdParty = join(kernelDir, 'THIRD-PARTY.md');
    if (existsSync(thirdParty)) {
      files.push({ filename: 'THIRD-PARTY.md', src: thirdParty });
    }
  }

  return { dest: 'vendor-python', files };
}

/** Resolve vendor assets for the Typst kernel (`vendor-typst/`). */
function resolveTypstGroup(base: VendorAnchor): VendorGroup {
  const kernelDir = findPackageRoot(base, '@didact/kernel-typst');
  const anchors =
    kernelDir !== null ? [anchorRequire(kernelDir), base] : [base];

  const files: VendorFile[] = [
    ...packageFiles(anchors, 'typst-wasm', [
      'dist/engine/engine.core.wasm',
      'dist/engine/engine.core2.wasm',
      'dist/engine/engine.core3.wasm',
    ]).files,
    ...packageFiles(
      anchors,
      '@typst-wasm/fonts',
      [
        'dist/files/LibertinusSerif-Regular.otf',
        'dist/files/LibertinusSerif-Bold.otf',
        'dist/files/LibertinusSerif-Italic.otf',
        'dist/files/NewCMMath-Regular.otf',
        'dist/files/DejaVuSansMono.ttf',
      ],
      'LibertinusSerif-Regular.otf',
    ).files,
  ];

  if (kernelDir !== null) {
    files.push(
      ...collectMatchingFiles(join(kernelDir, 'vendor'), (name) =>
        name.startsWith('LICENSE-'),
      ),
    );
  }

  return { dest: 'vendor-typst', files };
}

/** Auto-detect whichever of the 5 WASM `@didact/kernel-*` packages are installed. */
function detectInstalledKernels(base: VendorAnchor): VendorKernelId[] {
  const found: VendorKernelId[] = [];
  for (const { id, pkg } of ALL_KERNELS) {
    if (findPackageRoot(base, pkg) !== null) {
      found.push(id);
    }
  }
  return found;
}

/**
 * Resolve every vendor asset group for the requested (or auto-detected) WASM
 * kernels. Anchors npm resolution on each installed `@didact/kernel-*` package
 * with fallback to `resolveFrom` (default `process.cwd()`).
 *
 * `c` and `cpp` share `vendor-c/clang` and are automatically deduplicated.
 */
export function resolveVendorFiles(
  kernels?: readonly VendorKernelId[],
  resolveFrom?: string,
): VendorGroup[] {
  const base = anchorRequire(resolveFrom);
  const selected = kernels ?? detectInstalledKernels(base);
  const groups: VendorGroup[] = [];
  const emitted = new Set<string>();

  for (const id of selected) {
    const groupKey = id === 'c' || id === 'cpp' ? 'clang' : id;
    if (emitted.has(groupKey)) continue;
    emitted.add(groupKey);

    switch (id) {
      case 'asm':
        groups.push(resolveAsmGroup(base));
        break;
      case 'c':
      case 'cpp':
        groups.push(resolveClangGroup(base, id));
        break;
      case 'python':
        groups.push(resolvePythonGroup(base));
        break;
      case 'typst':
        groups.push(resolveTypstGroup(base));
        break;
    }
  }

  return groups;
}

/** Normalize Vite's `config.base` to a leading-and-trailing-slash URL prefix. */
export function normalizeBase(base: string): string {
  const path = /^https?:\/\//i.test(base) ? new URL(base).pathname : base;
  if (path === '' || path === './' || path === '.') return '/';
  const withLead = path.startsWith('/') ? path : `/${path}`;
  return withLead.endsWith('/') ? withLead : `${withLead}/`;
}

/** Map a vendor file's extension to its HTTP Content-Type header. */
function contentTypeFor(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case '.wasm':
      return 'application/wasm';
    case '.js':
    case '.mjs':
      return 'text/javascript';
    case '.json':
      return 'application/json';
    case '.zip':
      return 'application/zip';
    case '.otf':
      return 'font/otf';
    case '.ttf':
      return 'font/ttf';
    case '.txt':
    case '.md':
    case '':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Serve WASM kernel vendor assets directly from `node_modules` in dev, and
 * copy them into `outDir` at the end of production builds.
 */
export function didactVendors(options: DidactVendorsOptions = {}): Plugin {
  let outDir = '';
  let base = '/';
  let isBuild = false;
  let groups: VendorGroup[] = [];
  let routeMap = new Map<string, string>();

  return {
    name: 'didact-vendors',

    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      base = normalizeBase(config.base);
      isBuild = config.command === 'build';
      groups = resolveVendorFiles(options.kernels, config.root);
      routeMap = new Map();
      for (const group of groups) {
        for (const file of group.files) {
          routeMap.set(`${group.dest}/${file.filename}`, file.src);
        }
      }
    },

    configureServer(server) {
      if (routeMap.size === 0) return;

      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          next();
          return;
        }
        const rawUrl = req.url ?? '';
        const qIndex = rawUrl.indexOf('?');
        const rawPath = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
        let pathname: string;
        try {
          pathname = decodeURIComponent(rawPath);
        } catch {
          next();
          return;
        }

        if (!pathname.startsWith(base)) {
          next();
          return;
        }
        const rel = pathname.slice(base.length);
        const src = routeMap.get(rel);
        if (src === undefined) {
          next();
          return;
        }

        let size: number;
        try {
          size = statSync(src).size;
        } catch (error) {
          next(error);
          return;
        }

        res.setHeader('Content-Type', contentTypeFor(src));
        res.setHeader('Content-Length', String(size));
        if (req.method === 'HEAD') {
          res.end();
          return;
        }

        const stream = createReadStream(src);
        stream.on('error', (error) => {
          if (!res.headersSent) {
            next(error);
          } else {
            res.destroy(error);
          }
        });
        stream.pipe(res);
      });
    },

    closeBundle() {
      if (!isBuild) return;
      for (const group of groups) {
        const destDir = resolve(outDir, group.dest);
        mkdirSync(destDir, { recursive: true });
        for (const file of group.files) {
          const destFile = resolve(destDir, file.filename);
          if (
            existsSync(destFile) &&
            statSync(destFile).size === statSync(file.src).size
          ) {
            continue;
          }
          copyFileSync(file.src, destFile);
        }
      }
    },
  };
}

export default didactVendors;
