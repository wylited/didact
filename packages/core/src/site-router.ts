// site-router.ts — hash & memory route parsing, query stripping,
// percent-decoding, and page reference resolution.

import type { PageSpec } from './pages';

export type RoutingMode = 'hash' | 'memory';

export interface ParsedHashRoute {
  page: string;
  section: string | null;
}

function decodeSegment(segment: string | undefined): string {
  if (segment === undefined || segment === '') return '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Parse `#/<page-slug>[/<section-slug>][?query]` into decoded segments. */
export function parseHashRoute(hash: string): ParsedHashRoute {
  const withoutHash = hash.replace(/^#\/?/, '');
  const withoutQuery = withoutHash.split('?')[0] ?? '';
  const parts = withoutQuery.split('/');
  const page = decodeSegment(parts[0]);
  const section = decodeSegment(parts[1]);
  return { page, section: section === '' ? null : section };
}

/** Build a canonical fragment URL for a page slug and optional section. */
export function formatHash(slug: string, section?: string | null): string {
  return section !== undefined && section !== null && section !== ''
    ? `#/${slug}/${section}`
    : `#/${slug}`;
}

/** Resolve a 0-based index, slug, file name, or file stem to a page index
 *  (-1 when out of range or unknown). */
export function resolvePageRef(
  ref: number | string,
  pages: readonly PageSpec[],
  slugs: readonly string[],
): number {
  if (typeof ref === 'number') {
    return Number.isInteger(ref) && ref >= 0 && ref < pages.length ? ref : -1;
  }
  const trimmed = ref.trim();
  if (trimmed === '') return -1;
  const exact = slugs.indexOf(trimmed);
  if (exact !== -1) return exact;
  const lower = trimmed.toLowerCase();
  const stem = lower.replace(/\.org$/, '');
  for (let i = 0; i < pages.length; i++) {
    const slug = slugs[i]!;
    const file = (pages[i]!.file ?? `${slug}.org`).toLowerCase();
    if (
      slug.toLowerCase() === lower
      || file === lower
      || file.replace(/\.org$/, '') === stem
    ) {
      return i;
    }
  }
  return -1;
}

/** Update the window's URL fragment safely (guards sandboxed/file origins). */
export function replaceHash(win: Window, hash: string): void {
  try {
    win.history.replaceState(null, '', hash);
  } catch {
    /* history API may throw in restricted origins */
  }
}

/** True for an unmodified primary-button click (ignore Cmd/Ctrl/Shift/Alt/middle-click). */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey;
}
