// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mountSite } from '../src/site';
import type { SiteHandle } from '../src/site';
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

interface Mounted {
  handle: SiteHandle;
  root: HTMLElement;
  session: FakeSession;
}

function mount(pages: PageSpec[] = PAGES): Mounted {
  const { kernel, session } = fakeKernel('mips');
  const root = document.createElement('div');
  document.body.appendChild(root);
  const handle = mountSite({ root, kernels: [kernel], pages, fonts: false });
  return { handle, root, session };
}

/** Flush pending microtasks (no real timers): the click handler's async
 * run() chain resolves over a few awaits on already-settled promises. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const handles: SiteHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  location.hash = '';
  document.body.replaceChildren();
});

describe('mountSite: navigation', () => {
  it('renders one nav item per page, in page order, naming each page', () => {
    const { handle, root } = mount();
    handles.push(handle);
    const items = [...root.querySelectorAll("[data-test='nav-item']")];
    expect(items.map((a) => a.textContent)).toEqual(['First Lesson', 'Second Lesson: Registers']);
  });

  it("clicking nav item 2 switches to page 2's content and its slug in the hash", () => {
    const { handle, root } = mount();
    handles.push(handle);
    const items = root.querySelectorAll<HTMLAnchorElement>("[data-test='nav-item']");
    items[1]!.click();
    // the click sets the fragment; happy-dom does not auto-fire the
    // hashchange a real browser would, so drive it explicitly
    expect(location.hash).toBe('#/second-lesson-registers');
    window.dispatchEvent(new Event('hashchange'));
    const page = root.querySelector("[data-test='page']")!;
    expect(page.textContent).toContain('Body text for page two.');
    expect(page.textContent).not.toContain('Intro to page one.');
    expect(handle.activeIndex).toBe(1);
  });

  it("falls back to page 0 on an unknown hash, normalizing the URL to name the page actually shown", () => {
    const { handle, root } = mount();
    handles.push(handle);
    root.querySelectorAll<HTMLAnchorElement>("[data-test='nav-item']")[1]!.click();
    window.dispatchEvent(new Event('hashchange')); // reach page 2 first
    expect(handle.activeIndex).toBe(1);
    location.hash = '#/unknown-slug';
    window.dispatchEvent(new Event('hashchange'));
    const page = root.querySelector("[data-test='page']")!;
    expect(handle.activeIndex).toBe(0);
    expect(page.textContent).toContain('Intro to page one.');
    // the URL no longer claims a page that does not exist
    expect(location.hash).toBe('#/first-lesson');
    location.hash = '#/second-lesson-registers';
    window.dispatchEvent(new Event('hashchange'));
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
      window.dispatchEvent(new Event('hashchange'));
      root.querySelectorAll<HTMLAnchorElement>("[data-test='nav-item']")[0]!.click();
      window.dispatchEvent(new Event('hashchange'));
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
    window.dispatchEvent(new Event('hashchange'));
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

describe('mountSite: contents rail and panel zone', () => {
  it('running a block attaches the wide panel mode, detach collapses it again', async () => {
    const { handle, root } = mount();
    handles.push(handle);
    // at rest: no panel, the contents (toc) live in the LEFT nav rail
    expect(root.classList.contains('lw-panel-attached')).toBe(false);
    expect(root.querySelector('.lw-rail-left [data-test=\'toc\']')).not.toBeNull();

    location.hash = '#/second-lesson-registers';
    window.dispatchEvent(new Event('hashchange'));
    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();

    // panel attached: root carries lw-panel-attached (right rail goes wide)
    expect(root.classList.contains('lw-panel-attached')).toBe(true);
    expect(root.querySelector("[data-test='uth']")).not.toBeNull();

    root.querySelector<HTMLButtonElement>("[data-test='uth-detach']")!.click();
    expect(root.classList.contains('lw-panel-attached')).toBe(false);
    // the contents never left the left rail
    expect(root.querySelector('.lw-rail-left [data-test=\'toc\']')).not.toBeNull();
  });

  it('lists one contents entry per h2/h3 in document order, none on a heading-less page', () => {
    const { handle, root } = mount(TOC_PAGES);
    handles.push(handle);
    const items = [...root.querySelectorAll("[data-test='toc-item']")];
    expect(items.map((a) => a.textContent)).toEqual(['Alpha', 'Sub', 'Beta']);
    // each heading got a slugged, readable anchor id
    expect(root.querySelector('#lw-h-alpha')!.textContent).toBe('Alpha');
    expect(root.querySelector('#lw-h-beta')!.textContent).toBe('Beta');
    // exactly one entry is active at rest: the first
    const active = root.querySelectorAll('.lw-toc-active');
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toBe('Alpha');
    root.querySelectorAll<HTMLAnchorElement>("[data-test='nav-item']")[1]!.click();
    window.dispatchEvent(new Event('hashchange'));
    expect(root.querySelectorAll("[data-test='toc-item']")).toHaveLength(0);
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
      window.dispatchEvent(new Event('hashchange'));
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
      window.dispatchEvent(new Event('hashchange'));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(root.querySelector('.lw-toc-active')!.textContent).toBe('Beta');
    // away to the heading-less page and back
    const nav = root.querySelectorAll<HTMLAnchorElement>("[data-test='nav-item']");
    nav[1]!.click();
    window.dispatchEvent(new Event('hashchange'));
    expect(root.querySelector('#lw-h-alpha')).toBeNull(); // old anchors went with the old page
    nav[0]!.click();
    window.dispatchEvent(new Event('hashchange'));
    const items = [...root.querySelectorAll("[data-test='toc-item']")];
    expect(items.map((a) => a.textContent)).toEqual(['Alpha', 'Sub', 'Beta']);
    expect(root.querySelector('#lw-h-alpha')!.textContent).toBe('Alpha');
    const active = root.querySelectorAll('.lw-toc-active');
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toBe('Alpha');
    expect(handle.activeIndex).toBe(0);
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