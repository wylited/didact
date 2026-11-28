// site-chrome.ts — static layout DOM construction for mountSite:
// navigation rail, document <main>, panel <aside>, org-warnings banner,
// and per-page prev/next + progress footer.

import type { OrgDiagnostic } from './org';
import type { PageSpec } from './pages';
import type { NavView } from './site-storage';

export interface SiteChrome {
  rail: HTMLElement;
  brand: HTMLElement;
  searchInput: HTMLInputElement;
  searchResults: HTMLElement;
  contentsBtn: HTMLButtonElement;
  pagesBtn: HTMLButtonElement;
  sideBtn: HTMLButtonElement;
  hideBtn: HTMLButtonElement;
  revealBtn: HTMLButtonElement;
  contents: HTMLElement;
  tocList: HTMLElement;
  pageSlot: HTMLElement;
  docPane: HTMLElement;
  railRight: HTMLElement;
  panelPane: HTMLElement;
  layout: HTMLElement;
}

export interface SiteChromeConfig {
  doc: Document;
  brandText: string;
  brandHref: string | null;
  onSelectView: (view: NavView) => void;
  onInternalLinkClick: (href: string, event: MouseEvent) => void;
}

/** Construct the 3-zone textbook layout and attach it to `root`. */
export function createSiteChrome(root: HTMLElement, config: SiteChromeConfig): SiteChrome {
  const { doc } = config;

  const rail = doc.createElement('nav');
  rail.className = 'lw-rail lw-rail-nav';
  rail.dataset.test = 'nav';
  rail.setAttribute('aria-label', 'Lesson navigation');

  // Wordmark: first in the rail; a link home unless explicitly disabled (null).
  let brand: HTMLElement;
  if (config.brandHref === null) {
    brand = doc.createElement('span');
  } else {
    const a = doc.createElement('a');
    a.href = config.brandHref;
    if (config.brandHref.startsWith('#/')) {
      const targetHref = config.brandHref;
      a.title = 'Home — return to first lesson';
      a.addEventListener('click', (event) => config.onInternalLinkClick(targetHref, event));
    }
    brand = a;
  }
  brand.className = 'lw-brand';
  brand.dataset.test = 'brand';
  brand.textContent = config.brandText;

  // Lesson search sits above the CONTENTS | PAGES switch.
  const searchInput = doc.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'lw-nav-search';
  searchInput.dataset.test = 'search';
  searchInput.setAttribute('aria-label', 'Search lessons');
  searchInput.placeholder = 'Search lessons';

  const searchResults = doc.createElement('div');
  searchResults.className = 'lw-search-results';
  searchResults.dataset.test = 'search-results';
  searchResults.hidden = true;

  const railHead = doc.createElement('div');
  railHead.className = 'lw-rail-head lw-nav-head';

  const navSwitch = doc.createElement('div');
  navSwitch.className = 'lw-nav-switch';
  navSwitch.setAttribute('role', 'group');
  navSwitch.setAttribute('aria-label', 'Navigator view');

  const railViewButton = (view: NavView, label: string): HTMLButtonElement => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'lw-nav-tab';
    button.dataset.test = `rail-view-${view}`;
    button.dataset.view = view;
    button.textContent = label;
    button.addEventListener('click', () => config.onSelectView(view));
    navSwitch.appendChild(button);
    return button;
  };
  const contentsBtn = railViewButton('contents', 'Contents');
  const pagesBtn = railViewButton('pages', 'Pages');

  const sideBtn = doc.createElement('button');
  sideBtn.type = 'button';
  sideBtn.className = 'lw-nav-side';
  sideBtn.dataset.test = 'rail-side';

  const hideBtn = doc.createElement('button');
  hideBtn.type = 'button';
  hideBtn.className = 'lw-nav-hide';
  hideBtn.dataset.test = 'rail-hide';
  hideBtn.title = 'Hide sidebar';
  hideBtn.setAttribute('aria-label', 'Hide sidebar');

  railHead.append(navSwitch, sideBtn, hideBtn);

  // Contents container: always in the rail, hidden while pages show.
  const contents = doc.createElement('nav');
  contents.className = 'lw-contents';
  contents.dataset.test = 'toc';
  contents.setAttribute('aria-label', 'On this page');
  const tocList = doc.createElement('div');
  tocList.className = 'lw-toc-list';
  contents.appendChild(tocList);

  // Pages view slot: empty while contents show.
  const pageSlot = doc.createElement('div');
  pageSlot.className = 'lw-nav-slot';

  rail.append(brand, searchInput, railHead, contents, pageSlot, searchResults);

  // Floating reveal button shown only while the sidebar is hidden.
  const revealBtn = doc.createElement('button');
  revealBtn.type = 'button';
  revealBtn.className = 'lw-nav-reveal';
  revealBtn.dataset.test = 'rail-show';
  revealBtn.title = 'Show sidebar';
  revealBtn.setAttribute('aria-label', 'Show sidebar');

  // Document column (<main> landmark).
  const docPane = doc.createElement('main');
  docPane.className = 'lw-doc-pane';

  // Panel rail: zero-width until a panel attaches (theme.css).
  const railRight = doc.createElement('aside');
  railRight.className = 'lw-rail lw-rail-right';
  const panelPane = doc.createElement('div');
  panelPane.className = 'lw-panel-pane';
  railRight.appendChild(panelPane);

  const layout = doc.createElement('div');
  layout.className = 'lw-layout';
  layout.append(rail, docPane, railRight);
  root.append(layout, revealBtn);

  return {
    rail,
    brand,
    searchInput,
    searchResults,
    contentsBtn,
    pagesBtn,
    sideBtn,
    hideBtn,
    revealBtn,
    contents,
    tocList,
    pageSlot,
    docPane,
    railRight,
    panelPane,
    layout,
  };
}

/** Unsupported-construct report for one page: a hairline band above the
 *  article. Real DOM + textContent only; absent when the page is clean. */
export function buildWarningsBanner(
  doc: Document,
  diagnostics: readonly OrgDiagnostic[],
): HTMLElement {
  const box = doc.createElement('div');
  box.className = 'lw-org-warnings';
  box.dataset.test = 'org-warnings';
  const title = doc.createElement('p');
  title.className = 'lw-org-warnings-title';
  title.textContent = 'Unsupported Org syntax';
  const list = doc.createElement('ul');
  for (const diagnostic of diagnostics) {
    const item = doc.createElement('li');
    item.dataset.test = 'org-warning';
    item.dataset.severity = diagnostic.severity;
    item.textContent = `line ${diagnostic.line}: ${diagnostic.message}`;
    list.appendChild(item);
  }
  box.append(title, list);
  return box;
}

export interface PageState {
  /** The page carries checked exercises (their passes decide completion). */
  hasExercises: boolean;
  passed: number;
  total: number;
  complete: boolean;
}

export interface PageFooterConfig {
  doc: Document;
  index: number;
  pages: readonly PageSpec[];
  slugs: readonly string[];
  getState: () => PageState;
  onToggleManual: () => void;
  onRefreshNav: () => void;
  onInternalLinkClick: (href: string, event: MouseEvent) => void;
}

/** Per-page footer after the article: previous/next lesson links in PAGE
 *  order, completion reading, and a manual completion toggle when the page
 *  has no checked exercises. */
export function buildPageFooter(
  config: PageFooterConfig,
): { footer: HTMLElement; refresh: () => void } {
  const { doc, index, pages, slugs } = config;
  const footer = doc.createElement('footer');
  footer.className = 'lw-page-footer';
  footer.dataset.test = 'page-footer';

  if (index > 0 || index < pages.length - 1) {
    const prevnext = doc.createElement('nav');
    prevnext.className = 'lw-prevnext';
    prevnext.dataset.test = 'prevnext';
    prevnext.setAttribute('aria-label', 'Previous and next lessons');
    const lessonLink = (target: number, rel: 'prev' | 'next'): HTMLAnchorElement => {
      const href = `#/${slugs[target]}`;
      const link = doc.createElement('a');
      link.className = 'lw-prevnext-link';
      link.rel = rel;
      link.href = href;
      link.textContent = pages[target]!.title;
      link.setAttribute(
        'aria-label',
        `${rel === 'prev' ? 'Previous' : 'Next'} lesson: ${pages[target]!.title}`,
      );
      link.addEventListener('click', (event) => config.onInternalLinkClick(href, event));
      return link;
    };
    if (index > 0) prevnext.appendChild(lessonLink(index - 1, 'prev'));
    if (index < pages.length - 1) prevnext.appendChild(lessonLink(index + 1, 'next'));
    footer.appendChild(prevnext);
  }

  const meta = doc.createElement('div');
  meta.className = 'lw-page-meta';
  const progressEl = doc.createElement('p');
  progressEl.className = 'lw-page-progress';
  progressEl.dataset.test = 'page-progress';
  meta.appendChild(progressEl);

  let toggle: HTMLButtonElement | null = null;
  const renderState = (): void => {
    const state = config.getState();
    progressEl.textContent = state.hasExercises
      ? `Exercises ${state.passed}/${state.total}`
      : state.complete ? 'Page complete' : 'Not complete';
    if (toggle !== null) {
      toggle.textContent = state.complete ? 'Mark incomplete' : 'Mark complete';
      toggle.setAttribute('aria-pressed', String(state.complete));
    }
    config.onRefreshNav();
  };

  if (!config.getState().hasExercises) {
    toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.className = 'lw-page-complete';
    toggle.dataset.test = 'page-complete';
    toggle.addEventListener('click', () => {
      config.onToggleManual();
      renderState();
    });
    meta.appendChild(toggle);
  }

  footer.appendChild(meta);
  renderState();
  return { footer, refresh: renderState };
}
