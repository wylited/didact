// site.ts — mountSite: parse → render → block runtimes + panel host +
// tooltip engine, in the textbook-light two-pane layout. Multi-page: a
// slim nav bar switches the rendered document; switching disposes the old
// page's blocks and detaches the panel until the next run/step.

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
  const links = pages.map((page, index) => {
    const a = document.createElement('a');
    a.className = 'lw-nav-link';
    a.dataset.test = 'nav-item';
    a.href = '#';
    a.textContent = page.title;
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      show(index);
    });
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

  show(0);
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
      for (const block of blocks) block.dispose();
      blocks = [];
      root.replaceChildren();
      root.classList.remove('lw-site', 'lw-no-fonts', 'lw-detached');
    },
  };
}
