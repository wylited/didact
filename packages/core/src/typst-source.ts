// typst-source.ts — the contract between the build-time Typst pipeline and
// the browser renderer: which org text is math, which org src blocks are
// static diagrams, and how both are keyed.
//
// Website content is pre-rendered (scripts/prerender-typst.ts or the Vite
// plugin) into `TypstArtifacts`; rendering is a pure lookup, so this module
// has no engine, no DOM and no Node dependencies. The executable `typst`
// KERNEL is a separate layer and never imports this file.
//
// Grammar (org-babel compatible):
//   $…$    inline math (no space just inside either delimiter)
//   $$…$$  display math
//   =…= ~…~ code/verbatim spans are literal; \$ is a literal dollar
//   #+BEGIN_SRC typst :results svg   → static diagram (pre-rendered SVG)
//   #+BEGIN_SRC typst               → executable kernel block (unchanged)
//   #+BEGIN_SRC typst :file x.svg   → static diagram (same as :results svg)

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

/** Stable key for a formula: display flag plus whitespace-normalized source. */
export function mathKey(src: string, display: boolean): string {
  return `${display ? 'D' : 'I'}:${normalizeTypst(src)}`;
}

/** Stable key for a diagram: whitespace-normalized block source. */
export function diagramKey(src: string): string {
  return normalizeTypst(src);
}

/** The one normalization both sides use; never change without the pipeline. */
export function normalizeTypst(src: string): string {
  return src.trim().replace(/\s+/g, ' ');
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
    if (!display && /\s/.test(text[open]!)) {
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
      if (i > from && !/\s/.test(text[i - 1]!)) return i;
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
  for (const node of doc) {
    if (node.kind === 'src') {
      if (isTypstDiagram(node)) {
        const key = diagramKey(node.code);
        if (!seenDiagrams.has(key)) {
          seenDiagrams.add(key);
          diagrams.push(node.code);
        }
      }
      continue;
    }
    for (const text of inlineTexts(node)) {
      for (const part of splitTypstMath(text)) {
        if (part.kind !== 'math') continue;
        const key = mathKey(part.src, part.display);
        if (seenMath.has(key)) continue;
        seenMath.add(key);
        math.push({ src: part.src, display: part.display });
      }
    }
  }
  return { math, diagrams };
}
