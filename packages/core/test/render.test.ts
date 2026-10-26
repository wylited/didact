// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseOrg } from '../src/org';
import { renderDocument } from '../src/render';

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
