// site.ts — mountSite: parse → render → block runtimes + panel host +
// tooltip engine, in the textbook-light two-pane layout.

import { BlockRuntime } from './block';
import type { Kernel } from './kernel';
import { parseOrg } from './org';
import { renderDocument } from './render';
import { PanelHost } from './panel';
import { installTooltips } from './tooltip';
import './theme.css';

export interface MountOptions {
  root: HTMLElement;
  orgSource: string;
  kernels: Kernel[];
  /**
   * Load the Atkinson Hyperlegible webfonts (default true). Pass false to
   * fall back to the local serif stack.
   */
  fonts?: boolean;
}

export interface SiteHandle {
  /** All block runtimes in document order. */
  blocks: readonly BlockRuntime[];
  /** The under-the-hood panel host (right pane). */
  panel: PanelHost;
  dispose(): void;
}

export function mountSite(opts: MountOptions): SiteHandle {
  const { root, orgSource, kernels } = opts;
  const byLang = new Map(kernels.map((k) => [k.id, k] as const));

  root.classList.add('lw-site');
  if (opts.fonts === false) root.classList.add('lw-no-fonts');

  const layout = document.createElement('div');
  layout.className = 'lw-layout';

  const docPane = document.createElement('div');
  docPane.className = 'lw-doc-pane';
  layout.appendChild(docPane);

  const panelPane = document.createElement('div');
  panelPane.className = 'lw-panel-pane';
  layout.appendChild(panelPane);

  const doc = parseOrg(orgSource);
  const rendered = renderDocument(doc, (lang) => byLang.has(lang));
  docPane.appendChild(rendered.root);

  const panel = new PanelHost(panelPane);

  const blocks = rendered.blocks.map(
    (b) => new BlockRuntime(
      b.node,
      b.index,
      byLang.get(b.node.lang)!,
      b.mount,
      b.resultsEl,
      { onActivity: (block) => panel.attach(block) },
    ));

  root.appendChild(layout);
  const disposeTooltips = installTooltips(root);

  return {
    blocks,
    panel,
    dispose(): void {
      disposeTooltips();
      for (const block of blocks) block.dispose();
      root.replaceChildren();
      root.classList.remove('lw-site', 'lw-no-fonts');
    },
  };
}
