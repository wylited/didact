// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mountSite } from '../src/site';
import type { MountOptions, PageSpec, SiteHandle } from '../src/site';
import { fakeKernel, type FakeSession } from './fake-kernel';

const PAGES = [
  { title: 'First Lesson', orgSource: '#+TITLE: First Lesson\n\nIntro to page one.\n' },
  {
    title: 'Second Lesson: Registers',
    orgSource:
      '#+TITLE: Second Lesson: Registers\n\nBody text for page two.\n\n#+BEGIN_SRC mips\naddi $t0, $zero, 1\naddi $t1, $zero, 2\n#+END_SRC\n',
  },
];

const TOC_PAGES: PageSpec[] = [
  {
    title: 'Guide',
    orgSource:
      '#+TITLE: Guide\n\n* Alpha\n\nAlpha prose.\n\n** Sub\n\nSub prose.\n\n* Beta\n\nBeta prose.\n',
  },
  { title: 'Plain', orgSource: '#+TITLE: Plain\n\nJust prose, no headings.\n' },
];

/** The navigator's list markers, in DOM order. ALWAYS-ONE-LIST: the
 *  rail paints exactly one — the contents (`data-test="toc"`) with the
 *  pages list unmounted, or the pages list (`data-test="nav-list"`) with
 *  the contents container emptied and hidden — never both. */
const LIST_SELECTOR = "[data-test='toc'], [data-test='nav-list']";

/** The lists the navigator actually paints (contents counts only while
 *  it still carries an entry, i.e. is not hidden). */
function shownLists(root: HTMLElement): Element[] {
  return [...root.querySelectorAll(LIST_SELECTOR)]
    .filter((el) => el.dataset.test === 'nav-list'
      || !(el as HTMLElement).hidden);
}

/** Exact text of every contents entry currently in the rail. */
function tocTexts(root: HTMLElement): (string | null)[] {
  return [...root.querySelectorAll("[data-test='toc-item']")].map((a) => a.textContent);
}

/** Exact text of every page link currently in the rail. */
function pageLinkTexts(root: HTMLElement): (string | null)[] {
  return [...root.querySelectorAll("[data-test='nav-item']")].map((a) => a.textContent);
}

interface Mounted {
  handle: SiteHandle;
  root: HTMLElement;
  session: FakeSession;
}

function mount(pages: PageSpec[] = PAGES, extra: Partial<MountOptions> = {}): Mounted {
  const { kernel, session } = fakeKernel('mips');
  const root = document.createElement('div');
  document.body.appendChild(root);
  const handle = mountSite({ root, kernels: [kernel], pages, fonts: false, ...extra });
  return { handle, root, session };
}

/** Flush pending microtasks (no real timers): the click handler's async
 *  run() chain resolves over a few awaits on already-settled promises. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Drive the fragment change a real browser fires after a link click. */
function hashChanged(): void {
  window.dispatchEvent(new Event('hashchange'));
}

/** The navigator-side preference key (site.ts contract). */
const NAV_SIDE_KEY = 'didact:nav-side';

/** CSS with block comments blanked (so commented rules are not asserted). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

const handles: SiteHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  location.hash = '';
  document.body.replaceChildren();
  // per-test isolation for the navigator-side preference (page-scoped
  // storage in happy-dom); tests that deny storage simply store nothing
  try {
    window.localStorage.removeItem(NAV_SIDE_KEY);
  } catch {
    /* storage denied: nothing was stored */
  }
});

describe('mountSite: navigation', () => {
  it('renders one nav item per page, in page order, naming each page', () => {
    const { handle, root } = mount();
    handles.push(handle);
    // the pages view lists them all, in page order; the default view is contents
    expect(shownLists(root).map((el) => el.dataset.test)).toEqual(['toc']);
    root.querySelector<HTMLButtonElement>("[data-test='rail-view-pages']")!.click();
    expect(pageLinkTexts(root)).toEqual(['First Lesson', 'Second Lesson: Registers']);
    expect(shownLists(root).map((el) => el.dataset.test)).toEqual(['nav-list']);
  });

  it("clicking nav item 2 switches to page 2's content and its slug in the hash", () => {
    const { handle, root } = mount();
    handles.push(handle);
    // the page links live in the pages view of the navigator
    root.querySelector<HTMLButtonElement>("[data-test='rail-view-pages']")!.click();
    expect(shownLists(root).map((el) => el.dataset.test)).toEqual(['nav-list']);
    const items = root.querySelectorAll<HTMLAnchorElement>("[data-test='nav-item']");
    items[1]!.click();
    // the click sets the fragment; happy-dom does not auto-fire the
    // hashchange a real browser would, so drive it explicitly
    expect(location.hash).toBe('#/second-lesson-registers');
    hashChanged();
    const page = root.querySelector("[data-test='page']")!;
    expect(page.textContent).toContain('Body text for page two.');
    expect(page.textContent).not.toContain('Intro to page one.');
    expect(handle.activeIndex).toBe(1);
  });

  it("falls back to page 0 on an unknown hash, normalizing the URL to name the page actually shown", () => {
    const { handle, root } = mount();
    handles.push(handle);
    root.querySelector<HTMLButtonElement>("[data-test='rail-view-pages']")!.click();
    root.querySelectorAll<HTMLAnchorElement>("[data-test='nav-item']")[1]!.click();
    hashChanged(); // reach page 2 first
    expect(handle.activeIndex).toBe(1);
    location.hash = '#/unknown-slug';
    hashChanged();
    const page = root.querySelector("[data-test='page']")!;
    expect(handle.activeIndex).toBe(0);
    expect(page.textContent).toContain('Intro to page one.');
    // the URL no longer claims a page that does not exist
    expect(location.hash).toBe('#/first-lesson');
    location.hash = '#/second-lesson-registers';
    hashChanged();
    expect(handle.activeIndex).toBe(1);
  });

  it('a page-level hash after a section hash scrolls back to the top of the page', () => {
    const { handle, root } = mount(TOC_PAGES);
    handles.push(handle);
    const toTop: number[] = [];
    const originalScroll = window.scrollTo;
    const originalInto = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = (): void => undefined;
    window.scrollTo = ((opts?: ScrollToOptions) => {
      toTop.push(opts?.top ?? -1);
    }) as typeof window.scrollTo;
    try {
      // deep-link to Beta, then click the page's own nav link
      root.querySelectorAll<HTMLAnchorElement>("[data-test='toc-item']")[2]!.click();
      hashChanged();
      root.querySelector<HTMLButtonElement>("[data-test='rail-view-pages']")!.click();
      root.querySelectorAll<HTMLAnchorElement>("[data-test='nav-item']")[0]!.click();
      hashChanged();
      root.querySelector<HTMLButtonElement>("[data-test='rail-view-contents']")!.click();
    } finally {
      window.scrollTo = originalScroll;
      Element.prototype.scrollIntoView = originalInto;
    }
    // the page did not switch, but the viewport returned to the top
    expect(handle.activeIndex).toBe(0);
    expect(toTop).toEqual([0]);
    expect(root.querySelector('.lw-toc-active')!.textContent).toBe('Alpha');
  });
});

describe('mountSite: block execution wiring', () => {
  it('runs a registered-language block through the kernel session and renders its panels', async () => {
    const { handle, root, session } = mount();
    handles.push(handle);
    // the executable block lives on page 2 — deep-link straight to it
    location.hash = '#/second-lesson-registers';
    hashChanged();
    expect(handle.blocks).toHaveLength(1);
    const run = root.querySelector<HTMLButtonElement>("[data-test='block-run']")!;
    run.click();
    await flushAsync();
    expect(session.runCalls).toBe(1);
    const status = root.querySelector("[data-test='block-status']")!;
    expect(status.textContent).toContain('finished');
    // the html panel content lands in the panel host after the run
    expect(root.querySelector('svg')).not.toBeNull();
  });
});

describe('mountSite: navigator rail and panel zone', () => {
  it('running a block attaches the wide panel mode, detach collapses it again', async () => {
    const { handle, root } = mount();
    handles.push(handle);
    // at rest: no panel, the contents (toc) live in the navigator rail
    expect(root.classList.contains('lw-panel-attached')).toBe(false);
    expect(root.querySelector(".lw-rail-nav [data-test='toc']")).not.toBeNull();

    location.hash = '#/second-lesson-registers';
    hashChanged();
    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();

    // panel attached: root carries lw-panel-attached (panel rail goes wide)
    expect(root.classList.contains('lw-panel-attached')).toBe(true);
    expect(root.querySelector("[data-test='uth']")).not.toBeNull();

    root.querySelector<HTMLButtonElement>("[data-test='uth-detach']")!.click();
    expect(root.classList.contains('lw-panel-attached')).toBe(false);
    // the contents never left the navigator rail
    expect(root.querySelector(".lw-rail-nav [data-test='toc']")).not.toBeNull();
  });

  it('opens on the contents view: the switch is pressed there, exactly one list renders', () => {
    const { handle, root } = mount(TOC_PAGES);
    handles.push(handle);
    const contentsBtn = root.querySelector<HTMLButtonElement>("[data-test='rail-view-contents']")!;
    const pagesBtn = root.querySelector<HTMLButtonElement>("[data-test='rail-view-pages']")!;
    expect(handle.navView).toBe('contents');
    expect(contentsBtn.getAttribute('aria-pressed')).toBe('true');
    expect(pagesBtn.getAttribute('aria-pressed')).toBe('false');
    expect(contentsBtn.dataset.active).toBe('true');
    expect(pagesBtn.dataset.active).toBe('false');
    // the switch buttons are real buttons, not links or divs
    expect(contentsBtn.tagName).toBe('BUTTON');
    expect(contentsBtn.getAttribute('type')).toBe('button');
    expect(pagesBtn.tagName).toBe('BUTTON');
    expect(pagesBtn.getAttribute('type')).toBe('button');

    // header bar: the switch, then the side toggle
    const head = root.querySelector(".lw-rail-nav > .lw-nav-head")!;
    expect([...head.children].map((el) => el.className)).toEqual(['lw-nav-switch', 'lw-nav-side']);

    // exactly one list paints in the rail, and it is the contents; the
    // pages view is not even mounted yet
    expect(root.querySelectorAll(LIST_SELECTOR)).toHaveLength(1);
    expect(root.querySelectorAll("[data-test='nav-item']")).toHaveLength(0);
    const shown = shownLists(root);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.dataset.test).toBe('toc');
    expect(tocTexts(root)).toEqual(['Alpha', 'Sub', 'Beta']);
  });

  it("mount option navView: 'pages' opens on the page list (the example site's default)", () => {
    const { handle, root } = mount(TOC_PAGES, { navView: 'pages' });
    handles.push(handle);
    expect(handle.navView).toBe('pages');
    expect(root.querySelector<HTMLButtonElement>("[data-test='rail-view-pages']")!
      .getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector<HTMLButtonElement>("[data-test='rail-view-contents']")!
      .getAttribute('aria-pressed')).toBe('false');
    expect(shownLists(root).map((el) => el.dataset.test)).toEqual(['nav-list']);
    expect(pageLinkTexts(root)).toEqual(['Guide', 'Plain']);
    expect(root.querySelector("[data-test='toc']")!.hidden).toBe(true);
    // the contents are dormant, not lost: the switch brings them back
    root.querySelector<HTMLButtonElement>("[data-test='rail-view-contents']")!.click();
    expect(handle.navView).toBe('contents');
    expect(tocTexts(root)).toEqual(['Alpha', 'Sub', 'Beta']);
  });

  it('clicking "Pages" shows the page links and empties the contents; "Contents" restores them', () => {
    const { handle, root } = mount(TOC_PAGES);
    handles.push(handle);
    root.querySelector<HTMLButtonElement>("[data-test='rail-view-pages']")!.click();

    expect(handle.navView).toBe('pages');
    expect(root.querySelector<HTMLButtonElement>("[data-test='rail-view-pages']")!
      .getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector<HTMLButtonElement>("[data-test='rail-view-contents']")!
      .getAttribute('aria-pressed')).toBe('false');
    // exactly one list: the page list (all pages, active one marked)
    expect(shownLists(root)).toHaveLength(1);
    expect(shownLists(root)[0]!.dataset.test).toBe('nav-list');
    expect(pageLinkTexts(root)).toEqual(['Guide', 'Plain']);
    // the contents container is emptied and hidden while pages show
    expect(root.querySelector("[data-test='toc']")!.hidden).toBe(true);
    const marked = [...root.querySelectorAll("[data-test='nav-item'][data-active='true']")];
    expect(marked.map((a) => a.textContent)).toEqual(['Guide']);
    expect(marked[0]!.getAttribute('aria-current')).toBe('page');

    root.querySelector<HTMLButtonElement>("[data-test='rail-view-contents']")!.click();
    expect(handle.navView).toBe('contents');
    expect(shownLists(root)).toHaveLength(1);
    expect(shownLists(root)[0]!.dataset.test).toBe('toc');
    expect(tocTexts(root)).toEqual(['Alpha', 'Sub', 'Beta']);
    // and the active contents entry survived the round trip
    expect(root.querySelectorAll('.lw-toc-active')).toHaveLength(1);
    expect(root.querySelector('.lw-toc-active')!.textContent).toBe('Alpha');
  });

  it('a page switch preserves the chosen view, in both directions', () => {
    const { handle, root } = mount(TOC_PAGES);
    handles.push(handle);
    root.querySelector<HTMLButtonElement>("[data-test='rail-view-pages']")!.click();

    // switch to the heading-less page: still the page list, new page active
    location.hash = '#/plain';
    hashChanged();
    expect(handle.activeIndex).toBe(1);
    expect(handle.navView).toBe('pages');
    expect(shownLists(root)).toHaveLength(1);
    expect(shownLists(root)[0]!.dataset.test).toBe('nav-list');
    expect(root.querySelector("[data-test='toc']")!.hidden).toBe(true);
    expect([...root.querySelectorAll("[data-test='nav-item'][data-active='true']")]
      .map((a) => a.textContent)).toEqual(['Plain']);

    // back again: still pages
    location.hash = '#/guide/alpha';
    hashChanged();
    expect(handle.navView).toBe('pages');
    expect(shownLists(root)[0]!.dataset.test).toBe('nav-list');
    expect(pageLinkTexts(root)).toEqual(['Guide', 'Plain']);
    expect(root.querySelector("[data-test='toc']")!.hidden).toBe(true);

    // the contents view likewise survives a switch
    root.querySelector<HTMLButtonElement>("[data-test='rail-view-contents']")!.click();
    location.hash = '#/plain';
    hashChanged();
    expect(handle.navView).toBe('contents');
    expect(tocTexts(root)).toEqual([]); // page has no headings
    location.hash = '#/guide';
    hashChanged();
    expect(handle.navView).toBe('contents');
    expect(tocTexts(root)).toEqual(['Alpha', 'Sub', 'Beta']);
  });

  it('lists one contents entry per h2/h3 in document order, none on a heading-less page', () => {
    const { handle, root } = mount(TOC_PAGES);
    handles.push(handle);
    expect(tocTexts(root)).toEqual(['Alpha', 'Sub', 'Beta']);
    // h2 flush, h3 indented: the tree rhythm (`lw-toc-sub`)
    const items = [...root.querySelectorAll<HTMLAnchorElement>("[data-test='toc-item']")];
    expect(items[1]!.classList.contains('lw-toc-sub')).toBe(true);
    expect(items[0]!.classList.contains('lw-toc-sub')).toBe(false);
    // each heading got a slugged, readable anchor id
    expect(root.querySelector('#lw-h-alpha')!.textContent).toBe('Alpha');
    expect(root.querySelector('#lw-h-beta')!.textContent).toBe('Beta');
    // exactly one entry is active at rest: the first
    const active = root.querySelectorAll('.lw-toc-active');
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toBe('Alpha');
    // switch to a heading-less page from the pages view…
    root.querySelector<HTMLButtonElement>("[data-test='rail-view-pages']")!.click();
    root.querySelectorAll<HTMLAnchorElement>("[data-test='nav-item']")[1]!.click();
    hashChanged();
    // …then back to the contents view: no entries, nothing painted
    root.querySelector<HTMLButtonElement>("[data-test='rail-view-contents']")!.click();
    expect(root.querySelectorAll("[data-test='toc-item']")).toHaveLength(0);
    expect(shownLists(root)[0]!.dataset.test).toBe('toc');
  });

  it('contents links are real section deep links: the hash routes, then the page scrolls', () => {
    const { handle, root } = mount(TOC_PAGES);
    handles.push(handle);
    const scrolled: Element[] = [];
    const behaviors: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, opts?: ScrollIntoViewOptions): void {
      scrolled.push(this);
      behaviors.push(String(opts?.behavior));
    };
    try {
      root.querySelectorAll<HTMLAnchorElement>("[data-test='toc-item']")[2]!.click(); // Beta
      hashChanged();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    // the URL now names the section — copyable, back-button-able
    expect(location.hash).toBe('#/guide/beta');
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]!.id).toBe('lw-h-beta');
    // same-page section nav scrolls smoothly
    expect(behaviors[0]).toBe('smooth');
    // the clicked entry is active
    expect(root.querySelector('.lw-toc-active')!.textContent).toBe('Beta');
  });

  it('contents entries stay deep links from the contents view after visiting the pages view', () => {
    const { handle, root } = mount(TOC_PAGES);
    handles.push(handle);
    root.querySelector<HTMLButtonElement>("[data-test='rail-view-pages']")!.click();
    root.querySelector<HTMLButtonElement>("[data-test='rail-view-contents']")!.click();
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element): void {
      scrolled.push(this);
    };
    try {
      root.querySelectorAll<HTMLAnchorElement>("[data-test='toc-item']")[1]!.click(); // Sub
      hashChanged();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(location.hash).toBe('#/guide/sub');
    expect(scrolled.map((el) => el.id)).toEqual(['lw-h-sub']);
    // one active entry, and it is the clicked one; pages are not around
    const active = root.querySelectorAll('.lw-toc-active');
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toBe('Sub');
  });

  it('a section deep link on load lands on the page and jumps straight to the section', () => {
    location.hash = '#/guide/beta';
    const scrolled: Element[] = [];
    const behaviors: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, opts?: ScrollIntoViewOptions): void {
      scrolled.push(this);
      behaviors.push(String(opts?.behavior));
    };
    try {
      const { handle, root } = mount(TOC_PAGES);
      handles.push(handle);
      expect(handle.activeIndex).toBe(0);
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0]!.id).toBe('lw-h-beta');
      // a fresh load jumps, it does not animate
      expect(behaviors[0]).toBe('auto');
      // no implicit view change: a deep link keeps the default contents view
      expect(handle.navView).toBe('contents');
      expect(root.querySelector('.lw-toc-active')!.textContent).toBe('Beta');
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('section slugs are kebab-cased, deduplicated, and ASCII-less headings fall back', () => {
    const { handle, root } = mount([
      {
        title: 'Slugs',
        orgSource:
          '#+TITLE: Slugs\n\n* Registers & Flags\n\n* Registers & Flags\n\n* 中文标题\n\n* Third\n',
      },
    ]);
    handles.push(handle);
    const items = [...root.querySelectorAll<HTMLAnchorElement>("[data-test='toc-item']")];
    expect(items.map((a) => a.getAttribute('href'))).toEqual([
      '#/slugs/registers-flags',
      '#/slugs/registers-flags-2',
      '#/slugs/section-3',
      '#/slugs/third',
    ]);
    expect(root.querySelector('#lw-h-registers-flags-2')!).not.toBeNull();
    expect(root.querySelector('#lw-h-section-3')!).not.toBeNull();
  });

  it('rebuilds the contents and resets the active entry on page switch', () => {
    const { handle, root } = mount(TOC_PAGES);
    handles.push(handle);
    // move the active entry off the first heading via its deep link
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = (): void => undefined;
    try {
      root.querySelectorAll<HTMLAnchorElement>("[data-test='toc-item']")[2]!.click();
      hashChanged();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(root.querySelector('.lw-toc-active')!.textContent).toBe('Beta');
    // away to the heading-less page and back (via the pages view)
    location.hash = '#/plain';
    hashChanged();
    expect(root.querySelector('#lw-h-alpha')).toBeNull(); // old anchors went with the old page
    location.hash = '#/guide';
    hashChanged();
    expect(tocTexts(root)).toEqual(['Alpha', 'Sub', 'Beta']);
    expect(root.querySelector('#lw-h-alpha')!.textContent).toBe('Alpha');
    const active = root.querySelectorAll('.lw-toc-active');
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toBe('Alpha');
    expect(handle.activeIndex).toBe(0);
  });

});

describe('mountSite: navigator side', () => {

  function sideClass(root: HTMLElement): string[] {
    return ['lw-nav-left', 'lw-nav-right'].filter((c) => root.classList.contains(c));
  }

  it('defaults to the left: root class lw-nav-left, navigator is the first grid column', () => {
    const { handle, root } = mount();
    handles.push(handle);
    expect(handle.navSide).toBe('left');
    expect(sideClass(root)).toEqual(['lw-nav-left']);
    const layout = root.querySelector('.lw-layout')!;
    expect([...layout.children].map((el) => el.className)).toEqual([
      'lw-rail lw-rail-nav', 'lw-doc-pane', 'lw-rail lw-rail-right',
    ]);
    expect(window.localStorage.getItem(NAV_SIDE_KEY)).toBeNull(); // default is not persisted
    // the side toggle is a real button naming the ACTION, not the state
    const side = root.querySelector<HTMLButtonElement>("[data-test='rail-side']")!;
    expect(side.tagName).toBe('BUTTON');
    expect(side.getAttribute('type')).toBe('button');
    expect(side.textContent).toBe('Right →');
    expect(side.getAttribute('aria-label')).toBe('Move navigation to the right');
  });

  it("mount option navSide: 'right' puts the navigator on the right edge, document in the middle", () => {
    const { handle, root } = mount(PAGES, { navSide: 'right' });
    handles.push(handle);
    expect(handle.navSide).toBe('right');
    expect(sideClass(root)).toEqual(['lw-nav-right']);
    const layout = root.querySelector('.lw-layout')!;
    expect([...layout.children].map((el) => el.className)).toEqual([
      'lw-doc-pane', 'lw-rail lw-rail-right', 'lw-rail lw-rail-nav',
    ]);
    const side = root.querySelector<HTMLButtonElement>("[data-test='rail-side']")!;
    expect(side.textContent).toBe('← Left');
    expect(side.getAttribute('aria-label')).toBe('Move navigation to the left');
  });

  it('the rail-side toggle flips root class, layout order and handle state, and persists', () => {
    const { handle, root } = mount();
    handles.push(handle);
    const layout = root.querySelector('.lw-layout')!;
    root.querySelector<HTMLButtonElement>("[data-test='rail-side']")!.click();
    expect(handle.navSide).toBe('right');
    expect(sideClass(root)).toEqual(['lw-nav-right']);
    expect([...layout.children].map((el) => el.className)).toEqual([
      'lw-doc-pane', 'lw-rail lw-rail-right', 'lw-rail lw-rail-nav',
    ]);
    expect(window.localStorage.getItem(NAV_SIDE_KEY)).toBe('right');
    expect(root.querySelector<HTMLButtonElement>("[data-test='rail-side']")!.textContent)
      .toBe('← Left');

    root.querySelector<HTMLButtonElement>("[data-test='rail-side']")!.click();
    expect(handle.navSide).toBe('left');
    expect(sideClass(root)).toEqual(['lw-nav-left']);
    expect([...layout.children].map((el) => el.className)).toEqual([
      'lw-rail lw-rail-nav', 'lw-doc-pane', 'lw-rail lw-rail-right',
    ]);
    expect(window.localStorage.getItem(NAV_SIDE_KEY)).toBe('left');
  });

  it('the persisted side survives dispose and is read back by the next mount', () => {
    const first = mount();
    first.root.querySelector<HTMLButtonElement>("[data-test='rail-side']")!.click();
    expect(first.handle.navSide).toBe('right');
    first.handle.dispose();
    // dispose drops the root classes but leaves the stored preference
    expect(sideClass(first.root)).toEqual([]);
    expect(first.root.classList.contains('lw-site')).toBe(false);
    expect(window.localStorage.getItem(NAV_SIDE_KEY)).toBe('right');

    // default left in the options, but the stored choice wins
    const second = mount(PAGES, { navSide: 'left' });
    handles.push(second.handle);
    expect(second.handle.navSide).toBe('right');
    expect(sideClass(second.root)).toEqual(['lw-nav-right']);
    expect(second.root.querySelector<HTMLButtonElement>("[data-test='rail-side']")!.textContent)
      .toBe('← Left');
    expect(window.localStorage.getItem(NAV_SIDE_KEY)).toBe('right');

    // clearing the key returns to the option default on the next mount
    window.localStorage.removeItem(NAV_SIDE_KEY);
    second.handle.dispose();
    const third = mount(PAGES, { navSide: 'left' });
    handles.push(third.handle);
    expect(third.handle.navSide).toBe('left');
    expect(sideClass(third.root)).toEqual(['lw-nav-left']);
    expect(window.localStorage.getItem(NAV_SIDE_KEY)).toBeNull();
  });

  it('a stored value that is not left/right falls back to the option default', () => {
    window.localStorage.setItem(NAV_SIDE_KEY, 'sideways');
    const { handle, root } = mount(PAGES, { navSide: 'right' });
    handles.push(handle);
    expect(handle.navSide).toBe('right');
    expect(sideClass(root)).toEqual(['lw-nav-right']);
    // and nothing rewrote the junk value
    expect(window.localStorage.getItem(NAV_SIDE_KEY)).toBe('sideways');
  });

  it('setNavSide validates, persists and works alongside setNavView', () => {
    const { handle, root } = mount(TOC_PAGES);
    handles.push(handle);
    handle.setNavSide('right');
    expect(sideClass(root)).toEqual(['lw-nav-right']);
    expect(window.localStorage.getItem(NAV_SIDE_KEY)).toBe('right');
    handle.setNavSide('sideways' as never);
    expect(handle.navSide).toBe('right');
    handle.setNavView('pages');
    expect(handle.navView).toBe('pages');
    expect(shownLists(root)[0]!.dataset.test).toBe('nav-list');
  });

  it('a storage that throws does not break mounting, switching or toggling', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get(): Storage {
        throw new Error('SecurityError: storage denied');
      },
    });
    try {
      const { handle, root } = mount();
      handles.push(handle);
      expect(handle.navSide).toBe('left');
      expect(sideClass(root)).toEqual(['lw-nav-left']);
      expect(handle.activeIndex).toBe(0);
      // the toggle still applies the choice in this session
      root.querySelector<HTMLButtonElement>("[data-test='rail-side']")!.click();
      expect(handle.navSide).toBe('right');
      expect(sideClass(root)).toEqual(['lw-nav-right']);
      // a fresh mount starts from the option default again
      const again = mount(PAGES, { navSide: 'right' });
      handles.push(again.handle);
      expect(again.handle.navSide).toBe('right');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
      else delete (window as { localStorage?: Storage }).localStorage;
    }
  });
});

describe('mountSite: reduced motion', () => {
  // happy-dom cannot emulate prefers-reduced-motion media evaluation, so
  // the contract is pinned against the stylesheet text: the media query
  // must disable the rail/panel transitions and the panel animation.
  it('theme.css nullifies transitions and animations under prefers-reduced-motion', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, '../src/theme.css'), 'utf8');
    const mq = /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition: none !important;[^}]*animation: none !important;/;
    expect(mq.test(css)).toBe(true);
  });

});

describe('theme: measure', () => {
  // happy-dom applies no stylesheet, so — like the reduced-motion test —
  // the layout contract is pinned against the stylesheet text: find the
  // rule by its head, then the exact declaration it must (or must not)
  // carry.
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(here, '../src/theme.css'), 'utf8');

  /** theme.css with every block comment blanked. Comments are stripped
   *  first, not skipped while scanning: a comment-free body is already
   *  brace-balanced, and strings such as "SF Mono, SFMono-Regular" can
   *  hold a comment terminator that must not end the doc comment. */
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

  /** The body of the outermost rule whose selector is exactly `head`.
   *  `@media { … }` nests, so a viewport-specific override of the same
   *  selector is never mistaken for the base rule. */
  function ruleBody(head: string): string {
    let depth = 0;
    let start = 0;                       // first char of the rule head
    const bodies: string[] = [];
    for (let i = 0; i < bare.length; i++) {
      if (bare[i] === '{') {
        const selector = bare.slice(start, i).replace(/\s+/g, ' ').trim();
        if (depth === 0 && selector === head) {
          const end = bare.indexOf('}', i); // declaration bodies never nest
          bodies.push(bare.slice(i + 1, end));
        }
        depth++;
      } else if (bare[i] === '}') {
        depth--;
        start = i + 1;                   // the next head starts after it
      }
    }
    // an empty body would make every declaration check vacuously false
    expect(bodies.length === 1 && bodies[0]!.trim() !== '').toBe(true);
    return bodies[0]!;
  }
  /** `prop: value;` declared verbatim inside that outermost rule? */
  function declares(head: string, decl: string): boolean {
    return ruleBody(head).includes(decl);
  }
  /** Bodies of every `@media (min-width: <width>)` block: layout tokens
   *  and the doc's type tiers live in separate blocks of the same
   *  breakpoint, and both matter. */
  function mediaBodies(width: string | number): string[] {
    const query = typeof width === 'number' ? `${width}px` : width;
    const blocks = [...bare.matchAll(
      new RegExp(`@media \\(min-width: ${query}\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'g'))];
    expect(blocks.length > 0).toBe(true); // the media block exists
    return blocks.map((b) => b[1]!);
  }
  /** Custom properties set in the `@media (min-width: <width>)` blocks;
   *  a bare number is read as px. */
  function varsIn(width: string | number): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const body of mediaBodies(width)) {
      for (const m of body.matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g)) {
        vars[m[1]!] = m[2]!.trim();
      }
    }
    return vars;
  }
  /** The .lw-doc font-sizes declared in the `@media (min-width)` blocks. */
  function fontSizesIn(minWidth: number): string[] {
    return mediaBodies(minWidth).flatMap((body) => [...body.matchAll(
      /\.lw-doc\s*\{[^}]*?font-size:\s*([^;]+);/g)].map((m) => m[1]!.trim()));
  }

  it('the measure grows to 90ch with the type: 74ch @16px, 82ch @17px, 90ch @18px', () => {
    // the ch measure lives on the doc, so it resolves at the doc's own
    // font-size (a ch on .lw-site would stay the 16px ch)
    expect(declares('.lw-doc', '--lw-doc-measure: 74ch;')).toBe(true);
    expect(varsIn(1600)['lw-doc-measure']).toBe('82ch');
    expect(varsIn(2200)['lw-doc-measure']).toBe('90ch');
    // bigger body type on the same tiers, in the same media rules
    // (1.0625rem / 1.125rem = 17px / 18px at the default 16px root)
    expect(fontSizesIn(1600)).toEqual(['1.0625rem']);
    expect(fontSizesIn(2200)).toEqual(['1.125rem']);
    // prose fills that measure minus the 1ch wrap allowance; tables and
    // code may exceed it, but stop at the same 90ch ceiling
    expect(declares('.lw-para', 'max-width: calc(var(--lw-doc-measure) - 1ch);'))
      .toBe(true);
    expect(declares('.lw-table', 'max-width: min(100%, 90ch);')).toBe(true);
    expect(declares('.lw-src', 'max-width: min(100%, 90ch);')).toBe(true);
    // nothing double-caps the prose: no fixed rem cap survives
    expect(css).not.toMatch(/max-width:\s*(42|40)rem/);
  });

  it('inner spacing is em-based, so headings and rhythm scale with the type', () => {
    // rem here would leave headings and space fixed beside larger prose
    expect(declares('.lw-title', 'font-size: 2em;')).toBe(true);
    expect(declares('.lw-doc > h2.lw-heading', 'font-size: 1.4em;')).toBe(true);
    expect(declares('.lw-para', 'margin: 0 0 1em;')).toBe(true);
    expect(declares('.lw-heading', 'margin: 1.4em 0 0.47em;')).toBe(true);
  });

  it('the layout frame fits the widest tier; an attached panel keeps the doc >= 40ch', () => {
    // rail 232px + 2 * (measure + 4.5rem): 119.4/136.4/154.7rem, each
    // >= the text of its tier plus 4.5rem a side (767/903/1050px)
    expect(declares('.lw-layout', 'max-width: var(--lw-frame);')).toBe(true);
    expect(declares('.lw-site', '--lw-frame: 119.4rem;')).toBe(true);
    expect(varsIn(1600)['lw-frame']).toBe('136.4rem');
    expect(varsIn(2200)['lw-frame']).toBe('154.7rem');
    expect(css).not.toMatch(/max-width:\s*88rem/);
    // the 40ch floor is in the doc's ch, so it scales with the type too
    expect(declares('.lw-doc-pane > .lw-doc',
      'max-width: max(min(var(--lw-doc-measure), 100%), 40ch);')).toBe(true);
    // the panel's own clamp is unchanged on regular screens
    expect(declares('.lw-site.lw-panel-attached .lw-rail-right',
      'width: clamp(420px, 42vw, 720px);')).toBe(true);
  });

  it('the rest layout centres the text: no left/right offset rules', () => {
    // The doc is centred in the track left beside the 232px rail, and
    // the rail is exactly 232px wide, so the text already lands on the
    // page centre (see "centring check" in theme.css). A compensating
    // offset would move the auto-centred text by half its size and
    // split the gutter, so none may exist:
    expect(/--lw-doc-shift/.test(css)).toBe(false);
    // nor may the pane lose the symmetric gutter it centres against
    expect(declares('.lw-doc-pane', 'padding: 2rem var(--lw-gutter) 4rem;')).toBe(true);
    expect(declares('.lw-doc-pane > .lw-doc', 'margin-inline: auto;')).toBe(true);
    expect(css).not.toMatch(/\.lw-doc[^{]*\{[^}]*margin-left:\s*-/);
  });
});

describe('mountSite: navigator layout', () => {
  // theme.css cannot lay out in happy-dom, so the CSS contract is pinned
  // against the stylesheet text: the rail lives in the grid once
  // (`<nav>` between the document and the panel), never in two regions.
  const css = (): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/theme.css'), 'utf8');

  it('the navigator rail is one grid column: nav left = first, nav right = last; its hairline follows the side', () => {
    const text = stripComments(css());
    // the rail's width comes from the same variable as the grid's frame
    expect(text).toContain('.lw-rail-nav {\n  width: var(--lw-rail-w);');
    expect(text).toContain('.lw-site.lw-nav-right .lw-rail-nav {\n  border-right: none;\n  border-left: 1px solid var(--lw-hairline);');
    // the document keeps the middle track in both modes
    expect(text).toContain('.lw-layout {\n  display: grid;\n  grid-template-columns: auto minmax(0, 1fr) auto;');
    // right mode reorders the DOM (doc, panel, nav), so its template
    // must follow: the rail never lands in the flexible track
    expect(text).toMatch(/\.lw-site\.lw-nav-right \.lw-layout \{\s+grid-template-columns: minmax\(0, 1fr\) auto auto;/);
    // one list at a time: the hidden view paints nothing
    expect(text).toContain('.lw-contents[hidden]');
  });

  it('the <900px stack shows the rail header and wraps whichever list shows', () => {
    const text = stripComments(css());
    const narrow = text.slice(text.indexOf('@media (max-width: 899px)'));
    expect(narrow).toContain('.lw-rail-nav {');
    expect(narrow).toContain('.lw-contents, .lw-rail-pages-list {\n    flex-direction: row;');
    expect(narrow).toContain('.lw-rail-nav {\n    order: -1;');
  });

  it('small desktops stack while a panel is attached, so the document keeps its full width', () => {
    const text = stripComments(css());
    const mid = text.slice(text.indexOf('@media (min-width: 900px) and (max-width: 1199px)'));
    // the rail becomes a header strip; doc + panel stay side by side, so
    // the panel is never pushed below the document
    expect(mid).toContain('grid-template-areas: "nav nav" "doc panel";');
    expect(mid).toContain('.lw-site.lw-panel-attached .lw-rail-nav {\n    grid-area: nav;');
    expect(mid).toContain('.lw-site.lw-panel-attached .lw-rail-right {\n    grid-area: panel;');
    // the doc keeps its measure: only phones drop the cap
    expect(mid).not.toContain('max-width: none');
  });

  it('the navigator renders the same three zones in both modes, with no duplicated rail', () => {
    for (const navSide of ['left', 'right'] as const) {
      const { handle, root } = mount(TOC_PAGES, { navSide });
      handles.push(handle);
      const layout = root.querySelector('.lw-layout')!;
      const order = [...layout.children].map((el) => el.className);
      expect(order.filter((c) => c.includes('lw-rail-nav'))).toHaveLength(1);
      expect(root.querySelectorAll('.lw-layout').length).toBe(1);
      expect(order).toEqual(navSide === 'left'
        ? ['lw-rail lw-rail-nav', 'lw-doc-pane', 'lw-rail lw-rail-right']
        : ['lw-doc-pane', 'lw-rail lw-rail-right', 'lw-rail lw-rail-nav']);
    }
  });
});

describe('mountSite: document links', () => {
  const LINK_PAGES: PageSpec[] = [
    {
      title: 'Home',
      file: 'home.org',
      orgSource: [
        '#+TITLE: Home',
        '',
        'Read [[file:target.org][the target]] or [[file:target.org::*Second Part][part two]].',
        'Also [[file:target.org::#first-part][by slug]], [[*Local Part][locally]], and [[#local-part][this section]].',
        'Broken: [[file:nope.org][nowhere]] and [[file:target.org::*Missing][no heading]].',
        '',
        '* Local Part',
        '',
        'Local prose.',
      ].join('\n'),
    },
    {
      title: 'Target Page',
      file: 'target.org',
      orgSource:
        '#+TITLE: Target Page\n\n* First Part\n\nFirst prose.\n\n* Second Part\n\nSecond prose.\n',
    },
  ];

  it('resolves file, file+heading, slug, and in-page link forms to fragment hrefs', () => {
    const { handle, root } = mount(LINK_PAGES);
    handles.push(handle);
    const links = [...root.querySelectorAll<HTMLAnchorElement>('a.lw-link')];
    expect(links.map((a) => a.textContent)).toEqual([
      'the target', 'part two', 'by slug', 'locally', 'this section',
    ]);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '#/target-page',
      '#/target-page/second-part',
      '#/target-page/first-part',
      '#/home/local-part',
      '#/home/local-part',
    ]);
  });

  it('an unknown page or heading renders inert, never an anchor to another page', () => {
    const { handle, root } = mount(LINK_PAGES);
    handles.push(handle);
    const broken = [...root.querySelectorAll("[data-test='link-broken']")];
    expect(broken.map((el) => el.textContent)).toEqual(['nowhere', 'no heading']);
    // the five resolvable links are the only anchors in the prose
    expect(root.querySelectorAll('a.lw-link')).toHaveLength(5);
  });

  it('clicking a cross-page link switches the page and names it in the hash', () => {
    const { handle, root } = mount(LINK_PAGES);
    handles.push(handle);
    root.querySelectorAll<HTMLAnchorElement>('a.lw-link')[0]!.click();
    hashChanged();
    expect(location.hash).toBe('#/target-page');
    expect(handle.activeIndex).toBe(1);
    expect(root.querySelector("[data-test='page'] .lw-title")!.textContent)
      .toBe('Target Page');
  });

  it('clicking a cross-page heading link lands on that section of the other page', () => {
    const { handle, root } = mount(LINK_PAGES);
    handles.push(handle);
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element): void {
      scrolled.push(this);
    };
    try {
      root.querySelectorAll<HTMLAnchorElement>('a.lw-link')[1]!.click(); // part two
      hashChanged();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(location.hash).toBe('#/target-page/second-part');
    expect(handle.activeIndex).toBe(1);
    expect(scrolled.map((el) => el.id)).toEqual(['lw-h-second-part']);
    expect(root.querySelector('.lw-toc-active')!.textContent).toBe('Second Part');
  });

  it('a cross-page heading link still resolves when the page is named without file:', () => {
    const { handle, root } = mount([
      {
        title: 'Start',
        file: 'start.org',
        orgSource: '#+TITLE: Start\n\nGo [[target.org::*Later][later]].\n',
      },
      {
        title: 'Target',
        file: 'target.org',
        orgSource: '#+TITLE: Target\n\n* Later\n\nProse.\n',
      },
    ]);
    handles.push(handle);
    expect(root.querySelector<HTMLAnchorElement>('a.lw-link')!.getAttribute('href'))
      .toBe('#/target/later');
  });
});

describe('mountSite: org diagnostics', () => {
  /** Line 2 carries an unsupported directive; the heading on line 4
   *  renders normally, so the page still shows a real article. */
  const WARNED: PageSpec = {
    title: 'Warned',
    orgSource: '#+TITLE: Warned\n#+FOO: bar\n\n* Heading\n\nBody.\n',
  };
  const CLEAN: PageSpec = {
    title: 'Clean',
    orgSource: '#+TITLE: Clean\n\n* Heading\n\nBody.\n',
  };

  it('reports unsupported org syntax in a banner before the article', () => {
    const { handle, root } = mount([WARNED]);
    handles.push(handle);

    expect(root.querySelectorAll("[data-test='org-warnings']")).toHaveLength(1);
    const warnings = [...root.querySelectorAll("[data-test='org-warning']")];
    expect(warnings.map((el) => el.textContent)).toEqual([
      'line 2: unsupported directive #+FOO — dropped by the renderer',
    ]);
    expect(warnings[0]!.getAttribute('data-severity')).toBe('warning');

    const docPane = root.querySelector('.lw-doc-pane')!;
    expect(docPane.firstElementChild!.getAttribute('data-test')).toBe('org-warnings');
    expect(docPane.firstElementChild!.nextElementSibling!.getAttribute('data-test'))
      .toBe('page');
    // the warning is a banner, not a replacement for the rendered page
    expect(root.querySelector("[data-test='page'] h2")!.textContent).toBe('Heading');
  });

  it('a clean page has no banner', () => {
    const { handle, root } = mount([CLEAN]);
    handles.push(handle);
    expect(root.querySelectorAll("[data-test='org-warnings']")).toHaveLength(0);
    expect(root.querySelectorAll("[data-test='org-warning']")).toHaveLength(0);
    expect(root.querySelector('.lw-doc-pane')!.firstElementChild!.getAttribute('data-test'))
      .toBe('page');
  });

  it('switching from a warned page to a clean page removes the banner', () => {
    const { handle, root } = mount([WARNED, CLEAN]);
    handles.push(handle);
    expect(root.querySelectorAll("[data-test='org-warnings']")).toHaveLength(1);

    location.hash = '#/clean';
    hashChanged();

    expect(handle.activeIndex).toBe(1);
    expect(root.querySelectorAll("[data-test='org-warnings']")).toHaveLength(0);
    expect(root.querySelectorAll("[data-test='org-warning']")).toHaveLength(0);
    expect(root.querySelector('.lw-doc-pane')!.firstElementChild!.getAttribute('data-test'))
      .toBe('page');
  });
});
