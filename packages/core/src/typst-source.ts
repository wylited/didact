// typst-source.ts — the contract between the build-time Typst pipeline and
// the browser renderer: which org text is math, which org src blocks are
// static diagrams, and how both are keyed.
//
// Website content is pre-rendered (packages/vite/src/typst/prerender.ts or
// the Vite plugin) into `TypstArtifacts`; rendering is a pure lookup, so this
// module has no engine, no DOM and no Node dependencies. The executable `typst`
// KERNEL is a separate layer and never imports this file.
//
// Grammar (org-babel compatible):
//   $…$    inline math (no space just inside either delimiter)
//   $$…$$  display math
//   =…= ~…~ code/verbatim spans are literal; \$ is a literal dollar
//   #+BEGIN_SRC typst :results svg   → static diagram (pre-rendered SVG)
//   #+BEGIN_SRC typst               → executable kernel block (unchanged)
//   #+BEGIN_SRC typst :file x.svg   → static diagram (same as :results svg)
//
// Collection mirrors rendering: links split first (only a description is
// inline content), then emphasis (`*`/`/` recurse, `=`/`~` are literal), and
// only then is math read from each remaining run. Fold bodies are walked the
// same way the renderer walks them.

import type { OrgNode } from './org';

/** One pre-rendered formula: MathML (default) plus an SVG fallback. */
export interface TypstMathArtifact {
  mathml: string;
  svg: string;
}

/** Everything the build pipeline produces for the site's org sources. */
export interface TypstArtifacts {
  /** Keyed by `mathKey(source, display)`. */
  math: Record<string, TypstMathArtifact>;
  /** Keyed by `diagramKey(source)`; value is a self-contained `<svg>`. */
  diagrams: Record<string, string>;
  /** Typst's MathML layout CSS, emitted once per document by the engine. */
  mathCss: string;
  /**
   * Lazy per-page artifacts, keyed by page file name (`'c.org'`).
   *
   * When present, the site loads a page's own `math`/`diagrams` before it
   * swaps that page in, so a page never carries another page's SVGs in the
   * entry chunk. The top-level `math`/`diagrams` are then only a fallback
   * (they may be empty, e.g. when the Vite plugin's `perPage` mode is on);
   * mount-time indices such as heading slugs fall back to the source text.
   */
  pages?: Record<
    string,
    () => Promise<Pick<TypstArtifacts, 'math' | 'diagrams'>>
  >;
}

/** What the renderer needs: pre-rendered artifacts plus the math mode. */
export interface TypstRenderOptions {
  artifacts: TypstArtifacts;
  /** 'mathml' (default) keeps text selectable; 'svg' is pixel-exact. */
  math?: 'mathml' | 'svg';
}

export interface TypstMathSource {
  src: string;
  display: boolean;
}

export interface TypstSources {
  math: TypstMathSource[];
  diagrams: string[];
}

/** One piece of org inline text after math extraction. */
export type TypstTextPart =
  | { kind: 'text'; text: string }
  | { kind: 'math'; src: string; display: boolean };

/** Stable key for a formula: display flag plus the exact (trimmed) source. */
export function mathKey(src: string, display: boolean): string {
  return `${display ? 'D' : 'I'}:${normalizeTypst(src)}`;
}

/** Stable key for a diagram: the exact (trimmed) block source. */
export function diagramKey(src: string): string {
  return normalizeTypst(src);
}

/**
 * The one normalization both sides use; never change without the pipeline.
 * Only surrounding whitespace is dropped: collapsing inner runs would merge
 * sources that differ inside string literals (`"a  b"` vs `"a b"`) and make
 * two distinct figures share one artifact.
 */
export function normalizeTypst(src: string): string {
  return src.trim();
}

/** True when a src block is a static diagram rather than a kernel block. */
export function isTypstDiagram(node: { lang: string; headers: string }): boolean {
  if (node.lang !== 'typst') return false;
  return /(?:^|\s):results\s+svg\b|(?:^|\s):file\s+\S+/.test(node.headers);
}

/**
 * Split org inline text into literal text and math. Code/verbatim spans are
 * copied verbatim (a `$` inside `=…=` is not math), `\$` is a literal dollar,
 * `$$…$$` is display and `$…$` inline. A span must be non-empty and may not
 * begin or end with whitespace; an unmatched `$` is literal text.
 */
export function splitTypstMath(text: string): TypstTextPart[] {
  const parts: TypstTextPart[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf !== '') {
      parts.push({ kind: 'text', text: buf });
      buf = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\' && text[i + 1] === '$') {
      buf += '$';
      i += 2;
      continue;
    }
    if (c === '=' || c === '~') {
      const close = findCodeClose(text, i);
      if (close !== -1) {
        buf += text.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    if (c !== '$') {
      buf += c;
      i++;
      continue;
    }
    const display = text[i + 1] === '$';
    const open = display ? i + 2 : i + 1;
    if (open >= text.length) {
      buf += c;
      i++;
      continue;
    }
    // Inline math may not be space-padded ($ x $ is not math); display math
    // conventionally is ($$ x $$), so only trim its source at the end.
    if (!display && ORG_MATH_OPEN_BLOCKED.test(text[open]!)) {
      buf += c;
      i++;
      continue;
    }
    const close = findMathClose(text, open, display);
    if (close === -1) {
      buf += c;
      i++;
      continue;
    }
    flush();
    parts.push({
      kind: 'math',
      src: text.slice(open, close),
      display,
    });
    i = close + (display ? 2 : 1);
  }
  flush();
  return parts;
}

/**
 * Org's delimiter rules for `$…$` (org-element.el
 * `org-element-latex-fragment-parser`): the character after the opening `$`
 * may not be whitespace or `, . ;`, and the closing `$` must follow a
 * non-space, non-`, .` character and be followed by whitespace, punctuation,
 * a bracket, a quote, or end of line. Without the trailing rule, `$x$y` and
 * `a$x$b` would be math here but literal text in Emacs.
 */
const ORG_MATH_OPEN_BLOCKED = /[\s,.;]/;
const ORG_MATH_CLOSE_BEFORE = /[\s,.]/;
const ORG_MATH_AFTER = /^$|[\s.,;:!?'"()[\]{}<>]/;

/** Index of the closing `$`/`$$` for a math span starting at `from`. */
function findMathClose(text: string, from: number, display: boolean): number {
  let i = from;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '$') {
      if (display) {
        if (text[i + 1] === '$' && i > from) return i;
        i++;
        continue;
      }
      // Org takes the next `$` as the close and rejects the whole fragment
      // if either neighbour fails; it never retries a later dollar.
      const before = text[i - 1]!;
      const after = text[i + 1] ?? '';
      return i > from &&
        !ORG_MATH_CLOSE_BEFORE.test(before) &&
        ORG_MATH_AFTER.test(after)
        ? i
        : -1;
    }
    i++;
  }
  return -1;
}

/** Index of the org code/verbatim span's closing marker, or -1. */
function findCodeClose(text: string, start: number): number {
  const marker = text[start]!;
  const prev = start > 0 ? text[start - 1]! : '';
  if (/[\w/]/.test(prev)) return -1; // org: an opening marker follows no word char
  if (start + 1 >= text.length || /\s/.test(text[start + 1]!)) return -1;
  for (let i = start + 2; i < text.length; i++) {
    if (text[i] !== marker) continue;
    const next = i + 1 < text.length ? text[i + 1]! : '';
    if (/[\w/]/.test(next) || /\s/.test(text[i - 1]!)) continue;
    return i;
  }
  return -1;
}

/**
 * Org inline markup, mirrors `render.ts`'s RE_LINK / RE_INLINE exactly. The
 * link alternative comes first so a span that both sides can see is read as
 * a link; groups 1/2 are the link target and description, group 3 is one
 * emphasis span. Border rules are copied verbatim: an opening marker may not
 * follow a word character or `/`, a closing marker may not precede one.
 */
const RE_MARKUP =
  /\[\[([^\[\]]+)\](?:\[([^\]]*)\])?\]|(?<![\w/])(\*[^*\s][^*]*\*|\/[^/\s][^/]*\/|=[^=\s][^=]*=|~[^~\s][^~]*~)(?![\w/])/g;

/**
 * The link alternative of RE_MARKUP, used only to reject an emphasis
 * candidate that crosses a link: `render.ts` extracts links first, so
 * `=see $x$ [[page]]=` is not a code span there (the `$x$` is math), and an
 * emphasis span that swallows a link must be re-scanned rather than skipped.
 */
const RE_LINK_SPAN = /\[\[[^\[\]]+\](?:\[[^\]]*\])?\]/;

/**
 * Report the formulas in one link- and emphasis-free run of org text.
 */
function addMathRuns(
  run: string,
  add: (src: string, display: boolean) => void,
): void {
  for (const part of splitTypstMath(run)) {
    if (part.kind === 'math') add(part.src, part.display);
  }
}

/**
 * Report every formula a browser would render from one org inline text.
 * Mirrors `renderInline` step for step: links first (the label is inline
 * content — the description if present, otherwise the target without its
 * `file:` scheme), then emphasis on each link-free run (`*`/`/` recurse,
 * `=`/`~` stay literal), then `splitTypstMath` on every remaining run.
 */
function addTypstMath(
  text: string,
  add: (src: string, display: boolean) => void,
): void {
  // Local stateful RegExp per call so recursion never clobbers lastIndex.
  const re = new RegExp(RE_MARKUP.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[3] === undefined) {
      addMathRuns(text.slice(last, start), add);
      // Only the label is inline content; a bare target is not. With no
      // (or empty) description org renders the target itself as the label
      // (minus the `file:` scheme), and `renderInline` scans that label.
      const desc = m[2];
      const label = desc !== undefined && desc !== '' ? desc : m[1]!.replace(/^file:/i, '');
      addTypstMath(label, add);
      last = end;
      continue;
    }
    const span = m[3]!;
    const marker = span[0]!;
    if (RE_LINK_SPAN.test(span)) {
      // render.ts splits the run at the link before emphasis is considered,
      // so this candidate is not emphasis at all. Restart one character in
      // and let the link (and any valid emphasis inside) be found.
      re.lastIndex = start + 1;
      continue;
    }
    addMathRuns(text.slice(last, start), add);
    if (marker === '*' || marker === '/') addTypstMath(span.slice(1, -1), add);
    // `=` and `~` are literal: a `$` inside them is never math.
    last = end;
  }
  addMathRuns(text.slice(last), add);
}

/** All text-bearing inline content in an org node, in document order. */
function inlineTexts(node: OrgNode): string[] {
  switch (node.kind) {
    case 'title':
    case 'subtitle':
    case 'heading':
    case 'para':
      return [node.text];
    case 'list':
      return node.items;
    case 'table':
      return [...node.head, ...node.rows.flat()];
    default:
      return [];
  }
}

/** Collect every formula and diagram the build pipeline must render. */
export function collectTypstSources(doc: readonly OrgNode[]): TypstSources {
  const math: TypstMathSource[] = [];
  const diagrams: string[] = [];
  const seenMath = new Set<string>();
  const seenDiagrams = new Set<string>();
  const emitMath = (src: string, display: boolean): void => {
    const key = mathKey(src, display);
    if (seenMath.has(key)) return;
    seenMath.add(key);
    math.push({ src, display });
  };
  // Fold bodies are rendered as part of the same document, in place, so the
  // walk recurses rather than treating a fold as opaque.
  const visit = (nodes: readonly OrgNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'fold') {
        visit(node.doc);
        continue;
      }
      if (node.kind === 'src') {
        if (!isTypstDiagram(node)) continue;
        const key = diagramKey(node.code);
        if (!seenDiagrams.has(key)) {
          seenDiagrams.add(key);
          diagrams.push(node.code);
        }
        // Only static diagrams render a `#+CAPTION:` figcaption
        // (`render.ts`); a kernel block's caption never reaches the page,
        // so a formula there would be compiled for nothing.
        if (node.caption !== null) addTypstMath(node.caption, emitMath);
        continue;
      }
      for (const text of inlineTexts(node)) addTypstMath(text, emitMath);
    }
  };
  visit(doc);
  return { math, diagrams };
}
