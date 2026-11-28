// site-search.ts — lesson search indexing, snippet extraction, and results
// rendering for the navigator rail.

import type { OrgDoc } from './org';
import type { PageSpec } from './pages';
import { sectionSlugger } from './site-index';

/** One search hit: a page or section, with its own title and prose. */
export interface SearchChunk {
  /** Fragment href: `#/<page-slug>` or `#/<page-slug>/<section-slug>`. */
  href: string;
  title: string;
  text: string;
}

export const SEARCH_RESULT_LIMIT = 10;

/** Flatten one page into searchable chunks: the page intro (title plus
 *  prose before the first heading), then one chunk per h2/h3. Folds are
 *  walked in place — their headings open sections and their prose joins
 *  the surrounding chunk. Heading text comes through the real inline
 *  renderer (the TOC's text), and section slugs come from the same
 *  slugger, so a result URL always resolves. */
export function searchChunksForPage(
  page: PageSpec,
  doc: OrgDoc,
  slug: string,
  headingText: (text: string) => string,
): SearchChunk[] {
  const nextSlug = sectionSlugger();
  let headingIndex = 0;
  const chunks: SearchChunk[] = [];
  let current: SearchChunk = { href: `#/${slug}`, title: page.title, text: page.title };
  chunks.push(current);
  const append = (text: string): void => {
    const clean = text.trim();
    if (clean !== '') current.text = `${current.text} ${clean}`;
  };
  const visit = (nodes: OrgDoc): void => {
    for (const node of nodes) {
      switch (node.kind) {
        case 'heading':
          if (node.level <= 2) {
            const title = headingText(node.text).trim();
            const section = nextSlug(title, headingIndex++);
            current = { href: `#/${slug}/${section}`, title, text: title };
            chunks.push(current);
          } else {
            append(node.text);
          }
          break;
        case 'para':
          append(node.text);
          break;
        case 'list':
          for (const item of node.items) append(item);
          break;
        case 'table':
          for (const cell of node.head) append(cell);
          for (const row of node.rows) for (const cell of row) append(cell);
          break;
        case 'src':
          // code is searchable too (including examples inside hints)
          append(node.code);
          break;
        case 'fold':
          visit(node.doc);
          break;
        default:
          break; // title/subtitle/results carry no searchable prose
      }
    }
  };
  visit(doc);
  return chunks;
}

/** A one-line snippet around the first token match, never over 140
 *  characters (ellipses count). */
export function searchSnippet(text: string, token: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 140) return clean;
  const at = clean.toLowerCase().indexOf(token.toLowerCase());
  const start = at <= 60 ? 0 : at - 60;
  let out = clean.slice(start, start + 140);
  if (start > 0) out = `…${out.slice(1)}`;
  if (start + 140 < clean.length) out = `${out.slice(0, 139)}…`;
  return out;
}

/** Paint search results into `resultsEl`; returns true when a live search
 *  (≥2 trimmed characters) owns the rail. Every entry is built with
 *  textContent so org prose can never inject markup. */
export function renderSearchResults(
  queryRaw: string,
  index: readonly SearchChunk[],
  resultsEl: HTMLElement,
  doc: Document,
  onSelect: (href: string, event: MouseEvent) => void,
): boolean {
  const query = queryRaw.trim();
  if (query.length < 2) {
    resultsEl.replaceChildren();
    resultsEl.hidden = true;
    return false;
  }
  const tokens = query.toLowerCase().split(/\s+/).filter((token) => token !== '');
  const found: SearchChunk[] = [];
  for (const chunk of index) {
    const haystack = `${chunk.title} ${chunk.text}`.toLowerCase();
    if (!tokens.every((token) => haystack.includes(token))) continue;
    found.push(chunk);
    if (found.length === SEARCH_RESULT_LIMIT) break;
  }
  if (found.length === 0) {
    const empty = doc.createElement('p');
    empty.className = 'lw-search-empty';
    empty.dataset.test = 'search-empty';
    empty.textContent = 'No lessons match';
    resultsEl.replaceChildren(empty);
  } else {
    const firstToken = tokens[0]!;
    resultsEl.replaceChildren(
      ...found.map((chunk) => {
        const link = doc.createElement('a');
        link.className = 'lw-search-result';
        link.href = chunk.href;
        const title = doc.createElement('span');
        title.className = 'lw-search-result-title';
        title.textContent = chunk.title;
        const snippet = doc.createElement('span');
        snippet.className = 'lw-search-result-snippet';
        snippet.textContent = searchSnippet(chunk.text, firstToken);
        link.append(title, snippet);
        link.addEventListener('click', (event) => onSelect(chunk.href, event));
        return link;
      }),
    );
  }
  resultsEl.hidden = false;
  return true;
}
