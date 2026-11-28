// math-style.ts — reference-counted Typst MathML stylesheet ownership per
// Document. Live mounts that need the sheet share one <style> element, and
// the last owner to dispose removes it (adopted external sheets are kept).

interface MathStyleEntry {
  style: HTMLStyleElement;
  owners: number;
  owned: boolean;
}

const mathStyles = new WeakMap<Document, MathStyleEntry>();

/** Ensure the document has the Typst math stylesheet and return a release
 *  callback, or null when `mathCss` is empty. */
export function acquireMathStyle(
  doc: Document,
  fallbackHost: HTMLElement,
  mathCss: string,
): (() => void) | null {
  if (mathCss === '') return null;

  let entry = mathStyles.get(doc);
  if (entry !== undefined) {
    entry.style.textContent = mathCss;
    entry.owners++;
  } else {
    // An untracked sheet (supplied from outside this module) is adopted,
    // never removed by the mount that did not create it.
    const found = doc.head?.querySelector<HTMLStyleElement>(
      'style[data-test="typst-math-css"]',
    ) ?? null;
    const style = found ?? doc.createElement('style');
    if (found === null) {
      style.dataset.test = 'typst-math-css';
      (doc.head ?? fallbackHost).appendChild(style);
    }
    style.textContent = mathCss;
    entry = { style, owners: 1, owned: found === null };
    mathStyles.set(doc, entry);
  }

  let released = false;
  const held = entry;
  return () => {
    if (released) return;
    released = true;
    const current = mathStyles.get(doc);
    if (current !== held) return;
    current.owners--;
    if (current.owners <= 0) {
      mathStyles.delete(doc);
      if (current.owned) current.style.remove();
    }
  };
}
