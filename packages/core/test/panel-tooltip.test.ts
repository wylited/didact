// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { Panel } from '../src/kernel';
import { PanelHost } from '../src/panel';
import { installTooltips } from '../src/tooltip';

afterEach(() => {
  document.body.replaceChildren();
});

describe('PanelHost', () => {
  it('labels the panel aside and keys collapsed sections by panel.id', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const panels: Panel[] = [
      { kind: 'console', id: 'out-a', title: 'Output', text: 'first' },
      { kind: 'console', id: 'out-b', title: 'Output', text: 'second' },
    ];
    const host = new PanelHost(mount);
    host.attach({ title: 'Block 1', kernelLabel: 'Fake', state: () => panels });

    const aside = mount.querySelector<HTMLElement>("[data-test='uth']")!;
    expect(aside.tagName).toBe('ASIDE');
    expect(aside.getAttribute('aria-label')).toBe('Execution inspector');

    // Two panels share the same title; collapsing the first must not collapse the second.
    const sections = [...mount.querySelectorAll<HTMLElement>('.lw-section')];
    expect(sections).toHaveLength(2);
    sections[0]!.querySelector<HTMLButtonElement>('.lw-sec-label')!.click();
    expect(sections[0]!.classList.contains('lw-section-collapsed')).toBe(true);
    expect(sections[1]!.classList.contains('lw-section-collapsed')).toBe(false);

    // Re-rendering preserves collapse state by panel.id.
    host.attach({ title: 'Block 1', kernelLabel: 'Fake', state: () => panels });
    const after = [...mount.querySelectorAll<HTMLElement>('.lw-section')];
    expect(after[0]!.classList.contains('lw-section-collapsed')).toBe(true);
    expect(after[1]!.classList.contains('lw-section-collapsed')).toBe(false);
    host.detach();
  });

  it('scrolls the panel mount directly to reveal the current listing row', () => {
    const mount = document.createElement('div');
    mount.scrollTop = 10;
    mount.getBoundingClientRect = () => ({
      top: 0, bottom: 200, left: 0, right: 400, width: 400, height: 200,
      x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    document.body.appendChild(mount);

    let scrollIntoViewCalls = 0;
    const origScrollIntoView = Element.prototype.scrollIntoView;
    const origGetRect = Element.prototype.getBoundingClientRect;
    Element.prototype.scrollIntoView = () => { scrollIntoViewCalls++; };
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (this.getAttribute('data-test') === 'current-instr') {
        return {
          top: 250, bottom: 270, left: 0, right: 300, width: 300, height: 20,
          x: 0, y: 250, toJSON: () => ({}),
        } as DOMRect;
      }
      return origGetRect.call(this);
    };

    try {
      const host = new PanelHost(mount);
      host.attach({
        title: 'Block 1',
        kernelLabel: 'Fake',
        state: () => [{
          kind: 'listing',
          id: 'asm',
          title: 'Disassembly',
          rows: [
            { addr: 0x1000, bytes: '90', text: 'nop' },
            { addr: 0x1001, bytes: 'c3', text: 'ret', current: true, tip: 'return' },
          ],
        }],
      });
      // Adjusted mount.scrollTop by (270 - 200) = 70, never calling window-scrolling scrollIntoView.
      expect(scrollIntoViewCalls).toBe(0);
      expect(mount.scrollTop).toBe(80);
      host.detach();
    } finally {
      Element.prototype.scrollIntoView = origScrollIntoView;
      Element.prototype.getBoundingClientRect = origGetRect;
    }
  });
});

describe('installTooltips', () => {
  it('links aria-describedby to the tooltip id, ignores child pointerout, and hides when scrolled offscreen', () => {
    const scope = document.createElement('div');
    const row = document.createElement('div');
    row.dataset.tip = 'load immediate';
    const child = document.createElement('span');
    child.textContent = 'addi';
    row.appendChild(child);
    scope.appendChild(row);
    document.body.appendChild(scope);

    let rectTop = 50;
    let rectBottom = 70;
    row.getBoundingClientRect = () => ({
      top: rectTop, bottom: rectBottom, left: 10, right: 110, width: 100, height: 20,
      x: 10, y: rectTop, toJSON: () => ({}),
    }) as DOMRect;

    const dispose = installTooltips(scope);
    try {
      const tip = document.querySelector<HTMLElement>('.lw-tip')!;
      expect(tip.id).not.toBe('');
      expect(tip.hidden).toBe(true);

      row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      expect(tip.hidden).toBe(false);
      expect(tip.textContent).toBe('load immediate');
      expect(row.getAttribute('aria-describedby')).toBe(tip.id);

      // Moving pointer into a child of the same target must keep the tooltip open.
      row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: child }));
      expect(tip.hidden).toBe(false);
      expect(row.getAttribute('aria-describedby')).toBe(tip.id);

      // Scrolling the target completely above the viewport hides the tooltip and clears aria-describedby.
      rectTop = -40;
      rectBottom = -20;
      window.dispatchEvent(new Event('scroll'));
      expect(tip.hidden).toBe(true);
      expect(row.getAttribute('aria-describedby')).toBeNull();
    } finally {
      dispose();
    }
    expect(document.querySelector('.lw-tip')).toBeNull();
  });
});
