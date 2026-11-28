// block-io.ts — persistence, clipboard copy, platform key labels, and
// results-slot rendering for executable blocks.

import type { Panel } from './kernel';
import type { StorageLike } from './teaching';

export const DEFAULT_STORAGE_PREFIX = 'didact:';

/** Return a key prefix that ends in a namespace separator, appending `':'`
 *  when the caller passed a bare site name (`'my-site'` -> `'my-site:'`).
 *  `''` stays empty (deliberately unprefixed keys), and a prefix already
 *  ending in a separator (`':'`, `'/'`, `'_'`, `'.'`, `'-'`) is left alone.
 *  Keys are always namespaced this way, never concatenated directly
 *  (`'my-site' + 'nav-side'` would collide with a site named `'my-sitenav'`). */
export function normalizeStoragePrefix(prefix: string): string {
  if (prefix === '' || /[:/_.-]$/.test(prefix)) return prefix;
  return `${prefix}:`;
}

/** `Mod` is Meta on Apple platforms and Control elsewhere; the Run button
 *  advertises only the key that actually works on this machine. */
export function isApplePlatform(): boolean {
  return typeof navigator !== 'undefined'
    && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** localStorage may be absent or throw (privacy mode, sandboxed iframe). */
export function defaultStorage(): StorageLike | null {
  try {
    if (!('localStorage' in globalThis)) return null;
    const storage: StorageLike | null = globalThis.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

function codeKey(prefix: string, id: string): string {
  return `${prefix}code:${id}`;
}

/** Read a saved draft; unavailable or throwing storage returns null. */
export function readSavedCode(
  storage: StorageLike | null,
  prefix: string,
  id: string | undefined,
): string | null {
  if (id === undefined || storage === null) return null;
  try {
    return storage.getItem(codeKey(prefix, id));
  } catch {
    return null;
  }
}

/** Mirror the editor text into storage, or drop the draft when the text
 *  matches the sample. Never throws. */
export function writeSavedCode(
  storage: StorageLike | null,
  prefix: string,
  id: string | undefined,
  code: string,
  sample: string,
): void {
  if (id === undefined || storage === null) return;
  const key = codeKey(prefix, id);
  try {
    if (code === sample) storage.removeItem(key);
    else storage.setItem(key, code);
  } catch {
    // storage may be unavailable (privacy mode, quota, sandbox)
  }
}

/** Drop a saved draft from storage. Never throws. */
export function clearSavedCode(
  storage: StorageLike | null,
  prefix: string,
  id: string | undefined,
): void {
  if (id === undefined || storage === null) return;
  try {
    storage.removeItem(codeKey(prefix, id));
  } catch {
    // storage may be unavailable (privacy mode, quota, sandbox)
  }
}

/** Copy text via the async Clipboard API, falling back to a hidden textarea
 *  while preserving the previously focused element. */
export async function copyToClipboard(text: string, doc: Document): Promise<boolean> {
  try {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to textarea copy
  }
  return fallbackCopy(text, doc);
}

/** Hidden-textarea fallback for browsers without the async clipboard. */
function fallbackCopy(text: string, doc: Document): boolean {
  const previousFocus = doc.activeElement;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  try {
    doc.body.appendChild(area);
    area.select();
    return typeof doc.execCommand === 'function' && doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    if (
      previousFocus !== null
      && typeof (previousFocus as HTMLElement).focus === 'function'
    ) {
      (previousFocus as HTMLElement).focus();
    }
  }
}

/** Extract the console panel text (or empty string if absent). */
export function extractConsoleText(panels: readonly Panel[]): string {
  const panel = panels.find(
    (p: Panel): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
  return panel?.text ?? '';
}

/** Render console text and trusted kernel markup into a results slot. */
export function renderBlockResults(
  el: HTMLElement,
  panels: readonly Panel[],
  doc: Document,
): void {
  const nodes: Node[] = [];
  const con = panels.find(
    (p: Panel): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
  if (con !== undefined && con.text !== '') {
    const pre = doc.createElement('pre');
    pre.textContent = con.text;
    nodes.push(pre);
  }
  for (const p of panels) {
    if (p.kind !== 'html') continue;
    const box = doc.createElement('div');
    box.className = 'lw-html';
    box.innerHTML = p.html;
    nodes.push(box);
  }
  el.replaceChildren(...nodes);
}
