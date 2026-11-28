// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseOrg } from '../src/org';
import { renderDocument } from '../src/render';
import { diagramKey, mathKey } from '../src/typst-source';

describe('renderDocument: results slots', () => {
  it('wires a #+RESULTS: <name> slot to the src block with that name, not the nearest one', () => {
    const org = [
      '#+NAME: first',
      '#+BEGIN_SRC asm',
      'mov rax, 1',
      '#+END_SRC',
      '#+NAME: second',
      '#+BEGIN_SRC asm',
      'mov rbx, 2',
      '#+END_SRC',
      '#+RESULTS: first',
      ': canned output',
    ].join('\n');
    const { root, blocks } = renderDocument(parseOrg(org), () => true);

    expect(blocks).toHaveLength(2);
    const [first, second] = blocks;
    expect(first.node.name).toBe('first');
    expect(second.node.name).toBe('second');

    // The named results slot is wired to `first` only.
    expect(first.resultsEl).not.toBeNull();
    expect(first.resultsEl!.dataset.test).toBe('results');
    expect(first.resultsEl!.querySelector('pre')!.textContent).toBe('canned output');
    expect(second.resultsEl).toBeNull();

    // Exactly one results slot exists in the whole document.
    expect(root.querySelectorAll('[data-test="results"]')).toHaveLength(1);
  });

  it("leaves a block's results slot null when a second block's results cannot leak into it", () => {
    const org = [
      '#+NAME: lonely',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
      '#+NAME: other',
      '#+BEGIN_SRC asm',
      'nop',
      '#+END_SRC',
      '#+RESULTS: other',
      ': 99',
    ].join('\n');
    const { blocks } = renderDocument(parseOrg(org), () => true);
    expect(blocks[0]!.node.name).toBe('lonely');
    expect(blocks[0]!.resultsEl).toBeNull();
    expect(blocks[1]!.resultsEl!.querySelector('pre')!.textContent).toBe('99');
  });
});

describe('renderDocument: executability', () => {
  it('renders a lang outside the kernel registry as a static listing with no run control', () => {
    const org = [
      '#+BEGIN_SRC python',
      'print("hi")',
      '#+END_SRC',
    ].join('\n');
    const { root, blocks } = renderDocument(parseOrg(org), (lang) => lang === 'asm');

    expect(blocks).toEqual([]); // not registered → no executable block
    expect(root.querySelectorAll('.lw-block-slot')).toHaveLength(0); // no run control mount point
    const figure = root.querySelector('figure.lw-src')!;
    expect(figure.querySelector('figcaption')!.textContent).toBe('python');
    expect(figure.querySelector('pre')!.textContent).toBe('print("hi")');
  });
});

describe('renderDocument: table cells', () => {
  const org = [
    '| mnemonic | expansion |',
    '|---+---|',
    '| =write= | /assembler temporary/ |',
    '| *bold* and plain | ~verbatim~ |',
  ].join('\n');

  it('runs inline markup inside cells: =code=, /italic/, *bold*, ~verbatim~', () => {
    const { root } = renderDocument(parseOrg(org), () => true);
    const rows = root.querySelectorAll('.lw-table tbody tr');
    expect(rows).toHaveLength(2);

    // =write= → code.lw-inline, no stray markers left in the cell
    const td0 = rows[0]!.querySelectorAll('td')[0]!;
    expect(td0.querySelector('code.lw-inline')!.textContent).toBe('write');
    expect(td0.textContent).toBe('write');

    // /assembler temporary/ → em.lw-inline
    const td1 = rows[0]!.querySelectorAll('td')[1]!;
    expect(td1.querySelector('em.lw-inline')!.textContent).toBe('assembler temporary');
    expect(td1.textContent).toBe('assembler temporary');

    // a cell can mix marked and plain segments; ~verbatim~ → code
    const td2 = rows[1]!.querySelectorAll('td')[0]!;
    expect(td2.querySelector('strong.lw-inline')!.textContent).toBe('bold');
    expect(td2.textContent).toBe('bold and plain');
    const td3 = rows[1]!.querySelectorAll('td')[1]!;
    expect(td3.querySelector('code.lw-inline')!.textContent).toBe('verbatim');
  });

  it('renders marked-up header cells too, like an equivalent paragraph', () => {
    const { root } = renderDocument(parseOrg('| =$v0= | plain |', () => true));
    const th = root.querySelector('.lw-table thead th')!;
    expect(th.querySelector('code.lw-inline')!.textContent).toBe('$v0');
    expect(th.textContent).toBe('$v0');
  });

  it('leaves plain cells as bare text with no inline elements', () => {
    const { root } = renderDocument(parseOrg('| a | b |\n| c | d |', () => true));
    const cells = [...root.querySelectorAll('.lw-table th, .lw-table td')];
    expect(cells.map((c) => c.textContent)).toEqual(['a', 'b', 'c', 'd']);
    expect(cells.every((c) => c.querySelector('.lw-inline') === null)).toBe(true);
  });

  it('treats a pipe as a cell separator even inside a span (grammar has no escaping)', () => {
    // §Org-subset tokenizes rows on `|` before any markup pass, so =a|b=
    // is two cells — the unclosed markers stay literal text.
    const { root } = renderDocument(parseOrg('| =a | b= |', () => true));
    const cells = root.querySelectorAll('.lw-table th, .lw-table td');
    expect(cells).toHaveLength(2);
    expect(cells[0]!.querySelector('code')).toBeNull();
    expect(cells[0]!.textContent).toBe('=a');
    expect(cells[1]!.textContent).toBe('b=');
  });
});

describe('renderDocument: HTML safety', () => {
  it('renders prose containing <b>literal</b> as text, never as an element', () => {
    const org = '- item with <b>literal</b> markup\n';
    const { root } = renderDocument(parseOrg(org), () => true);
    expect(root.querySelector('b')).toBeNull();
    expect(root.querySelector('li')!.textContent).toBe('item with <b>literal</b> markup');
  });
});

describe('renderDocument: links', () => {
  const resolve = (target: string): string | null => {
    if (target === 'file:other.org') return '#/other-page';
    if (target === 'file:other.org::*Loops') return '#/other-page/loops';
    if (target === '*Local') return '#/this-page/local';
    return null;
  };

  it('renders an internal link through the resolver as a fragment anchor', () => {
    const { root } = renderDocument(
      parseOrg('See [[file:other.org][the other page]].'), () => true, { resolveLink: resolve });
    const a = root.querySelector('a.lw-link')!;
    expect(a.textContent).toBe('the other page');
    expect(a.getAttribute('href')).toBe('#/other-page');
    expect(a.getAttribute('target')).toBeNull();
  });

  it('renders a page + heading link and the inline markup inside its description', () => {
    const { root } = renderDocument(
      parseOrg('Read [[file:other.org::*Loops][the =while= loop]] next.'), () => true, { resolveLink: resolve });
    const a = root.querySelector('a.lw-link')!;
    expect(a.getAttribute('href')).toBe('#/other-page/loops');
    expect(a.querySelector('code.lw-inline')!.textContent).toBe('while');
    expect(a.textContent).toBe('the while loop');
  });

  it('falls back to the target text with the file: scheme hidden', () => {
    const { root } = renderDocument(
      parseOrg('See [[file:other.org]] and [[*Local]].'), () => true, { resolveLink: resolve });
    const anchors = [...root.querySelectorAll('a.lw-link')];
    expect(anchors.map((a) => a.textContent)).toEqual(['other.org', '*Local']);
    expect(anchors.map((a) => a.getAttribute('href')))
      .toEqual(['#/other-page', '#/this-page/local']);
  });

  it('renders emphasis inside a link label', () => {
    const { root } = renderDocument(
      parseOrg('Go [[*Local][=here= now]].'), () => true, { resolveLink: resolve });
    const a = root.querySelector('a.lw-link')!;
    expect(a.textContent).toBe('here now');
    expect(a.querySelector('code.lw-inline')!.textContent).toBe('here');
  });

  it('external http(s) links open in a new tab with a safe rel', () => {
    const { root } = renderDocument(
      parseOrg('Read [[https://example.org/a][the docs]].'), () => true, { resolveLink: resolve });
    const a = root.querySelector('a.lw-link')!;
    expect(a.getAttribute('href')).toBe('https://example.org/a');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.textContent).toBe('the docs');
  });

  it('mailto: works without a new tab', () => {
    const { root } = renderDocument(
      parseOrg('Mail [[mailto:a@b.c][us]].'), () => true, { resolveLink: resolve });
    const a = root.querySelector('a.lw-link')!;
    expect(a.getAttribute('href')).toBe('mailto:a@b.c');
    expect(a.getAttribute('target')).toBeNull();
  });

  it('an unresolved internal link is inert, never an anchor that navigates', () => {
    const { root } = renderDocument(
      parseOrg('Go [[file:missing.org][nowhere]].'), () => true, { resolveLink: resolve });
    expect(root.querySelector('a')).toBeNull();
    const broken = root.querySelector("[data-test='link-broken']")!;
    expect(broken.textContent).toBe('nowhere');
    expect(broken.getAttribute('title')).toBe('Unresolved link: file:missing.org');
  });

  it('without a resolver every internal link is broken (render is site-agnostic)', () => {
    const { root } = renderDocument(
      parseOrg('See [[file:other.org][other]].'), () => true);
    expect(root.querySelector('a')).toBeNull();
    expect(root.querySelectorAll("[data-test='link-broken']")).toHaveLength(1);
  });

  it('falls back to the target text when a link has an empty description [[target][]]', () => {
    const { root } = renderDocument(
      parseOrg('See [[file:other.org][]] and [[*Local][]].'),
      () => true,
      { resolveLink: resolve },
    );
    const anchors = [...root.querySelectorAll('a.lw-link')];
    expect(anchors.map((a) => a.textContent)).toEqual(['other.org', '*Local']);
    expect(anchors.map((a) => a.getAttribute('href')))
      .toEqual(['#/other-page', '#/this-page/local']);
  });
});

describe('renderDocument: folds', () => {
  const org = [
    '#+BEGIN_HINT',
    'Reach for *help* first.',
    '#+BEGIN_SOLUTION',
    'The answer is =42=.',
    '#+END_SOLUTION',
    '#+END_HINT',
  ].join('\n');

  it('renders hint and solution as closed <details> with a summary and body', () => {
    const { root } = renderDocument(parseOrg(org), () => true);
    const hint = root.querySelector("details[data-test='fold-hint']")!;
    expect(hint.classList.contains('lw-fold')).toBe(true);
    expect(hint.classList.contains('lw-hint')).toBe(true);
    expect(hint.hasAttribute('open')).toBe(false);
    expect(hint.querySelector('summary')!.textContent).toBe('Show hint');

    const body = hint.querySelector('.lw-fold-body')!;
    expect(body.children[0]!.textContent).toBe('Reach for help first.');
    expect(body.querySelector('strong.lw-inline')!.textContent).toBe('help');

    const solution = body.querySelector("details[data-test='fold-solution']")!;
    expect(solution.classList.contains('lw-solution')).toBe(true);
    expect(solution.querySelector('summary')!.textContent).toBe('Show solution');
    expect(solution.querySelector('code.lw-inline')!.textContent).toBe('42');
  });

  it('keeps executable indices continuous and pairs results across fold boundaries', () => {
    const src = [
      '#+BEGIN_SRC asm',
      'mov rax, 1',
      '#+END_SRC',
      '#+BEGIN_HINT',
      '#+BEGIN_SRC asm',
      'add rax, 2',
      '#+END_SRC',
      '#+RESULTS:',
      ': 3',
      '#+END_HINT',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
    ].join('\n');
    const { root, blocks } = renderDocument(parseOrg(src), () => true);

    expect(blocks.map((b) => b.index)).toEqual([1, 2, 3]);
    expect(blocks.map((b) => b.node.code)).toEqual(['mov rax, 1', 'add rax, 2', 'ret']);
    const body = root.querySelector('.lw-fold-body')!;
    expect(body.contains(blocks[1]!.mount)).toBe(true);
    expect(blocks[0]!.resultsEl).toBeNull();
    expect(blocks[1]!.resultsEl!.querySelector('pre')!.textContent).toBe('3');
    expect(blocks[2]!.resultsEl).toBeNull();
  });

  it('renders captions and math inside a fold with the document typst options', () => {
    const typst = {
      math: 'svg' as const,
      artifacts: {
        math: { [mathKey('P', false)]: { mathml: '<math/>', svg: '<svg id="fold-math"></svg>' } },
        diagrams: { [diagramKey('#let r = 1')]: '<svg id="fold-diagram"></svg>' },
        mathCss: '',
      },
    };
    const src = [
      '#+BEGIN_HINT',
      '#+CAPTION: tangent at $P$',
      '#+BEGIN_SRC typst :results svg',
      '#let r = 1',
      '#+END_SRC',
      '#+END_HINT',
    ].join('\n');
    const { root } = renderDocument(parseOrg(src), () => true, { typst });

    const body = root.querySelector('.lw-fold-body')!;
    expect(body.querySelector('figure.lw-diagram svg#fold-diagram')).not.toBeNull();
    const caption = body.querySelector('figcaption.lw-caption')!;
    expect(caption.querySelector('svg#fold-math')).not.toBeNull();
  });
});
