// site.ts — mountSite: parse → render → block runtimes + panel host.
//
// Layout: one navigation rail, the document column (<main>), and the panel
// rail. The navigator shows ONE list at a time (contents, pages, or live
// search results) and can sit on the left or right edge or be hidden.
// Routing supports URL hashes (`#/<page>/<section>`) or in-memory state.

import type { Extension } from '@codemirror/state';
import { parseBabelHeaders } from './babel';
import { BlockRuntime, type SharedSession } from './block';
import { DEFAULT_STORAGE_PREFIX, normalizeStoragePrefix } from './block-io';
import type { Kernel, Session } from './kernel';
import { acquireMathStyle } from './math-style';
import { parseOrgChecked } from './org';
import type { PageSpec } from './pages';
import { PanelHost } from './panel';
import { renderDocument } from './render';
import {
  buildPageFooter,
  buildWarningsBanner,
  createSiteChrome,
  type PageState,
} from './site-chrome';
import {
  buildPageLinkIndex,
  extractHeadingText,
  pageBlockIds,
  pageSlugs,
  resolveLinkTarget,
} from './site-index';
import {
  formatHash,
  isPlainClick,
  parseHashRoute,
  replaceHash,
  resolvePageRef,
  type RoutingMode,
} from './site-router';
import { renderSearchResults, searchChunksForPage } from './site-search';
import {
  createSiteStore,
  type NavSide,
  type NavView,
  type PageProgress,
} from './site-storage';
import { openAncestorFolds, TocController } from './site-toc';
import type {
  BlockRuntimeOptions,
  ExerciseOutcome,
  StorageLike,
} from './teaching';
import { installTooltips } from './tooltip';
import { isTypstDiagram, type TypstArtifacts, type TypstRenderOptions } from './typst-source';
import './theme.css';

export type { NavSide, NavView } from './site-storage';
export type { PageSpec } from './pages';
export type { RoutingMode } from './site-router';
export { isInClosedFold, selectActiveHeading, type SpySample } from './site-toc';

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
  /** Initial navigator side (default 'left'). A persisted choice
   *  (`<storagePrefix>nav-side`) wins over this default. */
  navSide?: NavSide;
  /** Initial navigator view (default 'contents'). Not persisted: the
   *  example site opens on the page list. */
  navView?: NavView;
  /** Site wordmark in the navigator rail (default 'Didact'). */
  brand?: string;
  /** Custom href for the brand wordmark; pass `null` to render a non-link
   *  wordmark. Defaults to `#/<first-page-slug>`. */
  brandHref?: string | null;
  /** Build-time Typst artifacts for prose math and static diagrams.
   *  Absent → `$…$` stays literal and a `:results svg` block becomes an
   *  ordinary kernel block. */
  typst?: TypstRenderOptions;
  /** Prefix for all persisted keys (nav state, progress, saved drafts).
   *  Defaults to `'didact:'`. Give distinct sites distinct prefixes to
   *  isolate their state on shared storage. */
  storagePrefix?: string;
  /** Custom storage backend threaded into site persistence and every block
   *  runtime (`null` disables persistence). Defaults to `localStorage`. */
  storage?: StorageLike | null;
  /** Routing strategy: `'hash'` (default) syncs with `location.hash`;
   *  `'memory'` keeps navigation state in memory without touching the URL. */
  routing?: RoutingMode;
  /** Initial page (0-based index, slug, or file name) used in memory mode
   *  or when the URL hash is absent/unknown. Defaults to `0`. */
  initialPage?: number | string;
  /** Control `document.title` updates. Defaults to `\`${page.title} · ${brand}\``
   *  and restores the original title in `dispose()`. Pass `false` to opt out. */
  documentTitle?: false | ((page: PageSpec, brand: string) => string);
  /** Fired after every route change (initial mount, link click, hashchange,
   *  `show()`, or `navigate()`). */
  onNavigate?: (info: {
    index: number;
    slug: string;
    section: string | null;
    page: PageSpec;
  }) => void;
  /** Fired after every checked exercise reaches a terminal execution on any
   *  page (both passes and fails). */
  onExerciseResult?: (
    outcome: ExerciseOutcome & { pageKey: string; pageIndex: number },
  ) => void;
  /** Render the unsupported-org-syntax banner above pages with diagnostics
   *  (default `true`). */
  showOrgWarnings?: boolean;
  /** Custom CodeMirror theme passed to every block editor. */
  editorTheme?: Extension;
  /** Additional CodeMirror extensions appended to every block editor. */
  editorExtensions?: readonly Extension[];
  /** Per-language CodeMirror extension overrides keyed by org `#+BEGIN_SRC`
   *  language id. */
  editorLanguages?: Record<string, Extension>;
}

export interface SiteHandle {
  /** Block runtimes on the active page, in document order. */
  readonly blocks: readonly BlockRuntime[];
  /** The under-the-hood panel host (panel rail). */
  readonly panel: PanelHost;
  /** 0-based index of the rendered page. */
  readonly activeIndex: number;
  /** URL slug of the rendered page. */
  readonly activeSlug: string;
  /** Which side the navigator rail is on (root class `lw-nav-<side>`). */
  readonly navSide: NavSide;
  /** Which list the navigator shows: the active page's contents
   *  (default) or the page list. Never changed implicitly. */
  readonly navView: NavView;
  /** True while the navigator rail is collapsed/hidden. */
  readonly navHidden: boolean;
  /** Resolves once the initial route has applied, including a pending lazy
   *  Typst artifact load. Stable across route changes. */
  readonly ready: Promise<void>;
  /** Resolves when the current pending route applies. Replaced on each lazy
   *  route and already resolved when nothing is pending. */
  readonly idle: Promise<void>;
  /** Render page `index` (disposes the current page's blocks first). */
  show(index: number): void;
  /** Navigate to a page (index, slug, or file name) and optional section. */
  navigate(page: number | string, section?: string): void;
  /** Move the navigator to `side` and persist the choice. */
  setNavSide(side: NavSide): void;
  /** Show `view` in the navigator (the user's explicit choice). */
  setNavView(view: NavView): void;
  /** Collapse or expand the navigator rail and persist the choice. */
  setNavHidden(hidden: boolean): void;
  dispose(): void;
}

export function mountSite(opts: MountOptions): SiteHandle {
  const { root, kernels, pages } = opts;
  if (pages.length === 0) throw new Error('mountSite: at least one page is required');

  const byLang = new Map(kernels.map((k) => [k.id, k] as const));
  // Every node is created in the root's document so cross-document/iframe
  // mounts work cleanly.
  const doc = root.ownerDocument ?? document;
  const win = doc.defaultView ?? window;
  const storagePrefix = normalizeStoragePrefix(opts.storagePrefix ?? DEFAULT_STORAGE_PREFIX);
  const store = createSiteStore(opts.storage, storagePrefix, win);
  const routing: RoutingMode = opts.routing ?? 'hash';
  const brandText = opts.brand ?? 'Didact';
  const showOrgWarnings = opts.showOrgWarnings !== false;
  const updateDocTitle = opts.documentTitle !== false;
  const originalDocTitle = doc.title;

  const slugs = pageSlugs(pages);
  // Storage/completion identity: the source file when one is named (a
  // rename or slug collision must not move a learner's progress), else
  // the URL slug.
  const pageKeys = pages.map((page, i) => page.file ?? slugs[i]!);

  // Mount-time indices (heading slugs, search, link resolution) use the eager
  // `opts.typst` artifacts. In split mode the top-level math/diagrams are
  // empty, so heading formulas fall back to their source text (and are not
  // reported as missing — the page's own artifacts are simply not loaded
  // yet); the rendered page still gets the real artifacts through
  // `pageTypst`.
  const splitArtifacts = opts.typst?.artifacts.pages !== undefined;
  const headingText = (text: string): string =>
    extractHeadingText(text, doc, splitArtifacts ? undefined : opts.typst);

  /** Page artifacts loaded from `artifacts.pages` on first navigation. */
  const pageArtifacts = new Map<
    number,
    Pick<TypstArtifacts, 'math' | 'diagrams'>
  >();

  /**
   * Typst options for rendering page `index`. A cached per-page load wins
   * over the eager artifacts; before the load (and for eager pages) the
   * mount-time artifacts are used unchanged.
   */
  function pageTypst(index: number): TypstRenderOptions | undefined {
    const cached = pageArtifacts.get(index);
    if (cached === undefined || opts.typst === undefined) return opts.typst;
    return {
      ...opts.typst,
      artifacts: { ...opts.typst.artifacts, ...cached },
    };
  }

  root.classList.add('lw-site');
  if (opts.fonts === false) root.classList.add('lw-no-fonts');

  const releaseMathStyle = acquireMathStyle(
    doc,
    root,
    opts.typst?.artifacts.mathCss ?? '',
  );

  // ---- navigator state ----
  const navSideDefault: NavSide = opts.navSide === 'right' ? 'right' : 'left';
  let navSide: NavSide = store.readNavSide() ?? navSideDefault;
  let navHidden: boolean = store.readNavHidden();
  let navView: NavView = opts.navView === 'pages' ? 'pages' : 'contents';

  const brandHref = opts.brandHref === undefined
    ? formatHash(slugs[0]!)
    : opts.brandHref;

  const chrome = createSiteChrome(root, {
    doc,
    brandText,
    brandHref,
    onSelectView: (view) => setView(view),
    onInternalLinkClick: (href, event) => handleInternalLinkClick(href, event),
  });

  function applyNavSide(): void {
    root.classList.toggle('lw-nav-left', navSide === 'left');
    root.classList.toggle('lw-nav-right', navSide === 'right');
    const target: NavSide = navSide === 'left' ? 'right' : 'left';
    chrome.sideBtn.textContent = target === 'left' ? '←' : '→';
    chrome.sideBtn.title = `Move navigation to the ${target}`;
    chrome.sideBtn.setAttribute('aria-label', `Move navigation to the ${target}`);
    chrome.hideBtn.textContent = navSide === 'left' ? '⇤' : '⇥';
    chrome.revealBtn.textContent = navSide === 'left' ? '⇥' : '⇤';
    const placed = navSide === 'left'
      ? chrome.layout.firstElementChild === chrome.rail
      : chrome.layout.lastElementChild === chrome.rail;
    if (placed) return;
    // Re-inserting the rail detaches its focused control, which would drop
    // keyboard focus to <body>; restore it after the move.
    const focused = doc.activeElement as HTMLElement | null;
    const railHadFocus = focused !== null && chrome.rail.contains(focused);
    if (navSide === 'left') chrome.layout.prepend(chrome.rail);
    else chrome.layout.append(chrome.rail);
    if (railHadFocus) focused!.focus();
  }

  function applyNavHidden(): void {
    root.classList.toggle('lw-nav-hidden', navHidden);
    // Prevent hidden desktop rail links from trapping keyboard focus.
    chrome.rail.inert = navHidden;
    if (navHidden) {
      chrome.rail.setAttribute('inert', '');
      chrome.rail.setAttribute('aria-hidden', 'true');
    } else {
      chrome.rail.removeAttribute('inert');
      chrome.rail.removeAttribute('aria-hidden');
    }
    chrome.revealBtn.hidden = !navHidden;
  }

  function setNavSide(side: NavSide): void {
    if (side !== 'left' && side !== 'right') return;
    navSide = side;
    applyNavSide();
    store.writeNavSide(side);
  }

  function setNavHidden(hidden: boolean): void {
    navHidden = hidden;
    applyNavHidden();
    store.writeNavHidden(hidden);
  }

  chrome.sideBtn.addEventListener('click', () => {
    setNavSide(navSide === 'left' ? 'right' : 'left');
  });
  chrome.hideBtn.addEventListener('click', () => {
    setNavHidden(true);
    chrome.revealBtn.focus();
  });
  chrome.revealBtn.addEventListener('click', () => {
    setNavHidden(false);
    chrome.hideBtn.focus();
  });

  // ---- parsed pages, indices, completion state ----
  const parsedPages = pages.map((page) => {
    const parsed = parseOrgChecked(page.orgSource);
    if (parsed.diagnostics.length > 0 && showOrgWarnings) {
      const lines = parsed.diagnostics.map((d) => `  line ${d.line}: ${d.message}`);
      console.warn(
        [`didact: ${page.title} has ${parsed.diagnostics.length} org diagnostic(s)`,
          ...lines].join('\n'),
      );
    }
    return parsed;
  });

  const linkIndex = pages.map(
    (page, i) => buildPageLinkIndex(page, parsedPages[i]!.doc, slugs[i]!, headingText));

  const pageBlockList = parsedPages.map((parsed, i) =>
    pageBlockIds(parsed.doc, pageKeys[i]!, (node) =>
      byLang.has(node.lang)
      && !(opts.typst !== undefined && isTypstDiagram(node))));

  const searchIndex = pages.flatMap(
    (page, i) => searchChunksForPage(page, parsedPages[i]!.doc, slugs[i]!, headingText));

  const links = pages.map((page, i) => {
    const href = formatHash(slugs[i]!);
    const a = doc.createElement('a');
    a.className = 'lw-nav-link';
    a.dataset.test = 'nav-item';
    a.href = href;
    a.textContent = page.title;
    a.addEventListener('click', (event) => handleInternalLinkClick(href, event));
    return a;
  });

  const progressCache = new Map<string, PageProgress>();
  const progressFor = (pageKey: string): PageProgress => {
    let progress = progressCache.get(pageKey);
    if (progress === undefined) {
      progress = store.readProgress(pageKey);
      progressCache.set(pageKey, progress);
    }
    return progress;
  };

  function pageState(index: number): PageState {
    const exerciseIds = pageBlockList[index]!.exerciseIds;
    const progress = progressFor(pageKeys[index]!);
    if (exerciseIds.length === 0) {
      return {
        hasExercises: false,
        passed: 0,
        total: 0,
        complete: progress.manual,
      };
    }
    let passed = 0;
    for (const id of exerciseIds) if (progress.passed.has(id)) passed++;
    return {
      hasExercises: true,
      passed,
      total: exerciseIds.length,
      complete: passed === exerciseIds.length,
    };
  }

  function refreshNavCompletion(): void {
    for (const [i, link] of links.entries()) {
      const complete = pageState(i).complete;
      let marker = link.querySelector<HTMLElement>('.lw-nav-check');
      if (complete) {
        link.dataset.complete = 'true';
        link.setAttribute('aria-label', `${pages[i]!.title} (complete)`);
        if (marker === null) {
          marker = doc.createElement('span');
          marker.className = 'lw-nav-check';
          marker.setAttribute('aria-hidden', 'true');
          marker.textContent = '✓';
          link.appendChild(marker);
        }
      } else {
        delete link.dataset.complete;
        link.removeAttribute('aria-label');
        marker?.remove();
      }
    }
  }

  function pageListView(): HTMLElement {
    const view = doc.createElement('div');
    view.className = 'lw-rail-pages-list';
    view.dataset.test = 'nav-list';
    view.replaceChildren(...links);
    return view;
  }

  // ---- TOC & search ----
  const toc = new TocController(
    doc,
    win,
    chrome.contents,
    chrome.tocList,
    (href, event) => handleInternalLinkClick(href, event),
  );

  function renderNav(): void {
    const searching = renderSearchResults(
      chrome.searchInput.value,
      searchIndex,
      chrome.searchResults,
      doc,
      (href, event) => {
        if (!isPlainClick(event)) return;
        // Rendering the (now cleared) results detaches the clicked link, so
        // the browser's default hash navigation would never run.
        event.preventDefault();
        chrome.searchInput.value = '';
        renderNav();
        if (routing === 'memory') {
          const parsed = parseHashRoute(href);
          const page = slugs.indexOf(parsed.page);
          if (page !== -1) routeTo(page, parsed.section, false);
        } else if (win.location.hash === href) {
          routeFromHash(false);
        } else {
          win.location.hash = href;
        }
      },
    );
    if (searching) {
      chrome.contents.hidden = true;
      chrome.pageSlot.replaceChildren();
    } else {
      const showContents = navView === 'contents';
      chrome.contents.hidden = !showContents;
      chrome.pageSlot.replaceChildren(...(showContents ? [] : [pageListView()]));
    }
    toc.syncDom();
  }

  chrome.searchInput.addEventListener('input', () => renderNav());
  chrome.searchInput.addEventListener('search', () => renderNav());
  chrome.searchInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (chrome.searchInput.value === '') return;
      chrome.searchInput.value = '';
      renderNav();
      event.preventDefault();
      return;
    }
    if (event.key !== 'Enter') return;
    const first = chrome.searchResults.querySelector<HTMLAnchorElement>('a');
    if (first === null) return;
    event.preventDefault();
    first.click();
  });

  function syncViewButtons(): void {
    chrome.contentsBtn.setAttribute('aria-pressed', String(navView === 'contents'));
    chrome.pagesBtn.setAttribute('aria-pressed', String(navView === 'pages'));
    chrome.contentsBtn.dataset.active = String(navView === 'contents');
    chrome.pagesBtn.dataset.active = String(navView === 'pages');
  }

  function setView(view: NavView): void {
    if (view !== 'contents' && view !== 'pages') return;
    if (view === navView) return;
    navView = view;
    syncViewButtons();
    renderNav();
    if (view === 'contents') toc.setActive(toc.activeIndex === -1 ? 0 : toc.activeIndex);
  }

  // ---- panel host & active page state ----
  const panel = new PanelHost(chrome.panelPane, (visible) => {
    root.classList.toggle('lw-panel-attached', visible);
  });

  let active = -1;
  let blocks: BlockRuntime[] = [];
  let refreshActiveFooter: (() => void) | null = null;
  let pageSessions: Session[] = [];
  const warnedSessions = new Set<string>();

  // ---- lazy route preparation ----
  // A page with a lazy artifact loader must not swap until its artifacts are
  // cached. `routeToken` invalidates an older in-flight route on navigation;
  // `idle` is replaced by every pending route and resolved when one applies;
  // `ready` resolves once the initial route has applied.
  let routeToken = 0;
  let disposed = false;
  let idleResolve: (() => void) | null = null;
  let idlePromise: Promise<void> = Promise.resolve();
  const {
    promise: readyPromise,
    resolve: resolveReady,
  } = Promise.withResolvers<void>();
  let readyPending = true;

  /** Resolve the promises an applied route is holding. */
  function settleRoute(): void {
    if (readyPending) {
      readyPending = false;
      resolveReady();
    }
    if (idleResolve !== null) {
      const resolve = idleResolve;
      idleResolve = null;
      resolve();
    }
  }

  function setRouteBusy(busy: boolean): void {
    if (busy) {
      chrome.docPane.setAttribute('aria-busy', 'true');
      root.classList.add('lw-loading');
    } else {
      chrome.docPane.removeAttribute('aria-busy');
      root.classList.remove('lw-loading');
    }
  }

  /** The lazy loader for page `index`, unless its artifacts are cached. */
  function pageLoader(
    index: number,
  ): (() => Promise<Pick<TypstArtifacts, 'math' | 'diagrams'>>) | undefined {
    const file = pages[index]?.file;
    if (file === undefined || pageArtifacts.has(index)) return undefined;
    return opts.typst?.artifacts.pages?.[file];
  }

  const disposePageSessions = (): void => {
    for (const session of pageSessions) session.dispose();
    pageSessions = [];
  };

  // Delegate clicks on internal links inside prose (`a.lw-link[href^="#/"]`).
  const onDocPaneClick = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    const link = target?.closest?.('a.lw-link');
    if (link === null || link === undefined) return;
    const href = link.getAttribute('href');
    if (href !== null && href.startsWith('#/')) {
      handleInternalLinkClick(href, event);
    }
  };
  chrome.docPane.addEventListener('click', onDocPaneClick);

  function renderPage(index: number): void {
    if (index < 0 || index >= pages.length || index === active) return;
    for (const block of blocks) block.dispose();
    blocks = [];
    disposePageSessions();
    refreshActiveFooter = null;
    chrome.docPane.replaceChildren();
    if (active !== -1) panel.detach();
    active = index;

    const page = pages[index]!;
    if (updateDocTitle) {
      if (typeof opts.documentTitle === 'function') {
        doc.title = opts.documentTitle(page, brandText);
      } else {
        doc.title = brandText === '' ? page.title : `${page.title} · ${brandText}`;
      }
    }

    const parsed = parsedPages[index]!;
    const rendered = renderDocument(
      parsed.doc,
      (lang) => byLang.has(lang),
      {
        resolveLink: (target) => resolveLinkTarget(target, index, linkIndex, slugs),
        typst: pageTypst(index),
        doc,
      },
    );
    rendered.root.dataset.test = 'page';
    if (showOrgWarnings && parsed.diagnostics.length > 0) {
      chrome.docPane.appendChild(buildWarningsBanner(doc, parsed.diagnostics));
    }
    chrome.docPane.appendChild(rendered.root);

    const pageKey = pageKeys[index]!;
    const { footer, refresh } = buildPageFooter({
      doc,
      index,
      pages,
      slugs,
      getState: () => pageState(index),
      onToggleManual: () => {
        const progress = progressFor(pageKey);
        progress.manual = !progress.manual;
        store.writeProgress(pageKey, progress);
      },
      onRefreshNav: () => refreshNavCompletion(),
      onInternalLinkClick: (href, event) => handleInternalLinkClick(href, event),
    });
    refreshActiveFooter = refresh;
    chrome.docPane.appendChild(footer);

    toc.build(rendered.root, slugs[index]!);
    renderNav();

    const blockIds = pageBlockList[index]!;
    const progress = progressFor(pageKey);
    const onExerciseResult = (outcome: ExerciseOutcome): void => {
      if (outcome.passed) {
        const had = progress.passed.has(outcome.id);
        progress.passed.add(outcome.id);
        if (!had) store.writeProgress(pageKey, progress);
        refreshActiveFooter?.();
        refreshNavCompletion();
      }
      try {
        opts.onExerciseResult?.({ ...outcome, pageKey, pageIndex: index });
      } catch {
        /* a host callback must not break the page */
      }
    };

    const optionsFor = (blockIndex: number, lang: string): BlockRuntimeOptions => {
      const id = blockIds.ids.get(blockIndex)!;
      const customLang = opts.editorLanguages !== undefined && lang in opts.editorLanguages
        ? opts.editorLanguages[lang]
        : undefined;
      return {
        id,
        storage: opts.storage,
        storagePrefix,
        exercisePassed: progress.passed.has(id),
        onExerciseResult,
        editorTheme: opts.editorTheme,
        editorExtensions: opts.editorExtensions,
        editorLanguage: customLang,
      };
    };

    const newGroup = (
      session: Session,
      name: string,
      supported: boolean,
    ): SharedSession => ({
      session,
      name,
      supported,
      loadedSource: null,
      loadedBlock: null,
      queue: Promise.resolve(),
      blocks: [],
    });
    const groups = new Map<string, { shared: SharedSession; used: boolean }>();

    blocks = rendered.blocks.map((b) => {
      const kernel = byLang.get(b.node.lang)!;
      const name = parseBabelHeaders(b.node.headers).session;
      const events = { onActivity: (block: BlockRuntime) => panel.attach(block) };
      const blockOpts = optionsFor(b.index, b.node.lang);
      if (name === undefined) {
        return new BlockRuntime(
          b.node, b.index, kernel, b.mount, b.resultsEl, events, undefined, blockOpts);
      }
      const key = `${b.node.lang}\0${name}`;
      let group = groups.get(key);
      if (group === undefined) {
        const session = kernel.createSession();
        const supported = typeof session.resume === 'function';
        group = { shared: newGroup(session, name, supported), used: false };
        groups.set(key, group);
        pageSessions.push(session);
        if (!supported && !warnedSessions.has(key)) {
          warnedSessions.add(key);
          console.warn(
            `didact: :session ${name} is not supported by the ${b.node.lang} kernel; blocks run isolated`,
          );
        }
      }
      let shared: SharedSession;
      if (group.shared.supported || !group.used) {
        shared = group.shared;
        group.used = true;
      } else {
        const session = kernel.createSession();
        pageSessions.push(session);
        shared = newGroup(session, name, false);
      }
      return new BlockRuntime(
        b.node, b.index, kernel, b.mount, b.resultsEl, events, shared, blockOpts);
    });

    for (const [i, a] of links.entries()) {
      const on = i === index;
      a.classList.toggle('lw-nav-active', on);
      a.dataset.active = String(on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    refreshNavCompletion();
  }

  function emitNavigate(index: number, section: string | null): void {
    try {
      opts.onNavigate?.({
        index,
        slug: slugs[index]!,
        section,
        page: pages[index]!,
      });
    } catch {
      /* a host callback must not break navigation */
    }
  }

  /** Render/scroll/announce a route. Returns the canonical section slug when
   *  the section resolved, else `null`. */
  function applyRoute(
    pageIndex: number,
    sectionSlug: string | null,
    initial: boolean,
  ): string | null {
    const changed = pageIndex !== active;
    if (changed || initial) renderPage(pageIndex);
    const sectionIdx = toc.findSection(sectionSlug);
    if (sectionIdx >= 0) {
      const entry = toc.items[sectionIdx]!;
      openAncestorFolds(entry.heading);
      entry.heading.scrollIntoView({ behavior: changed || initial ? 'auto' : 'smooth' });
      toc.setActive(sectionIdx);
      emitNavigate(pageIndex, entry.slug);
      return entry.slug;
    }
    win.scrollTo({ top: 0, behavior: changed || initial ? 'auto' : 'smooth' });
    toc.setActive(0);
    emitNavigate(pageIndex, null);
    return null;
  }

  /**
   * Route to `pageIndex`, preparing lazy artifacts first when needed. With no
   * pending loader this is `applyRoute` plus `after` synchronously (eager
   * behavior unchanged). A pending loader keeps the old page visible, marks
   * the document pane busy, and applies the same route — including `after`
   * and the canonical hash write — only once the artifacts are cached. A
   * newer route invalidates this one via `routeToken`.
   */
  function routeTo(
    index: number,
    sectionSlug: string | null,
    initial: boolean,
    after?: (canonical: string | null) => void,
  ): void {
    const token = ++routeToken;
    const loader = pageLoader(index);

    if (loader === undefined) {
      setRouteBusy(false);
      const canonical = applyRoute(index, sectionSlug, initial);
      after?.(canonical);
      settleRoute();
      return;
    }

    setRouteBusy(true);
    // A newer pending route supersedes the previous one: release its idle
    // wait so no caller is left on a promise that can never settle.
    idleResolve?.();
    const idle = Promise.withResolvers<void>();
    idlePromise = idle.promise;
    idleResolve = idle.resolve;

    const applyLoaded = (): void => {
      setRouteBusy(false);
      const canonical = applyRoute(index, sectionSlug, initial);
      after?.(canonical);
      settleRoute();
    };

    let loading: Promise<Pick<TypstArtifacts, 'math' | 'diagrams'>>;
    try {
      loading = loader();
    } catch (error) {
      loading = Promise.reject(error);
    }

    loading.then(
      (artifacts) => {
        pageArtifacts.set(index, {
          math: artifacts.math,
          diagrams: artifacts.diagrams,
        });
        if (disposed || token !== routeToken) return;
        applyLoaded();
      },
      (error: unknown) => {
        // Cache the empty set so a retry does not loop on the same failure;
        // the renderer then shows the org source for missing artifacts.
        console.warn(
          `didact: failed to load typst artifacts for ${pages[index]?.file ?? `page ${index}`}; rendering without them`,
          error,
        );
        pageArtifacts.set(index, { math: {}, diagrams: {} });
        if (disposed || token !== routeToken) return;
        applyLoaded();
      },
    );
  }

  function defaultPageIndex(): number {
    if (opts.initialPage === undefined) return 0;
    const resolved = resolvePageRef(opts.initialPage, pages, slugs);
    return resolved === -1 ? 0 : resolved;
  }

  function routeFromHash(initial: boolean): void {
    const parsed = parseHashRoute(win.location.hash);
    const matched = slugs.indexOf(parsed.page);
    if (matched === -1) {
      const fallback = defaultPageIndex();
      routeTo(fallback, null, initial, () => {
        replaceHash(win, formatHash(slugs[fallback]!));
      });
      return;
    }
    routeTo(matched, parsed.section, initial);
  }

  function handleInternalLinkClick(href: string, event: MouseEvent): void {
    if (!isPlainClick(event)) return;
    if (routing === 'memory') {
      event.preventDefault();
      const parsed = parseHashRoute(href);
      const page = slugs.indexOf(parsed.page);
      if (page !== -1) routeTo(page, parsed.section, false);
      return;
    }
    // Same-hash clicks fire no browser hashchange: route explicitly so
    // re-clicking a nav/TOC/brand link still scrolls back to its target.
    if (win.location.hash === href) {
      event.preventDefault();
      routeFromHash(false);
    }
  }

  function show(index: number): void {
    if (index < 0 || index >= pages.length) return;
    if (index === active) {
      // Clicking the visible page is not navigation; cancel any other
      // page's pending load so it cannot swap in later.
      if (idleResolve !== null) {
        routeToken++;
        setRouteBusy(false);
        settleRoute();
      }
      return;
    }
    routeTo(index, null, false, () => {
      if (routing === 'hash') replaceHash(win, formatHash(slugs[index]!));
    });
  }

  function navigate(page: number | string, section?: string): void {
    const index = resolvePageRef(page, pages, slugs);
    if (index === -1) return;
    const sectionSlug = section !== undefined && section !== '' ? section : null;
    // Route first: rendering the target page rebuilds the TOC, so the
    // canonical section can only be known afterwards (an unknown section
    // leaves the plain page hash, never `#/<slug>/<unknown>`). With a lazy
    // page the write happens after the artifacts load and the swap.
    routeTo(index, sectionSlug, false, (canonical) => {
      if (routing === 'hash') {
        replaceHash(win, formatHash(slugs[index]!, canonical));
      }
    });
  }

  syncViewButtons();
  renderNav();
  applyNavSide();
  applyNavHidden();

  const onHashChange = (): void => routeFromHash(false);
  if (routing === 'hash') {
    win.addEventListener('hashchange', onHashChange);
    routeFromHash(true);
  } else {
    routeTo(defaultPageIndex(), null, true);
  }

  const disposeTooltips = installTooltips(root);

  return {
    get blocks(): readonly BlockRuntime[] {
      return blocks;
    },
    panel,
    get activeIndex(): number {
      return active;
    },
    get activeSlug(): string {
      return slugs[active] ?? slugs[0]!;
    },
    get navSide(): NavSide {
      return navSide;
    },
    get navView(): NavView {
      return navView;
    },
    get navHidden(): boolean {
      return navHidden;
    },
    get ready(): Promise<void> {
      return readyPromise;
    },
    get idle(): Promise<void> {
      return idlePromise;
    },
    show,
    navigate,
    setNavSide,
    setNavView: setView,
    setNavHidden,
    dispose(): void {
      disposed = true;
      routeToken++;
      settleRoute();
      setRouteBusy(false);
      disposeTooltips();
      if (routing === 'hash') win.removeEventListener('hashchange', onHashChange);
      chrome.docPane.removeEventListener('click', onDocPaneClick);
      for (const block of blocks) block.dispose();
      blocks = [];
      refreshActiveFooter = null;
      disposePageSessions();
      toc.dispose();
      releaseMathStyle?.();
      if (updateDocTitle) doc.title = originalDocTitle;
      root.replaceChildren();
      root.classList.remove(
        'lw-site',
        'lw-no-fonts',
        'lw-panel-attached',
        'lw-nav-left',
        'lw-nav-right',
        'lw-nav-hidden',
        'lw-loading',
      );
    },
  };
}
