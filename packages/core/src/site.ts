// site.ts — mountSite: parse → render → block runtimes + panel host.
//
// Layout: one navigation rail, the document column, and the panel rail.
// The panel rail (`lw-rail-right`) is the third zone: a zero-width right
// column until the first run/step attaches it, then it animates wide
// (clamp(420px, 42vw, 720px)) while the doc column keeps a readable
// measure. The NAVIGATOR is a single rail (`lw-rail lw-rail-nav`,
// `data-test="nav"`) that is the FIRST grid column by default and the
// LAST when moved (see `navSide` below); the document column always
// stays in the middle.
//
// The navigator shows ONE list at a time (`ALWAYS-ONE-LIST`): either this
// page's section contents (`data-test="toc"` with one
// `data-test="toc-item"` deep link per h2/h3) or the page list
// (`data-test="nav-list"` with one `data-test="nav-item"` per page). The
// unshown view is not painted: its slot is emptied, and the contents
// container is emptied and hidden while pages show. A header bar
// (small-caps tabs on a hairline) holds the segmented CONTENTS | PAGES
// switch (`data-test="rail-view-contents"` /
// `data-test="rail-view-pages"`, real <button type="button"> with
// aria-pressed) and a compact side toggle (`data-test="rail-side"`).
// The default view is contents (`MountOptions.navView` can open on the
// page list, which the example site does); a page switch keeps whichever
// view is showing — only the user switches views.
//
// Side convention (root class on the mount element, which also carries
// `lw-site`): `lw-nav-left` = navigator is the first grid column, its
// hairline on its right edge (default); `lw-nav-right` = navigator is the
// last grid column, its hairline on its left edge, document still in the
// middle and the panel rail between them. Exactly one of the two classes
// is present; the other is removed. Chosen at mount by
// `MountOptions.navSide`, changed at runtime by `SiteHandle.setNavSide`.
// The column order follows the side (theme.css), so the rail's track is
// always the 232px `auto` one, never the flexible document track. A
// non-default choice is persisted in
// localStorage under `didact:nav-side` (guarded: a throwing storage never
// breaks mounting and a call that fails to store still applies); clearing
// that key (or a stored value that is not 'left'/'right') returns to the
// option default.
//
// Routing is hash-based and uniform: a page's fragment is
// `#/<page-slug>`, a section's is `#/<page-slug>/<section-slug>` (both
// kebab-cased). Every nav and contents link is a real fragment href;
// hashchange switches pages (disposing the old page's blocks and
// detaching the panel) or scrolls within the current page. A scroll-spy
// keeps exactly one contents entry active; it never writes the hash.

import { parseBabelHeaders } from './babel';
import { BlockRuntime, type SharedSession } from './block';
import type { Kernel, Session } from './kernel';
import { parseOrgChecked } from './org';
import type { OrgDiagnostic, OrgDoc } from './org';
import { renderDocument, renderInline } from './render';
import { PanelHost } from './panel';
import type { BlockRuntimeOptions, ExerciseOutcome } from './teaching';
import { installTooltips } from './tooltip';
import { isTypstDiagram, type TypstRenderOptions } from './typst-source';
import './theme.css';

/** Navigator side: the grid column the navigation rail occupies. */
export type NavSide = 'left' | 'right';

/** Which list the navigator shows. */
export type NavView = 'contents' | 'pages';

/** localStorage key holding the user's navigator side ('left' | 'right'). */
const NAV_SIDE_KEY = 'didact:nav-side';

/** One lesson page: nav title plus its org source. */
export interface PageSpec {
  title: string;
  orgSource: string;
  /** Source file name (`python.org`), the name org links use
   *  (`[[file:python.org]]`). Defaults to `<page-slug>.org`; without it,
   *  `file:` links still resolve by page slug. */
  file?: string;
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
  /** Initial navigator side (default 'left'). A persisted choice
   *  (`localStorage['didact:nav-side']`) wins over this default. */
  navSide?: NavSide;
  /** Initial navigator view (default 'contents'). Not persisted: the
   *  example site opens on the page list. */
  navView?: NavView;
  /** Site wordmark in the navigator rail (default 'Didact'). */
  brand?: string;
  /** Build-time Typst artifacts for prose math and static diagrams.
   *  Absent → `$…$` stays literal and a `:results svg` block becomes an
   *  ordinary kernel block. */
  typst?: TypstRenderOptions;
}

export interface SiteHandle {
  /** Block runtimes on the active page, in document order. */
  readonly blocks: readonly BlockRuntime[];
  /** The under-the-hood panel host (panel rail). */
  readonly panel: PanelHost;
  /** 0-based index of the rendered page. */
  readonly activeIndex: number;
  /** Which side the navigator rail is on (root class `lw-nav-<side>`). */
  readonly navSide: NavSide;
  /** Which list the navigator shows: the active page's contents
   *  (default) or the page list. Never changed implicitly. */
  readonly navView: NavView;
  /** Render page `index` (disposes the current page's blocks first). */
  show(index: number): void;
  /** Move the navigator to `side` and persist the choice. */
  setNavSide(side: NavSide): void;
  /** Show `view` in the navigator (the user's explicit choice). */
  setNavView(view: NavView): void;
  dispose(): void;
}

/** Read the persisted navigator side; null when absent, malformed or the
 *  storage is unavailable (private mode, denied, disabled). */
function readStoredNavSide(): NavSide | null {
  try {
    const stored = window.localStorage.getItem(NAV_SIDE_KEY);
    return stored === 'left' || stored === 'right' ? stored : null;
  } catch {
    return null;
  }
}

/** Persist the navigator side; a throwing storage is ignored. */
function writeStoredNavSide(side: NavSide): void {
  try {
    window.localStorage.setItem(NAV_SIDE_KEY, side);
  } catch {
    /* storage denied: the choice still applies, it just does not survive */
  }
}

/** Typst math styles are per document, not per mount: live mounts that
 *  need the sheet share one `<style>` reference, and the last owner to
 *  dispose removes it. `owned` is false when the mount adopted a sheet it
 *  did not create (an externally supplied one), so dispose leaves it. */
interface MathStyleEntry {
  style: HTMLStyleElement;
  owners: number;
  owned: boolean;
}
const mathStyles = new WeakMap<Document, MathStyleEntry>();

export function mountSite(opts: MountOptions): SiteHandle {
  const { root, kernels, pages } = opts;
  if (pages.length === 0) throw new Error('mountSite: at least one page is required');
  const byLang = new Map(kernels.map((k) => [k.id, k] as const));
  // every node is created in the ROOT's document: a mount can be handed an
  // element from another document (an iframe, a test environment) and
  // insertBefore/replaceChildren across documents silently drop nodes
  const doc = root.ownerDocument ?? document;

  // URL slugs are needed by the brand link before the first page is built.
  const slugs = pageSlugs(pages);
  // Storage/completion identity: the source file when one is named (a
  // rename or slug collision must not move a learner's progress), else
  // the URL slug. Block ids and progress keys both use this.
  const pageKeys = pages.map((page, i) => page.file ?? slugs[i]!);
  // Heading slugs must match what the rendered TOC sees: org inline markup
  // (links, emphasis, math) can change the visible text.
  const headingText = (text: string): string => {
    const holder = doc.createElement('div');
    renderInline(text, holder, { typst: opts.typst });
    return holder.textContent ?? '';
  };

  root.classList.add('lw-site');
  if (opts.fonts === false) root.classList.add('lw-no-fonts');

  // Typst emits its MathML layout rules with each HTML compile; the build
  // pipeline keeps one copy per mounted document, shared by every live
  // mount that needs it.
  const mathCss = opts.typst?.artifacts.mathCss ?? '';
  /** This mount's reference to the document's math sheet, or null when it
   *  needs none. Released (and the sheet removed with its last owner) in
   *  `dispose()`. */
  let mathStyle: MathStyleEntry | null = null;
  if (mathCss !== '') {
    const tracked = mathStyles.get(doc);
    if (tracked !== undefined) {
      tracked.style.textContent = mathCss;
      tracked.owners++;
      mathStyle = tracked;
    } else {
      // an untracked sheet (supplied from outside this module) is adopted,
      // never removed by the mount that did not create it
      const found = doc.head?.querySelector<HTMLStyleElement>(
        'style[data-test="typst-math-css"]',
      ) ?? null;
      const style = found ?? doc.createElement('style');
      if (found === null) {
        style.dataset.test = 'typst-math-css';
        (doc.head ?? root).appendChild(style);
      }
      style.textContent = mathCss;
      const entry: MathStyleEntry = { style, owners: 1, owned: found === null };
      mathStyles.set(doc, entry);
      mathStyle = entry;
    }
  }

  // ---- navigator rail: ONE list at a time (contents | pages) ----
  const navSideDefault: NavSide = opts.navSide === 'right' ? 'right' : 'left';
  let navSide: NavSide = readStoredNavSide() ?? navSideDefault;
  let navView: NavView = opts.navView === 'pages' ? 'pages' : 'contents';

  const rail = doc.createElement('nav');
  rail.className = 'lw-rail lw-rail-nav';
  rail.dataset.test = 'nav';

  // Wordmark: the first thing in the rail, a real link home.
  const brand = doc.createElement('a');
  brand.className = 'lw-brand';
  brand.dataset.test = 'brand';
  brand.href = `#/${slugs[0]}`;
  brand.textContent = opts.brand ?? 'Didact';

  // Lesson search sits above the CONTENTS | PAGES switch; results replace
  // whichever nav list was showing (see renderSearch).
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

  /** A segmented-switch button: small-caps label, aria-pressed state. */
  const railViewButton = (view: NavView, label: string): HTMLButtonElement => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'lw-nav-tab';
    button.dataset.test = `rail-view-${view}`;
    button.dataset.view = view;
    button.textContent = label;
    button.addEventListener('click', () => setView(view));
    navSwitch.appendChild(button);
    return button;
  };
  const contentsBtn = railViewButton('contents', 'Contents');
  const pagesBtn = railViewButton('pages', 'Pages');

  const sideBtn = doc.createElement('button');
  sideBtn.type = 'button';
  sideBtn.className = 'lw-nav-side';
  sideBtn.dataset.test = 'rail-side';

  railHead.append(navSwitch, sideBtn);

  // the contents container: always in the rail, hidden while pages show
  const contents = doc.createElement('nav');
  contents.className = 'lw-contents';
  contents.dataset.test = 'toc';
  const tocList = doc.createElement('div');
  tocList.className = 'lw-toc-list';
  contents.appendChild(tocList);

  // the pages view's slot in the rail: empty (and unpainted) while the
  // contents show; renderNav mounts the pages list into it on demand
  const pageSlot = doc.createElement('div');
  pageSlot.className = 'lw-nav-slot';

  rail.append(brand, searchInput, railHead, contents, pageSlot, searchResults);

  // ---- document column
  const docPane = doc.createElement('div');
  docPane.className = 'lw-doc-pane';

  // ---- panel rail: zero-width until a panel attaches (theme.css)
  const railRight = doc.createElement('aside');
  railRight.className = 'lw-rail lw-rail-right';
  const panelPane = doc.createElement('div');
  panelPane.className = 'lw-panel-pane';
  railRight.appendChild(panelPane);

  const layout = doc.createElement('div');
  layout.className = 'lw-layout';
  layout.append(rail, docPane, railRight);
  root.appendChild(layout);

  /** Apply the side: root classes + which end of the grid the rail takes.
   *  Right mode appends the navigator after the panel rail, so the rail
   *  stays on the page's right edge (theme.css assigns the matching
   *  column template); the document stays in the middle. */
  function applyNavSide(): void {
    root.classList.toggle('lw-nav-left', navSide === 'left');
    root.classList.toggle('lw-nav-right', navSide === 'right');
    const target: NavSide = navSide === 'left' ? 'right' : 'left';
    // the label names the ACTION (where a click moves the rail), not the
    // current side; the current side is visible in the layout itself
    sideBtn.textContent = target === 'left' ? '← Left' : 'Right →';
    sideBtn.title = `Move navigation to the ${target}`;
    sideBtn.setAttribute('aria-label', `Move navigation to the ${target}`);
    if (navSide === 'left') layout.prepend(rail);
    else layout.append(rail);
  }

  function setNavSide(side: NavSide): void {
    if (side !== 'left' && side !== 'right') return;
    navSide = side;
    applyNavSide();
    writeStoredNavSide(side);
  }

  sideBtn.addEventListener('click', () => {
    setNavSide(navSide === 'left' ? 'right' : 'left');
  });

  /** ALWAYS-ONE-LIST, or the search results: exactly ONE list paints in
   *  the rail. Contents view: the contents container (`data-test="toc"`,
   *  built per page) shows, and the pages slot holds nothing. Pages view:
   *  the contents container is hidden and the pages slot holds a freshly
   *  mounted `data-test="nav-list"` with one link per page. A live search
   *  (≥2 trimmed characters) paints `data-test="search-results"` instead
   *  and leaves both nav lists empty. Called on mount, every view change,
   *  every search edit and every page build. */
  function renderNav(): void {
    if (renderSearch()) {
      (contents as HTMLElement).hidden = true;
      pageSlot.replaceChildren();
    } else {
      const showContents = navView === 'contents';
      (contents as HTMLElement).hidden = !showContents;
      pageSlot.replaceChildren(...(showContents ? [] : [pageListView()]));
    }
    if (tocList.childElementCount !== tocEntries.length) {
      tocList.replaceChildren(...tocEntries.map((e) => e.link));
    }
  }

  /** Paint the search results for the current input; true when a live
   *  search owns the rail. Every entry is built with textContent, so org
   *  prose can never inject markup. */
  function renderSearch(): boolean {
    const query = searchInput.value.trim();
    if (query.length < 2) {
      searchResults.replaceChildren();
      searchResults.hidden = true;
      return false;
    }
    const tokens = query.toLowerCase().split(/\s+/).filter((token) => token !== '');
    const found: SearchChunk[] = [];
    for (const chunk of searchIndex) {
      const haystack = `${chunk.title} ${chunk.text}`.toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) continue;
      found.push(chunk);
      if (found.length === SEARCH_RESULT_LIMIT) break;
    }
    searchResults.replaceChildren(
      ...(found.length === 0
        ? [searchEmptyState()]
        : found.map((chunk) => searchResultLink(chunk, tokens[0]!))));
    searchResults.hidden = false;
    return true;
  }

  /** A live search that matched nothing: the rail keeps saying what it is
   *  (an empty column reads as a rendering bug). */
  function searchEmptyState(): HTMLElement {
    const empty = doc.createElement('p');
    empty.className = 'lw-search-empty';
    empty.dataset.test = 'search-empty';
    empty.textContent = 'No lessons match';
    return empty;
  }

  function searchResultLink(chunk: SearchChunk, token: string): HTMLAnchorElement {
    const link = doc.createElement('a');
    link.className = 'lw-search-result';
    link.href = chunk.href;
    const title = doc.createElement('span');
    title.className = 'lw-search-result-title';
    title.textContent = chunk.title;
    const snippet = doc.createElement('span');
    snippet.className = 'lw-search-result-snippet';
    snippet.textContent = searchSnippet(chunk.text, token);
    link.append(title, snippet);
    // Following a result ends the search: the rail returns to the nav view
    // the learner had before typing, so the destination page is not hidden
    // behind stale results.
    link.addEventListener('click', () => {
      // A hit for the fragment already in the URL fires no hashchange, so
      // route it explicitly: the query clear must not swallow the jump.
      const sameHash = location.hash === chunk.href;
      searchInput.value = '';
      renderNav();
      if (sameHash) routeAndScroll(false);
    });
    return link;
  }

  searchInput.addEventListener('input', () => renderNav());
  // the native clear affordance of <input type=search> fires `search`
  searchInput.addEventListener('search', () => renderNav());
  searchInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (searchInput.value === '') return;
      searchInput.value = '';
      renderNav();
      event.preventDefault();
      return;
    }
    if (event.key !== 'Enter') return;
    const first = searchResults.querySelector<HTMLAnchorElement>('a');
    if (first === null) return;
    event.preventDefault();
    first.click(); // the fragment href routes like any other link
  });

  function syncViewButtons(): void {
    contentsBtn.setAttribute('aria-pressed', String(navView === 'contents'));
    pagesBtn.setAttribute('aria-pressed', String(navView === 'pages'));
    contentsBtn.dataset.active = String(navView === 'contents');
    pagesBtn.dataset.active = String(navView === 'pages');
  }

  function setView(view: NavView): void {
    if (view !== 'contents' && view !== 'pages') return;
    if (view === navView) return;
    navView = view;
    syncViewButtons();
    renderNav();
    // never implicitly: the active entry is where the user left it
    if (view === 'contents') setActiveToc(tocActive === -1 ? 0 : tocActive);
  }

  // attaching/detaching only modulates the root class: the panel rail
  // animates from 0 to the panel measure (theme.css)
  const panel = new PanelHost(panelPane, (visible) => {
    root.classList.toggle('lw-panel-attached', visible);
  });

  let active = -1;
  let blocks: BlockRuntime[] = [];
  /** Repaints the visible page's footer (progress + nav markers) after an
   *  exercise pass or a manual completion toggle. Null between pages. */
  let refreshActiveFooter: (() => void) | null = null;
  // Page-scoped sessions: every `:session <name>` group's instance (plus
  // the isolated instances handed to blocks whose kernel cannot resume).
  // Host-owned — BlockRuntime never disposes these; the page switch and
  // dispose do, after the blocks are gone.
  let pageSessions: Session[] = [];
  // Unsupported-group warnings are issued once per mount, not per rebuild.
  const warnedSessions = new Set<string>();
  const disposePageSessions = (): void => {
    for (const session of pageSessions) session.dispose();
    pageSessions = [];
  };
  // Parsed once: the rendered page and the link index read the same doc.
  // Diagnostics are unsupported-construct reports, surfaced per page in
  // the document column (and logged here, once per page build).
  const parsedPages = pages.map((page) => {
    const parsed = parseOrgChecked(page.orgSource);
    if (parsed.diagnostics.length > 0) {
      const lines = parsed.diagnostics.map((d) => `  line ${d.line}: ${d.message}`);
      console.warn(
        [`didact: ${page.title} has ${parsed.diagnostics.length} org diagnostic(s)`,
          ...lines].join('\n'),
      );
    }
    return parsed;
  });
  const linkIndex = pages.map(
    (page, i) => buildPageLinkIndex(
      page, parsedPages[i]!.doc, slugs[i]!, headingText));
  // Stable page-scoped block ids plus the checked exercises each page
  // carries, computed eagerly: the page list marks completion for every
  // page, not only the rendered one. Fold bodies are walked in place, in
  // document order, matching the renderer's flattened block numbering.
  // Exactly renderDocument's rule: a registered language, and not a static
  // Typst diagram (those are build-time SVG, never an editor or a kernel).
  const pageBlockList = parsedPages.map((parsed, i) =>
    pageBlockIds(parsed.doc, pageKeys[i]!, (node) =>
      byLang.has(node.lang)
      && !(opts.typst !== undefined && isTypstDiagram(node))));
  // One flat index for lesson search: page titles, headings, prose, list
  // items and table cells, with fold children folded into their section.
  const searchIndex = pages.flatMap(
    (page, i) => searchChunksForPage(
      page, parsedPages[i]!.doc, slugs[i]!, headingText));
  const links = pages.map((page, i) => {
    const a = doc.createElement('a');
    a.className = 'lw-nav-link';
    a.dataset.test = 'nav-item';
    // real fragment href: the click sets the hash, hashchange does the
    // switch (so the URL always names the visible page)
    a.href = `#/${slugs[i]}`;
    a.textContent = page.title;
    return a;
  });
  // Completion state per page identity, read from storage on first use.
  const progressCache = new Map<string, PageProgress>();
  const progressFor = (pageSlug: string): PageProgress => {
    let progress = progressCache.get(pageSlug);
    if (progress === undefined) {
      progress = readProgress(pageSlug);
      progressCache.set(pageSlug, progress);
    }
    return progress;
  };

  interface PageState {
    /** The page carries checked exercises (their passes decide completion). */
    hasExercises: boolean;
    passed: number;
    total: number;
    complete: boolean;
  }

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

  /** Mirror completion onto the page links (`data-complete="true"`, a ✓
   *  marker, and an accessible "(complete)" suffix — the ✓ alone is
   *  aria-hidden). Links exist whether or not the pages view is mounted. */
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

  /** The pages view's list: one `data-test="nav-item"` link per page. */
  function pageListView(): HTMLElement {
    const view = doc.createElement('div');
    view.className = 'lw-rail-pages-list';
    view.dataset.test = 'nav-list';
    view.replaceChildren(...links);
    return view;
  }

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
    revealActiveToc();
  }

  /** Keep the active entry visible when the rail's contents column
   *  overflows. The list is laid out inside the rail, above or beside
   *  the document — a link brought into view must never scroll the
   *  DOCUMENT (that would corrupt the scroll position the spy reads), so
   *  only the overflowing list is scrolled directly, by the minimal
   *  amount that brings the entry back into the column's box. A no-op
   *  in DOMs without layout (tests) and when everything fits. */
  function revealActiveToc(): void {
    const link = tocEntries[tocActive]?.link;
    if (!link) return;
    const column = contents;
    const box = column.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    if (box.height === 0 || box.bottom === box.top) return; // not laid out
    if (item.top < box.top) column.scrollTop -= box.top - item.top;
    else if (item.bottom > box.bottom) column.scrollTop += item.bottom - box.bottom;
  }

  /** Active entry = the heading nearest the viewport top: the last one
   *  whose top edge crossed the threshold line (the section currently
   *  being read); above the first heading → the first entry. At the
   *  bottom of the page the last entry wins — a short final section
   *  can never cross the line on its own. Headings folded away (a closed
   *  `<details>`) have no rendered box and are skipped: a zero rect at
   *  the top must not outrank the section actually being read. */
  function spyUpdate(): void {
    const rects = tocEntries.map((entry) => entry.heading.getBoundingClientRect());
    // a real layout gives at least one heading a box; in a layout-less
    // DOM every rect is zero, so zero means nothing there
    const laidOut = rects.some((rect) => rect.width !== 0 || rect.height !== 0);
    const samples = tocEntries.map((entry, i) => {
      const rect = rects[i]!;
      return {
        top: rect.top,
        hidden: isInClosedFold(entry.heading)
          || (laidOut && rect.width === 0 && rect.height === 0),
      };
    });
    const docEl = doc.documentElement;
    // a document that cannot scroll is never "at the bottom": every
    // heading is visible, so the first (not the last) owns the spotlight
    const atBottom = docEl.scrollHeight > window.innerHeight + 2
      && window.scrollY + window.innerHeight >= docEl.scrollHeight - 2;
    const best = selectActiveHeading(samples, atBottom);
    if (best !== -1) setActiveToc(best);
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
   *  anchors survive insertions above them. The built entries are put
   *  into the DOM only while the contents view is showing (see
   *  renderNav), so the rail never carries both lists. */
  function buildToc(docRoot: HTMLElement, pageSlugStr: string): void {
    disposeToc();
    const headings = Array.from(
      docRoot.querySelectorAll<HTMLElement>('h2.lw-heading, h3.lw-heading'));
    const nextSlug = sectionSlugger();
    tocEntries = headings.map((heading, i) => {
      const unique = nextSlug(heading.textContent ?? '', i);
      heading.id = `lw-h-${unique}`;
      const link = doc.createElement('a');
      link.className = 'lw-toc-item';
      if (heading.tagName === 'H3') link.classList.add('lw-toc-sub');
      link.dataset.test = 'toc-item';
      link.href = `#/${pageSlugStr}/${unique}`;
      link.textContent = heading.textContent ?? '';
      return { heading, link, slug: unique };
    });
    setActiveToc(0);
    renderNav(); // exactly one list in the rail after every page build
    if (tocEntries.length === 0 || typeof IntersectionObserver === 'undefined') {
      return; // tests/old DOMs: the hashchange path still works
    }
    // cheap spy: recompute only when a heading crosses the viewport,
    // never per scroll frame
    spy = new IntersectionObserver(() => spyUpdate());
    for (const { heading } of tocEntries) spy.observe(heading);
  }

  /** Unsupported-construct report for one page: a hairline band above
   *  the article. Real DOM + textContent only (messages are source
   *  text, never markup); absent entirely when the page is clean. */
  function warningsBanner(diagnostics: readonly OrgDiagnostic[]): HTMLElement {
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

  /** Per-page footer after the article: previous/next lesson links in
   *  PAGE order (omitted at the ends), the completion reading, and — on
   *  pages with no checked exercises — a manual completion toggle. */
  function buildFooter(index: number): HTMLElement {
    const footer = doc.createElement('footer');
    footer.className = 'lw-page-footer';
    footer.dataset.test = 'page-footer';

    if (index > 0 || index < pages.length - 1) {
      const prevnext = doc.createElement('nav');
      prevnext.className = 'lw-prevnext';
      prevnext.dataset.test = 'prevnext';
      prevnext.setAttribute('aria-label', 'Lesson navigation');
      const lessonLink = (target: number, rel: 'prev' | 'next'): HTMLAnchorElement => {
        const link = doc.createElement('a');
        link.className = 'lw-prevnext-link';
        link.rel = rel;
        link.href = `#/${slugs[target]}`;
        link.textContent = pages[target]!.title;
        link.setAttribute(
          'aria-label',
          `${rel === 'prev' ? 'Previous' : 'Next'} lesson: ${pages[target]!.title}`);
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
    const pageKey = pageKeys[index]!;
    const renderState = (): void => {
      const state = pageState(index);
      progressEl.textContent = state.hasExercises
        ? `Exercises ${state.passed}/${state.total}`
        : state.complete ? 'Page complete' : 'Not complete';
      if (toggle !== null) {
        toggle.textContent = state.complete ? 'Mark incomplete' : 'Mark complete';
        toggle.setAttribute('aria-pressed', String(state.complete));
      }
      refreshNavCompletion();
    };

    if (!pageState(index).hasExercises) {
      toggle = doc.createElement('button');
      toggle.type = 'button';
      toggle.className = 'lw-page-complete';
      toggle.dataset.test = 'page-complete';
      toggle.addEventListener('click', () => {
        const progress = progressFor(pageKey);
        progress.manual = !progress.manual;
        writeProgress(pageKey, progress);
        renderState();
      });
      meta.appendChild(toggle);
    }

    footer.appendChild(meta);
    renderState();
    refreshActiveFooter = renderState;
    return footer;
  }

  function show(index: number): void {
    if (index < 0 || index >= pages.length || index === active) return;
    for (const block of blocks) block.dispose();
    blocks = [];
    disposePageSessions(); // page-scoped: the previous page's sessions end here
    refreshActiveFooter = null; // the old footer leaves with the old page
    docPane.replaceChildren();
    if (active !== -1) panel.detach(); // page switch: panel detaches
    active = index;

    const parsed = parsedPages[index]!;
    const rendered = renderDocument(
      parsed.doc,
      (lang) => byLang.has(lang),
      {
        resolveLink: (target) => resolveLinkTarget(target, index, linkIndex, slugs),
        typst: opts.typst,
      },
    );
    rendered.root.dataset.test = 'page';
    if (parsed.diagnostics.length > 0) {
      docPane.appendChild(warningsBanner(parsed.diagnostics));
    }
    docPane.appendChild(rendered.root);
    docPane.appendChild(buildFooter(index));
    buildToc(rendered.root, slugs[index]!);

    const pageKey = pageKeys[index]!;
    const blockIds = pageBlockList[index]!;
    const progress = progressFor(pageKey);
    const onExerciseResult = (outcome: ExerciseOutcome): void => {
      if (!outcome.passed) return;
      const had = progress.passed.has(outcome.id);
      progress.passed.add(outcome.id);
      if (!had) writeProgress(pageKey, progress);
      refreshActiveFooter?.();
      refreshNavCompletion();
    };
    const optionsFor = (blockIndex: number): BlockRuntimeOptions => {
      // pageBlockIds numbers exactly the blocks the renderer makes
      // executable (registered language, not a static diagram), so every
      // rendered block has an id.
      const id = blockIds.ids.get(blockIndex)!;
      return {
        id,
        exercisePassed: progress.passed.has(id),
        onExerciseResult,
      };
    };

    // One Session per (kernel id, `:session <name>`) on this page; a
    // session-capable kernel shares it across the group's blocks, a
    // kernel without resume() gets isolated sessions and a visible
    // unsupported badge. Normal blocks (no :session) keep their own.
    // Every wrapper carries its own group state: program identity, a
    // serialized operation queue, and its member blocks.
    const newGroup = (
      session: Session,
      name: string,
      supported: boolean,
    ): SharedSession => ({
      session,
      name,
      supported,
      loadedSource: null,
      queue: Promise.resolve(),
      blocks: [],
    });
    const groups = new Map<string, { shared: SharedSession; used: boolean }>();
    blocks = rendered.blocks.map((b) => {
      const kernel = byLang.get(b.node.lang)!;
      const name = parseBabelHeaders(b.node.headers).session;
      const events = { onActivity: (block: BlockRuntime) => panel.attach(block) };
      if (name === undefined) {
        return new BlockRuntime(
          b.node, b.index, kernel, b.mount, b.resultsEl, events,
          undefined, optionsFor(b.index));
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
        // unsupported kernel: every block after the first runs isolated in
        // its own fresh session, so each gets a wrapper of its own (and a
        // reset can never invalidate another block's output).
        const session = kernel.createSession();
        pageSessions.push(session);
        shared = newGroup(session, name, false);
      }
      return new BlockRuntime(
        b.node, b.index, kernel, b.mount, b.resultsEl, events,
        shared,
        optionsFor(b.index));
    });

    for (const [i, a] of links.entries()) {
      const on = i === index;
      a.classList.toggle('lw-nav-active', on);
      a.dataset.active = String(on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    refreshNavCompletion();
    // the view is the user's choice: a page switch never changes it
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
   *  page, so the lookup happens after any switch). An unknown page
   *  slug resolves to the first page and the URL is normalized to
   *  name it; a page-level hash (no section) means the top of the
   *  page — also clearing any scroll left over from the last page. */
  function routeAndScroll(initial: boolean): void {
    const rawSlug = location.hash.replace(/^#\/?/, '').split('/')[0] ?? '';
    const page = pageFromHash();
    if (slugs.indexOf(rawSlug) === -1) {
      history.replaceState(null, '', `#/${slugs[page]}`);
    }
    const changed = page !== active;
    if (changed || initial) show(page);
    const section = sectionFromHash();
    if (section >= 0) {
      const heading = tocEntries[section]!.heading;
      openAncestorFolds(heading);
      heading.scrollIntoView(
        { behavior: changed || initial ? 'auto' : 'smooth' });
      setActiveToc(section);
    } else {
      window.scrollTo(
        { top: 0, behavior: changed || initial ? 'auto' : 'smooth' });
      setActiveToc(0); // the top of the page: first section active
    }
  }

  syncViewButtons();
  renderNav();          // …painted before the first route build
  applyNavSide();
  const onHashChange = (): void => routeAndScroll(false);
  window.addEventListener('hashchange', onHashChange);
  routeAndScroll(true); // builds the first page (and its contents)
  const disposeTooltips = installTooltips(root);

  return {
    get blocks(): readonly BlockRuntime[] {
      return blocks;
    },
    panel,
    get activeIndex(): number {
      return active;
    },
    get navSide(): NavSide {
      return navSide;
    },
    get navView(): NavView {
      return navView;
    },
    show,
    setNavSide,
    setNavView: setView,
    dispose(): void {
      disposeTooltips();
      window.removeEventListener('hashchange', onHashChange);
      for (const block of blocks) block.dispose();
      blocks = [];
      refreshActiveFooter = null;
      disposePageSessions();
      disposeToc();
      if (mathStyle !== null) {
        const entry = mathStyles.get(doc);
        if (entry === mathStyle) {
          entry.owners--;
          if (entry.owners <= 0) {
            mathStyles.delete(doc);
            if (entry.owned) entry.style.remove();
          }
        }
        mathStyle = null;
      }
      root.replaceChildren();
      root.classList.remove(
        'lw-site', 'lw-no-fonts', 'lw-panel-attached', 'lw-nav-left', 'lw-nav-right');
      // the persisted side is deliberately kept: the next mount restores it
    },
  };
}

/** A section heading can live inside a closed hint/solution (nested folds
 *  too): open every ancestor `<details>` so the scroll we are about to do
 *  lands on visible content instead of a zero-height closed region. */
function openAncestorFolds(el: HTMLElement): void {
  for (let parent = el.parentElement; parent !== null; parent = parent.parentElement) {
    if (parent.localName === 'details') (parent as HTMLDetailsElement).open = true;
  }
}

/** Heading-slug generator shared by the rendered contents and the link
 *  index: kebab-case, deduplicated in document order, `section-N` when the
 *  heading has no ASCII. */
function sectionSlugger(): (text: string, index: number) => string {
  const taken = new Set<string>();
  return (text, index) => {
    const base = kebab(text) || `section-${index + 1}`;
    let unique = base;
    for (let n = 2; taken.has(unique); n++) unique = `${base}-${n}`;
    taken.add(unique);
    return unique;
  };
}

/** Stable page-scoped block ids and the checked exercises a page carries.
 *  `ids` maps the renderer's 1-based executable-block index to
 *  `<page-file>:n:<name>` (when `#+NAME` is unique on the page) or
 *  `<page-file>:h:<code-hash>:<occurrence>`; duplicate names and repeated
 *  samples therefore never collide. */
interface PageBlockIds {
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
function pageBlockIds(
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

/** One search hit: a page or section, with its own title and prose. */
interface SearchChunk {
  /** Fragment href: `#/<page-slug>` or `#/<page-slug>/<section-slug>`. */
  href: string;
  title: string;
  text: string;
}

const SEARCH_RESULT_LIMIT = 10;

/** The viewport line (px from the top) a section heading must cross to
 *  own the contents spotlight. */
const SPY_LINE = 96;

/** One heading's scroll-spy sample. */
export interface SpySample {
  /** Viewport-relative top edge of the heading (`DOMRect.top`). */
  top: number;
  /** The heading cannot be seen: it sits in a closed `<details>`, or its
   *  box is degenerate in a laid-out document. */
  hidden: boolean;
}

/** The active contents entry for a scroll position: the last VISIBLE
 *  heading whose top crossed the spotlight line, else the first visible
 *  heading; at the document bottom the last visible heading wins (a short
 *  final section can never cross the line). -1 when every heading is
 *  hidden. */
export function selectActiveHeading(
  samples: readonly SpySample[],
  atBottom: boolean,
): number {
  let first = -1;
  let best = -1;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    if (sample.hidden) continue;
    if (first === -1) first = i;
    if (sample.top > SPY_LINE) break;
    best = i;
  }
  if (first === -1) return -1;
  if (atBottom) {
    for (let i = samples.length - 1; i >= 0; i--) {
      if (!samples[i]!.hidden) return i;
    }
  }
  return best === -1 ? first : best;
}

/** True when the element sits inside a closed `<details>`: nothing there
 *  is rendered, so its zero rect must never win the scroll spy. */
export function isInClosedFold(el: HTMLElement): boolean {
  for (let parent = el.parentElement; parent !== null; parent = parent.parentElement) {
    if (parent.localName === 'details'
      && !(parent as HTMLDetailsElement).open) return true;
  }
  return false;
}

/** Flatten one page into searchable chunks: the page intro (title plus
 *  prose before the first heading), then one chunk per h2/h3. Folds are
 *  walked in place — their headings open sections and their prose joins
 *  the surrounding chunk. Heading text comes through the real inline
 *  renderer (the TOC's text), and section slugs come from the same
 *  slugger, so a result URL always resolves. */
function searchChunksForPage(
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
function searchSnippet(text: string, token: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 140) return clean;
  const at = clean.toLowerCase().indexOf(token.toLowerCase());
  const start = at <= 60 ? 0 : at - 60;
  let out = clean.slice(start, start + 140);
  if (start > 0) out = `…${out.slice(1)}`;
  if (start + 140 < clean.length) out = `${out.slice(0, 139)}…`;
  return out;
}

/** Per-page completion state persisted under
 *  `didact:progress:<page file or slug>`. */
interface PageProgress {
  /** Block ids of exercises that passed. */
  passed: Set<string>;
  /** Manual completion flag (pages without checked exercises). */
  manual: boolean;
}

const PROGRESS_PREFIX = 'didact:progress:';

/** Read one page's stored progress; malformed JSON, a foreign shape or a
 *  denied storage yields a clean slate. */
function readProgress(slug: string): PageProgress {
  const progress: PageProgress = { passed: new Set(), manual: false };
  try {
    const raw = globalThis.localStorage?.getItem(`${PROGRESS_PREFIX}${slug}`);
    if (raw === null || raw === undefined) return progress;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return progress;
    const record = parsed as { passed?: unknown; manual?: unknown };
    if (Array.isArray(record.passed)) {
      for (const id of record.passed) if (typeof id === 'string') progress.passed.add(id);
    }
    if (typeof record.manual === 'boolean') progress.manual = record.manual;
  } catch {
    /* malformed or storage denied: start clean */
  }
  return progress;
}

/** Persist one page's progress; a throwing storage is ignored. */
function writeProgress(slug: string, progress: PageProgress): void {
  try {
    globalThis.localStorage?.setItem(
      `${PROGRESS_PREFIX}${slug}`,
      JSON.stringify({ passed: [...progress.passed], manual: progress.manual }),
    );
  } catch {
    /* storage denied: the state still applies in this session */
  }
}

/** What a link can name on one page: its file, and its h2/h3 headings. */
interface PageLinkIndex {
  /** Source file name, lowercased (`python.org`). */
  file: string;
  slug: string;
  /** Heading text and its kebab form → section slug. */
  byHeading: Map<string, string>;
  sections: Set<string>;
}

function buildPageLinkIndex(
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
      byHeading.set(text.replace(/\s+/g, ' ').toLowerCase(), section);
      byHeading.set(kebab(text), section);
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
function findPageIndex(ref: string, index: readonly PageLinkIndex[]): number {
  const clean = ref.trim().replace(/^\.\//, '').toLowerCase();
  if (clean === '') return -1;
  const stem = clean.replace(/\.org$/, '');
  for (let i = 0; i < index.length; i++) {
    const page = index[i]!;
    if (clean === page.file || stem === page.file.replace(/\.org$/, '')
      || stem === page.slug) return i;
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
function resolveLinkTarget(
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
