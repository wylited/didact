import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDiagramQuality } from '../src/typst/check';

const SOURCE = '#let mark(x) = x\n#set page(width: auto)\n';

/** A typical Typst page: white background path, then the user's shapes. */
function page(body: string): string {
  return (
    '<svg class="typst" width="100pt" height="50pt" viewBox="0 0 100 50">' +
    '<path fill="#ffffff" d="M 0 0v 50h 100v -50Z"/>' +
    body +
    '</svg>'
  );
}

describe('assertDiagramQuality', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a blank Typst page (white background only)', () => {
    expect(() => assertDiagramQuality(page(''), SOURCE)).toThrow(
      /^typst diagram rejected: no drawable elements/,
    );
  });

  it('rejects a blank page whose only element is a white full-canvas rect', () => {
    const svg =
      '<svg class="typst" width="100pt" height="50pt" viewBox="0 0 100 50">' +
      '<rect x="0" y="0" width="100" height="50" fill="#ffffff"/>' +
      '</svg>';
    expect(() => assertDiagramQuality(svg, SOURCE)).toThrow(
      /^typst diagram rejected: no drawable elements/,
    );
  });

  it('accepts a page with a real path beside the background', () => {
    const svg = page('<path fill="none" stroke="#000000" d="M 10 10L 20 20"/>');
    expect(() => assertDiagramQuality(svg, SOURCE)).not.toThrow();
  });

  it('does not drop white-filled stroked node boxes inside <g>', () => {
    // Typst/Fletcher diagram nodes commonly draw white-filled stroked boxes
    // starting at (0, 0) inside a translated `<g>` group.
    const svg = page(
      '<g transform="translate(10, 5)">' +
        '<path fill="#ffffff" stroke="#000000" d="M 0 0v 50h 100v -50Z"/>' +
        '</g>',
    );
    expect(() => assertDiagramQuality(svg, SOURCE)).not.toThrow();
  });

  it('does not drop a top-level white path when it has a visible stroke', () => {
    const svg =
      '<svg class="typst" width="100pt" height="50pt" viewBox="0 0 100 50">' +
      '<path fill="#ffffff" stroke="#000000" d="M 0 0v 50h 100v -50Z"/>' +
      '</svg>';
    expect(() => assertDiagramQuality(svg, SOURCE)).not.toThrow();
  });

  it('accepts a relative horizontal path like M 10 10 h 10', () => {
    const svg = page('<path fill="none" stroke="#000000" d="M 10 10 h 10"/>');
    expect(() => assertDiagramQuality(svg, SOURCE)).not.toThrow();
  });

  it('accepts a relative line path like M 10 10 l 10 10', () => {
    const svg = page('<path fill="none" stroke="#000000" d="M 10 10 l 10 10"/>');
    expect(() => assertDiagramQuality(svg, SOURCE)).not.toThrow();
  });

  it('accepts a compact SVG arc command with concatenated flags', () => {
    const svg = page(
      '<path fill="none" stroke="#000000" d="M 0 0 a 5 5 0 0110 10"/>',
    );
    expect(() => assertDiagramQuality(svg, SOURCE)).not.toThrow();
  });

  it('rejects a move-only path', () => {
    const svg = page('<path fill="none" stroke="#000000" d="M 10 10"/>');
    expect(() => assertDiagramQuality(svg, SOURCE)).toThrow(
      /^typst diagram rejected: no non-trivial geometry/,
    );
  });

  it('rejects a zero-size rect', () => {
    const svg = page('<rect width="0" height="0" fill="#000000"/>');
    expect(() => assertDiagramQuality(svg, SOURCE)).toThrow(
      /^typst diagram rejected: no non-trivial geometry/,
    );
  });

  it('rejects a zero-length path with distinct x and y coordinates (M 10 20 L 10 20)', () => {
    const svg = page('<path fill="none" stroke="#000000" d="M 10 20 L 10 20"/>');
    expect(() => assertDiagramQuality(svg, SOURCE)).toThrow(
      /^typst diagram rejected: no non-trivial geometry/,
    );
  });

  it('rejects a zero-length path that returns to its start', () => {
    const svg = page(
      '<path fill="none" stroke="#000000" d="M 10 10 L 10 10 Z"/>',
    );
    expect(() => assertDiagramQuality(svg, SOURCE)).toThrow(
      /^typst diagram rejected: no non-trivial geometry/,
    );
  });

  it('rejects a zero-length relative path (M 10 20 l 0 0)', () => {
    const svg = page('<path fill="none" stroke="#000000" d="M 10 20 l 0 0"/>');
    expect(() => assertDiagramQuality(svg, SOURCE)).toThrow(
      /^typst diagram rejected: no non-trivial geometry/,
    );
  });

  it('rejects a figure whose only geometry lives in <defs>', () => {
    const svg = page(
      '<defs><clipPath id="c"><rect width="40" height="20"/></clipPath></defs>' +
        '<path fill="none" stroke="#000000" d="M 0 0 L 0 0"/>',
    );
    expect(() => assertDiagramQuality(svg, SOURCE)).toThrow(
      /^typst diagram rejected: no non-trivial geometry/,
    );
  });

  it('rejects fully transparent shapes', () => {
    const svg = page(
      '<rect width="40" height="20" fill="#000000" opacity="0"/>',
    );
    expect(() => assertDiagramQuality(svg, SOURCE)).toThrow(
      /^typst diagram rejected: no drawable elements/,
    );
  });

  it('accepts a shape with fill none and a visible stroke', () => {
    const svg = page(
      '<rect width="40" height="20" fill="none" stroke="#000000"/>',
    );
    expect(() => assertDiagramQuality(svg, SOURCE)).not.toThrow();
  });

  it('accepts a shape with fill-opacity="0" and a visible stroke', () => {
    const svg = page(
      '<rect width="40" height="20" fill="#000000" fill-opacity="0" stroke="#000000"/>',
    );
    expect(() => assertDiagramQuality(svg, SOURCE)).not.toThrow();
  });

  it('accepts a shape with stroke-opacity="0" and a visible fill', () => {
    const svg = page(
      '<rect width="40" height="20" fill="#000000" stroke="#000000" stroke-opacity="0"/>',
    );
    expect(() => assertDiagramQuality(svg, SOURCE)).not.toThrow();
  });

  it('rejects a shape whose fill and stroke both have opacity 0', () => {
    const svg = page(
      '<rect width="40" height="20" fill="#000000" fill-opacity="0" stroke="#000000" stroke-opacity="0"/>',
    );
    expect(() => assertDiagramQuality(svg, SOURCE)).toThrow(
      /^typst diagram rejected: no drawable elements/,
    );
  });

  it('accepts real text', () => {
    const svg = page('<text x="0" y="10" font-size="10">Hello</text>');
    expect(() => assertDiagramQuality(svg, SOURCE)).not.toThrow();
  });

  it('warns on an out-of-range fixed width without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svg =
      '<svg class="typst" width="10pt" height="10pt" viewBox="0 0 10 10">' +
      '<path fill="none" stroke="#000000" d="M 0 0L 5 5"/>' +
      '</svg>';
    expect(() => assertDiagramQuality(svg, SOURCE)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('outside 20-1400px'),
    );
  });

  it('warns on an oversized responsive SVG (width="100%") using viewBox width', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 1200pt = 1600px (> 1400px) even after responsiveSvg rewrote width to 100%.
    const svg =
      '<svg style="height:auto" class="typst" width="100%" viewBox="0 0 1200 400">' +
      '<path fill="none" stroke="#000000" d="M 10 10 L 100 100"/>' +
      '</svg>';
    expect(() => assertDiagramQuality(svg, SOURCE)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1600.0px is outside 20-1400px'),
    );
  });

  it('does not warn on an in-range responsive SVG (width="100%")', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 600pt = 800px, inside 20-1400px.
    const svg =
      '<svg style="height:auto" class="typst" width="100%" viewBox="0 0 600 200">' +
      '<path fill="none" stroke="#000000" d="M 10 10 L 100 100"/>' +
      '</svg>';
    expect(() => assertDiagramQuality(svg, SOURCE)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
