#!/usr/bin/env node
// cli.ts — `didact check`: lint lesson pages and optionally verify RESULTS/CHECK.

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPages, pythonRunner } from './check.ts';

const USAGE = `usage: didact check [--pages DIR] [--run] [--python CMD] [page-stem ...]

Lint org lesson pages under DIR for constructs the renderer drops.
With --run, execute every block in a fresh interpreter and compare stdout
against its canned #+RESULTS block and/or #+CHECK expectation.

  --pages DIR   directory of *.org pages (default: src/pages if present,
                otherwise apps/site/src/pages)
  --run         execute blocks (Python only; other languages are skipped)
  --python CMD  Python executable for --run (default: python3)
  page-stem     restrict the check to these pages
  -h, --help    show this help
`;

export interface CliArgs {
  pagesDir: string | null;
  run: boolean;
  python: string | null;
  stems: string[];
  help: boolean;
}

/**
 * Parse `didact check [options] [page-stem ...]`. `check` is a required
 * subcommand; `help` (or a leading --help/-h) requests usage instead.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const first = argv[0];
  if (first === 'help' || first === '--help' || first === '-h') {
    return { pagesDir: null, run: false, python: null, stems: [], help: true };
  }
  if (first === undefined) throw new Error('missing command (expected "check")');
  if (first !== 'check') throw new Error(`unknown command: ${first}`);

  const args: CliArgs = { pagesDir: null, run: false, python: null, stems: [], help: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--run') {
      args.run = true;
    } else if (arg === '--pages' || arg === '--python') {
      const value = argv[++i];
      if (value === undefined || value === '') throw new Error(`${arg} requires a value`);
      if (arg === '--pages') args.pagesDir = value;
      else args.python = value;
    } else if (arg.startsWith('--pages=')) {
      const value = arg.slice('--pages='.length);
      if (value === '') throw new Error('--pages requires a value');
      args.pagesDir = value;
    } else if (arg.startsWith('--python=')) {
      const value = arg.slice('--python='.length);
      if (value === '') throw new Error('--python requires a value');
      args.python = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      args.stems.push(arg);
    }
  }
  return args;
}

/**
 * Resolve the default pages directory when `--pages` is omitted: prefer
 * `src/pages` in `cwd` (consumer sites and `apps/site`), otherwise fall back
 * to `apps/site/src/pages` (the monorepo root).
 */
export function defaultPagesDir(cwd: string = process.cwd()): string {
  const local = resolve(cwd, 'src/pages');
  if (existsSync(local)) return local;
  return resolve(cwd, 'apps/site/src/pages');
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const pagesDir =
    args.pagesDir !== null ? resolve(process.cwd(), args.pagesDir) : defaultPagesDir();
  if (!existsSync(pagesDir)) {
    console.error(`pages directory not found: ${pagesDir}`);
    return 1;
  }

  const report = await checkPages({
    pagesDir,
    pages: args.stems.length === 0 ? undefined : args.stems,
    run: args.run,
    runner: args.run ? pythonRunner(args.python ?? 'python3') : undefined,
  });

  const wanted = args.stems.length === 0 ? null : new Set(args.stems);
  const pageNames = readdirSync(pagesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.org'))
    .map((entry) => entry.name.slice(0, -'.org'.length))
    .filter((stem) => wanted === null || wanted.has(stem))
    .sort();

  const diagnosticsByPage = new Map<string, typeof report.diagnostics>();
  for (const diagnostic of report.diagnostics) {
    const list = diagnosticsByPage.get(diagnostic.page) ?? [];
    list.push(diagnostic);
    diagnosticsByPage.set(diagnostic.page, list);
  }
  const blocksByPage = new Map<string, typeof report.blocks>();
  for (const block of report.blocks) {
    const list = blocksByPage.get(block.page) ?? [];
    list.push(block);
    blocksByPage.set(block.page, list);
  }

  let failures = 0;
  for (const page of pageNames) {
    const diagnostics = diagnosticsByPage.get(page) ?? [];
    const blocks = blocksByPage.get(page) ?? [];
    const badBlocks = blocks.filter((b) => b.status === 'error' || b.status === 'mismatch');
    const pageFailures = diagnostics.length + badBlocks.length;
    failures += pageFailures;
    console.log(
      `${page}  ${diagnostics.length} diagnostics  ${blocks.length} blocks  ` +
        (pageFailures === 0 ? 'ok' : `${pageFailures} failures`),
    );
    for (const diagnostic of diagnostics) {
      console.log(`  line ${diagnostic.line} [${diagnostic.severity}]: ${diagnostic.message}`);
    }
    for (const block of badBlocks) {
      const label = block.name === null ? block.lang : `${block.lang} ${block.name}`;
      console.log(`  line ${block.line} ${label}: ${block.status}`);
      for (const line of (block.detail ?? '').split('\n')) {
        if (line !== '') console.log(`    ${line}`);
      }
    }
  }

  console.log(
    `\n${report.pages} pages, ${report.diagnostics.length} diagnostics, ` +
      `${report.blocks.length} blocks, ${failures} failures`,
  );
  return failures > 0 ? 1 : 0;
}

/** Detect direct invocation under both Bun and Node 24 (including bin symlinks). */
function isEntryPoint(): boolean {
  if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
    return true;
  }
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
