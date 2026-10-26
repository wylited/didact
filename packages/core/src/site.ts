// site.ts — mountSite: parse → render → block runtimes + panel host +
// tooltip engine, in the textbook-light three-rail layout: page links in
// a left rail, the document center, and a right rail hosting the active
// page's table of contents. The first run/step of any block attaches the
// under-the-hood panel, which takes over the right rail (the TOC hides);
// detaching or switching pages restores the TOC. The rail itself always
// exists — only its content swaps. Multi-page with hash routing: each
// page's fragment is `#/<slug>` (kebab-cased title); mount reads
// location.hash, nav links target fragments, and hashchange switches the
// rendered document, disposing the old page's blocks. In-page TOC links
// never touch location.hash (that would route pages); they smooth-scroll.

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
  root: HTMLElement;
  fonts?: boolean;
  kernels: Kernel[];
  pages: PageSpec[];
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

/** One right-rail TOC entry: its heading in the document and its link. */
interface TocEntry {
  heading: HTMLElement;
  link: HTMLAnchorElement;
}

export function mountSite(opts: MountOptions): SiteHandle {
  const { root, kernels, pages } = opts;
  if (pages.length === 0) throw new Error('mountSite: at least one page is required');
  const byLang = new Map(kernels.map((k) => [k.id, k] as const));

  root.classList.add('lw-site');
  if (opts.fonts === false) root.classList.add('lw-no-fonts');

  // left rail: the page list, vertical fragment links
  const pageNav = document.createElement('nav');
  pageNav.className = 'lw-page-nav';
  pageNav.dataset.test = 'nav';
  const label = document.createElement('span');
  label.className = 'lw-page-nav-label';
  label.textContent = 'Pages';
  pageNav.appendChild(label);

  // center: the rendered document
  const docPane = document.createElement('div');
  docPane.className = 'lw-doc-pane';

  // right rail: the active page's TOC, or the panel while one is attached
  const rail = document.createElement('div');
  rail.className = 'lw-rail';

  root.append(pageNav, docPane, rail);

  // panel visibility swaps the rail's content: lw-panel-attached on the
  // site root hides the TOC; detach/page-switch drops the class and the
  // TOC returns. The layout never collapses.
  const panel = new PanelHost(rail, (visible) => {
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
    pageNav.appendChild(a);
    return a;
  });

  // ---- right-rail table of contents ----

  let toc: HTMLElement | null = null;
  let tocEntries: TocEntry[] = [];
  let tocActive = -1;
  let spy: IntersectionObserver | null = null;

  function setActiveToc(index: number): void {
    if (index === tocActive) return;
    if (tocActive !== -1) tocEntries[tocActive].link.classList.remove('lw-toc-active');
    tocActive = index;
    tocEntries[index].link.classList.add('lw-toc-active');
  }

  /** Active entry = the heading nearest the viewport top: the last one
   *  whose top edge crossed the threshold line (the section currently
   *  being read); above the first heading → the first entry. */
  function spyUpdate(): void {
    let best = 0;
    for (let i = 0; i < tocEntries.length; i++) {
      if (tocEntries[i].heading.getBoundingClientRect().top <= 96) best = i;
      else break;
    }
    setActiveToc(best);
  }

  /** Tear down the TOC and its spy: on every page switch. */
  function disposeToc(): void {
    spy?.disconnect();
    spy = null;
    toc?.remove();
    toc = null;
    tocEntries = [];
    tocActive = -1;
  }

  /** Build the TOC from a freshly rendered page: one link per h2/h3
   *  (org depth-1/2) heading. A page without any gets no TOC — the rail
   *  stays empty until a panel attaches. */
  function buildToc(doc: HTMLElement): void {
    const headings = Array.from(
      doc.querySelectorAll<HTMLElement>('h2.lw-heading, h3.lw-heading'));
    if (headings.length === 0) return;
    tocEntries = headings.map((heading, i) => {
      heading.id = `lw-h-${i + 1}`; // per page, document order
      const link = document.createElement('a');
      link.className = 'lw-toc-item';
      if (heading.tagName === 'H3') link.classList.add('lw-toc-sub');
      link.dataset.test = 'toc-item';
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent ?? '';
      link.addEventListener('click', (e) => {
        e.preventDefault(); // never route: location.hash names pages
        setActiveToc(i);
        heading.scrollIntoView({ behavior: 'smooth' });
      });
      return { heading, link };
    });
    toc = document.createElement('nav');
    toc.className = 'lw-toc';
    toc.dataset.test = 'toc';
    const tocLabel = document.createElement('span');
    tocLabel.className = 'lw-toc-label';
    tocLabel.textContent = 'Contents';
    toc.appendChild(tocLabel);
    for (const { link } of tocEntries) toc.appendChild(link);
    rail.appendChild(toc);
    setActiveToc(0);
    if (typeof IntersectionObserver === 'undefined') return; // tests/old DOMs
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
    disposeToc();
    if (active !== -1) panel.detach(); // page switch: panel detaches
    active = index;

    const doc = parseOrg(pages[index].orgSource);
    const rendered = renderDocument(doc, (lang) => byLang.has(lang));
    rendered.root.dataset.test = 'page';
    docPane.appendChild(rendered.root);
    buildToc(rendered.root);

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
  // deep link: show the page named by the hash, first page otherwise;
  // later hash changes (nav clicks, back/forward) switch pages
  const onHashChange = (): void => show(indexFromHash(slugs));
  window.addEventListener('hashchange', onHashChange);
  show(indexFromHash(slugs));
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

/** URL fragment slug for a page title: lowercase, non-alphanumeric runs
 *  collapsed to single '-'. Titles with no ASCII (or colliding slugs)
 *  fall back to `page-N` so every page stays reachable. */
function pageSlug(title: string, index: number, taken: Set<string>): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length === 0 || taken.has(slug)) return `page-${index}`;
  taken.add(slug);
  return slug;
}

/** Slugs for a whole page list (order-stable, collision-free). */
function pageSlugs(pages: PageSpec[]): string[] {
  const taken = new Set<string>();
  return pages.map((page, i) => pageSlug(page.title, i, taken));
}

/** Page index named by `location.hash` (`#/<slug>`); unknown or missing
 *  hash resolves to the first page. */
function indexFromHash(slugs: string[]): number {
  const slug = location.hash.replace(/^#\//, '');
  const index = slugs.indexOf(slug);
  return index === -1 ? 0 : index;
}
