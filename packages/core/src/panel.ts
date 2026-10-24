// panel.ts — under-the-hood panel host. Renders Session.state() Panel[]
// generically; attached to at most one block (the last that ran/stepped);
// idle-empty when detached. Full re-render on every state() snapshot.

import type { Panel } from './kernel';

export interface AttachedBlock {
  /** `#name` or `Block N`. */
  title: string;
  kernelLabel: string;
  state(): Panel[];
}

export class PanelHost {
  private readonly root: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly sectionsEl: HTMLElement;
  private block: AttachedBlock | null = null;

  constructor(mount: HTMLElement) {
    this.root = document.createElement('aside');
    this.root.className = 'lw-panel';
    this.root.dataset.test = 'uth';
    this.root.dataset.tip = 'Under the hood: the live machine state of the attached block.';

    const head = document.createElement('div');
    head.className = 'lw-panel-head';

    this.titleEl = document.createElement('span');
    this.titleEl.className = 'lw-panel-title';
    this.titleEl.dataset.test = 'uth-title';
    head.appendChild(this.titleEl);

    const detach = document.createElement('button');
    detach.type = 'button';
    detach.dataset.test = 'uth-detach';
    detach.textContent = 'detach';
    detach.dataset.tip = 'Disconnect the panel from its block. Blocks keep running; the next run or step re-attaches.';
    detach.addEventListener('click', () => this.detach());
    head.appendChild(detach);

    this.root.appendChild(head);

    this.sectionsEl = document.createElement('div');
    this.sectionsEl.className = 'lw-sections';
    this.sectionsEl.dataset.test = 'uth-sections';
    this.root.appendChild(this.sectionsEl);

    mount.appendChild(this.root);
    this.render();
  }

  attach(block: AttachedBlock): void {
    this.block = block;
    this.render();
  }

  detach(): void {
    this.block = null;
    this.render();
  }

  get attached(): AttachedBlock | null {
    return this.block;
  }

  private render(): void {
    if (this.block === null) {
      this.titleEl.textContent = '';
      this.sectionsEl.replaceChildren();
      const idle = document.createElement('p');
      idle.className = 'lw-panel-idle';
      idle.textContent = 'idle — run or step a block to look under the hood';
      this.sectionsEl.appendChild(idle);
      return;
    }
    const { title, kernelLabel } = this.block;
    this.titleEl.textContent = `${title} · ${kernelLabel}`;
    this.sectionsEl.replaceChildren();
    for (const panel of this.block.state()) {
      this.sectionsEl.appendChild(renderSection(panel));
    }
  }
}

function sectionShell(panel: Panel): HTMLDivElement {
  const sec = document.createElement('div');
  sec.className = 'lw-section';
  sec.dataset.kind = panel.kind;
  const label = document.createElement('div');
  label.className = 'lw-sec-label';
  label.textContent = panel.title;
  if (panel.tip !== undefined) label.dataset.tip = panel.tip;
  sec.appendChild(label);
  return sec;
}

function renderSection(panel: Panel): HTMLElement {
  const sec = sectionShell(panel);
  switch (panel.kind) {
    case 'fields': {
      const grid = document.createElement('div');
      grid.className = 'lw-fields';
      for (const f of panel.fields) {
        const cell = document.createElement('div');
        cell.className = f.changed === true ? 'lw-field lw-changed' : 'lw-field';
        cell.dataset.test = `reg-${f.key}`;
        if (f.tip !== undefined) cell.dataset.tip = f.tip;
        const key = document.createElement('span');
        key.className = 'lw-field-key';
        key.textContent = f.key;
        const val = document.createElement('span');
        val.className = 'lw-field-val';
        val.textContent = f.value;
        cell.append(key, val);
        if (f.sub !== undefined && f.sub !== '') {
          const sub = document.createElement('span');
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
      const table = document.createElement('table');
      table.className = 'lw-listing';
      const tbody = document.createElement('tbody');
      for (const row of panel.rows) {
        const tr = document.createElement('tr');
        tr.className = row.current === true ? 'lw-row-current' : 'lw-row';
        if (row.current === true) tr.dataset.test = 'current-instr';
        if (row.tip !== undefined) tr.dataset.tip = row.tip;
        const addr = document.createElement('td');
        addr.className = 'lw-addr';
        addr.textContent = hex(row.addr);
        const bytes = document.createElement('td');
        bytes.className = 'lw-bytes';
        bytes.textContent = row.bytes;
        const text = document.createElement('td');
        text.className = 'lw-text';
        text.textContent = row.text;
        tr.append(addr, bytes, text);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      sec.appendChild(table);
      const current = tbody.querySelector('[data-test="current-instr"]');
      if (current !== null) current.scrollIntoView({ block: 'nearest' });
      break;
    }
    case 'hexdump': {
      const pre = document.createElement('pre');
      pre.className = 'lw-hexdump';
      const lines: string[] = [];
      for (const row of panel.rows) {
        const cells: string[] = [];
        for (let i = 0; i < 16; i++) {
          cells.push(i < row.bytes.length ? byte(row.bytes[i]!) : '  ');
        }
        const half = cells.slice(0, 8).join(' ');
        const rest = cells.slice(8).join(' ');
        lines.push(`${hex(row.addr)}  ${half} ${rest}  |${row.ascii}|`);
      }
      pre.textContent = lines.join('\n');
      sec.appendChild(pre);
      break;
    }
    case 'console': {
      const out = document.createElement('pre');
      out.className = 'lw-console';
      out.dataset.test = 'output';
      out.dataset.tip = 'Program output: everything the attached block printed.';
      out.textContent = panel.text;
      sec.appendChild(out);
      break;
    }
  }
  return sec;
}

const hex = (n: number): string => `0x${n.toString(16).padStart(4, '0')}`;
const byte = (n: number): string => n.toString(16).padStart(2, '0');
