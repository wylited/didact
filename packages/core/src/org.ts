// org.ts — hand-written parser for the org-mode subset (docs/design.md
// §Org-subset grammar). The lesson stays a valid org-babel document in
// Emacs; this parser renders it in the browser.

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
    }
  | { kind: 'results'; name: string | null; canned: string };

/** A parsed lesson document (flat node list, document order). */
export type OrgDoc = OrgNode[];

/** A construct the subset parser/rendering does not support. */
export interface OrgDiagnostic {
  /** 1-based source line. */
  line: number;
  severity: 'warning' | 'error';
  message: string;
}

// #+TITLE: has a colon; #+BEGIN_SRC does not — make the colon optional.
const RE_DIRECTIVE = /^#\+([A-Za-z_]+):?(.*)$/;
const RE_END_SRC = /^\s*#\+END_SRC\s*$/i;
const RE_NUMBERED_LIST = /^\s*\d+[.)]\s/;
const RE_BLOCKQUOTE = /^\s*>\s?/;
const RE_MD_LINK = /\[[^\]\n]*\]\([^)\n]*\)/;
const RE_OUTPUT_LINE = /^\s*:/;

function normalizeKeyword(raw: string): string {
  return raw.split('_').map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase()).join('');
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

function parseDoc(src: string): OrgDoc {
  const nodes: OrgNode[] = [];
  const lines = src.split(/\r?\n/);
  let i = 0;
  let pendingName: string | null = null;
  let pendingCaption: string | null = null;

  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();
    if (t === '') { i++; continue; }

    if (t.startsWith('#')) {
      const dm = RE_DIRECTIVE.exec(t);
      if (dm === null) { i++; continue; } // plain '# comment' → hidden
      const kw = normalizeKeyword(dm[1]!);
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
          pendingName = body.split(/\s+/)[0] ?? null;
          i++;
          continue;
        // `#+CAPTION:` names the next src block's figure; org's convention is
        // to put it immediately before the block.
        case 'Caption':
          pendingCaption = body === '' ? null : body;
          i++;
          continue;
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
          nodes.push({
            kind: 'src',
            lang: lang || 'text',
            name: pendingName,
            caption: pendingCaption,
            headers, // babel headers parsed + ignored
            code: code.join('\n'),
          });
          pendingName = null;
          pendingCaption = null;
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
  let inSrc = false;
  let srcBeginLine = 0;
  let srcLang = 'text';
  let inResults = false;
  let pendingName: { name: string; line: number } | null = null;
  let seenTitle = false;

  const report = (line: number, severity: OrgDiagnostic['severity'], message: string): void => {
    diagnostics.push({ line, severity, message });
  };
  // parseDoc keeps a #+NAME: promise alive across blank lines, comments,
  // directives, headings, and paragraphs; it is lost only to another #+NAME:
  // (which overwrites it) or EOF. A src block fulfils it.
  const flushPendingName = (): void => {
    if (pendingName !== null) {
      report(pendingName.line, 'warning', `#+NAME: ${pendingName.name} is not followed by a source block`);
      pendingName = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
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
      const dm = RE_DIRECTIVE.exec(t);
      if (dm === null) continue; // plain '# comment' → intentionally hidden
      const kw = normalizeKeyword(dm[1]!);
      const body = dm[2]!.trim();
      switch (kw) {
        case 'Title':
          seenTitle = true;
          break;
        case 'Subtitle':
        case 'Caption':
          break;
        case 'BeginComment': {
          // Hidden comments are not rendered, so their body must not
          // produce diagnostics either.
          i++;
          while (i < lines.length && lines[i]!.trim().toUpperCase() !== '#+END_COMMENT') i++;
          break;
        }
        case 'Name':
          flushPendingName();
          pendingName = { name: body.split(/\s+/)[0] ?? '', line: lineNo };
          break;
        case 'BeginSrc': {
          pendingName = null; // promise fulfilled by this block
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
  flushPendingName();
  if (!seenTitle) report(1, 'warning', 'missing #+TITLE: line');

  // Stable sort keeps same-line diagnostics in rule order.
  diagnostics.sort((a, b) => a.line - b.line);
  return diagnostics;
}
