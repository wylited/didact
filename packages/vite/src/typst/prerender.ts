// prerender.ts — org pages in, Typst artifacts out.
//
// Each page is parsed with the core org parser, every formula and static
// diagram is collected through the shared contract, and each unique key is
// compiled once. Artifacts are memoized at module scope: Vite reloads the
// virtual module after any page edit, but unchanged formulas are never
// recompiled (package resolution is warm and compiles stay sequential).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOrg, parseOrgChecked } from '@didact/core/org';
import {
  collectTypstSources,
  diagramKey,
  mathKey,
  type TypstArtifacts,
  type TypstMathArtifact,
} from '@didact/core/typst';
import { assertDiagramQuality } from './check.ts';
import { compileDiagram, compileMath, mathLayoutCss } from './engine.ts';

const mathCache = new Map<string, TypstMathArtifact>();
const diagramCache = new Map<string, string>();

/** How a block appears in its org source, which picks the location strategy. */
export type BlockKind = 'math' | 'diagram';

/**
 * Locate a block in its page: the line number and a representative source
 * line. Boilerplate (`#set page`, `#set text`, `#import`) is skipped so the
 * message names the code that failed, not the prelude every block shares.
 *
 * Diagram sources are reproduced verbatim in the org file (src blocks), so
 * the exact `src` locates the block even when a shared prelude line appears
 * in several diagrams. Math sources appear without their `$` delimiters, so
 * the delimited form locates them.
 */
export function blockLocation(
  org: string,
  src: string,
  kind: BlockKind,
): { line: number | null; snippet: string } {
  const normalizedOrg = org.replace(/\r\n?/g, '\n');
  const normalizedSrc = src.replace(/\r\n?/g, '\n');

  const lines = normalizedSrc.split('\n');
  const isPrelude = (line: string): boolean =>
    /^\s*(#set\s+(page|text)\b|#import\b)/.test(line);
  let offset = lines.findIndex((line) => line.trim() !== '' && !isPrelude(line));
  if (offset < 0) offset = lines.findIndex((line) => line.trim() !== '');
  const raw = offset < 0 ? '' : (lines[offset] ?? '').trim();
  const snippet = raw.length > 64 ? `${raw.slice(0, 61)}...` : raw;
  if (raw === '') return { line: null, snippet };

  // Exact sources are the reliable locator; fall back to the representative
  // line when the page's whitespace differs from what was collected.
  if (kind === 'diagram') {
    const at = normalizedOrg.indexOf(normalizedSrc);
    if (at >= 0) {
      return { line: normalizedOrg.slice(0, at).split('\n').length, snippet };
    }
  } else {
    // Display (`$$…$$`) and inline (`$…$`) spellings; the earliest wins so a
    // display formula is not reported at the inner inline offset.
    let at = -1;
    for (const needle of [`$$${normalizedSrc}$$`, `$${normalizedSrc}$`]) {
      const found = normalizedOrg.indexOf(needle);
      if (found >= 0 && (at < 0 || found < at)) at = found;
    }
    if (at >= 0) {
      return { line: normalizedOrg.slice(0, at).split('\n').length, snippet };
    }
  }

  // Match the whole line, not a substring: a short formula (`x`, `0`) occurs
  // on many lines, and `indexOf` would happily report an earlier one. The
  // representative source line is unique enough in practice, and a miss is
  // better than a confident wrong line.
  const orgLines = normalizedOrg.split('\n');
  const at = orgLines.findIndex((line) => line.trim() === raw);
  const line = at < 0 ? null : at + 1;
  return { line, snippet };
}

/**
 * Prefix a compile failure with the page, block line, and a source line.
 * The Typst diagnostic alone (`didact-build-main.typ:15`) cannot tell an author
 * which of a page's blocks failed.
 */
function withPage(
  error: unknown,
  kind: string,
  page: string,
  org: string,
  src: string,
  blockKind: BlockKind,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const { line, snippet } = blockLocation(org, src, blockKind);
  const file = page.endsWith('.org') ? page : `${page}.org`;
  const where = line === null ? file : `${file}:${line}`;
  return new Error(`${kind} in ${where} (\`${snippet}\`):\n${message}`);
}

/** One block waiting for a compile, with the page that first named it. */
interface PendingMath {
  src: string;
  display: boolean;
  page: string;
  org: string;
}

interface PendingDiagram {
  src: string;
  page: string;
  org: string;
}

/**
 * Compile a deduped block set through the module-level caches. Failures are
 * returned, not thrown: the caller reports them (eager mode lists every
 * failing block in one error; per-page mode compiles the whole set first and
 * then aborts the build the same way).
 */
async function compilePending(
  pendingMath: Map<string, PendingMath>,
  pendingDiagrams: Map<string, PendingDiagram>,
): Promise<{
  math: Record<string, TypstMathArtifact>;
  diagrams: Record<string, string>;
  failures: string[];
}> {
  const math: Record<string, TypstMathArtifact> = {};
  const diagrams: Record<string, string> = {};
  const failures: string[] = [];
  // Sequential on purpose: one engine instance, one promise chain.
  for (const [key, item] of pendingMath) {
    let artifact = mathCache.get(key);
    if (artifact === undefined) {
      try {
        artifact = await compileMath(item.src, item.display);
      } catch (error) {
        failures.push(
          withPage(error, 'typst math', item.page, item.org, item.src, 'math')
            .message,
        );
        continue;
      }
      mathCache.set(key, artifact);
    }
    math[key] = artifact;
  }
  for (const [key, item] of pendingDiagrams) {
    let svg = diagramCache.get(key);
    if (svg === undefined) {
      try {
        svg = await compileDiagram(item.src);
        assertDiagramQuality(svg, item.src);
      } catch (error) {
        failures.push(
          withPage(
            error,
            'typst diagram',
            item.page,
            item.org,
            item.src,
            'diagram',
          ).message,
        );
        continue;
      }
      diagramCache.set(key, svg);
    }
    diagrams[key] = svg;
  }
  return { math, diagrams, failures };
}

/** Throw one aggregated error naming every block that failed to compile. */
function throwFailures(failures: readonly string[]): void {
  if (failures.length === 0) return;
  throw new Error(
    failures.length === 1
      ? failures[0]!
      : `${failures.length} typst blocks failed:\n\n${failures.join('\n\n')}`,
  );
}

/** Compile every formula and diagram in one page set, in document order. */
export async function prerenderOrgPages(
  sources: Record<string, string>,
): Promise<TypstArtifacts> {
  // A page can repeat a formula; keys dedupe across the whole set.
  const pendingMath = new Map<string, PendingMath>();
  const pendingDiagrams = new Map<string, PendingDiagram>();

  for (const [page, org] of Object.entries(sources)) {
    const collected = collectTypstSources(parseOrg(org));
    for (const item of collected.math) {
      const key = mathKey(item.src, item.display);
      if (!pendingMath.has(key)) {
        pendingMath.set(key, { ...item, page, org });
      }
    }
    for (const src of collected.diagrams) {
      const key = diagramKey(src);
      if (!pendingDiagrams.has(key)) {
        pendingDiagrams.set(key, { src, page, org });
      }
    }
  }

  // Compile everything, then report. One broken block should not hide the
  // rest: a cold build pays for every compile it can complete, and an author
  // fixing a page should see all of its failures in one pass.
  const { math, diagrams, failures } = await compilePending(
    pendingMath,
    pendingDiagrams,
  );
  throwFailures(failures);

  // Avoid booting typst-wasm when the page set contains no math formulas.
  const mathCss = Object.keys(math).length === 0 ? '' : await mathLayoutCss();
  return { math, diagrams, mathCss };
}

/**
 * Prerender every page separately: each result carries only the formulas and
 * diagrams that page renders, keyed by its file name (`c.org`). Compiles are
 * still global and memoized, so a formula shared by two pages compiles once;
 * `mathCss` is the same value for every page (it is one document stylesheet).
 *
 * Used by the Vite plugin's `perPage` mode, where each page becomes its own
 * lazy chunk so the app entry never contains another page's SVGs.
 */
export async function prerenderOrgPagesByPage(
  sources: Record<string, string>,
): Promise<Record<string, TypstArtifacts>> {
  const pendingMath = new Map<string, PendingMath>();
  const pendingDiagrams = new Map<string, PendingDiagram>();
  // Key order per page, so each page's artifacts follow document order.
  const pageKeys = new Map<string, { math: string[]; diagrams: string[] }>();

  for (const [page, org] of Object.entries(sources)) {
    const collected = collectTypstSources(parseOrgChecked(org).doc);
    const keys = { math: [] as string[], diagrams: [] as string[] };
    for (const item of collected.math) {
      const key = mathKey(item.src, item.display);
      keys.math.push(key);
      if (!pendingMath.has(key)) {
        pendingMath.set(key, { ...item, page, org });
      }
    }
    for (const src of collected.diagrams) {
      const key = diagramKey(src);
      keys.diagrams.push(key);
      if (!pendingDiagrams.has(key)) {
        pendingDiagrams.set(key, { src, page, org });
      }
    }
    pageKeys.set(page, keys);
  }

  const { math, diagrams, failures } = await compilePending(
    pendingMath,
    pendingDiagrams,
  );
  throwFailures(failures);
  const mathCss = Object.keys(math).length === 0 ? '' : await mathLayoutCss();

  const result: Record<string, TypstArtifacts> = {};
  for (const [page, keys] of pageKeys) {
    const pageMath: Record<string, TypstMathArtifact> = {};
    for (const key of keys.math) {
      const artifact = math[key];
      if (artifact !== undefined) pageMath[key] = artifact;
    }
    const pageDiagrams: Record<string, string> = {};
    for (const key of keys.diagrams) {
      const svg = diagrams[key];
      if (svg !== undefined) pageDiagrams[key] = svg;
    }
    result[page] = { math: pageMath, diagrams: pageDiagrams, mathCss };
  }
  return result;
}

/** Read every `*.org` file in `dir` (sorted) and prerender it. */
export async function prerenderPageFiles(dir: string): Promise<TypstArtifacts> {
  const entries = await readdir(dir, { withFileTypes: true });
  const sources: Record<string, string> = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.org')) continue;
    const name = entry.name.slice(0, -'.org'.length);
    sources[name] = await readFile(join(dir, entry.name), 'utf8');
  }
  return prerenderOrgPages(sources);
}

/**
 * Read every `*.org` file in `dir` (sorted) and prerender them separately.
 * Result keys are page file names (`c.org`) because that is the identity the
 * site and org links use.
 */
export async function prerenderPageFilesByPage(
  dir: string,
): Promise<Record<string, TypstArtifacts>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const sources: Record<string, string> = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.org')) continue;
    sources[entry.name] = await readFile(join(dir, entry.name), 'utf8');
  }
  return prerenderOrgPagesByPage(sources);
}
