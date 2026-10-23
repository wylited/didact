// Org-subset parser for the literate lesson document (grammar from
// docs/design.md). Hand-written, no dependencies; the authored lesson stays
// valid org-babel source in Emacs.

export interface SrcNode {
  kind: 'src';
  lang: string;
  headers: string[];
  code: string;
  name: string | null;
  /** Canned `#+RESULTS:` content following the block, if any. */
  results: string | null;
}

export type OrgNode =
  | { kind: 'title'; text: string }
  | { kind: 'subtitle'; text: string }
  | { kind: 'heading'; depth: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | SrcNode
  | { kind: 'example'; lines: string[] }
  | { kind: 'results'; lines: string[] };

export interface OrgDoc {
  title: string | null;
  subtitle: string | null;
  nodes: OrgNode[];
}

const RE_HEADING = /^(\*+)\s+(.*)$/;
const RE_DIRECTIVE = /^#\+([A-Za-z_-]+):?\s*(.*)$/;
const RE_LIST_ITEM = /^[-+]\s+(.*)$/;
const RE_COLON_LINE = /^:(?:\s?(.*))?$/;

function splitTableRow(raw: string): string[] {
  let body = raw.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body.split('|').map((c) => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c) && c.length > 0);
}

export function parseOrg(text: string): OrgDoc {
  const lines = text.split(/\r?\n/);
  const nodes: OrgNode[] = [];
  let title: string | null = null;
  let subtitle: string | null = null;
  let pendingName: string | null = null;
  let resultsMode = false;
  let resultsBuf: string[] = [];

  let para: string[] = [];
  let list: string[] = [];
  let table: string[][] = [];

  const flushPara = (): void => {
    if (para.length === 0) return;
    nodes.push({ kind: 'paragraph', text: para.join('\n') });
    para = [];
  };
  const flushList = (): void => {
    if (list.length === 0) return;
    nodes.push({ kind: 'list', items: list });
    list = [];
  };
  const flushTable = (): void => {
    if (table.length === 0) return;
    const rows = table;
    table = [];
    if (isSeparatorRow(rows[0])) rows.shift();
    if (rows.length === 0) return;
    const header = rows[0];
    nodes.push({ kind: 'table', header, rows: rows.slice(1) });
  };
  const flushAll = (): void => {
    flushPara();
    flushList();
    flushTable();
  };
  const flushResults = (): void => {
    if (resultsBuf.length > 0) nodes.push({ kind: 'results', lines: resultsBuf });
    resultsBuf = [];
    resultsMode = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (line.length === 0) {
      if (resultsMode) flushResults();
      flushAll();
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      flushResults();
      flushAll();
      nodes.push({ kind: 'heading', depth: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const directive = RE_DIRECTIVE.exec(line);
    if (directive) {
      const key = directive[1].toUpperCase();
      const value = directive[2].trim();
      if (key === 'TITLE') {
        if (title === null) title = value;
        continue;
      }
      if (key === 'SUBTITLE') {
        if (subtitle === null) subtitle = value;
        continue;
      }
      if (key === 'NAME') {
        pendingName = value.split(/\s+/)[0] || null;
        continue;
      }
      if (key === 'RESULTS') {
        flushAll();
        resultsMode = true;
        resultsBuf = [];
        continue;
      }
      if (key === 'BEGIN_SRC') {
        flushResults();
        flushAll();
        const parts = value.split(/\s+/).filter((p) => p.length > 0);
        const lang = (parts[0] ?? '').toLowerCase();
        const headers = parts.slice(1);
        const body: string[] = [];
        i++;
        while (i < lines.length && !/^\s*#\+END_SRC\s*$/i.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        nodes.push({ kind: 'src', lang, headers, code: body.join('\n'), name: pendingName, results: null });
        pendingName = null;
        continue;
      }
      if (key === 'BEGIN_EXAMPLE') {
        const body: string[] = [];
        i++;
        while (i < lines.length && !/^\s*#\+END_EXAMPLE\s*$/i.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        if (resultsMode) {
          resultsBuf.push(...body);
        } else {
          flushAll();
          nodes.push({ kind: 'example', lines: body });
        }
        continue;
      }
      // Unknown #+directive: parsed (so the file stays valid org) and ignored.
      continue;
    }

    // `#` comment (not `#+`): hidden.
    if (line.startsWith('#')) continue;

    const colon = RE_COLON_LINE.exec(raw.trim());
    if (colon && resultsMode) {
      resultsBuf.push(colon[1] ?? '');
      continue;
    }

    const item = RE_LIST_ITEM.exec(line);
    if (item) {
      flushPara();
      flushTable();
      list.push(item[1].trim());
      continue;
    }
    if (list.length > 0 && /^\s/.test(raw)) {
      // indented continuation of the previous item
      list[list.length - 1] += ' ' + line;
      continue;
    }

    if (line.startsWith('|')) {
      flushPara();
      flushList();
      const cells = splitTableRow(line);
      if (!isSeparatorRow(cells)) table.push(cells);
      continue;
    }

    flushList();
    flushTable();
    if (resultsMode) flushResults();
    para.push(line);
  }

  if (resultsMode) flushResults();
  flushAll();

  // Attach a results node to the src block it follows.
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.kind !== 'src') continue;
    const next = nodes[i + 1];
    if (next && next.kind === 'results') {
      node.results = next.lines.join('\n');
      nodes.splice(i + 1, 1);
    }
  }

  return { title, subtitle, nodes };
}
