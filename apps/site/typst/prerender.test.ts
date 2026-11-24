import { describe, expect, it } from 'vitest';
import type { Diagnostic } from 'typst-wasm';
import { formatDiagnostic } from './engine';
import { blockLocation } from './prerender';

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

  it('subtracts the injected diagram prelude line', () => {
    expect(formatDiagnostic(diagnostic, 1)).toBe(
      'didact-build-main.typ:1: boom',
    );
  });

  it('leaves math and other zero-offset compiles untouched', () => {
    expect(formatDiagnostic(diagnostic)).toBe(
      'didact-build-main.typ:2: boom',
    );
  });
});
