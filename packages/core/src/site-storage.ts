// site-storage.ts — prefixed, error-guarded persistence for navigator state
// and per-page completion progress.

import { DEFAULT_STORAGE_PREFIX, normalizeStoragePrefix } from './block-io';
import type { StorageLike } from './teaching';

/** Navigator side: the grid column the navigation rail occupies. */
export type NavSide = 'left' | 'right';

/** Which list the navigator shows. */
export type NavView = 'contents' | 'pages';

/** Per-page completion state persisted under
 *  `<prefix>progress:<page file or slug>`. */
export interface PageProgress {
  /** Block ids of exercises that passed. */
  passed: Set<string>;
  /** Manual completion flag (pages without checked exercises). */
  manual: boolean;
}

export interface SiteStore {
  readonly prefix: string;
  readNavSide(): NavSide | null;
  writeNavSide(side: NavSide): void;
  readNavHidden(): boolean;
  writeNavHidden(hidden: boolean): void;
  readProgress(pageKey: string): PageProgress;
  writeProgress(pageKey: string, progress: PageProgress): void;
}

/** Build a site-scoped storage wrapper. When `storage` is omitted, reads
 *  `win.localStorage` lazily inside each try/catch so throwing or unavailable
 *  storage never breaks mounting or interaction. */
export function createSiteStore(
  storage: StorageLike | null | undefined,
  prefix: string = DEFAULT_STORAGE_PREFIX,
  win: Window = window,
): SiteStore {
  prefix = normalizeStoragePrefix(prefix);
  const navSideKey = `${prefix}nav-side`;
  const navHiddenKey = `${prefix}nav-hidden`;
  const progressPrefix = `${prefix}progress:`;

  const backend = (): StorageLike | null => {
    if (storage === null) return null;
    if (storage !== undefined) return storage;
    try {
      return win.localStorage ?? null;
    } catch {
      return null;
    }
  };

  return {
    prefix,

    readNavSide(): NavSide | null {
      try {
        const stored = backend()?.getItem(navSideKey);
        return stored === 'left' || stored === 'right' ? stored : null;
      } catch {
        return null;
      }
    },

    writeNavSide(side: NavSide): void {
      try {
        backend()?.setItem(navSideKey, side);
      } catch {
        /* storage denied: the choice still applies, it just does not survive */
      }
    },

    readNavHidden(): boolean {
      try {
        return backend()?.getItem(navHiddenKey) === '1';
      } catch {
        return false;
      }
    },

    writeNavHidden(hidden: boolean): void {
      try {
        const store = backend();
        if (store === null) return;
        if (hidden) store.setItem(navHiddenKey, '1');
        else store.removeItem(navHiddenKey);
      } catch {
        /* storage denied */
      }
    },

    readProgress(pageKey: string): PageProgress {
      const progress: PageProgress = { passed: new Set(), manual: false };
      try {
        const raw = backend()?.getItem(`${progressPrefix}${pageKey}`);
        if (raw === null || raw === undefined) return progress;
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return progress;
        const record = parsed as { passed?: unknown; manual?: unknown };
        if (Array.isArray(record.passed)) {
          for (const id of record.passed) {
            if (typeof id === 'string') progress.passed.add(id);
          }
        }
        if (typeof record.manual === 'boolean') progress.manual = record.manual;
      } catch {
        /* malformed or storage denied: start clean */
      }
      return progress;
    },

    writeProgress(pageKey: string, progress: PageProgress): void {
      try {
        backend()?.setItem(
          `${progressPrefix}${pageKey}`,
          JSON.stringify({ passed: [...progress.passed], manual: progress.manual }),
        );
      } catch {
        /* storage denied: the state still applies in this session */
      }
    },
  };
}
