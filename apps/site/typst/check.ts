// check.ts — build-time structural gate for compiled diagrams.
//
// A diagram can compile cleanly and still be visually empty: a blank block, a
// zero-size page, or shapes sized to nothing all produce a valid SVG with a
// viewBox and no ink. Rasterizing at build time is too expensive, so this gate
// checks structure only: a usable root, at least one drawable element, and at
// least one element with real geometry.

/** Greppable prefix on every rejection, so build logs can be filtered. */
const REJECT = 'typst diagram rejected:';

/** Elements that can leave a mark on the canvas (case-insensitive). */
const DRAWABLE_TAG =
  /<(path|line|rect|circle|ellipse|polygon|polyline|text|use|image)\b([^>]*)>/gi;

/** One `name="value"` / `name='value'` / `name=value` attribute. */
const ATTRIBUTE = /([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** Draw commands other than a bare moveto/closepath; `e` is never a command. */
const DRAW_COMMAND = /[LlHhVvCcSsQqTtAa]/;

/**
 * Throw when `svg` cannot be a meaningful diagram. `source` is the original
 * Typst block, included in the error so the log points at the offending page.
 *
 * Rejects: no `<svg>` root; missing or non-finite `viewBox`; no drawable
 * element; no non-trivial geometry. Warns on an intrinsic width outside
 * 20–1400px. Never mutates the SVG.
 *
 * Typst pads every page with a white background, which is not ink. A white
 * path starting at the origin and a white full-canvas rect are treated as
 * background: they do not count as drawables or as geometry.
 */
export function assertDiagramQuality(svg: string, source: string): void {
  const root = /<svg\b([^>]*)>/i.exec(svg);
  if (root === null) throw rejected('no <svg> root element', source);
  const rootAttrs = attributes(root[1] ?? '');
  const page = checkViewBox(rootAttrs, source);

  let drawables = 0;
  let paths = 0;
  let drawnPaths = 0;
  let textNodes = 0;
  let textDrawn = false;
  let geometry = false;

  // Definitions inside these containers are never painted directly, so a
  // clip path or symbol must not satisfy the gate on its own.
  const painted = svg.replace(
    /<(defs|clipPath|mask|pattern|symbol|marker)\b[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );

  for (const match of painted.matchAll(DRAWABLE_TAG)) {
    const tag = (match[1] ?? '').toLowerCase();
    const attrs = attributes(match[2] ?? '');

    // The page background is not a drawable; otherwise a blank page passes.
    if (tag === 'path' && isBackgroundPath(attrs)) continue;
    if (tag === 'rect' && isBackgroundRect(attrs, page.width, page.height)) {
      continue;
    }
    // A transparent or unpainted element leaves no mark.
    if (invisible(attrs)) continue;

    drawables += 1;

    if (tag === 'path') {
      paths += 1;
      if (drawnPath(attrs.get('d'))) {
        drawnPaths += 1;
        geometry = true;
      }
    } else if (tag === 'line') {
      const x1 = number(attrs.get('x1'));
      const y1 = number(attrs.get('y1'));
      const x2 = number(attrs.get('x2'));
      const y2 = number(attrs.get('y2'));
      if (x1 !== x2 || y1 !== y2) geometry = true;
    } else if (tag === 'rect') {
      if (positive(attrs, 'width') && positive(attrs, 'height')) geometry = true;
    } else if (tag === 'circle') {
      if (positive(attrs, 'r')) geometry = true;
    } else if (tag === 'ellipse') {
      if (positive(attrs, 'rx') && positive(attrs, 'ry')) geometry = true;
    } else if (tag === 'polygon' || tag === 'polyline') {
      if (spansPoints(attrs.get('points'))) geometry = true;
    } else if (tag === 'use' || tag === 'image') {
      // A reference is the only claim this gate can verify structurally.
      const href = attrs.get('href') ?? attrs.get('xlink:href') ?? '';
      if (href.trim() !== '') geometry = true;
    } else if (tag === 'text') {
      textNodes += 1;
    }
  }

  if (drawables === 0) {
    throw rejected(
      'no drawable elements (path, line, rect, circle, ellipse, polygon, polyline, text, use, image)',
      source,
    );
  }

  if (textNodes > 0 && !textDrawn) {
    for (const match of painted.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)) {
      if (textContent(match[1] ?? '') !== '') {
        textDrawn = true;
        geometry = true;
        break;
      }
    }
  }

  if (!geometry) {
    const reasons: string[] = [];
    if (paths > 0 && drawnPaths === 0) {
      reasons.push(`all ${paths} <path> element(s) have empty or move-only "d"`);
    }
    if (textNodes > 0 && !textDrawn) {
      reasons.push('all <text> content is whitespace');
    }
    if (reasons.length === 0) reasons.push('every element is zero-size');
    throw rejected(`no non-trivial geometry (${reasons.join('; ')})`, source);
  }

  warnWidth(rootAttrs, source);
}

/** The root must describe a positive, finite canvas. */
function checkViewBox(
  attrs: Map<string, string>,
  source: string,
): { width: number; height: number } {
  const raw = attrs.get('viewbox');
  if (raw === undefined) {
    throw rejected('root <svg> has no viewBox', source);
  }
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .filter((part) => part !== '')
    .map(Number);
  if (parts.length !== 4 || !parts.every((part) => Number.isFinite(part))) {
    throw rejected(`root <svg> viewBox is not four finite numbers: "${raw}"`, source);
  }
  const width = parts[2] ?? 0;
  const height = parts[3] ?? 0;
  if (!(width > 0 && height > 0)) {
    throw rejected(`root <svg> viewBox has no area: "${raw}"`, source);
  }
  return { width, height };
}

/** `fill` is an opaque white; Typst's page padding uses `#ffffff`. */
function whiteFill(attrs: Map<string, string>): boolean {
  const fill = (attrs.get('fill') ?? '').trim().toLowerCase();
  return fill === '#ffffff' || fill === '#fff' || fill === 'white';
}

/** A white path whose drawing starts at the page origin is page padding. */
function isBackgroundPath(attrs: Map<string, string>): boolean {
  if (!whiteFill(attrs)) return false;
  const start = /^[Mm][\s,]*([-+]?[\d.]+)[\s,]+([-+]?[\d.]+)/.exec(
    attrs.get('d') ?? '',
  );
  if (start === null) return false;
  return Number(start[1]) === 0 && Number(start[2]) === 0;
}

/** A white rect spanning the whole viewBox is page padding (allow pt drift). */
function isBackgroundRect(
  attrs: Map<string, string>,
  width: number,
  height: number,
): boolean {
  if (!whiteFill(attrs)) return false;
  if (number(attrs.get('x')) !== 0 || number(attrs.get('y')) !== 0) return false;
  return (
    Math.abs(number(attrs.get('width')) - width) <= 1 &&
    Math.abs(number(attrs.get('height')) - height) <= 1
  );
}

/** Warn, but do not fail, on a suspicious intrinsic page width. */
function warnWidth(attrs: Map<string, string>, source: string): void {
  const raw = attrs.get('width');
  if (raw === undefined) return;
  // Percentages and other relative units have no intrinsic width to judge.
  const match = /^\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*(pt|px)?\s*$/i.exec(raw);
  if (match === null) return;
  const value = Number(match[1] ?? NaN);
  if (!Number.isFinite(value)) return;
  const px = (match[2] ?? '').toLowerCase() === 'pt' ? (value * 4) / 3 : value;
  if (px < 20 || px > 1400) {
    console.warn(
      `typst diagram width ${px.toFixed(1)}px is outside 20-1400px (source: ${sourceExcerpt(source)})`,
    );
  }
}

/** Parse an attribute list into lowercase names → raw values. */
function attributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? '').toLowerCase();
    attrs.set(name, match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attrs;
}

/** A drawable path needs a coordinate, a drawing command, and real extent. */
function drawnPath(d: string | undefined): boolean {
  if (d === undefined || !/\d/.test(d) || !DRAW_COMMAND.test(d)) return false;
  // `M 10 10 L 10 10 Z` paints nothing; a visible path spans two coordinates.
  const coords = d.match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? [];
  return new Set(coords.map(Number)).size > 1;
}

/** True for elements that are provably invisible (no paint or opacity 0). */
function invisible(attrs: Map<string, string>): boolean {
  const zero = (name: string): boolean => {
    const raw = attrs.get(name);
    return raw !== undefined && Number(raw.trim()) === 0;
  };
  if (attrs.get('display') === 'none') return true;
  if (attrs.get('visibility') === 'hidden') return true;
  if (zero('opacity') || zero('fill-opacity') || zero('stroke-opacity')) {
    return true;
  }
  const fill = (attrs.get('fill') ?? '').trim().toLowerCase();
  const stroke = (attrs.get('stroke') ?? '').trim().toLowerCase();
  return fill === 'none' && (stroke === '' || stroke === 'none');
}

/** An attribute parsed as a number, defaulting to 0 like SVG does. */
function number(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : 0;
}

function positive(attrs: Map<string, string>, name: string): boolean {
  return number(attrs.get(name)) > 0;
}

/** Two distinct points are the minimum for a polygon/polyline to draw. */
function spansPoints(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const coords = raw
    .trim()
    .split(/[\s,]+/)
    .filter((part) => part !== '')
    .map(Number);
  if (coords.length < 4 || coords.some((n) => !Number.isFinite(n))) return false;
  for (let i = 2; i + 1 < coords.length; i += 2) {
    if (coords[i] !== coords[0] || coords[i + 1] !== coords[1]) return true;
  }
  return false;
}

/** Text content minus nested markup and whitespace-only entities. */
function textContent(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|#160|#x[aA]0);/g, ' ')
    .trim();
}

/** First three non-empty source lines, folded onto one line. */
function sourceExcerpt(source: string): string {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 3);
  return lines.length === 0 ? '<empty source>' : lines.join(' | ');
}

/** A one-paragraph error naming the problem and pointing at the block. */
function rejected(problem: string, source: string): Error {
  return new Error(`${REJECT} ${problem} (source: ${sourceExcerpt(source)})`);
}
