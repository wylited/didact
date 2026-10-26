// site.ts — mountSite: parse → render → block runtimes + panel host, in
// the textbook-light three-zone layout: a collapsible left page rail
// (192px ↔ 32px), the document column, and a dual-width right rail that
// shows the active page's section TOC (h2/h3, 264px) until the
// under-the-hood panel attaches (clamp(420px, 42vw, 720px)). Width
// modulation and the TOC/panel cross-fade are pure CSS (theme.css); the
// panel element still enters/leaves the DOM on attach/detach. Multi-page
// with hash routing: each page's fragment is `#/<slug>` (kebab-cased
// title); mount reads location.hash, nav links target fragments, and
// hashchange switches the rendered document, disposing the old page's
// blocks and detaching the panel until the next run/step. TOC links
// never touch location.hash (that would route pages); they
// smooth-scroll.

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
  /** The under-the-hood panel host (right pane). */
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

  // left page rail: small-caps header with the collapse toggle + links.
  // Collapsed = 0-width content: the rail shrinks to a 32px strip that
  // keeps only the (always focusable) toggle. Per-session state only.
  const rail = document.createElement('nav');
  rail.className = 'lw-rail lw-rail-left';
  rail.dataset.test = 'nav';

  const railHead = document.createElement('div');
  railHead.className = 'lw-rail-head';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'lw-rail-toggle';
  toggle.dataset.test = 'nav-toggle';
  toggle.setAttribute('aria-expanded', 'true');
  const chevron = document.createElement('span');
  chevron.className = 'lw-rail-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '‹';
  const toggleLabel = document.createElement('span');
  toggleLabel.className = 'lw-rail-toggle-label';
  toggleLabel.textContent = 'Pages';
  toggle.append(chevron, toggleLabel);
  railHead.appendChild(toggle);

  const pagesEl = document.createElement('div');
  pagesEl.className = 'lw-rail-pages';
  rail.append(railHead, pagesEl);

  const layout = document.createElement('div');
  layout.className = 'lw-layout';

  const docPane = document.createElement('div');
  docPane.className = 'lw-doc-pane';

  // right rail: TOC overlays the panel slot; attaching the panel widens
  // the rail (root class lw-panel-attached) and cross-fades TOC → panel
  const railRight = document.createElement('aside');
  railRight.className = 'lw-rail lw-rail-right';
  const railBody = document.createElement('div');
  railBody.className = 'lw-rail-body';
  const toc = document.createElement('nav');
  toc.className = 'lw-toc';
  toc.dataset.test = 'toc';
  const tocHead = document.createElement('div');
  tocHead.className = 'lw-rail-head';
  const tocLabel = document.createElement('span');
  tocLabel.className = 'lw-rail-title';
  tocLabel.textContent = 'Contents';
  tocHead.appendChild(tocLabel);
  const tocList = document.createElement('div');
  tocList.className = 'lw-toc-list';
  toc.append(tocHead, tocList);

  const panelPane = document.createElement('div');
  panelPane.className = 'lw-panel-pane';
  railBody.append(toc, panelPane);
  railRight.appendChild(railBody);

  layout.append(rail, docPane, railRight);
  root.appendChild(layout);

  let leftCollapsed = false;
  const setLeftCollapsed = (collapsed: boolean): void => {
    leftCollapsed = collapsed;
    root.classList.toggle('lw-left-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    chevron.textContent = collapsed ? '›' : '‹';
    pagesEl.hidden = collapsed;
  };
  toggle.addEventListener('click', () => setLeftCollapsed(!leftCollapsed));

  // attaching/detaching only modulates the root class: the right rail
  // widens to the panel measure and the TOC cross-fades out (theme.css)
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
    pagesEl.appendChild(a);
    return a;
  });

  // ---- right-rail table of contents (the page's own sections) ----

  interface TocEntry {
    heading: HTMLElement;
    link: HTMLAnchorElement;
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

  /** Clear the TOC and its spy: on every page switch and dispose. */
  function disposeToc(): void {
    spy?.disconnect();
    spy = null;
    tocList.replaceChildren();
    tocEntries = [];
    tocActive = -1;
  }

  /** Build the TOC from a freshly rendered page: one link per h2/h3
   *  (org depth-1/2) heading. A page without any leaves the rail
   *  empty until a panel attaches. In-page links never touch
   *  location.hash (fragments name pages); they smooth-scroll. */
  function buildToc(doc: HTMLElement): void {
    disposeToc();
    const headings = Array.from(
      doc.querySelectorAll<HTMLElement>('h2.lw-heading, h3.lw-heading'));
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
      tocList.appendChild(link);
      return { heading, link };
    });
    setActiveToc(0);
    if (tocEntries.length === 0 || typeof IntersectionObserver === 'undefined') {
      return; // tests/old DOMs: the click-path still works
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
  show(indexFromHash(slugs)); // TOC mode: panel attaches on first run/step
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
      root.classList.remove('lw-site', 'lw-no-fonts', 'lw-panel-attached', 'lw-left-collapsed');
    },
  };
}

/** URL fragment slug for a page title: lowercase, non-alphanumeric runs
 *  collapsed to single '-'. Titles with no ASCII (or colliding slugs)
 *  fall back to `page-N` so every page stays reachable. */
function pageSlug(title: string, index: number, taken: Set<string>): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug === '' || taken.has(slug)) return `page-${index}`;
  taken.add(slug);
  return slug;
}

/** Slugs for a whole page list (order-stable, collision-free). */
function pageSlugs(pages: PageSpec[]): string[] {
  const taken = new Set<string>();
  return pages.map((p, i) => pageSlug(p.title, i, taken));
}

/** Page index named by `location.hash` (`#/<slug>`); unknown or missing
 *  hash resolves to the first page. */
function indexFromHash(slugs: string[]): number {
  const slug = location.hash.replace(/^#\//, '');
  const index = slugs.indexOf(slug);
  return index === -1 ? 0 : index;
}
