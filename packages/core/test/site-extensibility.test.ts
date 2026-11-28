// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { resolvePages } from '../src/pages';
import { mountSite, type PageSpec, type SiteHandle } from '../src/site';
import { pageSlugs } from '../src/site-index';
import type { ExerciseOutcome, StorageLike } from '../src/teaching';
import { mathKey } from '../src/typst-source';
import { fakeKernel } from './fake-kernel';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}

const handles: SiteHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  location.hash = '';
  document.title = '';
  document.body.replaceChildren();
});

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('mountSite: multi-site storagePrefix isolation', () => {
  it('isolates nav state, progress, and code drafts between two sites sharing one storage', () => {
    const storage = new MemoryStorage();
    const pages: PageSpec[] = [{
      title: 'Lesson',
      file: 'lesson.org',
      orgSource: '#+TITLE: Lesson\n\n#+NAME: ex\n#+BEGIN_SRC mips\nnop\n#+END_SRC\n',
    }];

    const rootA = document.createElement('div');
    const rootB = document.createElement('div');
    document.body.append(rootA, rootB);

    const a = mountSite({
      root: rootA,
      kernels: [fakeKernel('mips').kernel],
      pages,
      fonts: false,
      routing: 'memory',
      storage,
      storagePrefix: 'siteA:',
    });
    const b = mountSite({
      root: rootB,
      kernels: [fakeKernel('mips').kernel],
      pages,
      fonts: false,
      routing: 'memory',
      storage,
      storagePrefix: 'siteB:',
    });
    handles.push(a, b);

    // Mutate nav side, manual completion, and editor code on site A only.
    a.setNavSide('right');
    rootA.querySelector<HTMLButtonElement>("[data-test='page-complete']")!.click();
    const viewA = EditorView.findFromDOM(rootA.querySelector<HTMLElement>('.cm-editor')!)!;
    viewA.dispatch({ changes: { from: 0, to: viewA.state.doc.length, insert: 'edited A' } });

    expect(storage.getItem('siteA:nav-side')).toBe('right');
    expect(storage.getItem('siteA:code:lesson.org:n:ex')).toBe('edited A');
    expect(storage.getItem('siteA:progress:lesson.org')).not.toBeNull();

    // Site B has untouched storage and state.
    expect(storage.getItem('siteB:nav-side')).toBeNull();
    expect(storage.getItem('siteB:code:lesson.org:n:ex')).toBeNull();
    expect(storage.getItem('siteB:progress:lesson.org')).toBeNull();
    expect(b.navSide).toBe('left');
    expect(b.blocks[0]!.source).toBe('nop');
    expect(rootB.querySelector("[data-test='page-progress']")!.textContent).toBe('Not complete');
  });

  it('normalizes a bare storagePrefix to a namespaced key and keeps an explicit "" unprefixed', () => {
    const storage = new MemoryStorage();
    const pages: PageSpec[] = [{
      title: 'Lesson',
      file: 'lesson.org',
      orgSource: '#+TITLE: Lesson\n\n#+NAME: ex\n#+BEGIN_SRC mips\nnop\n#+END_SRC\n',
    }];

    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages,
      fonts: false,
      routing: 'memory',
      storage,
      storagePrefix: 'my-site',
    });
    handles.push(handle);

    handle.setNavSide('right');
    root.querySelector<HTMLButtonElement>("[data-test='page-complete']")!.click();
    const view = EditorView.findFromDOM(root.querySelector<HTMLElement>('.cm-editor')!)!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } });

    // Keys are namespaced with a separator, never concatenated.
    expect(storage.getItem('my-site:nav-side')).toBe('right');
    expect(storage.getItem('my-site:progress:lesson.org')).not.toBeNull();
    expect(storage.getItem('my-site:code:lesson.org:n:ex')).toBe('edited');
    expect(storage.getItem('my-sitenav-side')).toBeNull();
    expect(storage.getItem('my-siteprogress:lesson.org')).toBeNull();

    // An explicit empty prefix stays unprefixed.
    const bareRoot = document.createElement('div');
    document.body.appendChild(bareRoot);
    const bare = mountSite({
      root: bareRoot,
      kernels: [fakeKernel('mips').kernel],
      pages,
      fonts: false,
      routing: 'memory',
      storage,
      storagePrefix: '',
    });
    handles.push(bare);
    bare.setNavSide('right');
    expect(storage.getItem('nav-side')).toBe('right');
  });
});

describe('mountSite: memory routing & initialPage', () => {
  const PAGES: PageSpec[] = [
    { title: 'Alpha', file: 'alpha.org', orgSource: '#+TITLE: Alpha\n\n* Intro\n\nOne.\n' },
    { title: 'Beta', file: 'beta.org', orgSource: '#+TITLE: Beta\n\n* Start\n\nTwo.\n' },
  ];

  it('navigates across pages without reading or mutating location.hash', () => {
    location.hash = '#/external-host-route';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const navigated: { index: number; slug: string; section: string | null }[] = [];

    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      fonts: false,
      routing: 'memory',
      initialPage: 'beta',
      navView: 'pages',
      storage: new MemoryStorage(),
      onNavigate: ({ index, slug, section }) => navigated.push({ index, slug, section }),
    });
    handles.push(handle);

    expect(handle.activeIndex).toBe(1);
    expect(handle.activeSlug).toBe('beta');
    expect(location.hash).toBe('#/external-host-route');

    // Clicking a nav link switches pages in memory without changing location.hash.
    root.querySelectorAll<HTMLAnchorElement>("[data-test='nav-item']")[0]!.click();
    expect(handle.activeIndex).toBe(0);
    expect(handle.activeSlug).toBe('alpha');
    expect(location.hash).toBe('#/external-host-route');

    // handle.navigate() works with slug + section.
    handle.navigate('beta', 'start');
    expect(handle.activeIndex).toBe(1);
    expect(location.hash).toBe('#/external-host-route');
    expect(navigated).toEqual([
      { index: 1, slug: 'beta', section: null },
      { index: 0, slug: 'alpha', section: null },
      { index: 1, slug: 'beta', section: 'start' },
    ]);
  });

  it('decodes percent-encoded hash segments and strips ?query before matching slugs', () => {
    location.hash = '#/%62eta/start?utm=test';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      fonts: false,
      storage: new MemoryStorage(),
    });
    handles.push(handle);

    expect(handle.activeIndex).toBe(1);
    expect(handle.activeSlug).toBe('beta');
    expect(root.querySelector('.lw-toc-active')!.textContent).toBe('Start');
  });
});

describe('mountSite: sidebar inert, landmarks, and document.title', () => {
  const PAGES: PageSpec[] = [
    { title: 'First', orgSource: '#+TITLE: First\n\nBody.\n' },
    { title: 'Second', orgSource: '#+TITLE: Second\n\nBody.\n' },
  ];

  it('marks the hidden navigation rail inert + aria-hidden and exposes navHidden/setNavHidden', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      fonts: false,
      routing: 'memory',
      storage: new MemoryStorage(),
    });
    handles.push(handle);

    const rail = root.querySelector<HTMLElement>("[data-test='nav']")!;
    const main = root.querySelector<HTMLElement>('.lw-doc-pane')!;
    const toc = root.querySelector<HTMLElement>("[data-test='toc']")!;

    expect(main.tagName).toBe('MAIN');
    expect(rail.getAttribute('aria-label')).toBe('Lesson navigation');
    expect(toc.getAttribute('aria-label')).toBe('On this page');
    expect(handle.navHidden).toBe(false);
    expect(rail.inert).toBe(false);
    expect(rail.getAttribute('aria-hidden')).toBeNull();

    handle.setNavHidden(true);
    expect(handle.navHidden).toBe(true);
    expect(rail.inert).toBe(true);
    expect(rail.hasAttribute('inert')).toBe(true);
    expect(rail.getAttribute('aria-hidden')).toBe('true');

    handle.setNavHidden(false);
    expect(handle.navHidden).toBe(false);
    expect(rail.inert).toBe(false);
    expect(rail.hasAttribute('inert')).toBe(false);
    expect(rail.getAttribute('aria-hidden')).toBeNull();
  });

  it('updates document.title per page and restores the original title on dispose', () => {
    document.title = 'Host App';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      brand: 'Course',
      fonts: false,
      routing: 'memory',
      storage: new MemoryStorage(),
    });

    expect(document.title).toBe('First · Course');
    handle.show(1);
    expect(document.title).toBe('Second · Course');

    handle.dispose();
    expect(document.title).toBe('Host App');
  });

  it('respects documentTitle: false and custom documentTitle formatter', () => {
    document.title = 'Untouched';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const quiet = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      fonts: false,
      routing: 'memory',
      documentTitle: false,
      storage: new MemoryStorage(),
    });
    expect(document.title).toBe('Untouched');
    quiet.show(1);
    expect(document.title).toBe('Untouched');
    quiet.dispose();
    expect(document.title).toBe('Untouched');

    const custom = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      brand: 'Lab',
      fonts: false,
      routing: 'memory',
      documentTitle: (page, brand) => `[${brand}] ${page.title}`,
      storage: new MemoryStorage(),
    });
    expect(document.title).toBe('[Lab] First');
    custom.dispose();
    expect(document.title).toBe('Untouched');
  });

  it('supports brandHref: null, showOrgWarnings: false, and host onExerciseResult', async () => {
    const outcomes: (ExerciseOutcome & { pageKey: string; pageIndex: number })[] = [];
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: [{
        title: 'Lab',
        file: 'lab.org',
        orgSource: [
          '#+TITLE: Lab',
          '#+UNKNOWN: dropped',
          '#+NAME: drill',
          '#+EXERCISE: Print hello',
          '#+CHECK: hello from fake kernel',
          '#+BEGIN_SRC mips',
          'nop',
          '#+END_SRC',
        ].join('\n'),
      }],
      fonts: false,
      routing: 'memory',
      brandHref: null,
      showOrgWarnings: false,
      storage: new MemoryStorage(),
      onExerciseResult: (outcome) => outcomes.push(outcome),
    });
    handles.push(handle);

    const brand = root.querySelector<HTMLElement>("[data-test='brand']")!;
    expect(brand.tagName).toBe('SPAN');
    expect(brand.getAttribute('href')).toBeNull();
    expect(root.querySelector("[data-test='org-warnings']")).toBeNull();

    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    expect(outcomes).toEqual([{
      id: 'lab.org:n:drill',
      title: 'Print hello',
      passed: true,
      actual: 'hello from fake kernel',
      pageKey: 'lab.org',
      pageIndex: 0,
    }]);
  });

  it('leaves no trailing separator in document.title when brand is empty', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      brand: '',
      fonts: false,
      routing: 'memory',
      storage: new MemoryStorage(),
    });
    handles.push(handle);

    expect(document.title).toBe('First');
    handle.show(1);
    expect(document.title).toBe('Second');
  });

  it('keeps focus and skips a redundant re-insert when moving the nav rail', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      fonts: false,
      routing: 'memory',
      storage: new MemoryStorage(),
    });
    handles.push(handle);

    const layout = root.querySelector<HTMLElement>('.lw-layout')!;
    const rail = root.querySelector<HTMLElement>("[data-test='nav']")!;
    const brand = root.querySelector<HTMLElement>("[data-test='brand']")!;
    expect(layout.firstElementChild).toBe(rail);

    brand.focus();
    expect(document.activeElement).toBe(brand);

    handle.setNavSide('right');
    expect(layout.lastElementChild).toBe(rail);
    expect(document.activeElement).toBe(brand);

    // A second request for the same side must not detach the focused control.
    handle.setNavSide('right');
    expect(layout.lastElementChild).toBe(rail);
    expect(document.activeElement).toBe(brand);
  });

  it('exposes distinct prev/next and lesson navigation landmarks', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      fonts: false,
      routing: 'memory',
      storage: new MemoryStorage(),
    });
    handles.push(handle);

    const prevnext = root.querySelector<HTMLElement>("[data-test='prevnext']")!;
    const nav = root.querySelector<HTMLElement>("[data-test='nav']")!;
    expect(prevnext.getAttribute('aria-label')).toBe('Previous and next lessons');
    expect(nav.getAttribute('aria-label')).toBe('Lesson navigation');
  });

  it('renders a non-link wordmark for brandHref: null and a titled home link by default', () => {
    const plainRoot = document.createElement('div');
    const linkRoot = document.createElement('div');
    document.body.append(plainRoot, linkRoot);
    const plain = mountSite({
      root: plainRoot,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      fonts: false,
      routing: 'memory',
      brandHref: null,
      storage: new MemoryStorage(),
    });
    const link = mountSite({
      root: linkRoot,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      fonts: false,
      routing: 'memory',
      storage: new MemoryStorage(),
    });
    handles.push(plain, link);

    const wordmark = plainRoot.querySelector<HTMLElement>("[data-test='brand']")!;
    expect(wordmark.tagName).toBe('SPAN');
    expect(wordmark.hasAttribute('title')).toBe(false);
    expect(wordmark.hasAttribute('href')).toBe(false);

    const home = linkRoot.querySelector<HTMLElement>("[data-test='brand']")!;
    expect(home.tagName).toBe('A');
    expect(home.getAttribute('title')).toBe('Home — return to first lesson');
    expect(home.getAttribute('href')).toBe('#/first');
  });
});

describe('mountSite: hash routing canonicalization', () => {
  const PAGES: PageSpec[] = [
    { title: 'Alpha', file: 'alpha.org', orgSource: '#+TITLE: Alpha\n\n* Intro\n\nOne.\n' },
    { title: 'Beta', file: 'beta.org', orgSource: '#+TITLE: Beta\n\n* Start\n\nTwo.\n' },
  ];

  it('navigates from a live search result even though rendering detaches the link', async () => {
    location.hash = '#/alpha';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      fonts: false,
      storage: new MemoryStorage(),
    });
    handles.push(handle);
    expect(handle.activeSlug).toBe('alpha');

    const input = root.querySelector<HTMLInputElement>("[data-test='search']")!;
    const results = root.querySelector<HTMLElement>("[data-test='search-results']")!;
    input.value = 'start';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const first = results.querySelector<HTMLAnchorElement>('a')!;
    const href = first.getAttribute('href')!;
    expect(href).toBe('#/beta/start');
    first.click();
    // The click assigns location.hash; happy-dom delivers hashchange from a
    // timer, so dispatch it deterministically (same pattern as site.test.ts).
    window.dispatchEvent(new Event('hashchange'));
    await flushAsync();
    expect(handle.activeSlug).toBe('beta');
    expect(location.hash).toBe(href);
    expect(root.querySelector('.lw-toc-active')!.textContent).toBe('Start');

    // Re-clicking a result whose href already IS the hash still routes.
    input.value = 'start';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    location.hash = href;
    results.querySelector<HTMLAnchorElement>('a')!.click();
    await flushAsync();
    expect(handle.activeSlug).toBe('beta');
    expect(root.querySelector('.lw-toc-active')!.textContent).toBe('Start');
  });

  it('navigate() canonicalizes the hash and drops unknown sections', () => {
    location.hash = '#/alpha';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const navigated: { section: string | null }[] = [];
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      fonts: false,
      storage: new MemoryStorage(),
      onNavigate: ({ section }) => navigated.push({ section }),
    });
    handles.push(handle);

    handle.navigate('beta', 'no-such-section');
    expect(location.hash).toBe('#/beta');
    expect(navigated.at(-1)).toEqual({ section: null });

    handle.navigate('beta', 'start');
    expect(location.hash).toBe('#/beta/start');
    expect(navigated.at(-1)).toEqual({ section: 'start' });
  });

  it('show() canonicalizes the hash, drops stale sections, and scrolls to the top', () => {
    location.hash = '#/beta/start';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const win = window;
    const originalScrollTo = win.scrollTo;
    const scrolls: ScrollToOptions[] = [];
    win.scrollTo = ((opts?: ScrollToOptions | number, y?: number): void => {
      scrolls.push(typeof opts === 'object' ? opts : { left: opts ?? 0, top: y ?? 0 });
    }) as typeof win.scrollTo;
    try {
      const handle = mountSite({
        root,
        kernels: [fakeKernel('mips').kernel],
        pages: PAGES,
        fonts: false,
        storage: new MemoryStorage(),
      });
      handles.push(handle);
      expect(handle.activeSlug).toBe('beta');

      scrolls.length = 0;
      handle.show(0);
      expect(location.hash).toBe('#/alpha');
      expect(handle.activeIndex).toBe(0);
      expect(scrolls.at(-1)).toEqual({ top: 0, behavior: 'auto' });
    } finally {
      win.scrollTo = originalScrollTo;
    }
  });

  it('falls back to initialPage for an unknown hash page slug', () => {
    location.hash = '#/unknown-slug';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: PAGES,
      fonts: false,
      initialPage: 'beta',
      storage: new MemoryStorage(),
    });
    handles.push(handle);

    expect(handle.activeSlug).toBe('beta');
    expect(location.hash).toBe('#/beta');
  });
});

describe('site-index: slug collisions, duplicate headings, and math mode consistency', () => {
  it('avoids pageSlug collisions between explicit "Page 0"/"Page 1" titles and non-ASCII titles', () => {
    const slugsA = pageSlugs([
      { title: '中文', orgSource: '' },
      { title: 'Page 0', orgSource: '' },
    ]);
    expect(new Set(slugsA).size).toBe(2);
    expect(slugsA).toEqual(['page-0', 'page-1']);

    const slugsB = pageSlugs([
      { title: 'Page 1', orgSource: '' },
      { title: '中文', orgSource: '' },
    ]);
    expect(new Set(slugsB).size).toBe(2);
    expect(slugsB).toEqual(['page-1', 'page-1-2']);
  });

  it('resolves duplicate heading links to the FIRST matching heading', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages: [{
        title: 'Dupes',
        orgSource: [
          '#+TITLE: Dupes',
          '',
          'Jump to [[*Notes][notes]].',
          '',
          '* Notes',
          'First notes.',
          '',
          '* Notes',
          'Second notes.',
        ].join('\n'),
      }],
      fonts: false,
      routing: 'memory',
      storage: new MemoryStorage(),
    });
    handles.push(handle);

    const link = root.querySelector<HTMLAnchorElement>('a.lw-link')!;
    expect(link.getAttribute('href')).toBe('#/dupes/notes');
  });

  it('produces identical heading slugs in MathML and SVG math modes', () => {
    const artifacts = {
      math: {
        [mathKey('x^2', false)]: {
          mathml: '<math><msup><mi>x</mi><mn>2</mn></msup></math>',
          svg: '<svg viewBox="0 0 10 10"></svg>',
        },
      },
      diagrams: {},
      mathCss: '',
    };
    const pages: PageSpec[] = [{
      title: 'Math',
      orgSource: '#+TITLE: Math\n\nSee [[*Rule x^2][rule]].\n\n* Rule $x^2$\n\nBody.\n',
    }];

    const mountWithMode = (math: 'mathml' | 'svg'): { href: string | null; tocHref: string | null } => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      const handle = mountSite({
        root,
        kernels: [fakeKernel('mips').kernel],
        pages,
        fonts: false,
        routing: 'memory',
        storage: new MemoryStorage(),
        typst: { artifacts, math },
      });
      handles.push(handle);
      return {
        href: root.querySelector<HTMLAnchorElement>('a.lw-link')!.getAttribute('href'),
        tocHref: root.querySelector<HTMLAnchorElement>("[data-test='toc-item']")!.getAttribute('href'),
      };
    };

    const mathml = mountWithMode('mathml');
    const svg = mountWithMode('svg');
    expect(mathml.tocHref).toBe('#/math/rule-x-2');
    expect(svg.tocHref).toBe(mathml.tocHref);
    expect(svg.href).toBe(mathml.href);
  });
});

describe('mountSite: lazy per-page typst artifacts', () => {
  const mathFor = (src: string) => ({
    [mathKey(src, false)]: {
      mathml: `<math><mi>${src}</mi></math>`,
      svg: `<svg viewBox="0 0 10 10"><text>${src}</text></svg>`,
    },
  });

  it('mounts before the loader resolves and renders math only after ready', async () => {
    const gate = Promise.withResolvers<void>();
    const loader = vi.fn(() =>
      gate.promise.then(() => ({ math: mathFor('e1'), diagrams: {} })));
    const pages: PageSpec[] = [{
      title: 'Lazy',
      file: 'p.org',
      orgSource: '#+TITLE: Lazy\n\n* H\n\n$e1$\n',
    }];
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages,
      fonts: false,
      routing: 'memory',
      storage: new MemoryStorage(),
      typst: {
        artifacts: {
          math: {},
          diagrams: {},
          mathCss: '',
          pages: { 'p.org': loader },
        },
      },
    });
    handles.push(handle);

    // Mounted and routable, but the old (empty) document is still visible.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(handle.activeIndex).toBe(-1);
    expect(root.querySelector("[data-test='page']")).toBeNull();
    expect(root.querySelector("[data-test='math']")).toBeNull();
    expect(root.querySelector('.lw-doc-pane')!.getAttribute('aria-busy')).toBe('true');
    expect(root.classList.contains('lw-loading')).toBe(true);

    let ready = false;
    void handle.ready.then(() => { ready = true; });
    await flushAsync();
    expect(ready).toBe(false);

    gate.resolve();
    await handle.ready;
    await handle.idle;
    expect(ready).toBe(true);
    expect(handle.activeIndex).toBe(0);
    expect(root.querySelector('.lw-doc-pane')!.hasAttribute('aria-busy')).toBe(false);
    expect(root.classList.contains('lw-loading')).toBe(false);
    const math = root.querySelector<HTMLElement>("[data-test='math']");
    expect(math).not.toBeNull();
    expect(math!.textContent).toContain('e1');
  });

  it('keeps eager rendering synchronous when no pages map is present', async () => {
    const pages: PageSpec[] = [{
      title: 'Eager',
      file: 'p.org',
      orgSource: '#+TITLE: Eager\n\n* H\n\n$e2$\n',
    }];
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages,
      fonts: false,
      routing: 'memory',
      storage: new MemoryStorage(),
      typst: {
        artifacts: { math: mathFor('e2'), diagrams: {}, mathCss: '' },
      },
    });
    handles.push(handle);

    expect(handle.activeIndex).toBe(0);
    expect(root.querySelector<HTMLElement>("[data-test='math']")!.textContent).toContain('e2');
    expect(root.classList.contains('lw-loading')).toBe(false);
    await handle.ready;
    await handle.idle;
  });

  it('cancels a pending swap when navigating to an eager page first', async () => {
    const gate = Promise.withResolvers<void>();
    const loader = vi.fn(() =>
      gate.promise.then(() => ({ math: mathFor('e3'), diagrams: {} })));
    const pages: PageSpec[] = [
      { title: 'Alpha', file: 'a.org', orgSource: '#+TITLE: Alpha\n\nA text.\n' },
      { title: 'Beta', file: 'b.org', orgSource: '#+TITLE: Beta\n\n* B\n\n$e3$\n' },
      { title: 'Gamma', file: 'c.org', orgSource: '#+TITLE: Gamma\n\nC text.\n' },
    ];
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountSite({
      root,
      kernels: [fakeKernel('mips').kernel],
      pages,
      fonts: false,
      routing: 'memory',
      storage: new MemoryStorage(),
      typst: {
        artifacts: {
          math: {},
          diagrams: {},
          mathCss: '',
          pages: { 'b.org': loader },
        },
      },
    });
    handles.push(handle);
    expect(handle.activeSlug).toBe('alpha');

    handle.navigate('beta');
    expect(loader).toHaveBeenCalledTimes(1);
    // Beta's artifacts are not ready: Alpha stays visible and the pane is busy.
    expect(handle.activeSlug).toBe('alpha');
    expect(root.textContent).toContain('A text.');
    expect(root.classList.contains('lw-loading')).toBe(true);

    handle.navigate('gamma');
    expect(handle.activeSlug).toBe('gamma');
    expect(root.textContent).toContain('C text.');
    expect(root.classList.contains('lw-loading')).toBe(false);
    await handle.idle;

    // The late Beta result must not swap back over the newer route.
    gate.resolve();
    await flushAsync();
    expect(handle.activeSlug).toBe('gamma');
    expect(root.querySelector("[data-test='math']")).toBeNull();

    // Once resolved, the cached artifacts apply without another load.
    handle.navigate('beta');
    expect(handle.activeSlug).toBe('beta');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(root.querySelector<HTMLElement>("[data-test='math']")!.textContent).toContain('e3');
  });
});

describe('resolvePages', () => {
  it('orders pages, reads case-insensitive #+title:, falls back to stem, and warns on missing/extra files', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pages = resolvePages(
        {
          './pages/first.org': '#+title: Lowercase Title\n\nBody.\n',
          './pages/untitled.org': 'Just prose, no title line.\n',
          './pages/extra.org': '#+TITLE: Extra\n',
        },
        ['first', 'missing', 'untitled'],
      );
      expect(pages).toEqual([
        { title: 'Lowercase Title', orgSource: '#+title: Lowercase Title\n\nBody.\n', file: 'first.org' },
        { title: 'untitled', orgSource: 'Just prose, no title line.\n', file: 'untitled.org' },
      ]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]![0]).toContain('missing');
      expect(warn.mock.calls[1]![0]).toContain('extra.org');
    } finally {
      warn.mockRestore();
    }
  });

  it('reduces Windows-style path keys and order entries to the file stem', () => {
    const windows = resolvePages(
      { 'C:\\pages\\win.org': '#+TITLE: Win\n' },
      ['win'],
    );
    expect(windows).toEqual([{ title: 'Win', orgSource: '#+TITLE: Win\n', file: 'win.org' }]);

    const nested = resolvePages(
      { 'pages/a.org': '#+TITLE: A\n' },
      ['sub\\a.org'],
    );
    expect(nested).toEqual([{ title: 'A', orgSource: '#+TITLE: A\n', file: 'a.org' }]);
  });
});
