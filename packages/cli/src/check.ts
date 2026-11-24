// check.ts — `didact check`: lesson linting and RESULTS verification.
//
// Generalizes scripts/lint_lessons.py and scripts/verify_lessons.py from a
// page tree: syntax diagnostics come from core's parseOrgChecked, and
// `--run` executes each block in a fresh interpreter via a BlockRunner.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOrgChecked } from '@didact/core';

export interface CheckDiagnostic {
  file: string;
  page: string;
  line: number;
  severity: 'warning' | 'error';
  message: string;
}

export interface BlockCheck {
  file: string;
  page: string;
  line: number;
  lang: string;
  name: string | null;
  status: 'ok' | 'mismatch' | 'error' | 'skipped';
  detail?: string;
}

export interface RunnerOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export type BlockRunner = (block: {
  file: string;
  page: string;
  line: number;
  lang: string;
  session: string | null;
  code: string;
}) => Promise<RunnerOutput | null>;

export interface CheckOptions {
  pagesDir: string;
  pages?: string[];
  run?: boolean;
  runner?: BlockRunner;
}

export interface CheckReport {
  pages: number;
  diagnostics: CheckDiagnostic[];
  blocks: BlockCheck[];
}

interface ScannedBlock {
  line: number;
  lang: string;
  name: string | null;
  session: string | null;
  code: string;
  canned: string | null;
}

const RE_BEGIN_SRC = /^#\+BEGIN_SRC(?:\s+(.*))?$/i;
const RE_END_SRC = /^#\+END_SRC\s*$/i;
const RE_RESULTS = /^#\+RESULTS\b:?/i;
const RE_OUTPUT_LINE = /^\s*:\s?(.*)$/;
const RE_NAME = /^#\+NAME:\s*(\S+)/i;
const RE_SESSION = /(?:^|\s):session\s+(\S+)/i;
const TIMEOUT_MS = 30_000;
const STDERR_EXCERPT = 2_000;

/** Strip trailing newlines only (Python str.rstrip("\n")). */
function rstripNl(text: string): string {
  return text.replace(/\n+$/, '');
}

interface ResultsOccurrence {
  name: string | null;
  canned: string;
  /** Index of the nearest preceding scanned block, or -1 when none. */
  preceding: number;
}

/**
 * Scan #+NAME, #+BEGIN_SRC/#+END_SRC, and #+RESULTS blocks in document order.
 * The language defaults to `text` when the header is empty. Text inside a
 * source block is code even if it spells #+BEGIN_SRC or #+RESULTS.
 *
 * RESULTS blocks are paired afterwards: a named `#+RESULTS: <name>` targets
 * the first preceding block with that #+NAME (falling back to the nearest
 * preceding block); an unnamed block targets the nearest preceding block.
 * Blank lines and comment lines between a block and its results are ignored,
 * and each results block is attached to at most one block.
 */
function scanBlocks(src: string): ScannedBlock[] {
  const lines = src.split(/\r?\n/);
  const blocks: ScannedBlock[] = [];
  const results: ResultsOccurrence[] = [];
  let pendingName: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i]!.trim();
    if (stripped === '') continue;

    const nameMatch = RE_NAME.exec(stripped);
    if (nameMatch !== null) {
      pendingName = nameMatch[1]!;
      continue;
    }

    const resultsMatch = RE_RESULTS.exec(stripped);
    if (resultsMatch !== null) {
      pendingName = null;
      const tail = stripped.slice(resultsMatch[0].length).trim();
      const name = tail === '' ? null : tail.split(/\s+/)[0]!;
      const out: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const m = RE_OUTPUT_LINE.exec(lines[j]!);
        if (m === null) break;
        out.push(m[1]!);
        j++;
      }
      results.push({ name, canned: out.join('\n'), preceding: blocks.length - 1 });
      i = j - 1; // continue after the consumed RESULTS block
      continue;
    }

    const beginMatch = RE_BEGIN_SRC.exec(stripped);
    if (beginMatch === null) {
      pendingName = null;
      continue;
    }

    const line = i + 2; // first code line (1-based)
    const tokens = (beginMatch[1] ?? '').trim().split(/\s+/).filter(Boolean);
    const lang = (tokens.shift() ?? 'text').toLowerCase();
    const header = tokens.join(' ');
    const sessionMatch = RE_SESSION.exec(header);
    const session = sessionMatch === null ? null : sessionMatch[1]!;
    const name = pendingName;
    pendingName = null;
    const code: string[] = [];

    i++;
    while (i < lines.length && !RE_END_SRC.test(lines[i]!.trim())) {
      code.push(lines[i]!);
      i++;
    }

    blocks.push({ line, lang, name, session, code: code.join('\n'), canned: null });
  }

  for (const result of results) {
    let target = -1;
    if (result.name !== null) {
      for (let b = 0; b <= result.preceding; b++) {
        if (blocks[b]!.name === result.name) {
          target = b;
          break;
        }
      }
    }
    if (target === -1) target = result.preceding;
    if (target < 0) continue;
    const block = blocks[target]!;
    if (block.canned === null) block.canned = result.canned;
  }

  return blocks;
}

export async function checkPages(opts: CheckOptions): Promise<CheckReport> {
  const wanted = opts.pages === undefined ? null : new Set(opts.pages);
  const files = readdirSync(opts.pagesDir)
    .filter((name) => name.endsWith('.org'))
    .filter((name) => wanted === null || wanted.has(name.slice(0, -'.org'.length)))
    .sort();

  if (files.length === 0) throw new Error('no pages matched');

  const run = opts.run === true;
  const runner: BlockRunner | null = run ? (opts.runner ?? pythonRunner()) : null;
  const diagnostics: CheckDiagnostic[] = [];
  const blocks: BlockCheck[] = [];

  for (const file of files) {
    const page = file.slice(0, -'.org'.length);
    const src = readFileSync(join(opts.pagesDir, file), 'utf8');

    const parsed = parseOrgChecked(src);
    for (const d of parsed.diagnostics) {
      diagnostics.push({ file, page, line: d.line, severity: d.severity, message: d.message });
    }

    for (const block of scanBlocks(src)) {
      const base = { file, page, line: block.line, lang: block.lang, name: block.name };
      if (runner === null) {
        blocks.push({ ...base, status: 'skipped' });
        continue;
      }
      if (block.session !== null) {
        blocks.push({
          ...base,
          status: 'skipped',
          detail: `:session ${block.session} blocks are not verified by --run (shared state); run them in the browser`,
        });
        continue;
      }
      try {
        const result = await runner({
          file,
          page,
          line: block.line,
          lang: block.lang,
          session: block.session,
          code: block.code,
        });
        if (result === null) {
          blocks.push({ ...base, status: 'skipped' });
        } else if (result.code !== 0) {
          blocks.push({
            ...base,
            status: 'error',
            detail: `exit ${result.code}\n${
              result.stderr.trim().length > STDERR_EXCERPT
                ? `${result.stderr.trim().slice(0, STDERR_EXCERPT)}\n…`
                : result.stderr.trim()
            }`,
          });
        } else if (
          block.canned !== null &&
          rstripNl(result.stdout) !== rstripNl(block.canned)
        ) {
          blocks.push({
            ...base,
            status: 'mismatch',
            detail: ['output mismatch', '--- canned #+RESULTS', '+++ actual stdout']
              .concat(rstripNl(block.canned).split('\n').map((line) => `-${line}`))
              .concat(rstripNl(result.stdout).split('\n').map((line) => `+${line}`))
              .join('\n'),
          });
        } else {
          blocks.push({ ...base, status: 'ok' });
        }
      } catch (err) {
        blocks.push({
          ...base,
          status: 'error',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { pages: files.length, diagnostics, blocks };
}

/** Run Python blocks in a fresh interpreter; other languages are skipped. */
export function pythonRunner(python = 'python3'): BlockRunner {
  return async (block) => {
    if (block.lang.toLowerCase() !== 'python') return null;
    if (block.code.includes('input(')) {
      throw new Error('block calls input(); there is no stdin');
    }

    const dir = mkdtempSync(join(tmpdir(), 'didact-check-'));
    try {
      const file = join(dir, 'block.py');
      writeFileSync(file, `${block.code}\n`);
      const result = spawnSync(python, [file], {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      let stderr = String(result.stderr ?? '');
      if (result.error !== undefined) {
        stderr = stderr === '' ? result.error.message : `${stderr}\n${result.error.message}`;
      }
      return {
        code: result.status ?? 1,
        stdout: String(result.stdout ?? ''),
        stderr,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
