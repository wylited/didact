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

import { BlockRuntime } from './block';
import type { Kernel } from './kernel';
import { parseOrgChecked } from './org';
import type { OrgDiagnostic, OrgDoc } from './org';
import { renderDocument } from './render';
import { PanelHost } from './panel';
import { installTooltips } from './tooltip';
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

export function mountSite(opts: MountOptions): SiteHandle {
  const { root, kernels, pages } = opts;
  if (pages.length === 0) throw new Error('mountSite: at least one page is required');
  const byLang = new Map(kernels.map((k) => [k.id, k] as const));
  // every node is created in the ROOT's document: a mount can be handed an
  // element from another document (an iframe, a test environment) and
  // insertBefore/replaceChildren across documents silently drop nodes
  const doc = root.ownerDocument ?? document;

  root.classList.add('lw-site');
  if (opts.fonts === false) root.classList.add('lw-no-fonts');

  // ---- navigator rail: ONE list at a time (contents | pages) ----
  const navSideDefault: NavSide = opts.navSide === 'right' ? 'right' : 'left';
  let navSide: NavSide = readStoredNavSide() ?? navSideDefault;
  let navView: NavView = opts.navView === 'pages' ? 'pages' : 'contents';

  const rail = doc.createElement('nav');
  rail.className = 'lw-rail lw-rail-nav';
  rail.dataset.test = 'nav';

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

  rail.append(railHead, contents, pageSlot);

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

  /** ALWAYS-ONE-LIST: exactly ONE list paints in the rail.
   *  Contents view: the contents container (`data-test="toc"`, built per
   *  page) shows, and the pages slot holds nothing. Pages view: the
   *  contents container is hidden and the pages slot holds a freshly
   *  mounted `data-test="nav-list"` with one link per page. Called on
   *  mount, every view change and every page build. */
  function renderNav(): void {
    const showContents = navView === 'contents';
    (contents as HTMLElement).hidden = !showContents;
    pageSlot.replaceChildren(...(showContents ? [] : [pageListView()]));
    if (tocList.childElementCount !== tocEntries.length) {
      tocList.replaceChildren(...tocEntries.map((e) => e.link));
    }
  }

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
  const slugs = pageSlugs(pages);
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
    (page, i) => buildPageLinkIndex(page, parsedPages[i]!.doc, slugs[i]!));
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

  /** A fresh pages list (the pages view's list) with one link per page. */
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
   *  can never cross the line on its own. */
  function spyUpdate(): void {
    let best = 0;
    for (let i = 0; i < tocEntries.length; i++) {
      if (tocEntries[i]!.heading.getBoundingClientRect().top <= 96) best = i;
      else break;
    }
    const docEl = doc.documentElement;
    if (window.scrollY + window.innerHeight >= docEl.scrollHeight - 2) {
      best = tocEntries.length - 1;
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

  function show(index: number): void {
    if (index < 0 || index >= pages.length || index === active) return;
    for (const block of blocks) block.dispose();
    blocks = [];
    docPane.replaceChildren();
    if (active !== -1) panel.detach(); // page switch: panel detaches
    active = index;

    const parsed = parsedPages[index]!;
    const rendered = renderDocument(
      parsed.doc,
      (lang) => byLang.has(lang),
      (target) => resolveLinkTarget(target, index, linkIndex, slugs),
    );
    rendered.root.dataset.test = 'page';
    if (parsed.diagnostics.length > 0) {
      docPane.appendChild(warningsBanner(parsed.diagnostics));
    }
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
      a.dataset.active = String(on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
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
      tocEntries[section]!.heading.scrollIntoView(
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
      disposeToc();
      root.replaceChildren();
      root.classList.remove(
        'lw-site', 'lw-no-fonts', 'lw-panel-attached', 'lw-nav-left', 'lw-nav-right');
      // the persisted side is deliberately kept: the next mount restores it
    },
  };
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

/** What a link can name on one page: its file, and its h2/h3 headings. */
interface PageLinkIndex {
  /** Source file name, lowercased (`python.org`). */
  file: string;
  slug: string;
  /** Heading text and its kebab form → section slug. */
  byHeading: Map<string, string>;
  sections: Set<string>;
}

function buildPageLinkIndex(page: PageSpec, doc: OrgDoc, slug: string): PageLinkIndex {
  const nextSlug = sectionSlugger();
  const byHeading = new Map<string, string>();
  const sections = new Set<string>();
  let headingIndex = 0;
  for (const node of doc) {
    if (node.kind !== 'heading' || node.level > 2) continue;
    const section = nextSlug(node.text, headingIndex++);
    sections.add(section);
    byHeading.set(node.text.trim().replace(/\s+/g, ' ').toLowerCase(), section);
    byHeading.set(kebab(node.text), section);
  }
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
