// org.ts — hand-written parser for the org-mode subset (docs/design.md
// §Org-subset grammar). The lesson stays a valid org-babel document in
// Emacs; this parser renders it in the browser.

import type { ExerciseSpec } from './teaching';

export type OrgNode =
  | { kind: 'title'; text: string }
  | { kind: 'subtitle'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | {
      kind: 'src';
      lang: string;
      name: string | null;
      caption: string | null;
      headers: string;
      code: string;
      /** Present when `#+EXERCISE:` precedes the block. */
      exercise: ExerciseSpec | null;
    }
  | { kind: 'results'; name: string | null; canned: string }
  | {
      kind: 'fold';
      /** `hint` and `solution` differ only in the summary label. */
      variant: 'hint' | 'solution';
      /** Fold body, parsed with this same parser (folds nest). */
      doc: OrgDoc;
    };

/** A parsed lesson document (document order; folds carry nested docs). */
export type OrgDoc = OrgNode[];

/** A construct the subset parser/rendering does not support. */
export interface OrgDiagnostic {
  /** 1-based source line. */
  line: number;
  severity: 'warning' | 'error';
  message: string;
}

// #+TITLE: has a colon; #+BEGIN_SRC does not — make the colon optional.
// Exported as the canonical directive grammar: the CLI (`didact check`)
// parses `#+` lines with exactly these two helpers so it cannot drift.
export const ORG_DIRECTIVE = /^#\+([A-Za-z_]+):?(.*)$/;
const RE_END_SRC = /^\s*#\+END_SRC\s*$/i;
const RE_NUMBERED_LIST = /^\s*\d+[.)]\s/;
const RE_BLOCKQUOTE = /^\s*>\s?/;
const RE_MD_LINK = /\[[^\]\n]*\]\([^)\n]*\)/;
const RE_OUTPUT_LINE = /^\s*:/;

export function normalizeOrgKeyword(raw: string): string {
  return raw
    .split('_')
    .filter((p) => p.length > 0)
    .map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase())
    .join('');
}

/** Parse a document, discarding diagnostics (byte-identical rendering). */
export function parseOrg(src: string): OrgDoc {
  return parseOrgChecked(src).doc;
}

/**
 * Parse a document and report unsupported constructs in document order.
 * Diagnostics never affect the produced doc.
 */
export function parseOrgChecked(src: string): { doc: OrgDoc; diagnostics: OrgDiagnostic[] } {
  return { doc: parseDoc(src), diagnostics: collectDiagnostics(src) };
}

/** Directives that promise something to the next src block. One scope per
 *  document body: a promise set before a fold reaches the first src block
 *  inside it in document order, but a promise created inside a fold never
 *  reaches a block outside it (see scopePromises). */
interface PendingPromises {
  name: string | null;
  caption: string | null;
  exercise: string | null;
  check: string | null;
}

function parseDoc(src: string): OrgDoc {
  return parseLines(src.split(/\r?\n/), {
    name: null,
    caption: null,
    exercise: null,
    check: null,
  });
}

/**
 * Fold bodies may consume an outer promise (the first src inside takes it)
 * but may not create or overwrite one: whatever changed while parsing the
 * fold body is discarded when it ends, so a promise inside a fold never
 * reaches a block outside it. Fields the body left untouched keep their
 * outer value.
 */
function scopePromises(pending: PendingPromises, outer: PendingPromises): void {
  pending.name = pending.name === outer.name ? outer.name : null;
  pending.caption = pending.caption === outer.caption ? outer.caption : null;
  pending.exercise = pending.exercise === outer.exercise ? outer.exercise : null;
  pending.check = pending.check === outer.check ? outer.check : null;
}

/** Index of the line closing the fold opened at `begin`, or `lines.length`
 *  when unterminated. Src and comment bodies are opaque (their lines are
 *  code/hidden text, not markers), and only markers of the same variant
 *  nest — a solution inside a hint cannot close it. */
function foldEnd(lines: string[], begin: number, variant: 'hint' | 'solution'): number {
  const beginKw = variant === 'hint' ? 'BeginHint' : 'BeginSolution';
  const endKw = variant === 'hint' ? 'EndHint' : 'EndSolution';
  let depth = 0;
  for (let i = begin + 1; i < lines.length; i++) {
    const dm = ORG_DIRECTIVE.exec(lines[i]!.trim());
    if (dm === null) continue;
    const kw = normalizeOrgKeyword(dm[1]!);
    if (kw === 'BeginSrc') {
      i++;
      while (i < lines.length && !RE_END_SRC.test(lines[i]!)) i++;
    } else if (kw === 'BeginComment') {
      i++;
      while (i < lines.length && lines[i]!.trim().toUpperCase() !== '#+END_COMMENT') i++;
    } else if (kw === beginKw) {
      depth++;
    } else if (kw === endKw) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return lines.length;
}

function parseLines(lines: string[], pending: PendingPromises): OrgDoc {
  const nodes: OrgNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();
    if (t === '') { i++; continue; }

    if (t.startsWith('#')) {
      const dm = ORG_DIRECTIVE.exec(t);
      if (dm === null) { i++; continue; } // plain '# comment' → hidden
      const kw = normalizeOrgKeyword(dm[1]!);
      const body = dm[2]!.trim();
      switch (kw) {
        case 'Title':
          nodes.push({ kind: 'title', text: body });
          i++;
          continue;
        case 'Subtitle':
          nodes.push({ kind: 'subtitle', text: body });
          i++;
          continue;
        case 'Name':
          pending.name = body === '' ? null : (body.split(/\s+/)[0] ?? null);
          i++;
          continue;
        // `#+CAPTION:` names the next src block's figure; org's convention is
        // to put it immediately before the block.
        case 'Caption':
          pending.caption = body === '' ? null : body;
          i++;
          continue;
        // `#+EXERCISE:`/`#+CHECK:` promise the next src block; they never
        // change its language or headers. Both promises clear at that block.
        case 'Exercise':
          pending.exercise = body === '' ? null : body;
          i++;
          continue;
        case 'Check':
          pending.check = body === '' ? null : body;
          i++;
          continue;
        case 'BeginHint':
        case 'BeginSolution': {
          const variant = kw === 'BeginHint' ? 'hint' : 'solution';
          const end = foldEnd(lines, i, variant);
          const outer = {
            name: pending.name,
            caption: pending.caption,
            exercise: pending.exercise,
            check: pending.check,
          };
          nodes.push({
            kind: 'fold',
            variant,
            doc: parseLines(lines.slice(i + 1, end), pending),
          });
          scopePromises(pending, outer);
          i = end < lines.length ? end + 1 : end;
          continue;
        }
        case 'BeginComment': {
          // org block comment: hide everything up to (and including) the
          // closing marker. No nesting; unterminated blocks run to EOF.
          i++;
          while (i < lines.length && lines[i]!.trim().toUpperCase() !== '#+END_COMMENT') i++;
          if (i < lines.length) i++; // consume #+END_COMMENT
          continue;
        }
        case 'BeginSrc': {
          const parts = body.split(/\s+/).filter(Boolean);
          const lang = (parts[0] ?? '').toLowerCase();
          const headers = parts.slice(1).join(' ');
          const code: string[] = [];
          i++;
          while (i < lines.length && !RE_END_SRC.test(lines[i]!)) {
            code.push(lines[i]!);
            i++;
          }
          if (i < lines.length) i++; // consume #+END_SRC
          const exercise = pending.exercise !== null || pending.check !== null
            ? { title: pending.exercise ?? 'Exercise', expected: pending.check }
            : null;
          nodes.push({
            kind: 'src',
            lang: lang || 'text',
            name: pending.name,
            caption: pending.caption,
            headers, // babel headers parsed + ignored
            code: code.join('\n'),
            exercise,
          });
          pending.name = null;
          pending.caption = null;
          pending.exercise = null;
          pending.check = null;
          continue;
        }
        case 'Results': {
          const name = body !== '' ? body.split(/\s+/)[0]! : null;
          const canned: string[] = [];
          let j = i + 1;
          while (j < lines.length) {
            const l = lines[j]!;
            if (/^\s*:/.test(l)) {
              canned.push(l.replace(/^\s*:\s?/, ''));
              j++;
            } else break;
          }
          nodes.push({ kind: 'results', name, canned: canned.join('\n') });
          i = j;
          continue;
        }
        default:
          i++; // #+END_SRC or an unrecognized keyword → ignore
          continue;
      }
    }

    const hm = /^(\*+)\s+(.*)$/.exec(t);
    if (hm !== null) {
      nodes.push({ kind: 'heading', level: hm[1]!.length, text: hm[2]!.trim() });
      i++;
      continue;
    }

    if (/^[-+]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const ct = cur.trim();
        if (/^[-+]\s+/.test(ct)) {
          items.push(ct.replace(/^[-+]\s+/, ''));
          i++;
        } else if (
          items.length > 0 && /^\s+\S/.test(cur) && ct !== ''
          && !ct.startsWith('#') && !/^(\*+)\s/.test(ct)
          && !/^[-+]\s+/.test(ct) && !ct.startsWith('|')
        ) {
          // indented continuation line: org appends it to the current item
          items[items.length - 1] += ' ' + ct;
          i++;
        } else break;
      }
      nodes.push({ kind: 'list', items });
      continue;
    }

    if (t.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        const row = lines[i]!.trim();
        if (!/^[-|+: ]+$/.test(row)) { // skip |---+---| separator rows
          rows.push(row.split('|').slice(1, -1).map((c) => c.trim()));
        }
        i++;
      }
      nodes.push({ kind: 'table', head: rows[0] ?? [], rows: rows.slice(1) });
      continue;
    }

    // paragraph: gather plain lines until a blank line or a special construct
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      const lt = l.trim();
      if (lt === '' || lt.startsWith('#') || /^(\*+)\s/.test(lt)
        || /^[-+]\s+/.test(lt) || lt.startsWith('|')) break;
      para.push(lt);
      i++;
    }
    nodes.push({ kind: 'para', text: para.join(' ') });
  }
  return nodes;
}

/**
 * Line-oriented scan for constructs the subset renderer cannot express.
 * Mirrors parseDoc's structure enough to know which lines are src code and
 * which belong to a #+RESULTS block; it never mutates the doc.
 */
function collectDiagnostics(src: string): OrgDiagnostic[] {
  const diagnostics: OrgDiagnostic[] = [];
  const lines = src.split(/\r?\n/);
  let pendingName: { name: string; line: number } | null = null;
  let pendingExercise: { title: string; line: number } | null = null;
  let pendingCheck: { text: string; line: number } | null = null;
  let seenTitle = false;

  const report = (line: number, severity: OrgDiagnostic['severity'], message: string): void => {
    diagnostics.push({ line, severity, message });
  };
  // parseDoc keeps a #+NAME: promise alive across blank lines, comments,
  // directives, headings, and paragraphs; it is lost only to another #+NAME:
  // (which overwrites it), the end of a fold body that created it, or EOF.
  // A src block fulfils it.
  const flushPendingName = (): void => {
    if (pendingName !== null) {
      report(pendingName.line, 'warning', `#+NAME: ${pendingName.name} is not followed by a source block`);
      pendingName = null;
    }
  };
  // #+EXERCISE:/#+CHECK: have the same lifetime; both are fulfilled by the
  // same src block. A #+CHECK: without #+EXERCISE: still attaches (the title
  // falls back to "Exercise"), so it is fulfilled, not lost, when consumed.
  const flushPendingExercise = (): void => {
    if (pendingExercise !== null) {
      report(
        pendingExercise.line,
        'warning',
        `#+EXERCISE: ${pendingExercise.title} is not followed by a source block`,
      );
      pendingExercise = null;
    }
  };
  const flushPendingCheck = (): void => {
    if (pendingCheck !== null) {
      report(
        pendingCheck.line,
        'warning',
        `#+CHECK: ${pendingCheck.text} is not followed by a source block`,
      );
      pendingCheck = null;
    }
  };

  // Scan one document region [from, to); fold bodies recurse with their own
  // src/results state and their own promise scope, like parseLines.
  const scan = (from: number, to: number): void => {
    let inSrc = false;
    let srcBeginLine = 0;
    let srcLang = 'text';
    let inResults = false;

    for (let i = from; i < to; i++) {
      const line = lines[i]!;
      const lineNo = i + 1;

      if (inSrc) {
        if (RE_END_SRC.test(line)) inSrc = false;
        continue; // no diagnostics inside source code
      }

      if (inResults) {
        if (RE_OUTPUT_LINE.test(line)) continue;
        inResults = false;
      }

      const t = line.trim();
      if (t === '') continue;

      if (t.startsWith('#')) {
        const dm = ORG_DIRECTIVE.exec(t);
        if (dm === null) continue; // plain '# comment' → intentionally hidden
        const kw = normalizeOrgKeyword(dm[1]!);
        const body = dm[2]!.trim();
        switch (kw) {
          case 'Title':
            seenTitle = true;
            break;
          case 'Subtitle':
          case 'Caption':
          case 'EndHint':
          case 'EndSolution':
            break;
          case 'Exercise':
            flushPendingExercise();
            if (body !== '') pendingExercise = { title: body, line: lineNo };
            break;
          case 'Check':
            flushPendingCheck();
            if (body !== '') pendingCheck = { text: body, line: lineNo };
            break;
          case 'BeginHint':
          case 'BeginSolution': {
            // Fold bodies are rendered (inside <details>), so recurse at the
            // same absolute line numbers; an unterminated fold ends at EOF.
            const variant = kw === 'BeginHint' ? 'hint' : 'solution';
            const end = foldEnd(lines, i, variant);
            // Promises are per-body exactly like parseDoc: the body may
            // consume an outer one, but whatever it creates or overwrites
            // dies with the fold and is reported as lost here.
            const outer = {
              name: pendingName,
              exercise: pendingExercise,
              check: pendingCheck,
            };
            scan(i + 1, Math.min(end, to));
            if (pendingName !== outer.name) flushPendingName();
            if (pendingExercise !== outer.exercise) flushPendingExercise();
            if (pendingCheck !== outer.check) flushPendingCheck();
            // Resume past the END marker, or stop at this region's boundary
            // when the fold runs past the body it was opened in.
            i = end < to ? end : to;
            break;
          }
          case 'BeginComment': {
            // Hidden comments are not rendered, so their body must not
            // produce diagnostics either.
            i++;
            while (i < lines.length && lines[i]!.trim().toUpperCase() !== '#+END_COMMENT') i++;
            break;
          }
          case 'Name':
            flushPendingName();
            if (body !== '') pendingName = { name: body.split(/\s+/)[0]!, line: lineNo };
            break;
          case 'BeginSrc': {
            // Promises are fulfilled by this block (whatever their kind).
            pendingName = null;
            pendingExercise = null;
            pendingCheck = null;
            const lang = (body.split(/\s+/).filter(Boolean)[0] ?? '').toLowerCase();
            inSrc = true;
            srcBeginLine = lineNo;
            srcLang = lang || 'text';
            break;
          }
          case 'EndSrc':
            report(lineNo, 'error', '#+END_SRC without #+BEGIN_SRC');
            break;
          case 'Results':
            inResults = true;
            break;
          default:
            report(lineNo, 'warning', `unsupported directive #+${dm[1]} — dropped by the renderer`);
            break;
        }
        continue;
      }

      // Headings, lists, tables, and paragraphs do not lose a pending #+NAME
      // promise (parseDoc keeps it until a src block, another #+NAME, or EOF).
      if (RE_NUMBERED_LIST.test(line)) report(lineNo, 'warning', 'numbered lists are not rendered; use "- "');
      if (RE_BLOCKQUOTE.test(line)) report(lineNo, 'warning', 'blockquotes are not rendered');
      if (RE_MD_LINK.test(line)) report(lineNo, 'warning', 'Markdown links are not supported; use [[url][label]]');
      if (RE_OUTPUT_LINE.test(line)) {
        report(lineNo, 'warning', '":" output line outside a #+RESULTS block is rendered as prose');
      }
    }

    if (inSrc) report(srcBeginLine, 'error', `unclosed #+BEGIN_SRC (${srcLang})`);
  };

  scan(0, lines.length);
  flushPendingName();
  flushPendingExercise();
  flushPendingCheck();
  if (!seenTitle) report(1, 'warning', 'missing #+TITLE: line');

  // Stable sort keeps same-line diagnostics in rule order.
  diagnostics.sort((a, b) => a.line - b.line);
  return diagnostics;
}
