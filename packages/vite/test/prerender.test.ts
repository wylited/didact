import { describe, expect, it } from 'vitest';
import type { Diagnostic } from 'typst-wasm';
import { formatDiagnostic, responsiveSvg } from '../src/typst/engine';
import { blockLocation, prerenderOrgPages } from '../src/typst/prerender';

describe('blockLocation', () => {
  it('locates inline math by its dollar delimiters', () => {
    const org = '#+title: Demo\n\nHere is $x$ in a sentence.\n';
    expect(blockLocation(org, 'x', 'math').line).toBe(3);
  });

  it('locates display math on its own line', () => {
    const org = '#+title: Demo\n\n$$y$$\n';
    expect(blockLocation(org, 'y', 'math').line).toBe(3);
  });

  it('locates a diagram by its exact source, not a colliding line', () => {
    const first = [
      '#import "@preview/fletcher:0.4.0"',
      '#let shared = 1',
      '#let first = 2',
    ].join('\n');
    const second = [
      '#import "@preview/fletcher:0.5.0"',
      '#let shared = 1',
    ].join('\n');
    const org = [
      '* Diagrams',
      '',
      '#+begin_src typst',
      first,
      '#+end_src',
      '',
      '#+begin_src typst',
      second,
      '#+end_src',
    ].join('\n');

    // The representative line `#let shared = 1` also occurs in the earlier
    // diagram; the exact source must still name the second block.
    expect(blockLocation(org, second, 'diagram').line).toBe(10);
  });

  it('locates blocks accurately in Windows CRLF org files', () => {
    const first = '#let shared = 1\n#let first = 2';
    const second = '#let shared = 1\n#let second = 3';
    const org = [
      '#+title: CRLF Demo',
      '',
      '#+begin_src typst :results svg',
      ...first.split('\n'),
      '#+end_src',
      '',
      '#+begin_src typst :results svg',
      ...second.split('\n'),
      '#+end_src',
      '',
      '$$a +\r\nb$$',
    ].join('\r\n');

    expect(blockLocation(org, second, 'diagram')).toEqual({
      line: 9,
      snippet: '#let shared = 1',
    });
    expect(blockLocation(org, 'a +\nb', 'math')).toEqual({
      line: 13,
      snippet: 'a +',
    });
  });

  it('returns a null line when the block is absent', () => {
    const org = '#+title: Demo\n\nNothing here.\n';
    expect(blockLocation(org, '#let missing = 3', 'diagram').line).toBeNull();
  });
});

describe('formatDiagnostic', () => {
  const diagnostic: Diagnostic = {
    message: 'boom',
    severity: 'error',
    file: 'didact-build-main.typ',
    line: 2,
    formatted: '',
    hints: [],
    trace: [],
  };

  it('subtracts the injected prelude line', () => {
    expect(formatDiagnostic(diagnostic, 1)).toBe(
      'didact-build-main.typ:1: boom',
    );
  });

  it('leaves zero-offset compiles untouched', () => {
    expect(formatDiagnostic(diagnostic)).toBe('didact-build-main.typ:2: boom');
  });
});

describe('responsiveSvg', () => {
  it('leaves narrow SVGs untouched', () => {
    const svg =
      '<svg class="typst" width="200pt" height="100pt" viewBox="0 0 200 100"><rect height="50pt"/></svg>';
    expect(responsiveSvg(svg)).toBe(svg);
  });

  it('rewrites only the opening <svg> tag and leaves child attributes intact', () => {
    const svg =
      '<svg class="typst" width="600pt" viewBox="0 0 600 200"><rect width="100pt" height="50pt"/></svg>';
    expect(responsiveSvg(svg)).toBe(
      '<svg style="height:auto" class="typst" width="100%" viewBox="0 0 600 200"><rect width="100pt" height="50pt"/></svg>',
    );
  });

  it('merges height:auto cleanly when <svg> already has a style attribute', () => {
    const svg =
      '<svg class="typst" style="display:block" width="600pt" height="200pt" viewBox="0 0 600 200"><path d="M 0 0 L 10 10"/></svg>';
    expect(responsiveSvg(svg)).toBe(
      '<svg class="typst" style="display:block;height:auto" width="100%" viewBox="0 0 600 200"><path d="M 0 0 L 10 10"/></svg>',
    );
  });
});

describe('prerenderOrgPages', () => {
  it('skips mathLayoutCss and returns empty mathCss when no math is present', async () => {
    const artifacts = await prerenderOrgPages({
      plain: '#+TITLE: Plain\n\nJust prose and a code block.\n',
    });
    expect(artifacts).toEqual({
      math: {},
      diagrams: {},
      mathCss: '',
    });
  });
});
