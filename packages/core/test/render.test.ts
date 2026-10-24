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

describe('renderDocument: HTML safety', () => {
  it('renders prose containing <b>literal</b> as text, never as an element', () => {
    const org = '- item with <b>literal</b> markup\n';
    const { root } = renderDocument(parseOrg(org), () => true);
    expect(root.querySelector('b')).toBeNull();
    expect(root.querySelector('li')!.textContent).toBe('item with <b>literal</b> markup');
  });
});
