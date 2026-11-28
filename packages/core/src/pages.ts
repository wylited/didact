// pages.ts — lesson page descriptor and helper for turning globbed org
// sources + an explicit page order into PageSpec[].

/** One lesson page: nav title plus its org source. */
export interface PageSpec {
  title: string;
  orgSource: string;
  /** Source file name (`python.org`), the name org links use
   *  (`[[file:python.org]]`). Defaults to `<page-slug>.org`; without it,
   *  `file:` links still resolve by page slug. */
  file?: string;
}

const RE_TITLE = /^#\+TITLE:\s*(.+)$/im;

/** Strip any leading directory path and trailing `.org` extension. */
function stemOf(path: string): string {
  return path.replace(/^.*[/\\]/, '').replace(/\.org$/i, '');
}

/**
 * Resolve raw org sources (e.g. from `import.meta.glob('./pages/*.org', ...)`)
 * into an ordered `PageSpec[]`. Titles come from `#+TITLE:` (case-insensitive),
 * falling back to the file stem. Missing stems in `order` and extra files in
 * `sources` are reported via `console.warn` and skipped.
 */
export function resolvePages(
  sources: Record<string, string>,
  order: readonly string[],
): PageSpec[] {
  const byStem = new Map<string, string>();
  for (const [path, orgSource] of Object.entries(sources)) {
    byStem.set(stemOf(path), orgSource);
  }

  const orderedStems = new Set<string>();
  const pages: PageSpec[] = [];
  for (const name of order) {
    const stem = stemOf(name);
    orderedStems.add(stem);
    const orgSource = byStem.get(stem);
    if (orgSource === undefined) {
      console.warn(
        `didact: page "${name}" is in page order but missing from sources — skipped`,
      );
      continue;
    }
    const title = RE_TITLE.exec(orgSource)?.[1]?.trim() || stem;
    pages.push({ title, orgSource, file: `${stem}.org` });
  }

  for (const path of Object.keys(sources)) {
    if (orderedStems.has(stemOf(path))) continue;
    console.warn(`didact: ${path} is not in page order — page not shown`);
  }

  return pages;
}
