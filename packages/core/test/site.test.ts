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

  it("falls back to page 0 on an unknown hash without crashing, and back-nav via hash returns to page 2", () => {
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
    location.hash = '#/second-lesson-registers';
    window.dispatchEvent(new Event('hashchange'));
    expect(handle.activeIndex).toBe(1);
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

describe('mountSite: dual-width right rail', () => {
  it('TOC mode by default; running a block attaches the wide panel mode, detach returns to TOC', async () => {
    const { handle, root } = mount();
    handles.push(handle);
    // TOC mode: no panel-attached class, TOC hook present
    expect(root.classList.contains('lw-panel-attached')).toBe(false);
    expect(root.querySelector("[data-test='toc']")).not.toBeNull();

    location.hash = '#/second-lesson-registers';
    window.dispatchEvent(new Event('hashchange'));
    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();

    // panel attached: root carries lw-panel-attached (right rail goes wide)
    expect(root.classList.contains('lw-panel-attached')).toBe(true);
    expect(root.querySelector("[data-test='uth']")).not.toBeNull();

    root.querySelector<HTMLButtonElement>("[data-test='uth-detach']")!.click();
    expect(root.classList.contains('lw-panel-attached')).toBe(false);
    expect(root.querySelector("[data-test='toc']")).not.toBeNull();
  });

  it('lists one toc item per h2/h3 in document order, none on a heading-less page', () => {
    const { handle, root } = mount(TOC_PAGES);
    handles.push(handle);
    const items = [...root.querySelectorAll("[data-test='toc-item']")];
    expect(items.map((a) => a.textContent)).toEqual(['Alpha', 'Sub', 'Beta']);
    // each heading got a per-page id in document order
    expect(root.querySelector('#lw-h-1')!.textContent).toBe('Alpha');
    expect(root.querySelector('#lw-h-3')!.textContent).toBe('Beta');
    // exactly one entry is active at rest: the first
    const active = root.querySelectorAll('.lw-toc-active');
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toBe('Alpha');
    root.querySelectorAll<HTMLAnchorElement>("[data-test='nav-item']")[1]!.click();
    window.dispatchEvent(new Event('hashchange'));
    expect(root.querySelectorAll("[data-test='toc-item']")).toHaveLength(0);
  });

  it("clicking a toc item scrolls its heading into view without touching the page hash", () => {
    const { handle, root } = mount(TOC_PAGES);
    handles.push(handle);
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element): void {
      scrolled.push(this);
    };
    try {
      root.querySelectorAll<HTMLAnchorElement>("[data-test='toc-item']")[2]!.click(); // Beta
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]!.id).toBe('lw-h-3');
    // in-page links never route: the fragment still names no heading
    expect(location.hash).not.toContain('lw-h-');
    // the clicked entry becomes active immediately
    const active = root.querySelectorAll('.lw-toc-active');
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toBe('Beta');
  });

  it('rebuilds the toc and resets the active entry on page switch', () => {
    const { handle, root } = mount(TOC_PAGES);
    handles.push(handle);
    // move the active entry off the first heading
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = (): void => undefined;
    try {
      root.querySelectorAll<HTMLAnchorElement>("[data-test='toc-item']")[2]!.click();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(root.querySelector('.lw-toc-active')!.textContent).toBe('Beta');
    // away to the heading-less page and back
    const nav = root.querySelectorAll<HTMLAnchorElement>("[data-test='nav-item']");
    nav[1]!.click();
    window.dispatchEvent(new Event('hashchange'));
    expect(root.querySelector('#lw-h-1')).toBeNull(); // old ids went with the old page
    nav[0]!.click();
    window.dispatchEvent(new Event('hashchange'));
    const items = [...root.querySelectorAll("[data-test='toc-item']")];
    expect(items.map((a) => a.textContent)).toEqual(['Alpha', 'Sub', 'Beta']);
    expect(root.querySelector('#lw-h-1')!.textContent).toBe('Alpha');
    const active = root.querySelectorAll('.lw-toc-active');
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toBe('Alpha');
    expect(handle.activeIndex).toBe(0);
  });

});

describe('mountSite: collapsible left page rail', () => {
  it('toggle collapses the rail (links hidden, aria-expanded flips) and expands back', () => {
    const { handle, root } = mount();
    handles.push(handle);
    const toggle = root.querySelector<HTMLButtonElement>("[data-test='nav-toggle']")!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(root.classList.contains('lw-left-collapsed')).toBe(true);
    const pages = root.querySelector('.lw-rail-pages')!;
    expect(pages.hidden).toBe(true);
    // the toggle itself stays reachable in the 32px strip
    expect(toggle.isConnected).toBe(true);
    expect(toggle.hidden).toBe(false);
    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(root.classList.contains('lw-left-collapsed')).toBe(false);
    expect(root.querySelector('.lw-rail-pages')!.hidden).toBe(false);
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