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

interface PageBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

interface PathSummary {
  drawn: boolean;
  hasPoints: boolean;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Throw when `svg` cannot be a meaningful diagram. `source` is the original
 * Typst block, included in the error so the log points at the offending page.
 *
 * Rejects: no `<svg>` root; missing or non-finite `viewBox`; no drawable
 * element; no non-trivial geometry. Warns on an intrinsic width outside
 * 20–1400px. Never mutates the SVG.
 *
 * Typst pads every page with a white background, which is not ink. An
 * unstroked top-level white path (before the first `<g>`) or unstroked white
 * rect that fills the viewBox is treated as background: it does not count as
 * a drawable or as geometry.
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

  // Typst emits the page background before any `<g>` group. Shapes inside
  // `<g>` (such as white-filled diagram boxes) are always foreground content.
  const firstGroup = /<g\b/i.exec(painted)?.index ?? -1;

  for (const match of painted.matchAll(DRAWABLE_TAG)) {
    const tag = (match[1] ?? '').toLowerCase();
    const attrs = attributes(match[2] ?? '');
    const beforeFirstGroup =
      firstGroup === -1 || (match.index ?? 0) < firstGroup;

    // A transparent or unpainted element leaves no mark.
    if (invisible(attrs, tag)) continue;

    // The page background is not a drawable; otherwise a blank page passes.
    let pathSummary: PathSummary | null = null;
    if (tag === 'path') {
      pathSummary = parsePath(attrs.get('d') ?? '');
      if (isBackgroundPath(attrs, page, beforeFirstGroup, pathSummary)) {
        continue;
      }
    } else if (
      tag === 'rect' &&
      isBackgroundRect(attrs, page, beforeFirstGroup)
    ) {
      continue;
    }

    drawables += 1;

    if (tag === 'path') {
      paths += 1;
      if (pathSummary !== null && pathSummary.drawn) {
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
      if (positive(attrs, 'width') && positive(attrs, 'height')) {
        geometry = true;
      }
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
      reasons.push(
        `all ${paths} <path> element(s) have empty or move-only "d"`,
      );
    }
    if (textNodes > 0 && !textDrawn) {
      reasons.push('all <text> content is whitespace');
    }
    if (reasons.length === 0) reasons.push('every element is zero-size');
    throw rejected(`no non-trivial geometry (${reasons.join('; ')})`, source);
  }

  warnWidth(rootAttrs, page, source);
}

/** The root must describe a positive, finite canvas. */
function checkViewBox(attrs: Map<string, string>, source: string): PageBox {
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
    throw rejected(
      `root <svg> viewBox is not four finite numbers: "${raw}"`,
      source,
    );
  }
  const minX = parts[0] ?? 0;
  const minY = parts[1] ?? 0;
  const width = parts[2] ?? 0;
  const height = parts[3] ?? 0;
  if (!(width > 0 && height > 0)) {
    throw rejected(`root <svg> viewBox has no area: "${raw}"`, source);
  }
  return { minX, minY, width, height };
}

/** `fill` is an opaque white; Typst's page padding uses `#ffffff`. */
function whiteFill(attrs: Map<string, string>): boolean {
  const fill = (attrs.get('fill') ?? '').trim().toLowerCase();
  return fill === '#ffffff' || fill === '#fff' || fill === 'white';
}

/** True when an attribute is explicitly numeric zero (e.g. `opacity="0"`). */
function zeroAttr(attrs: Map<string, string>, name: string): boolean {
  const raw = attrs.get(name);
  return raw !== undefined && Number(raw.trim()) === 0;
}

/** True when the element has a painted, non-zero-opacity stroke. */
function hasVisibleStroke(attrs: Map<string, string>): boolean {
  const stroke = (attrs.get('stroke') ?? '').trim().toLowerCase();
  return stroke !== '' && stroke !== 'none' && !zeroAttr(attrs, 'stroke-opacity');
}

/** True when the element has a painted, non-zero-opacity fill (SVG default is black). */
function hasVisibleFill(attrs: Map<string, string>): boolean {
  const fill = (attrs.get('fill') ?? '').trim().toLowerCase();
  return fill !== 'none' && !zeroAttr(attrs, 'fill-opacity');
}

/**
 * Only a top-level (before `<g>`), unstroked white path whose bounding box
 * matches the canvas is page padding. White-filled stroked boxes inside `<g>`
 * (like diagram nodes) are real ink.
 */
function isBackgroundPath(
  attrs: Map<string, string>,
  page: PageBox,
  beforeFirstGroup: boolean,
  summary: PathSummary,
): boolean {
  if (!beforeFirstGroup) return false;
  if (!whiteFill(attrs) || hasVisibleStroke(attrs)) return false;
  if (!summary.hasPoints) return false;
  return (
    Math.abs(summary.minX - page.minX) <= 1 &&
    Math.abs(summary.minY - page.minY) <= 1 &&
    Math.abs(summary.maxX - summary.minX - page.width) <= 1 &&
    Math.abs(summary.maxY - summary.minY - page.height) <= 1
  );
}

/** An unstroked top-level white rect spanning the whole viewBox is page padding. */
function isBackgroundRect(
  attrs: Map<string, string>,
  page: PageBox,
  beforeFirstGroup: boolean,
): boolean {
  if (!beforeFirstGroup) return false;
  if (!whiteFill(attrs) || hasVisibleStroke(attrs)) return false;
  return (
    Math.abs(number(attrs.get('x')) - page.minX) <= 1 &&
    Math.abs(number(attrs.get('y')) - page.minY) <= 1 &&
    Math.abs(number(attrs.get('width')) - page.width) <= 1 &&
    Math.abs(number(attrs.get('height')) - page.height) <= 1
  );
}

/**
 * Warn, but do not fail, on a suspicious intrinsic page width.
 * When `width` is relative (e.g. `width="100%"` after `responsiveSvg`) or
 * omitted, fall back to the `viewBox` width (Typst emits viewBox units in pt).
 */
function warnWidth(
  attrs: Map<string, string>,
  page: PageBox,
  source: string,
): void {
  const raw = attrs.get('width');
  let px: number;
  if (raw !== undefined) {
    const match = /^\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*(pt|px)?\s*$/i.exec(raw);
    if (match !== null) {
      const value = Number(match[1] ?? NaN);
      if (!Number.isFinite(value)) return;
      px = (match[2] ?? '').toLowerCase() === 'pt' ? (value * 4) / 3 : value;
    } else {
      // Relative width such as `100%`: judge against the intrinsic viewBox.
      px = (page.width * 4) / 3;
    }
  } else {
    px = (page.width * 4) / 3;
  }

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

/**
 * Walk an SVG path `d` attribute across all path commands
 * (`M/m/L/l/H/h/V/v/C/c/S/s/Q/q/T/t/A/a/Z/z`), tracking pen movement and
 * bounding box so relative moves (`M 10 10 h 10`) count as drawn while
 * zero-length paths (`M 10 20 L 10 20`) do not.
 */
function parsePath(d: string): PathSummary {
  const len = d.length;
  let pos = 0;

  const skipSep = (): void => {
    while (pos < len) {
      const ch = d.charCodeAt(pos);
      if (
        ch === 32 ||
        ch === 9 ||
        ch === 10 ||
        ch === 13 ||
        ch === 12 ||
        ch === 44
      ) {
        pos++;
      } else {
        break;
      }
    }
  };

  const numRe = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const readNum = (): number | null => {
    skipSep();
    if (pos >= len) return null;
    numRe.lastIndex = pos;
    const m = numRe.exec(d);
    if (m === null) return null;
    pos = numRe.lastIndex;
    const v = Number(m[0]);
    return Number.isFinite(v) ? v : null;
  };

  const readFlag = (): number | null => {
    skipSep();
    if (pos >= len) return null;
    const ch = d[pos];
    if (ch !== '0' && ch !== '1') return null;
    pos++;
    return ch === '1' ? 1 : 0;
  };

  let x = 0;
  let y = 0;
  let subX = 0;
  let subY = 0;
  let drawn = false;
  let hasPoints = false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const record = (px: number, py: number): void => {
    hasPoints = true;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  };

  let cmd = '';
  let isFirstMove = true;

  while (pos < len) {
    skipSep();
    if (pos >= len) break;

    const ch = d[pos]!;
    if (/^[MmLlHhVvCcSsQqTtAaZz]$/.test(ch)) {
      cmd = ch;
      pos++;
    } else if (cmd === '') {
      break;
    }

    const rel = cmd >= 'a' && cmd <= 'z';
    const upper = cmd.toUpperCase();

    if (upper === 'Z') {
      if (x !== subX || y !== subY) drawn = true;
      x = subX;
      y = subY;
      cmd = '';
      continue;
    }

    if (upper === 'M') {
      const a = readNum();
      const b = readNum();
      if (a === null || b === null) break;
      if (rel && !isFirstMove) {
        x += a;
        y += b;
      } else {
        x = a;
        y = b;
      }
      isFirstMove = false;
      subX = x;
      subY = y;
      record(x, y);
      // Subsequent coordinate pairs after M/m are implicit L/l per SVG spec.
      cmd = rel ? 'l' : 'L';
      continue;
    }

    if (upper === 'L') {
      const a = readNum();
      const b = readNum();
      if (a === null || b === null) break;
      const nx = rel ? x + a : a;
      const ny = rel ? y + b : b;
      if (nx !== x || ny !== y) drawn = true;
      record(x, y);
      record(nx, ny);
      x = nx;
      y = ny;
      continue;
    }

    if (upper === 'H') {
      const a = readNum();
      if (a === null) break;
      const nx = rel ? x + a : a;
      if (nx !== x) drawn = true;
      record(x, y);
      record(nx, y);
      x = nx;
      continue;
    }

    if (upper === 'V') {
      const a = readNum();
      if (a === null) break;
      const ny = rel ? y + a : a;
      if (ny !== y) drawn = true;
      record(x, y);
      record(x, ny);
      y = ny;
      continue;
    }

    if (upper === 'C') {
      const a1 = readNum();
      const b1 = readNum();
      const a2 = readNum();
      const b2 = readNum();
      const a3 = readNum();
      const b3 = readNum();
      if (
        a1 === null ||
        b1 === null ||
        a2 === null ||
        b2 === null ||
        a3 === null ||
        b3 === null
      ) {
        break;
      }
      const x1 = rel ? x + a1 : a1;
      const y1 = rel ? y + b1 : b1;
      const x2 = rel ? x + a2 : a2;
      const y2 = rel ? y + b2 : b2;
      const x3 = rel ? x + a3 : a3;
      const y3 = rel ? y + b3 : b3;
      if (
        x1 !== x ||
        y1 !== y ||
        x2 !== x ||
        y2 !== y ||
        x3 !== x ||
        y3 !== y
      ) {
        drawn = true;
      }
      record(x, y);
      record(x1, y1);
      record(x2, y2);
      record(x3, y3);
      x = x3;
      y = y3;
      continue;
    }

    if (upper === 'S' || upper === 'Q') {
      const a1 = readNum();
      const b1 = readNum();
      const a2 = readNum();
      const b2 = readNum();
      if (a1 === null || b1 === null || a2 === null || b2 === null) break;
      const x1 = rel ? x + a1 : a1;
      const y1 = rel ? y + b1 : b1;
      const x2 = rel ? x + a2 : a2;
      const y2 = rel ? y + b2 : b2;
      if (x1 !== x || y1 !== y || x2 !== x || y2 !== y) drawn = true;
      record(x, y);
      record(x1, y1);
      record(x2, y2);
      x = x2;
      y = y2;
      continue;
    }

    if (upper === 'T') {
      const a = readNum();
      const b = readNum();
      if (a === null || b === null) break;
      const nx = rel ? x + a : a;
      const ny = rel ? y + b : b;
      if (nx !== x || ny !== y) drawn = true;
      record(x, y);
      record(nx, ny);
      x = nx;
      y = ny;
      continue;
    }

    if (upper === 'A') {
      const rx = readNum();
      const ry = readNum();
      const rot = readNum();
      const largeArc = readFlag();
      const sweep = readFlag();
      const a = readNum();
      const b = readNum();
      if (
        rx === null ||
        ry === null ||
        rot === null ||
        largeArc === null ||
        sweep === null ||
        a === null ||
        b === null
      ) {
        break;
      }
      const nx = rel ? x + a : a;
      const ny = rel ? y + b : b;
      if (nx !== x || ny !== y) drawn = true;
      record(x, y);
      record(nx, ny);
      x = nx;
      y = ny;
      continue;
    }

    break;
  }

  return { drawn, hasPoints, minX, minY, maxX, maxY };
}

/**
 * True for elements that are provably invisible. A shape is visible if
 * `opacity !== 0` AND either fill is visible (`fill !== 'none'` and
 * `fill-opacity !== 0`) OR stroke is visible (`stroke` present,
 * `stroke !== 'none'`, and `stroke-opacity !== 0`).
 */
function invisible(attrs: Map<string, string>, tag: string): boolean {
  const display = (attrs.get('display') ?? '').trim().toLowerCase();
  if (display === 'none') return true;
  const visibility = (attrs.get('visibility') ?? '').trim().toLowerCase();
  if (visibility === 'hidden' || visibility === 'collapse') return true;
  if (zeroAttr(attrs, 'opacity')) return true;
  // `<image>` paints pixels regardless of fill/stroke attributes.
  if (tag === 'image') return false;
  return !(hasVisibleFill(attrs) || hasVisibleStroke(attrs));
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
  if (coords.length < 4 || coords.some((n) => !Number.isFinite(n))) {
    return false;
  }
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
