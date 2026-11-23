// cli.ts — acceptance/verification entry for the build-time pipeline.
//
//   node apps/site/typst/cli.ts <pagesDir>
//
// Reads every `*.org` file, prints the formula/diagram counts per page and the
// total compile time. Relative imports keep their `.ts` extensions so Node 24
// can run this file directly through type stripping — no bundler involved.

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseOrg } from '../../../packages/core/src/org.ts';
import { collectTypstSources } from '../../../packages/core/src/typst-source.ts';
import { prerenderOrgPages } from './prerender.ts';

async function main(): Promise<void> {
  const dir = resolve(process.argv[2] ?? 'src/pages');
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.org'))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) {
    throw new Error(`no *.org files in ${dir}`);
  }

  const sources: Record<string, string> = {};
  const counts: { name: string; math: number; diagrams: number }[] = [];
  for (const file of files) {
    const name = file.slice(0, -'.org'.length);
    const text = await readFile(join(dir, file), 'utf8');
    sources[name] = text;
    const collected = collectTypstSources(parseOrg(text));
    counts.push({
      name,
      math: collected.math.length,
      diagrams: collected.diagrams.length,
    });
  }

  const started = performance.now();
  const artifacts = await prerenderOrgPages(sources);
  const ms = performance.now() - started;

  for (const { name, math, diagrams } of counts) {
    console.log(`${name}: ${math} math, ${diagrams} diagrams`);
  }
  console.log(
    `total: ${Object.keys(artifacts.math).length} math, ` +
      `${Object.keys(artifacts.diagrams).length} diagrams, ` +
      `${artifacts.mathCss.length} css chars, ${ms.toFixed(0)} ms`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
