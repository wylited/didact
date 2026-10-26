// site.ts — mountSite: parse → render → block runtimes + panel host.
// Layout: a left navigation rail — this page's section contents above,
// all pages below — and the document column; the under-the-hood panel
// is the third zone, a zero-width right rail until the first run/step
// attaches it, then it animates wide (clamp(420px, 42vw, 720px)) while
// the doc column keeps a readable measure (pure CSS, theme.css).
// Routing is hash-based and uniform: a page's fragment is
// `#/<page-slug>`, a section's is `#/<page-slug>/<section-slug>` (both
// kebab-cased). Every nav and contents link is a real fragment href;
// hashchange switches pages (disposing the old page's blocks and
// detaching the panel) or scrolls within the current page. A
// scroll-spy keeps exactly one contents entry active; it never writes
// the hash.

import { BlockRuntime } from './block';
import type { Kernel } from './kernel';
import { parseOrg } from './org';
import { renderDocument } from './render';
import { PanelHost } from './panel';
import { installTooltips } from './tooltip';
import './theme.css';

/** One lesson page: nav title plus its org source. */
export interface PageSpec {
  title: string;
  orgSource: string;
}

export interface MountOptions {
  /** Element the site renders into (replaced children). */
  root: HTMLElement;
  /** Registered kernels; a block is executable when its org language
   *  matches a kernel id. */
  kernels: readonly Kernel[];
  /** Lesson pages, in navigation order. */
  pages: readonly PageSpec[];
  /** Set false to skip loading the web fonts (tests). */
  fonts?: boolean;
}

export interface SiteHandle {
  /** Block runtimes on the active page, in document order. */
  readonly blocks: readonly BlockRuntime[];
  /** The under-the-hood panel host (right rail). */
  readonly panel: PanelHost;
  /** 0-based index of the rendered page. */
  readonly activeIndex: number;
  /** Render page `index` (disposes the current page's blocks first). */
  show(index: number): void;
  dispose(): void;
}

export function mountSite(opts: MountOptions): SiteHandle {
  const { root, kernels, pages } = opts;
  if (pages.length === 0) throw new Error('mountSite: at least one page is required');
  const byLang = new Map(kernels.map((k) => [k.id, k] as const));

  root.classList.add('lw-site');
  if (opts.fonts === false) root.classList.add('lw-no-fonts');

  /** A rail section header: small-caps label on a hairline. */
  const railHead = (label: string): HTMLElement => {
    const head = document.createElement('div');
    head.className = 'lw-rail-head';
    const span = document.createElement('span');
    span.className = 'lw-rail-title';
    span.textContent = label;
    head.appendChild(span);
    return head;
  };

  // ---- left navigation rail: contents (this page's sections) + pages
  const railLeft = document.createElement('nav');
  railLeft.className = 'lw-rail lw-rail-left';
  railLeft.dataset.test = 'nav';

  const contents = document.createElement('nav');
  contents.className = 'lw-contents';
  contents.dataset.test = 'toc';
  contents.appendChild(railHead('Contents'));
  const tocList = document.createElement('div');
  tocList.className = 'lw-toc-list';
  contents.appendChild(tocList);

  const pagesEl = document.createElement('div');
  pagesEl.className = 'lw-rail-pages';
  pagesEl.appendChild(railHead('Pages'));
  const pagesList = document.createElement('div');
  pagesList.className = 'lw-rail-pages-list';
  pagesEl.appendChild(pagesList);

  railLeft.append(contents, pagesEl);

  // ---- document column
  const docPane = document.createElement('div');
  docPane.className = 'lw-doc-pane';

  // ---- right rail: zero-width until a panel attaches (theme.css)
  const railRight = document.createElement('aside');
  railRight.className = 'lw-rail lw-rail-right';
  const panelPane = document.createElement('div');
  panelPane.className = 'lw-panel-pane';
  railRight.appendChild(panelPane);

  const layout = document.createElement('div');
  layout.className = 'lw-layout';
  layout.append(railLeft, docPane, railRight);
  root.appendChild(layout);

  // attaching/detaching only modulates the root class: the right rail
  // animates from 0 to the panel measure (theme.css)
  const panel = new PanelHost(panelPane, (visible) => {
    root.classList.toggle('lw-panel-attached', visible);
  });

  let active = -1;
  let blocks: BlockRuntime[] = [];
  const slugs = pageSlugs(pages);
  const links = pages.map((page, i) => {
    const a = document.createElement('a');
    a.className = 'lw-nav-link';
    a.dataset.test = 'nav-item';
    // real fragment href: the click sets the hash, hashchange does the
    // switch (so the URL always names the visible page)
    a.href = `#/${slugs[i]}`;
    a.textContent = page.title;
    pagesList.appendChild(a);
    return a;
  });

  // ---- contents: the active page's own sections ----

  interface TocEntry {
    heading: HTMLElement;
    link: HTMLAnchorElement;
    /** URL slug of the section (`#/<page-slug>/<section-slug>`). */
    slug: string;
  }
  let tocEntries: TocEntry[] = [];
  let tocActive = -1;
  let spy: IntersectionObserver | null = null;

  function setActiveToc(index: number): void {
    if (index === tocActive) return;
    if (tocActive !== -1) tocEntries[tocActive]!.link.classList.remove('lw-toc-active');
    tocActive = index;
    if (tocEntries[index]) tocEntries[index]!.link.classList.add('lw-toc-active');
  }

  /** Active entry = the heading nearest the viewport top: the last one
   *  whose top edge crossed the threshold line (the section currently
   *  being read); above the first heading → the first entry. */
  function spyUpdate(): void {
    let best = 0;
    for (let i = 0; i < tocEntries.length; i++) {
      if (tocEntries[i]!.heading.getBoundingClientRect().top <= 96) best = i;
      else break;
    }
    setActiveToc(best);
  }

  /** Clear the contents and its spy: on every page switch and dispose. */
  function disposeToc(): void {
    spy?.disconnect();
    spy = null;
    tocList.replaceChildren();
    tocEntries = [];
    tocActive = -1;
  }

  /** Build the contents from a freshly rendered page: one real
   *  fragment link per h2/h3 (org depth-1/2) heading — the hashchange
   *  handler does the scrolling, so clicks, back/forward and shared
   *  URLs all take the same path. A page without any leaves the
   *  section empty. Heading ids are slugged (`lw-h-<slug>`), so
   *  anchors survive insertions above them. */
  function buildToc(doc: HTMLElement, pageSlugStr: string): void {
    disposeToc();
    const headings = Array.from(
      doc.querySelectorAll<HTMLElement>('h2.lw-heading, h3.lw-heading'));
    const taken = new Set<string>();
    tocEntries = headings.map((heading, i) => {
      let slug = kebab(heading.textContent ?? '');
      if (slug === '') slug = `section-${i + 1}`;
      let unique = slug;
      let n = 2;
      while (taken.has(unique)) unique = `${slug}-${n++}`;
      taken.add(unique);
      heading.id = `lw-h-${unique}`;
      const link = document.createElement('a');
      link.className = 'lw-toc-item';
      if (heading.tagName === 'H3') link.classList.add('lw-toc-sub');
      link.dataset.test = 'toc-item';
      link.href = `#/${pageSlugStr}/${unique}`;
      link.textContent = heading.textContent ?? '';
      tocList.appendChild(link);
      return { heading, link, slug: unique };
    });
    setActiveToc(0);
    if (tocEntries.length === 0 || typeof IntersectionObserver === 'undefined') {
      return; // tests/old DOMs: the hashchange path still works
    }
    // cheap spy: recompute only when a heading crosses the viewport,
    // never per scroll frame
    spy = new IntersectionObserver(() => spyUpdate());
    for (const { heading } of tocEntries) spy.observe(heading);
  }

  function show(index: number): void {
    if (index < 0 || index >= pages.length || index === active) return;
    for (const block of blocks) block.dispose();
    blocks = [];
    docPane.replaceChildren();
    if (active !== -1) panel.detach(); // page switch: panel detaches
    active = index;

    const doc = parseOrg(pages[index]!.orgSource);
    const rendered = renderDocument(doc, (lang) => byLang.has(lang));
    rendered.root.dataset.test = 'page';
    docPane.appendChild(rendered.root);
    buildToc(rendered.root, slugs[index]!);

    blocks = rendered.blocks.map(
      (b) => new BlockRuntime(
        b.node,
        b.index,
        byLang.get(b.node.lang)!,
        b.mount,
        b.resultsEl,
        { onActivity: (block) => panel.attach(block) },
      ));

    for (const [i, a] of links.entries()) {
      const on = i === index;
      a.classList.toggle('lw-nav-active', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  /** Page named by the hash (`#/<slug>/…`): unknown or missing slug →
   *  the first page. */
  function pageFromHash(): number {
    const [pageSlugStr] = location.hash.replace(/^#\/?/, '').split('/');
    const index = slugs.indexOf(pageSlugStr ?? '');
    return index === -1 ? 0 : index;
  }

  /** Section of the ACTIVE page's contents named by the hash
   *  (`#/<page-slug>/<section-slug>`; only the active page's slugs are
   *  known). Missing or unknown section → none. */
  function sectionFromHash(): number {
    const sectionSlug = location.hash.replace(/^#\/?/, '').split('/')[1];
    return sectionSlug
      ? tocEntries.findIndex((e) => e.slug === sectionSlug)
      : -1;
  }

  /** One routing path for mount, hashchange (nav click, contents
   *  click, back/forward): switch the page if it changed, then scroll
   *  to the named section — smoothly within a page, instantly after a
   *  page swap (section slugs only resolve against the rendered
   *  page, so the lookup happens after any switch). */
  function routeAndScroll(initial: boolean): void {
    const page = pageFromHash();
    const changed = page !== active;
    if (changed || initial) show(page);
    const section = sectionFromHash();
    if (section >= 0) {
      tocEntries[section]!.heading.scrollIntoView(
        { behavior: changed || initial ? 'auto' : 'smooth' });
      setActiveToc(section);
    }
  }

  const onHashChange = (): void => routeAndScroll(false);
  window.addEventListener('hashchange', onHashChange);
  routeAndScroll(true);
  const disposeTooltips = installTooltips(root);

  return {
    get blocks(): readonly BlockRuntime[] {
      return blocks;
    },
    panel,
    get activeIndex(): number {
      return active;
    },
    show,
    dispose(): void {
      disposeTooltips();
      window.removeEventListener('hashchange', onHashChange);
      for (const block of blocks) block.dispose();
      blocks = [];
      disposeToc();
      root.replaceChildren();
      root.classList.remove('lw-site', 'lw-no-fonts', 'lw-panel-attached');
    },
  };
}

/** Kebab-case a title: lowercase, non-alphanumeric runs collapsed to a
 *  single '-'. */
function kebab(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** URL fragment slug for a page title. Titles with no ASCII (or
 *  colliding slugs) fall back to `page-N` so every page stays
 *  reachable. */
function pageSlug(title: string, index: number, taken: Set<string>): string {
  const slug = kebab(title);
  if (slug === '' || taken.has(slug)) return `page-${index}`;
  taken.add(slug);
  return slug;
}

/** Slugs for a whole page list (order-stable, collision-free). */
function pageSlugs(pages: readonly PageSpec[]): string[] {
  const taken = new Set<string>();
  return pages.map((p, i) => pageSlug(p.title, i, taken));
}
