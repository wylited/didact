// cli.ts — acceptance/verification entry for the build-time Typst pipeline.
//
//   node packages/vite/src/typst/cli.ts [pagesDir] [-o|--out <dir>]
//
// Defaults to `./src/pages` in the current working directory. Reads every
// `*.org` file, prints the formula/diagram counts per page and the total
// compile time. With `--out`, also writes one `<page>-<n>.svg` per diagram so
// an author can open the artifact the page will show. Compiling a diagram and
// passing the quality gate either succeeds silently or throws, so exit code 0
// with the counts printed means every diagram passed.
//
// Relative imports keep their `.ts` extensions so Node 24 can run this file
// directly through type stripping — no bundler involved.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseOrg } from '@didact/core/org';
import {
  collectTypstSources,
  diagramKey,
  type TypstArtifacts,
} from '@didact/core/typst';
import { prerenderOrgPages } from './prerender.ts';

const DEFAULT_PAGES = resolve(process.cwd(), 'src/pages');

const USAGE = `usage: node packages/vite/src/typst/cli.ts [pagesDir] [-o|--out <dir>]

  pagesDir        directory of *.org pages (default: ${DEFAULT_PAGES})
  -o, --out <dir> also write every diagram as <page>-<n>.svg
  -h, --help      this message

environment:
  TYPST_PACKAGE_BASE_URL  package mirror (default https://packages.typst.org)
  TYPST_NO_PACKAGE_CACHE=1  ignore .typst-cache for this run`;

function parseArgs(argv: string[]): { dir: string; out: string | null } {
  const positional: string[] = [];
  let out: string | null = null;
  const takeOut = (value: string | undefined): void => {
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`--out needs a directory\n${USAGE}`);
    }
    out = resolve(value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--out' || arg === '-o') {
      takeOut(argv[++i]);
    } else if (arg.startsWith('--out=') || arg.startsWith('-o=')) {
      takeOut(arg.slice(arg.indexOf('=') + 1));
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown flag ${arg}\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) {
    throw new Error(`expected one pages directory\n${USAGE}`);
  }
  return { dir: resolve(positional[0] ?? DEFAULT_PAGES), out };
}

/** Intrinsic size from a diagram's `viewBox`, in pt. */
function viewBoxSize(svg: string): string {
  const raw = /\bviewBox="([^"]+)"/.exec(svg)?.[1];
  if (raw === undefined) return '?';
  const [, , width, height] = raw.trim().split(/[\s,]+/).map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return '?';
  return `${Math.round(width!)}x${Math.round(height!)} pt`;
}

async function writeDiagrams(
  out: string,
  perFile: { name: string; keys: string[] }[],
  artifacts: TypstArtifacts,
): Promise<void> {
  await mkdir(out, { recursive: true });
  for (const { name, keys } of perFile) {
    for (let i = 0; i < keys.length; i++) {
      const svg = artifacts.diagrams[keys[i]!];
      if (svg === undefined) continue;
      const file = join(out, `${name}-${i + 1}.svg`);
      await writeFile(file, svg, 'utf8');
      console.log(`${file}: ${viewBoxSize(svg)}`);
    }
  }
}

async function main(): Promise<void> {
  const { dir, out } = parseArgs(process.argv.slice(2));
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`no such pages directory: ${dir}\n${USAGE}`);
    }
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.org'))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) {
    throw new Error(`no *.org files in ${dir}`);
  }

  const sources: Record<string, string> = {};
  const counts: {
    name: string;
    math: number;
    diagrams: number;
    keys: string[];
  }[] = [];
  for (const file of files) {
    const name = file.slice(0, -'.org'.length);
    const text = await readFile(join(dir, file), 'utf8');
    sources[name] = text;
    const collected = collectTypstSources(parseOrg(text));
    counts.push({
      name,
      math: collected.math.length,
      diagrams: collected.diagrams.length,
      keys: collected.diagrams.map(diagramKey),
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
  if (out !== null) {
    await writeDiagrams(out, counts, artifacts);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
