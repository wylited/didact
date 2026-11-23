// @vitest-environment happy-dom
// The build-time pipeline and the browser renderer share one contract:
// what counts as math/diagram, how it is keyed, and how a missing artifact
// degrades. These tests pin the contract, not the engine.

import { describe, expect, it } from 'vitest';
import { parseOrg } from '../src/org';
import { renderDocument, renderInline } from '../src/render';
import {
  collectTypstSources,
  diagramKey,
  isTypstDiagram,
  mathKey,
  splitTypstMath,
  type TypstArtifacts,
  type TypstRenderOptions,
} from '../src/typst-source';

function artifacts(over: Partial<TypstArtifacts> = {}): TypstArtifacts {
  return { math: {}, diagrams: {}, mathCss: '', ...over };
}

function inlineHtml(text: string, typst?: TypstRenderOptions): string {
  const p = document.createElement('p');
  renderInline(text, p, typst);
  return p.innerHTML;
}

describe('splitTypstMath', () => {
  it('splits inline and display math with exact sources', () => {
    expect(splitTypstMath('a $x^2$ b $$y = 1$$ c')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'math', src: 'x^2', display: false },
      { kind: 'text', text: ' b ' },
      { kind: 'math', src: 'y = 1', display: true },
      { kind: 'text', text: ' c' },
    ]);
  });

  it('leaves dollars literal inside code and verbatim spans', () => {
    expect(splitTypstMath('=$v0= and ~$a$~')).toEqual([
      { kind: 'text', text: '=$v0= and ~$a$~' },
    ]);
  });

  it('treats escaped, unmatched, and space-padded dollars as text', () => {
    expect(splitTypstMath('\\$5 and $ 6 $ and $7')).toEqual([
      { kind: 'text', text: '$5 and $ 6 $ and $7' },
    ]);
  });

  it('allows spaces inside display delimiters and normalizes the key', () => {
    const parts = splitTypstMath('before $$ y = 1 $$ after');
    expect(parts).toEqual([
      { kind: 'text', text: 'before ' },
      { kind: 'math', src: ' y = 1 ', display: true },
      { kind: 'text', text: ' after' },
    ]);
    const mathPart = parts[1];
    expect(mathPart?.kind).toBe('math');
    if (mathPart?.kind !== 'math') throw new Error('expected a math part');
    expect(mathKey(mathPart.src, mathPart.display)).toBe('D:y = 1');
  });

  it('normalizes whitespace inside the key, not inside the source', () => {
    expect(mathKey(' x  +\n y ', false)).toBe('I:x + y');
    expect(mathKey('x', true)).toBe('D:x');
  });
});

describe('collectTypstSources', () => {
  it('finds math in prose, lists and tables but not in src blocks', () => {
    const org = [
      'Prose $a$ and $$b$$.',
      '- item $c$',
      '| $d$ | =$e=$ |',
      '#+BEGIN_SRC typst',
      '#let f = $g$',
      '#+END_SRC',
    ].join('\n');
    const got = collectTypstSources(parseOrg(org));
    expect(got.math.map((m) => `${m.display ? 'D' : 'I'}:${m.src}`)).toEqual([
      'I:a',
      'D:b',
      'I:c',
      'I:d',
    ]);
    expect(got.diagrams).toEqual([]);
  });

  it('deduplicates repeated formulas and collects static diagrams only', () => {
    const org = [
      'Repeated $x$ and $x$ again.',
      '#+BEGIN_SRC typst :results svg',
      '#import "@preview/fletcher:0.5.8": diagram',
      '#diagram()',
      '#+END_SRC',
      '#+BEGIN_SRC typst',
      'plain kernel block',
      '#+END_SRC',
    ].join('\n');
    const parsed = parseOrg(org);
    expect(collectTypstSources(parsed)).toEqual({
      math: [{ src: 'x', display: false }],
      diagrams: [
        '#import "@preview/fletcher:0.5.8": diagram\n#diagram()',
      ],
    });
    const [diagram, kernel] = parsed.filter((n) => n.kind === 'src');
    expect(diagram!.kind === 'src' && isTypstDiagram(diagram!)).toBe(true);
    expect(kernel!.kind === 'src' && isTypstDiagram(kernel!)).toBe(false);
  });
});

describe('renderInline math', () => {
  it('inserts the pre-rendered MathML and keeps surrounding text', () => {
    const key = mathKey('x^2', false);
    const html = inlineHtml('before $x^2$ after', {
      math: 'mathml',
      artifacts: artifacts({
        math: { [key]: { mathml: '<math><msup><mi>x</mi></msup></math>', svg: '<svg/>' } },
      }),
    });
    expect(html).toBe(
      'before <span class="lw-math" data-test="math"><math><msup><mi>x</mi></msup></math></span> after',
    );
  });

  it('uses the SVG artifact when math mode is svg and marks display math', () => {
    const key = mathKey('y', true);
    const html = inlineHtml('$$y$$', {
      math: 'svg',
      artifacts: artifacts({ math: { [key]: { mathml: '<math/>', svg: '<svg id="s"/>' } } }),
    });
    expect(html).toBe(
      '<span class="lw-math lw-math-block" data-test="math"><svg id="s"></svg></span>',
    );
  });

  it('shows the source instead of a hole when the artifact is missing', () => {
    const html = inlineHtml('$z$', { math: 'mathml', artifacts: artifacts() });
    expect(html).toBe(
      '<span class="lw-math lw-math-missing" data-test="math">$z$</span>',
    );
  });

  it('falls back to SVG when MathML is unavailable and no mode is forced', () => {
    const key = mathKey('x', false);
    const html = inlineHtml('$x$', {
      artifacts: artifacts({ math: { [key]: { mathml: '<math/>', svg: '<svg id="s"/>' } } }),
    });
    // happy-dom does not define MathMLElement, so this is the old-browser path.
    expect(html).toContain('<svg id="s">');
    expect(html).not.toContain('<math>');
  });

  it('leaves dollars literal when no artifacts are supplied', () => {
    expect(inlineHtml('cost $5 and $6')).toBe('cost $5 and $6');
  });

  it('does not turn =$v0= into math', () => {
    const html = inlineHtml('=mov $v0= $x$', {
      math: 'mathml',
      artifacts: artifacts({ math: { [mathKey('x', false)]: { mathml: '<math/>', svg: '' } } }),
    });
    expect(html).toBe(
      '<code class="lw-inline">mov $v0</code> <span class="lw-math" data-test="math"><math></math></span>',
    );
  });
});

describe('renderDocument static diagrams', () => {
  const org = [
    '#+BEGIN_SRC typst :results svg',
    '#let x = 1',
    '#+END_SRC',
    '#+BEGIN_SRC typst',
    '#let y = 2',
    '#+END_SRC',
  ].join('\n');

  it('renders a diagram block as SVG and does not mount a kernel', () => {
    const svg = '<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>';
    const { root, blocks } = renderDocument(parseOrg(org), () => true, {
      artifacts: artifacts({ diagrams: { [diagramKey('#let x = 1')]: svg } }),
    });
    expect(blocks).toHaveLength(1); // only the plain typst kernel block
    expect(blocks[0]!.node.code).toBe('#let y = 2');
    expect(root.querySelector('.lw-diagram svg')).not.toBeNull();
    expect(root.querySelectorAll('.lw-block-slot')).toHaveLength(1);
  });

  it('reports a missing diagram artifact with the source', () => {
    const { root } = renderDocument(parseOrg(org), () => true, {
      artifacts: artifacts(),
    });
    const miss = root.querySelector('.lw-diagram-missing');
    expect(miss?.textContent).toContain('not pre-rendered');
    expect(miss?.textContent).toContain('#let x = 1');
  });
});
