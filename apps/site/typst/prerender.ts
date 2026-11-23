// prerender.ts — org pages in, Typst artifacts out.
//
// Each page is parsed with the core org parser, every formula and static
// diagram is collected through the shared contract, and each unique key is
// compiled once. Artifacts are memoized at module scope: Vite reloads the
// virtual module after any page edit, but unchanged formulas are never
// recompiled (package resolution is warm and compiles stay sequential).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOrg } from '../../../packages/core/src/org.ts';
import {
  collectTypstSources,
  diagramKey,
  mathKey,
} from '../../../packages/core/src/typst-source.ts';
import type {
  TypstArtifacts,
  TypstMathArtifact,
} from '../../../packages/core/src/typst-source.ts';
import { assertDiagramQuality } from './check.ts';
import { compileDiagram, compileMath, mathLayoutCss } from './engine.ts';

const mathCache = new Map<string, TypstMathArtifact>();
const diagramCache = new Map<string, string>();

/** Compile every formula and diagram in one page set, in document order. */
export async function prerenderOrgPages(
  sources: Record<string, string>,
): Promise<TypstArtifacts> {
  const math: Record<string, TypstMathArtifact> = {};
  const diagrams: Record<string, string> = {};
  // A page can repeat a formula; keys dedupe across the whole set.
  const pendingMath = new Map<string, { src: string; display: boolean }>();
  const pendingDiagrams = new Map<string, string>();

  for (const org of Object.values(sources)) {
    const collected = collectTypstSources(parseOrg(org));
    for (const item of collected.math) {
      const key = mathKey(item.src, item.display);
      if (!(key in math) && !pendingMath.has(key)) pendingMath.set(key, item);
    }
    for (const src of collected.diagrams) {
      const key = diagramKey(src);
      if (!(key in diagrams) && !pendingDiagrams.has(key)) {
        pendingDiagrams.set(key, src);
      }
    }
  }

  // Sequential on purpose: one engine instance, one promise chain.
  for (const [key, item] of pendingMath) {
    let artifact = mathCache.get(key);
    if (artifact === undefined) {
      artifact = await compileMath(item.src, item.display);
      mathCache.set(key, artifact);
    }
    math[key] = artifact;
  }
  for (const [key, src] of pendingDiagrams) {
    let svg = diagramCache.get(key);
    if (svg === undefined) {
      svg = await compileDiagram(src);
      assertDiagramQuality(svg, src);
      diagramCache.set(key, svg);
    }
    diagrams[key] = svg;
  }

  return { math, diagrams, mathCss: await mathLayoutCss() };
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
