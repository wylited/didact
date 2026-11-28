// site-index.ts — page & section slugging, mode-independent heading text
// extraction, stable block-id assignment, and cross-page org link resolution.

import type { OrgDoc } from './org';
import type { PageSpec } from './pages';
import { renderInline } from './render';
import type { TypstRenderOptions } from './typst-source';

/** Kebab-case a title: lowercase, non-alphanumeric runs collapsed to a
 *  single '-'. */
export function kebab(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** URL fragment slug for a page title. Titles with no ASCII (or colliding
 *  slugs) fall back to `page-N` (and `page-N-2`, … if `page-N` is already
 *  taken by an explicit title), and every issued slug is recorded in `taken`. */
export function pageSlug(title: string, index: number, taken: Set<string>): string {
  const base = kebab(title) || `page-${index}`;
  let unique = base;
  if (taken.has(unique)) {
    unique = `page-${index}`;
    for (let n = 2; taken.has(unique); n++) unique = `page-${index}-${n}`;
  }
  taken.add(unique);
  return unique;
}

/** Slugs for a whole page list (order-stable, collision-free). */
export function pageSlugs(pages: readonly PageSpec[]): string[] {
  const taken = new Set<string>();
  return pages.map((p, i) => pageSlug(p.title, i, taken));
}

/** Heading-slug generator shared by the rendered contents, search index,
 *  and link index: kebab-case, deduplicated in document order, `section-N`
 *  when the heading has no ASCII. */
export function sectionSlugger(): (text: string, index: number) => string {
  const taken = new Set<string>();
  return (text, index) => {
    const base = kebab(text) || `section-${index + 1}`;
    let unique = base;
    for (let n = 2; taken.has(unique); n++) unique = `${base}-${n}`;
    taken.add(unique);
    return unique;
  };
}

/** Extract visible text from a rendered heading or inline subtree, using the
 *  formula source on `.lw-math` spans so MathML and SVG modes yield identical
 *  heading labels and slugs. */
export function elementText(node: Node): string {
  if (node.nodeType === 3) return (node as Text).data;
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  if (el.classList.contains('lw-math')) {
    const aria = el.getAttribute('aria-label');
    if (aria !== null) return aria;
    const alt = el.querySelector('math')?.getAttribute('alttext');
    if (alt !== null && alt !== undefined) return alt;
    return el.textContent ?? '';
  }
  let out = '';
  for (let child = el.firstChild; child !== null; child = child.nextSibling) {
    out += elementText(child);
  }
  return out;
}

/** Render org inline markup off-screen and extract its mode-independent text. */
export function extractHeadingText(
  raw: string,
  doc: Document,
  typst?: TypstRenderOptions,
): string {
  const holder = doc.createElement('div');
  renderInline(raw, holder, { typst, doc });
  return elementText(holder);
}

/** Stable page-scoped block ids and the checked exercises a page carries.
 *  `ids` maps the renderer's 1-based executable-block index to
 *  `<page-file>:n:<name>` (when `#+NAME` is unique on the page) or
 *  `<page-file>:h:<code-hash>:<occurrence>`; duplicate names and repeated
 *  samples therefore never collide. */
export interface PageBlockIds {
  ids: Map<number, string>;
  /** Distinct ids of `#+EXERCISE` blocks that carry a `#+CHECK`. */
  exerciseIds: readonly string[];
}

/** Stable page-scoped block id for persistence: the source file (or page
 *  slug) namespaces it; a unique `#+NAME` names it; otherwise the sample
 *  code is hashed and an occurrence counter disambiguates identical
 *  samples. The executable ordinal is deliberately NOT part of the id —
 *  inserting a block above must not rewrite a learner's saved code.
 *  `isExecutableBlock` must match renderDocument's rule exactly (registered
 *  language, and not a static Typst diagram): both walks assign the same
 *  ordinals. */
export function pageBlockIds(
  doc: OrgDoc,
  pageKey: string,
  isExecutableBlock: (node: { lang: string; headers: string }) => boolean,
): PageBlockIds {
  // Pass 1: name cardinality across the whole page (folds included).
  const names = new Map<string, number>();
  const countNames = (nodes: OrgDoc): void => {
    for (const node of nodes) {
      if (node.kind === 'fold') countNames(node.doc);
      else if (node.kind === 'src' && node.name !== null) {
        names.set(node.name, (names.get(node.name) ?? 0) + 1);
      }
    }
  };
  countNames(doc);

  // Pass 2: walk executable blocks in document order (fold bodies are
  // flattened in place), assigning ids and collecting checked exercises.
  const ids = new Map<number, string>();
  const exerciseIds: string[] = [];
  const seen = new Set<string>();
  const occurrences = new Map<string, number>();
  let index = 0;
  const assign = (nodes: OrgDoc): void => {
    for (const node of nodes) {
      if (node.kind === 'fold') {
        assign(node.doc);
        continue;
      }
      if (node.kind !== 'src' || !isExecutableBlock(node)) continue;
      index += 1;
      let id: string;
      if (node.name !== null && names.get(node.name) === 1) {
        id = `${pageKey}:n:${node.name}`;
      } else {
        const hash = codeHash(node.code);
        const occurrence = (occurrences.get(hash) ?? 0) + 1;
        occurrences.set(hash, occurrence);
        id = `${pageKey}:h:${hash}:${occurrence}`;
      }
      ids.set(index, id);
      if (node.exercise !== null && node.exercise.expected !== null && !seen.has(id)) {
        seen.add(id);
        exerciseIds.push(id);
      }
    }
  };
  assign(doc);
  return { ids, exerciseIds };
}

/** FNV-1a (32-bit) → base36: a short, stable content hash for block ids. */
function codeHash(code: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    hash ^= code.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** What a link can name on one page: its file, and its h2/h3 headings. */
export interface PageLinkIndex {
  /** Source file name, lowercased (`python.org`). */
  file: string;
  slug: string;
  /** Heading text and its kebab form → first matching section slug. */
  byHeading: Map<string, string>;
  sections: Set<string>;
}

export function buildPageLinkIndex(
  page: PageSpec,
  doc: OrgDoc,
  slug: string,
  headingText: (text: string) => string,
): PageLinkIndex {
  const nextSlug = sectionSlugger();
  const byHeading = new Map<string, string>();
  const sections = new Set<string>();
  let headingIndex = 0;
  // Fold bodies are part of the page: a heading inside a hint/solution is
  // a real section and must be linkable like any other.
  const visit = (nodes: OrgDoc): void => {
    for (const node of nodes) {
      if (node.kind === 'fold') {
        visit(node.doc);
        continue;
      }
      if (node.kind !== 'heading' || node.level > 2) continue;
      // `::*Heading` text is matched against the heading's RENDERED text,
      // exactly what the TOC shows (the org source may carry links/math).
      const text = headingText(node.text).trim();
      const section = nextSlug(text, headingIndex++);
      sections.add(section);
      // Duplicate headings map to the FIRST occurrence, matching Emacs org.
      const normalized = text.replace(/\s+/g, ' ').toLowerCase();
      if (!byHeading.has(normalized)) byHeading.set(normalized, section);
      const slugForm = kebab(text);
      if (slugForm !== '' && !byHeading.has(slugForm)) byHeading.set(slugForm, section);
    }
  };
  visit(doc);
  return {
    file: (page.file ?? `${slug}.org`).toLowerCase(),
    slug,
    byHeading,
    sections,
  };
}

/** Page named by a file link: exact file, file stem, or page slug. */
export function findPageIndex(ref: string, index: readonly PageLinkIndex[]): number {
  const clean = ref.trim().replace(/^\.\//, '').toLowerCase();
  if (clean === '') return -1;
  const stem = clean.replace(/\.org$/, '');
  for (let i = 0; i < index.length; i++) {
    const page = index[i]!;
    if (
      clean === page.file
      || stem === page.file.replace(/\.org$/, '')
      || stem === page.slug
    ) {
      return i;
    }
  }
  return -1;
}

/** Resolve one org link target for the page being rendered. Accepted
 *  forms, all valid org:
 *    file:python.org                another page
 *    file:python.org::*Heading      a heading on another page
 *    file:python.org::#section      a section slug on another page
 *    *Heading / #section            the current page
 *  A bare `python.org` or `python` also resolves (org treats a relative
 *  file link the same way). Unknown page, heading, or section → null. */
export function resolveLinkTarget(
  raw: string,
  current: number,
  index: readonly PageLinkIndex[],
  slugs: readonly string[],
): string | null {
  let ref = raw.trim();
  if (ref.toLowerCase().startsWith('file:')) ref = ref.slice(5);
  const sep = ref.indexOf('::');
  let filePart = sep === -1 ? ref : ref.slice(0, sep);
  let sectionPart = sep === -1 ? '' : ref.slice(sep + 2);
  if (sep === -1 && (ref.startsWith('*') || ref.startsWith('#'))) {
    filePart = ''; // in-page link: [[*Heading]] or [[#slug]]
    sectionPart = ref;
  }
  const page = filePart === '' ? current : findPageIndex(filePart, index);
  if (page === -1) return null;
  const target = index[page]!;
  let section = '';
  if (sectionPart !== '') {
    if (sectionPart.startsWith('*')) {
      const text = sectionPart.slice(1).trim();
      section = target.byHeading.get(
        text.trim().replace(/\s+/g, ' ').toLowerCase()) ?? '';
      if (section === '') return null;
    } else if (sectionPart.startsWith('#')) {
      section = sectionPart.slice(1).trim();
      if (!target.sections.has(section)) return null;
    } else {
      return null;
    }
  }
  return `#/${slugs[page]}${section === '' ? '' : `/${section}`}`;
}
