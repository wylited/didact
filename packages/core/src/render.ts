// render.ts — turns an OrgDoc into DOM. Executable src blocks leave a mount
// point that site.ts fills with a BlockRuntime; read-only languages render
// as a static listing. Results slots pair with the nearest preceding src
// block (by #+NAME: when given).

import type { OrgDoc, OrgNode } from './org';

export interface RenderedBlock {
  /** 1-based index among executable blocks (for "Block N"). */
  index: number;
  node: Extract<OrgNode, { kind: 'src' }>;
  /** Element the BlockRuntime mounts into. */
  mount: HTMLElement;
  /** Paired `#+RESULTS:` slot element, if the document has one. */
  resultsEl: HTMLElement | null;
}

export interface RenderedDoc {
  root: HTMLElement;
  blocks: RenderedBlock[];
}

// Inline markup: *bold* /italic/ =code= ~verbatim~ (markers must hug a
// non-space character, so plain math like a/b stays untouched).
const RE_INLINE = /(\*[^*\s][^*]*\*|\/[^/\s][^/]*\/|=[^=\s][^=]*=|~[^~\s][^~]*~)/g;

/** Render org inline markup into DOM children of `into`. */
export function renderInline(text: string, into: HTMLElement): void {
  for (const part of text.split(RE_INLINE)) {
    if (part === '') continue;
    const m = /^(\*|\/|=|~)([\s\S]+)\1$/.exec(part);
    if (m === null) {
      into.appendChild(document.createTextNode(part));
      continue;
    }
    const el = document.createElement(
      m[1] === '*' ? 'strong' : m[1] === '/' ? 'em' : 'code');
    el.classList.add('lw-inline');
    el.textContent = m[2]!;
    into.appendChild(el);
  }
}

export function renderDocument(doc: OrgDoc, isExecutable: (lang: string) => boolean): RenderedDoc {
  const root = document.createElement('article');
  root.className = 'lw-doc';
  const blocks: RenderedBlock[] = [];
  let execIndex = 0;
  let lastBlock: RenderedBlock | null = null;
  for (const node of doc) {
    switch (node.kind) {
      case 'title': {
        const h = document.createElement('h1');
        h.className = 'lw-title';
        h.textContent = node.text;
        root.appendChild(h);
        break;
      }
      case 'subtitle': {
        const p = document.createElement('p');
        p.className = 'lw-subtitle';
        p.textContent = node.text;
        root.appendChild(p);
        break;
      }
      case 'heading': {
        const h = document.createElement(
          node.level <= 1 ? 'h2' : node.level === 2 ? 'h3' : 'h4');
        h.className = 'lw-heading';
        h.textContent = node.text;
        root.appendChild(h);

        break;
      }
      case 'list': {
        const ul = document.createElement('ul');
        ul.className = 'lw-list';
        for (const item of node.items) {
          const li = document.createElement('li');
          renderInline(item, li);
          ul.appendChild(li);
        }
        root.appendChild(ul);
        break;
      }
      case 'table': {
        const table = document.createElement('table');
        table.className = 'lw-table';
        if (node.head.length > 0) {
          const thead = document.createElement('thead');
          const tr = document.createElement('tr');
          for (const cell of node.head) {
            const th = document.createElement('th');
            th.textContent = cell;
            tr.appendChild(th);
          }
          thead.appendChild(tr);
          table.appendChild(thead);
        }
        const tbody = document.createElement('tbody');
        for (const row of node.rows) {
          const tr = document.createElement('tr');
          for (const cell of row) {
            const td = document.createElement('td');
            td.textContent = cell;
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        root.appendChild(table);
        break;
      }
      case 'src': {
        const figure = document.createElement('figure');
        figure.className = 'lw-src';
        if (isExecutable(node.lang)) {
          execIndex += 1;
          const mount = document.createElement('div');
          mount.className = 'lw-block-slot';
          figure.appendChild(mount);
          root.appendChild(figure);
          lastBlock = { index: execIndex, node, mount, resultsEl: null };
          blocks.push(lastBlock);
        } else {
          const head = document.createElement('figcaption');
          head.className = 'lw-ro-head';
          head.textContent = node.lang;
          figure.appendChild(head);
          const pre = document.createElement('pre');
          pre.className = 'lw-ro-code';
          pre.textContent = node.code;
          figure.appendChild(pre);
          root.appendChild(figure);
          lastBlock = null;
        }
        break;
      }
      case 'results': {
        const slot = document.createElement('div');
        slot.className = 'lw-results';
        slot.dataset.test = 'results';
        if (node.canned !== '') {
          const pre = document.createElement('pre');
          pre.textContent = node.canned;
          slot.appendChild(pre);
        }
        root.appendChild(slot);
        const target = node.name !== null
          ? blocks.find((b) => b.node.name === node.name) ?? null
          : lastBlock;
        if (target !== null) target.resultsEl = slot;
        break;
      }
    }
  }
  return { root, blocks };
}
