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
  | { kind: 'src'; lang: string; name: string | null; headers: string; code: string }
  | { kind: 'results'; name: string | null; canned: string };

/** A parsed lesson document (flat node list, document order). */
export type OrgDoc = OrgNode[];

// #+TITLE: has a colon; #+BEGIN_SRC does not — make the colon optional.
const RE_DIRECTIVE = /^#\+([A-Za-z_]+):?(.*)$/;
const RE_END_SRC = /^\s*#\+END_SRC\s*$/i;

export function parseOrg(src: string): OrgDoc {
  const nodes: OrgNode[] = [];
  const lines = src.split(/\r?\n/);
  let i = 0;
  let pendingName: string | null = null;

  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();
    if (t === '') { i++; continue; }

    if (t.startsWith('#')) {
      const dm = RE_DIRECTIVE.exec(t);
      if (dm === null) { i++; continue; } // plain '# comment' → hidden
      const kw = dm[1]!.split('_').map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase()).join('');
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
            headers, // babel headers parsed + ignored
            code: code.join('\n'),
          });
          pendingName = null;
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
