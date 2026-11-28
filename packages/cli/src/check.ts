// check.ts — `didact check`: lesson linting and RESULTS/CHECK verification.
//
// Syntax diagnostics come from core's parseOrgChecked; `--run` executes each
// block in a fresh interpreter via a BlockRunner and compares stdout against
// canned `#+RESULTS` and `#+CHECK` expectations.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBabelHeaders } from '@didact/core/babel';
import { normalizeOrgKeyword, ORG_DIRECTIVE, parseOrgChecked } from '@didact/core/org';

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
  exercise: { title: string; expected: string | null } | null;
}

// Directive keywords, languages, markers, and babel headers are parsed with
// core's ORG_DIRECTIVE/normalizeOrgKeyword/parseBabelHeaders (imported above)
// so the checker cannot drift from the renderer's grammar. Only the src-end
// and output-line forms are local; both match core's.
const RE_END_SRC = /^\s*#\+END_SRC\s*$/i;
const RE_OUTPUT_LINE = /^\s*:\s?(.*)$/;
const TIMEOUT_MS = 30_000;
const STDERR_EXCERPT = 2_000;

type FoldVariant = 'hint' | 'solution';

/** Promise fields scoped to the current document region, like core parseDoc. */
interface PendingPromises {
  name: string | null;
  exercise: string | null;
  check: string | null;
}

/**
 * Index of the line closing the fold opened at `begin`, or `limit` when it is
 * unterminated inside [begin, limit). Src and comment bodies are opaque, and
 * only markers of the same variant nest — a solution inside a hint cannot
 * close it. Mirrors core's `foldEnd`, bounded by the enclosing region so a
 * nested fold cannot close using a marker outside its parent body.
 */
function foldEnd(lines: string[], begin: number, variant: FoldVariant, limit: number): number {
  const beginKw = variant === 'hint' ? 'BeginHint' : 'BeginSolution';
  const endKw = variant === 'hint' ? 'EndHint' : 'EndSolution';
  let depth = 0;
  for (let i = begin + 1; i < limit; i++) {
    const dm = ORG_DIRECTIVE.exec(lines[i]!.trim());
    if (dm === null) continue;
    const kw = normalizeOrgKeyword(dm[1]!);
    if (kw === 'BeginSrc') {
      i++;
      while (i < limit && !RE_END_SRC.test(lines[i]!.trim())) i++;
    } else if (kw === 'BeginComment') {
      i++;
      while (i < limit && lines[i]!.trim().toUpperCase() !== '#+END_COMMENT') i++;
    } else if (kw === beginKw) {
      depth++;
    } else if (kw === endKw) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return limit;
}

/** Strip trailing newlines only (Python str.rstrip("\n")). */
function rstripNl(text: string): string {
  return text.replace(/\n+$/, '');
}

/** Normalize console output for `#+CHECK` comparison: CRLF becomes LF,
 *  trailing whitespace is insignificant on every line, and trailing
 *  newlines are ignored (the same rules the browser exercise runtime uses). */
function normalizeCheckOutput(text: string): string {
  return rstripNl(
    text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n'),
  );
}

/** One `--- expected` / `+++ actual` section for a mismatch detail. */
function diffSection(label: string, expected: string, actual: string): string[] {
  return [`--- ${label}`, '+++ actual stdout']
    .concat(expected.split('\n').map((line) => `-${line}`))
    .concat(actual.split('\n').map((line) => `+${line}`));
}

interface ResultsOccurrence {
  name: string | null;
  canned: string;
  /** Index of the nearest preceding scanned block, or -1 when none. */
  preceding: number;
}

/**
 * Scan #+NAME, #+EXERCISE, #+CHECK, #+BEGIN_SRC/#+END_SRC, and #+RESULTS
 * blocks in document order. The language defaults to `text` when the header
 * is empty. Text inside a source block is code even if it spells
 * #+BEGIN_SRC or #+RESULTS. A `#+BEGIN_COMMENT` region is hidden text, not
 * code: it is skipped case-insensitively (an unterminated region runs to
 * EOF), so nothing in it is reported or run.
 *
 * `#+EXERCISE:` and `#+CHECK:` are promises to the next source block, just
 * like `#+NAME:`: a later directive of the same kind overwrites the
 * promise, and a source block consumes all of them. Promises are scoped to
 * the document region that created them, like core's parseDoc: a src block
 * inside a `#+BEGIN_HINT`/`#+BEGIN_SOLUTION` fold may consume an outer
 * promise, but a promise created or overwritten inside the fold dies at the
 * `#+END_*` marker, so it never reaches a block outside. A comment region
 * leaves the surrounding promises untouched (nothing inside can create
 * one). A `#+CHECK:` without `#+EXERCISE:` still attaches, with the default
 * title `Exercise`; an exercise without a check has `expected: null`.
 *
 * RESULTS blocks are paired afterwards: a named `#+RESULTS: <name>` targets
 * the first preceding block with that #+NAME, and is dropped when no
 * preceding block carries the name (it never falls back to the nearest
 * block); an unnamed block targets the nearest preceding block.
 * Blank lines and comment lines between a block and its results are ignored,
 * and each results block is attached to at most one block.
 */
function scanBlocks(src: string): ScannedBlock[] {
  const lines = src.split(/\r?\n/);
  const blocks: ScannedBlock[] = [];
  const results: ResultsOccurrence[] = [];
  const pending: PendingPromises = { name: null, exercise: null, check: null };

  // Scan one document region [from, to). Fold bodies recurse with their own
  // src/results state and promise scope, exactly like core's parseLines.
  const scan = (from: number, to: number): void => {
    let i = from;
    while (i < to) {
      const stripped = lines[i]!.trim();
      if (stripped === '') {
        i++;
        continue;
      }

      const dm = ORG_DIRECTIVE.exec(stripped);
      if (dm === null) {
        i++;
        continue;
      }
      const kw = normalizeOrgKeyword(dm[1]!);
      const body = dm[2]!.trim();

      // Hidden code is not code: skip the whole comment region, including an
      // unterminated one. Pending promises survive untouched, and nothing in
      // the body can create one. Comment markers inside a src block are
      // consumed by the src loop below and never reach this check. As in
      // core, only the exact `#+END_COMMENT` line (trimmed, upper-cased)
      // closes the region: `#+END_COMMENT: note` does not.
      if (kw === 'BeginComment') {
        i++;
        // Bounded by the region, like core's sliced fold body: a comment
        // opened inside a fold stops at the fold's end marker.
        while (i < to && lines[i]!.trim().toUpperCase() !== '#+END_COMMENT') i++;
        if (i < to) i++; // consume #+END_COMMENT
        continue;
      }

      // Fold bodies are rendered, so they are scanned like the outer
      // document with one extra rule: whatever promise the body changes is
      // discarded when the fold ends (core's scopePromises). An outer
      // promise consumed inside therefore stays consumed.
      if (kw === 'BeginHint' || kw === 'BeginSolution') {
        const variant: FoldVariant = kw === 'BeginHint' ? 'hint' : 'solution';
        const end = foldEnd(lines, i, variant, to);
        const outer: PendingPromises = { ...pending };
        scan(i + 1, end);
        if (pending.name !== outer.name) pending.name = null;
        if (pending.exercise !== outer.exercise) pending.exercise = null;
        if (pending.check !== outer.check) pending.check = null;
        i = end < to ? end + 1 : to; // resume past #+END_* (or at the region end)
        continue;
      }

      if (kw === 'Name') {
        pending.name = body.split(/\s+/)[0] ?? null;
        i++;
        continue;
      }

      if (kw === 'Exercise') {
        pending.exercise = body === '' ? null : body;
        i++;
        continue;
      }

      if (kw === 'Check') {
        pending.check = body === '' ? null : body;
        i++;
        continue;
      }

      if (kw === 'Results') {
        const name = body === '' ? null : body.split(/\s+/)[0]!;
        const out: string[] = [];
        let j = i + 1;
        while (j < to) {
          const m = RE_OUTPUT_LINE.exec(lines[j]!);
          if (m === null) break;
          out.push(m[1]!);
          j++;
        }
        results.push({ name, canned: out.join('\n'), preceding: blocks.length - 1 });
        i = j; // continue after the consumed RESULTS block
        continue;
      }

      if (kw !== 'BeginSrc') {
        i++;
        continue;
      }

      const line = i + 2; // first code line (1-based)
      const tokens = body.split(/\s+/).filter(Boolean);
      const lang = (tokens.shift() ?? 'text').toLowerCase();
      const header = tokens.join(' ');
      const session = parseBabelHeaders(header).session ?? null;
      const name = pending.name;
      const exercise =
        pending.exercise === null && pending.check === null
          ? null
          : { title: pending.exercise ?? 'Exercise', expected: pending.check };
      pending.name = null;
      pending.exercise = null;
      pending.check = null;
      const code: string[] = [];

      i++;
      while (i < to && !RE_END_SRC.test(lines[i]!.trim())) {
        code.push(lines[i]!);
        i++;
      }
      if (i < to) i++; // consume #+END_SRC

      blocks.push({ line, lang, name, session, code: code.join('\n'), canned: null, exercise });
    }
  };

  scan(0, lines.length);

  for (const result of results) {
    let target = result.preceding;
    if (result.name !== null) {
      // Strict pairing, like render.ts: a named RESULTS block belongs only
      // to a block with that #+NAME, never to the nearest preceding one.
      target = -1;
      for (let b = 0; b <= result.preceding; b++) {
        if (blocks[b]!.name === result.name) {
          target = b;
          break;
        }
      }
    }
    if (target < 0) continue;
    const block = blocks[target]!;
    if (block.canned === null) block.canned = result.canned;
  }

  return blocks;
}

export async function checkPages(opts: CheckOptions): Promise<CheckReport> {
  const allFiles = readdirSync(opts.pagesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.org'))
    .map((entry) => entry.name)
    .sort();

  let files: string[];
  if (opts.pages === undefined) {
    files = allFiles;
  } else {
    const available = new Set(allFiles.map((name) => name.slice(0, -'.org'.length)));
    const wanted = new Set(opts.pages);
    const missing = [...wanted].filter((stem) => !available.has(stem));
    if (missing.length > 0) {
      const label = missing.length === 1 ? 'page not found' : 'pages not found';
      throw new Error(`${label}: ${missing.join(', ')}`);
    }
    files = allFiles.filter((name) => wanted.has(name.slice(0, -'.org'.length)));
  }

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
      const expectedCheck = block.exercise?.expected ?? null;
      // An unchecked drill is not a reason to execute a block: without
      // canned output or a #+CHECK there is nothing to verify.
      if (expectedCheck === null && block.canned === null && block.exercise !== null) {
        blocks.push({ ...base, status: 'skipped' });
        continue;
      }
      try {
        const result = await runner({
          file,
          page,
          line: block.line,
          lang: block.lang,
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
        } else {
          const actualResults = rstripNl(result.stdout);
          const resultsOk =
            block.canned === null
              ? null
              : actualResults === rstripNl(block.canned);
          const actualCheck = normalizeCheckOutput(result.stdout);
          const checkOk =
            expectedCheck === null
              ? null
              : actualCheck === normalizeCheckOutput(expectedCheck);
          if (resultsOk === false || checkOk === false) {
            const failed: string[] = [];
            if (resultsOk === false) failed.push('canned #+RESULTS');
            if (checkOk === false) failed.push('#+CHECK');
            const detail = ['output mismatch', `failed: ${failed.join(', ')}`];
            if (resultsOk === false) {
              detail.push(
                ...diffSection('canned #+RESULTS', rstripNl(block.canned!), actualResults),
              );
            }
            if (checkOk === false) {
              detail.push(
                ...diffSection(
                  'expected #+CHECK',
                  normalizeCheckOutput(expectedCheck!),
                  actualCheck,
                ),
              );
            }
            blocks.push({ ...base, status: 'mismatch', detail: detail.join('\n') });
          } else {
            blocks.push({ ...base, status: 'ok' });
          }
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
