// @vitest-environment happy-dom
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

interface Mounted {
  handle: SiteHandle;
  root: HTMLElement;
  session: FakeSession;
}

function mount(): Mounted {
  const { kernel, session } = fakeKernel('mips');
  const root = document.createElement('div');
  document.body.appendChild(root);
  const handle = mountSite({ root, kernels: [kernel], pages: PAGES, fonts: false });
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
