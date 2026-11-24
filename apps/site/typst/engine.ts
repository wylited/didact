// engine.ts — the build-time Typst compiler (Node only).
//
// One compiler instance for the whole build: the wasm modules and the five
// fonts Typst's defaults need are loaded once behind a module-level promise.
// Every compile runs through one promise chain so the stateful compiler's
// virtual project never sees overlapping writes.
//
// Unlike the browser kernel (packages/kernel-typst/src/vendor.ts) this engine
// keeps the library's real fetch: `@preview/*` imports must resolve from
// packages.typst.org, and there is deliberately no rejecting loader. That
// fetch is wrapped with a byte cache so cold builds do not refetch packages.
//
// Package archive cache:
//   Layout — apps/site/.typst-cache/<url path with unsafe chars as `_`>,
//            e.g. https://packages.typst.org/preview/fletcher-0.4.0.tar.gz
//            becomes .typst-cache/preview_fletcher-0.4.0.tar.gz.
//   Env    — TYPST_PACKAGE_BASE_URL overrides the package mirror base
//            (default https://packages.typst.org); TYPST_NO_PACKAGE_CACHE=1
//            disables cache reads and writes while keeping the wrapper.
// Cache failures are logged once and never fail the build.
//
// Two output shapes:
//   math      — MathML (format html, also yields Typst's math layout CSS) with
//               an SVG fallback rendered on an auto-sized, background-free page.
//   diagrams  — a self-contained SVG page, widened to 100% when it would
//               overflow the article column (same rule as the kernel).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTypstCompiler } from 'typst-wasm';
import type {
  Diagnostic as TypstDiagnostic,
  TypstCompiler,
} from 'typst-wasm';

/** Virtual entry path; compiles are serialized so it is safe to reuse. */
const MAIN = 'didact-build-main.typ';

/** Typst package mirror; must match `packageBaseUrl` below. */
const PACKAGE_BASE_URL = (
  process.env.TYPST_PACKAGE_BASE_URL?.trim() || 'https://packages.typst.org'
).replace(/\/+$/, '');

/** Prefix every package archive response URL starts with. */
const PACKAGE_URL_PREFIX = `${PACKAGE_BASE_URL}/preview/`;

/** Repo-local byte cache for downloaded package archives. */
const PACKAGE_CACHE_DIR = fileURLToPath(
  new URL('../.typst-cache/', import.meta.url),
);

/** Set to `1` to skip cache reads and writes (network is still wrapped). */
const PACKAGE_CACHE_DISABLED = process.env.TYPST_NO_PACKAGE_CACHE === '1';

/** Global fetch, captured before any local shadowing. */
const networkFetch = globalThis.fetch;

/** Engine modules, in the names typst-wasm's CoreModules type requires. */
const ENGINE_FILES = [
  'engine.core.wasm',
  'engine.core2.wasm',
  'engine.core3.wasm',
] as const;

/** Minimum families for the default text, bold, italic, math and raw faces. */
const FONT_FILES = [
  'LibertinusSerif-Regular.otf',
  'LibertinusSerif-Bold.otf',
  'LibertinusSerif-Italic.otf',
  'NewCMMath-Regular.otf',
  'DejaVuSansMono.ttf',
] as const;

/** Pages wider than this (px at 96 dpi) become responsive instead. */
const MAX_INLINE_PX = 680;

let compilerPromise: Promise<TypstCompiler> | null = null;
let queue: Promise<void> = Promise.resolve();
/** Unique `<style>` payloads seen in HTML compiles, first-seen order. */
const cssChunks: string[] = [];

/** In-flight package downloads, so concurrent misses share one fetch. */
const packageRequests = new Map<string, Promise<Uint8Array | Response>>();
/** Whether a cache failure has already been reported. */
let cacheFailureLogged = false;
/** Lazily created cache directory; reset on failure so a later build retries. */
let cacheDirPromise: Promise<void> | null = null;

/** Resolve a package archive URL to its cache file, derived from the path. */
function packageCacheFile(url: string): string {
  const pathname = new URL(url).pathname;
  const name = pathname
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_');
  return join(PACKAGE_CACHE_DIR, name === '' ? 'package.tar.gz' : name);
}

function ensureCacheDir(): Promise<void> {
  cacheDirPromise ??= mkdir(PACKAGE_CACHE_DIR, { recursive: true })
    .then(() => undefined)
    .catch((error: unknown) => {
      cacheDirPromise = null;
      throw error;
    });
  return cacheDirPromise;
}

function warnCacheOnce(action: string, error: unknown): void {
  if (cacheFailureLogged) return;
  cacheFailureLogged = true;
  console.warn(
    `typst package cache ${action} failed; continuing without cache: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

/** A gzip response over bytes we already hold (avoids a second request). */
function archiveResponse(bytes: Uint8Array): Response {
  return new Response(bytes, {
    headers: { 'content-type': 'application/gzip' },
  });
}

/** True when a thrown fs error carries the given errno code. */
function hasErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === code;
}

/**
 * Read a cached archive. A truncated/corrupt file is treated as a miss so it
 * gets replaced by the network copy.
 */
async function readCachedPackage(file: string): Promise<Uint8Array | null> {
  try {
    const bytes = new Uint8Array(await readFile(file));
    // gzip magic: a valid archive is at least two bytes.
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
      return null;
    }
    return bytes;
  } catch (error) {
    if (!hasErrnoCode(error, 'ENOENT')) {
      warnCacheOnce('read', error);
    }
    return null;
  }
}

/** Best-effort cache write; never throws. */
async function writeCachedPackage(
  file: string,
  bytes: Uint8Array,
): Promise<void> {
  try {
    await ensureCacheDir();
    await writeFile(file, bytes);
  } catch (error) {
    warnCacheOnce('write', error);
  }
}

/** Network fetch plus best-effort cache storage for a package archive. */
async function loadPackageArchive(
  url: string,
  init: RequestInit | undefined,
): Promise<Uint8Array | Response> {
  const file = PACKAGE_CACHE_DISABLED ? null : packageCacheFile(url);
  if (file !== null) {
    const cached = await readCachedPackage(file);
    if (cached !== null) return cached;
  }
  const response = await networkFetch(url, init);
  if (!response.ok) return response;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (file !== null) await writeCachedPackage(file, bytes);
  return bytes;
}

/**
 * Fetch used by typst-wasm. Package archives are served from the byte cache;
 * every other URL is passed straight through. Concurrent requests for the same
 * archive share one promise.
 */
const cachedPackageFetch: typeof fetch = (input, init) => {
  const url =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
  if (!url.startsWith(PACKAGE_URL_PREFIX) || !url.endsWith('.tar.gz')) {
    return networkFetch(input, init);
  }
  const existing = packageRequests.get(url);
  if (existing !== undefined) {
    return existing.then((value) =>
      value instanceof Response ? value : archiveResponse(value),
    );
  }
  const request = loadPackageArchive(url, init);
  packageRequests.set(url, request);
  const settle = (): void => {
    if (packageRequests.get(url) === request) packageRequests.delete(url);
  };
  request.then(settle, settle);
  return request.then((value) =>
    value instanceof Response ? value : archiveResponse(value),
  );
};

/** Load the engine and its fonts once; a failure does not poison retries. */
function getCompiler(): Promise<TypstCompiler> {
  compilerPromise ??= (async () => {
    const coreModules = {} as Record<
      (typeof ENGINE_FILES)[number],
      WebAssembly.Module
    >;
    await Promise.all(
      ENGINE_FILES.map(async (name) => {
        const path = new URL(import.meta.resolve(`typst-wasm/engine/${name}`));
        coreModules[name] = await WebAssembly.compile(
          new Uint8Array(await readFile(path)),
        );
      }),
    );
    const compiler = await createTypstCompiler({
      coreModules,
      backend: 'jspi',
      // Mirrorable package resolution backed by the repo-local byte cache.
      fetch: cachedPackageFetch,
      packageBaseUrl: PACKAGE_BASE_URL,
    });
    const fonts = await Promise.all(
      FONT_FILES.map(async (name) =>
        new Uint8Array(
          await readFile(
            new URL(import.meta.resolve(`@typst-wasm/fonts/${name}`)),
          ),
        ),
      ),
    );
    await compiler.addFonts(...fonts);
    return compiler;
  })();
  compilerPromise.catch(() => {
    compilerPromise = null;
  });
  return compilerPromise;
}

/** Serialize one compile behind every other compile. */
function serialized<T>(task: (compiler: TypstCompiler) => Promise<T>): Promise<T> {
  const result = queue.then(async () => task(await getCompiler()));
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Compile one formula to MathML and an SVG fallback. */
export function compileMath(
  src: string,
  display: boolean,
): Promise<{ mathml: string; svg: string }> {
  return serialized(async (compiler) => {
    try {
      const htmlSource = display ? `$ ${src} $` : `$${src}$`;
      const html = await compileHtml(compiler, htmlSource);
      const mathml = extractMath(html);
      if (mathml === null) {
        throw new Error('typst HTML output contained no <math> element');
      }
      const css = extractCss(html);
      if (css !== '' && !cssChunks.includes(css)) cssChunks.push(css);

      // Same inline/display wrapper as the HTML compile: Typst uses the
      // spaces inside the dollars to pick display style.
      const svgSource =
        `#set page(width: auto, height: auto, margin: 0pt, fill: none)\n` +
        (display ? `$ ${src} $` : `$${src}$`);
      const svg = stripWhiteBackground(await compileSvg(compiler, svgSource));
      return { mathml, svg };
    } catch (error) {
      throw typstFailure(error);
    }
  });
}

/** Compile a static diagram block to a self-contained SVG page. */
export function compileDiagram(src: string): Promise<string> {
  return serialized(async (compiler) => {
    try {
      // The user's own `#set page` later in the block overrides this.
      const doc = `#set page(width: auto, height: auto, margin: 6pt)\n${src}`;
      // The page's white background is invisible on the page; dropping it
      // keeps figures transparent for print and forced-colors rendering.
      return responsiveSvg(stripWhiteBackground(await compileSvg(compiler, doc)));
    } catch (error) {
      throw typstFailure(error);
    }
  });
}

/**
 * Typst's MathML layout CSS, taken verbatim from HTML compiles. If no formula
 * was compiled yet (a page set with no math), compile a trivial one.
 */
export function mathLayoutCss(): Promise<string> {
  return serialized(async (compiler) => {
    if (cssChunks.length === 0) {
      try {
        const html = await compileHtml(compiler, '$ x $');
        const css = extractCss(html);
        if (css !== '') cssChunks.push(css);
      } catch (error) {
        throw typstFailure(error);
      }
    }
    return cssChunks.join('\n');
  });
}

async function compileHtml(
  compiler: TypstCompiler,
  src: string,
): Promise<string> {
  await compiler.addSource(MAIN, src);
  const result = await compiler.compile({ main: MAIN, format: 'html' });
  assertNoErrors(result.diagnostics);
  return result.output;
}

async function compileSvg(
  compiler: TypstCompiler,
  src: string,
): Promise<string> {
  await compiler.addSource(MAIN, src);
  const result = await compiler.compile({ main: MAIN, format: 'svg' });
  assertNoErrors(result.diagnostics);
  // A figure is one page. Dropping the rest would silently truncate a
  // diagram that overflowed its page box.
  if (result.pages.length !== 1) {
    throw new Error(
      `typst produced ${result.pages.length} SVG pages for one figure; ` +
        'add a page size or remove the page break',
    );
  }
  return result.pages[0]!.output;
}

function assertNoErrors(diagnostics: readonly TypstDiagnostic[]): void {
  const error = diagnostics.find((d) => d.severity === 'error');
  if (error !== undefined) throw new Error(formatDiagnostic(error));
}

/** The first `math` element, including its attributes. */
function extractMath(html: string): string | null {
  const match = /<math\b[^>]*>[\s\S]*?<\/math>/.exec(html);
  return match === null ? null : match[0];
}

/** The payload of the document's first `<style>` block. */
function extractCss(html: string): string {
  const match = /<style\b[^>]*>([\s\S]*?)<\/style>/.exec(html);
  return match === null ? '' : match[1]!.trim();
}

/**
 * Remove Typst's page-sized white background path, which starts at the page
 * origin (`d="M 0 0v …"`). Other white-filled shapes are left alone.
 */
function stripWhiteBackground(svg: string): string {
  // Typst draws the page as the first top-level path. Node boxes are also
  // white-filled `M 0 0v …` paths, but they live inside `<g transform>`, so
  // only a path before the first group and sized to the viewBox is the page.
  const firstGroup = svg.indexOf('<g');
  const path = /<path\b[^>]*\/>/.exec(svg);
  if (path === null) return svg;
  if (firstGroup !== -1 && path.index > firstGroup) return svg;
  if (!/\bfill="#ffffff"/.test(path[0]) || !/\bd="M 0 0v /.test(path[0])) {
    return svg;
  }
  return svg.slice(0, path.index) + svg.slice(path.index + path[0].length);
}

/** Same width rule as packages/kernel-typst/src/session.ts. */
function responsiveSvg(svg: string): string {
  const open = /^<svg\b[^>]*>/.exec(svg);
  if (open === null) return svg;
  const width = /\swidth="([\d.]+)pt"/.exec(open[0]);
  if (width === null) return svg;
  const px = (parseFloat(width[1]!) * 4) / 3;
  if (px <= MAX_INLINE_PX) return svg;
  return svg
    .replace(/\swidth="[\d.]+pt"/, ' width="100%"')
    .replace(/\sheight="[\d.]+pt"/, '')
    .replace('<svg', '<svg style="height:auto"');
}

/** A readable error carrying the diagnostic's file, line and hints. */
function typstFailure(error: unknown): Error {
  const diagnostics = diagnosticsOf(error);
  if (diagnostics !== null) {
    const first =
      diagnostics.find((d) => d.severity === 'error') ?? diagnostics[0]!;
    return new Error(formatDiagnostic(first));
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Narrow the library's CompileError to its diagnostic list. */
function diagnosticsOf(error: unknown): TypstDiagnostic[] | null {
  if (typeof error !== 'object' || error === null) return null;
  if (!('diagnostics' in error)) return null;
  const diagnostics = error.diagnostics;
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return null;
  // CompileError is the library's own shape; only emptiness is checked.
  return diagnostics as TypstDiagnostic[];
}

function formatDiagnostic(diagnostic: TypstDiagnostic): string {
  const location = `${diagnostic.file ?? 'typst'}:${diagnostic.line ?? 0}`;
  const hints = diagnostic.hints.length
    ? '\n' + diagnostic.hints.map((hint) => `  hint: ${hint}`).join('\n')
    : '';
  return `${location}: ${diagnostic.message}${hints}`;
}
