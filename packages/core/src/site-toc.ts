// site-toc.ts — active-page table of contents and scroll-spy spotlight.

import { elementText, sectionSlugger } from './site-index';

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

/** A section heading can live inside a closed hint/solution (nested folds
 *  too): open every ancestor `<details>` so the scroll we are about to do
 *  lands on visible content instead of a zero-height closed region. */
export function openAncestorFolds(el: HTMLElement): void {
  for (let parent = el.parentElement; parent !== null; parent = parent.parentElement) {
    if (parent.localName === 'details') (parent as HTMLDetailsElement).open = true;
  }
}

export interface TocEntry {
  heading: HTMLElement;
  link: HTMLAnchorElement;
  /** URL slug of the section (`#/<page-slug>/<section-slug>`). */
  slug: string;
}

/** Owns the active page's TOC entries, IntersectionObserver + passive
 *  rAF-throttled scroll spy, and active-item reveal inside the contents rail. */
export class TocController {
  private readonly doc: Document;
  private readonly win: Window;
  private readonly contentsEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly onLinkClick: (href: string, event: MouseEvent) => void;
  private entries: TocEntry[] = [];
  private active = -1;
  private observer: IntersectionObserver | null = null;
  private rafId: number | null = null;
  private readonly onScroll: () => void;

  constructor(
    doc: Document,
    win: Window,
    contentsEl: HTMLElement,
    listEl: HTMLElement,
    onLinkClick: (href: string, event: MouseEvent) => void,
  ) {
    this.doc = doc;
    this.win = win;
    this.contentsEl = contentsEl;
    this.listEl = listEl;
    this.onLinkClick = onLinkClick;

    this.onScroll = () => {
      if (this.rafId !== null || this.entries.length === 0) return;
      this.rafId = this.win.requestAnimationFrame(() => {
        this.rafId = null;
        this.spyUpdate();
      });
    };
    this.win.addEventListener('scroll', this.onScroll, { passive: true });
  }

  get items(): readonly TocEntry[] {
    return this.entries;
  }

  get activeIndex(): number {
    return this.active;
  }

  findSection(slug: string | null): number {
    if (slug === null || slug === '') return -1;
    return this.entries.findIndex((e) => e.slug === slug);
  }

  /** Ensure `listEl` holds the current entries' anchor nodes. */
  syncDom(): void {
    if (this.listEl.childElementCount !== this.entries.length) {
      this.listEl.replaceChildren(...this.entries.map((e) => e.link));
    }
  }

  setActive(index: number): void {
    if (this.entries.length === 0) {
      this.active = -1;
      return;
    }
    const clamped = Math.max(0, Math.min(index, this.entries.length - 1));
    if (clamped === this.active) return;
    if (this.active !== -1 && this.entries[this.active] !== undefined) {
      this.entries[this.active]!.link.classList.remove('lw-toc-active');
    }
    this.active = clamped;
    this.entries[clamped]!.link.classList.add('lw-toc-active');
    this.revealActive();
  }

  /** Build the contents from a freshly rendered page: one real fragment
   *  link per h2/h3 heading. */
  build(docRoot: HTMLElement, pageSlugStr: string): void {
    this.clear();
    const headings = Array.from(
      docRoot.querySelectorAll<HTMLElement>('h2.lw-heading, h3.lw-heading'));
    const nextSlug = sectionSlugger();
    this.entries = headings.map((heading, i) => {
      const label = elementText(heading);
      const unique = nextSlug(label, i);
      heading.id = `lw-h-${unique}`;
      const href = `#/${pageSlugStr}/${unique}`;
      const link = this.doc.createElement('a');
      link.className = 'lw-toc-item';
      if (heading.tagName === 'H3') link.classList.add('lw-toc-sub');
      link.dataset.test = 'toc-item';
      link.href = href;
      link.textContent = label;
      link.addEventListener('click', (event) => this.onLinkClick(href, event));
      return { heading, link, slug: unique };
    });
    this.setActive(0);
    if (this.entries.length === 0 || typeof IntersectionObserver === 'undefined') {
      return; // tests/old DOMs: the hashchange & scroll paths still work
    }
    this.observer = new IntersectionObserver(() => this.spyUpdate());
    for (const { heading } of this.entries) this.observer.observe(heading);
  }

  /** Recompute the spotlight entry for the current viewport scroll. */
  spyUpdate(): void {
    if (this.entries.length === 0) return;
    const rects = this.entries.map((entry) => entry.heading.getBoundingClientRect());
    const laidOut = rects.some((rect) => rect.width !== 0 || rect.height !== 0);
    const samples = this.entries.map((entry, i) => {
      const rect = rects[i]!;
      return {
        top: rect.top,
        hidden: isInClosedFold(entry.heading)
          || (laidOut && rect.width === 0 && rect.height === 0),
      };
    });
    const docEl = this.doc.documentElement;
    // A document that cannot scroll is never "at the bottom": every
    // heading is visible, so the first (not the last) owns the spotlight.
    const atBottom = docEl.scrollHeight > this.win.innerHeight + 2
      && this.win.scrollY + this.win.innerHeight >= docEl.scrollHeight - 2;
    const best = selectActiveHeading(samples, atBottom);
    if (best !== -1) this.setActive(best);
  }

  /** Clear entries and observer on page switch. */
  clear(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.rafId !== null) {
      this.win.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.listEl.replaceChildren();
    this.entries = [];
    this.active = -1;
  }

  /** Tear down listeners and entries on site dispose. */
  dispose(): void {
    this.win.removeEventListener('scroll', this.onScroll);
    this.clear();
  }

  /** Scroll only the overflowing contents rail to reveal the active link
   *  without touching document scroll. */
  private revealActive(): void {
    const link = this.entries[this.active]?.link;
    if (link === undefined) return;
    const column = this.contentsEl;
    const box = column.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    if (box.height === 0 || box.bottom === box.top) return; // not laid out
    if (item.top < box.top) column.scrollTop -= box.top - item.top;
    else if (item.bottom > box.bottom) column.scrollTop += item.bottom - box.bottom;
  }
}
