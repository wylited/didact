// panel.ts — under-the-hood panel host. Renders Session.state() Panel[]
// generically; attached to at most one block (the last that ran/stepped).
// The panel starts detached: it is not in the DOM until the first
// attach() (first run/step), and detaching unmounts it entirely (the host
// layout drops the right pane); the next attach re-mounts it. Full
// re-render on every state() snapshot. Tooltips are comment-only: listing
// rows carry their source-line comment via data-tip; nothing else gets one.

import type { Panel } from './kernel';

export interface AttachedBlock {
  /** `#name` or `Block N`. */
  title: string;
  kernelLabel: string;
  state(): Panel[];
}

export class PanelHost {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly sectionsEl: HTMLElement;
  private readonly mount: HTMLElement;
  private readonly onVisibility: ((visible: boolean) => void) | undefined;
  private readonly collapsed = new Set<string>();
  private block: AttachedBlock | null = null;

  constructor(mount: HTMLElement, onVisibility?: (visible: boolean) => void) {
    this.mount = mount;
    this.doc = mount.ownerDocument ?? document;
    this.onVisibility = onVisibility;

    this.root = this.doc.createElement('aside');
    this.root.className = 'lw-panel';
    this.root.dataset.test = 'uth';
    this.root.setAttribute('aria-label', 'Execution inspector');

    const head = this.doc.createElement('div');
    head.className = 'lw-panel-head';

    this.titleEl = this.doc.createElement('span');
    this.titleEl.className = 'lw-panel-title';
    this.titleEl.dataset.test = 'uth-title';
    head.appendChild(this.titleEl);

    const detach = this.doc.createElement('button');
    detach.type = 'button';
    detach.dataset.test = 'uth-detach';
    detach.textContent = 'detach';
    detach.title = 'Close inspector panel';
    detach.addEventListener('click', () => this.detach());
    head.appendChild(detach);

    this.root.appendChild(head);

    this.sectionsEl = this.doc.createElement('div');
    this.sectionsEl.className = 'lw-sections';
    this.sectionsEl.dataset.test = 'uth-sections';
    this.root.appendChild(this.sectionsEl);

    // not mounted: the first attach() puts the panel into the DOM
  }

  attach(block: AttachedBlock): void {
    if (!this.root.isConnected) this.mount.appendChild(this.root);
    this.block = block;
    this.render();
    this.onVisibility?.(true);
  }

  /** Unmount the panel from the DOM and forget the attached block. */
  detach(): void {
    this.block = null;
    this.root.remove();
    this.onVisibility?.(false);
  }

  get attached(): AttachedBlock | null {
    return this.block;
  }

  private render(): void {
    // render() only runs while attached: attach() always sets the block.
    // NB: call this.block.state() as a method — destructuring `state` off
    // the block would detach it from its `this` and throw.
    const block = this.block!;
    this.titleEl.textContent = `${block.title} · ${block.kernelLabel}`;
    this.sectionsEl.replaceChildren();
    for (const panel of block.state()) {
      this.sectionsEl.appendChild(renderSection(panel, this.collapsed, this.doc));
    }
    // Scroll the listing's current instruction into view inside the panel
    // scroller directly (never scrolling the document window).
    const current = this.sectionsEl.querySelector<HTMLElement>('[data-test="current-instr"]');
    if (current !== null) scrollChildIntoContainer(this.mount, current);
  }
}

/** Scroll `container` by the minimal delta needed to reveal `child` without
 *  scrolling ancestor containers or the window. No-op when not laid out. */
function scrollChildIntoContainer(container: HTMLElement, child: HTMLElement): void {
  const box = container.getBoundingClientRect();
  const item = child.getBoundingClientRect();
  if (box.height === 0 || box.bottom === box.top) return;
  if (item.top < box.top) container.scrollTop -= box.top - item.top;
  else if (item.bottom > box.bottom) container.scrollTop += item.bottom - box.bottom;
}

function sectionShell(panel: Panel, collapsed: Set<string>, doc: Document): HTMLDivElement {
  const sec = doc.createElement('div');
  sec.className = 'lw-section';
  sec.dataset.kind = panel.kind;
  const isCollapsed = collapsed.has(panel.id);
  if (isCollapsed) sec.classList.add('lw-section-collapsed');

  const label = doc.createElement('button');
  label.type = 'button';
  label.className = 'lw-sec-label';
  label.textContent = panel.title;
  label.setAttribute('aria-expanded', String(!isCollapsed));
  label.addEventListener('click', () => {
    const next = !sec.classList.contains('lw-section-collapsed');
    sec.classList.toggle('lw-section-collapsed', next);
    label.setAttribute('aria-expanded', String(!next));
    if (next) collapsed.add(panel.id);
    else collapsed.delete(panel.id);
  });
  sec.appendChild(label);
  return sec;
}

const ZERO_VALUE = /^(0|0x0+|0\.0+|false)$/i;

function renderSection(panel: Panel, collapsed: Set<string>, doc: Document): HTMLElement {
  const sec = sectionShell(panel, collapsed, doc);
  switch (panel.kind) {
    case 'fields': {
      const grid = doc.createElement('div');
      grid.className = 'lw-fields';
      for (const f of panel.fields) {
        const cell = doc.createElement('div');
        const classes = ['lw-field'];
        if (f.changed === true) classes.push('lw-changed');
        else if (ZERO_VALUE.test(f.value.trim())) classes.push('lw-field-zero');
        cell.className = classes.join(' ');
        cell.dataset.test = `reg-${f.key}`;
        const key = doc.createElement('span');
        key.className = 'lw-field-key';
        key.textContent = f.key;
        const val = doc.createElement('span');
        val.className = 'lw-field-val';
        val.textContent = f.value;
        cell.append(key, val);
        if (f.sub !== undefined && f.sub !== '') {
          const sub = doc.createElement('span');
          sub.className = 'lw-field-sub';
          sub.textContent = f.sub;
          cell.appendChild(sub);
        }
        grid.appendChild(cell);
      }
      sec.appendChild(grid);
      break;
    }
    case 'listing': {
      const table = doc.createElement('table');
      table.className = 'lw-listing';
      const tbody = doc.createElement('tbody');
      for (const row of panel.rows) {
        const tr = doc.createElement('tr');
        tr.className = row.current === true ? 'lw-row-current' : 'lw-row';
        if (row.current === true) tr.dataset.test = 'current-instr';
        if (row.tip !== undefined && row.tip !== '') tr.dataset.tip = row.tip;
        const addr = doc.createElement('td');
        addr.className = 'lw-addr';
        addr.textContent = hex(row.addr);
        const bytes = doc.createElement('td');
        bytes.className = 'lw-bytes';
        bytes.textContent = row.bytes;
        const text = doc.createElement('td');
        text.className = 'lw-text';
        text.textContent = row.text;
        tr.append(addr, bytes, text);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      sec.appendChild(table);
      break;
    }
    case 'hexdump': {
      const pre = doc.createElement('pre');
      pre.className = 'lw-hexdump';
      for (let r = 0; r < panel.rows.length; r++) {
        const row = panel.rows[r]!;
        if (r > 0) pre.appendChild(doc.createTextNode('\n'));
        const addrSpan = doc.createElement('span');
        addrSpan.className = 'lw-addr';
        addrSpan.textContent = `${hex(row.addr)}  `;
        pre.appendChild(addrSpan);
        for (let i = 0; i < 16; i++) {
          if (i > 0) pre.appendChild(doc.createTextNode(' '));
          if (i < row.bytes.length) {
            const b = row.bytes[i]!;
            const txt = byte(b);
            if (b === 0) {
              const z = doc.createElement('span');
              z.className = 'lw-hex-zero';
              z.textContent = txt;
              pre.appendChild(z);
            } else {
              pre.appendChild(doc.createTextNode(txt));
            }
          } else {
            pre.appendChild(doc.createTextNode('  '));
          }
        }
        const asciiSpan = doc.createElement('span');
        asciiSpan.className = 'lw-hex-ascii';
        asciiSpan.textContent = `  |${row.ascii}|`;
        pre.appendChild(asciiSpan);
      }
      sec.appendChild(pre);
      break;
    }
    case 'console': {
      const out = doc.createElement('pre');
      out.className = 'lw-console';
      out.dataset.test = 'output';
      out.textContent = panel.text;
      sec.appendChild(out);
      break;
    }
    case 'html': {
      // Trusted kernel-generated markup (e.g. rendered SVG) — never raw
      // user input; the kernel contract vouches for it.
      const box = doc.createElement('div');
      box.className = 'lw-html';
      box.dataset.test = 'html-panel';
      box.innerHTML = panel.html;
      sec.appendChild(box);
      break;
    }
  }
  return sec;
}

const hex = (n: number): string => `0x${n.toString(16).padStart(4, '0')}`;
const byte = (n: number): string => n.toString(16).padStart(2, '0');
