// site.ts — mountSite: parse → render → block runtimes + panel host +
// tooltip engine, in the textbook-light two-pane layout. Multi-page with
// hash routing: each page's fragment is `#/<slug>` (kebab-cased title);
// mount reads location.hash, nav links target fragments, and hashchange
// switches the rendered document, disposing the old page's blocks and
// detaching the panel until the next run/step. The panel starts detached
// — no right pane at load; the first run/step attaches it.

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

  const nav = document.createElement('nav');
  nav.className = 'lw-nav';
  nav.dataset.test = 'nav';
  const label = document.createElement('span');
  label.className = 'lw-nav-label';
  label.textContent = pages[0]!.title;
  nav.appendChild(label);

  const layout = document.createElement('div');
  layout.className = 'lw-layout';

  const docPane = document.createElement('div');
  docPane.className = 'lw-doc-pane';
  layout.appendChild(docPane);

  const panelPane = document.createElement('div');
  panelPane.className = 'lw-panel-pane';
  layout.appendChild(panelPane);

  root.append(nav, layout);

  // detaching hides the panel entirely and collapses the layout to a
  // single centered column; the next attach restores the two panes
  const panel = new PanelHost(panelPane, (visible) => {
    root.classList.toggle('lw-detached', !visible);
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
    nav.appendChild(a);
    return a;
  });

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
  panel.detach(); // start detached: single centered column until first run/step
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
      root.replaceChildren();
      root.classList.remove('lw-site', 'lw-no-fonts', 'lw-detached');
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
