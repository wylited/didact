// render.ts — turns an OrgDoc into DOM. Executable src blocks leave a mount
// point that site.ts fills with a BlockRuntime; read-only languages render
// as a static listing. Results slots pair with the nearest preceding src
// block (by #+NAME: when given).

import type { OrgDoc, OrgNode } from './org';
import {
  diagramKey,
  isTypstDiagram,
  mathKey,
  splitTypstMath,
  type TypstRenderOptions,
} from './typst-source';

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

// Inline markup: *bold* /italic/ =code= ~verbatim~. Org emphasis border
// rules: an opening marker must not follow a word character or `/` (so
// `add/addu/sub` and `src/core/main.ts` stay plain), and a closing marker
// must not precede one (so `x/y` mid-word never closes an italic).
const RE_INLINE =
  /(?<![\w/])(\*[^*\s][^*]*\*|\/[^/\s][^/]*\/|=[^=\s][^=]*=|~[^~\s][^~]*~)(?![\w/])/g;

/** Render org inline markup into DOM children of `into`. */
export function renderInline(
  text: string,
  into: HTMLElement,
  typst?: TypstRenderOptions,
): void {
  for (const part of text.split(RE_INLINE)) {
    if (part === '') continue;
    const m = /^(\*|\/|=|~)([\s\S]+)\1$/.exec(part);
    if (m === null) {
      appendText(part, into, typst);
      continue;
    }
    const el = document.createElement(
      m[1] === '*' ? 'strong' : m[1] === '/' ? 'em' : 'code');
    el.classList.add('lw-inline');
    // Emphasis nests (/see =la= here/); code and verbatim are literal, so a
    // `$` inside =…= must never become math.
    if (m[1] === '*' || m[1] === '/') renderInline(m[2]!, el, typst);
    else el.textContent = m[2]!;
    into.appendChild(el);
  }
}

/** Text node, or one wrapper per math span looked up in the artifacts. */
function appendText(
  text: string,
  into: HTMLElement,
  typst?: TypstRenderOptions,
): void {
  if (typst === undefined) {
    into.appendChild(document.createTextNode(text));
    return;
  }
  for (const part of splitTypstMath(text)) {
    if (part.kind === 'text') {
      into.appendChild(document.createTextNode(part.text));
      continue;
    }
    const wrapper = document.createElement('span');
    wrapper.className = part.display ? 'lw-math lw-math-block' : 'lw-math';
    wrapper.dataset.test = 'math';
    const art = typst.artifacts.math[mathKey(part.src, part.display)];
    if (art === undefined) {
      // A missing artifact is a build bug; show the source instead of a hole.
      wrapper.classList.add('lw-math-missing');
      wrapper.textContent = part.display ? `$$${part.src}$$` : `$${part.src}$`;
    } else {
      // Explicit mode wins; otherwise MathML where the browser has it and
      // the pixel-exact SVG fallback where it does not (older engines).
      const svg = typst.math === 'svg'
        || (typst.math !== 'mathml' && typeof MathMLElement === 'undefined');
      // Build-time engine output; same trusted-markup rule as panels.
      wrapper.innerHTML = svg ? art.svg : art.mathml;
    }
    into.appendChild(wrapper);
  }
}

export function renderDocument(
  doc: OrgDoc,
  isExecutable: (lang: string) => boolean,
  typst?: TypstRenderOptions,
): RenderedDoc {
  const root = document.createElement('article');
  root.className = 'lw-doc';
  const inline = (text: string, into: HTMLElement): void =>
    renderInline(text, into, typst);
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
        inline(node.text, p);
        root.appendChild(p);
        break;
      }
      case 'para': {
        const p = document.createElement('p');
        p.className = 'lw-para';
        inline(node.text, p);
        root.appendChild(p);
        break;
      }
      case 'heading': {
        const h = document.createElement(
          node.level <= 1 ? 'h2' : node.level === 2 ? 'h3' : 'h4');
        h.className = 'lw-heading';
        inline(node.text, h);
        root.appendChild(h);
        break;
      }
      case 'list': {
        const ul = document.createElement('ul');
        ul.className = 'lw-list';
        for (const item of node.items) {
          const li = document.createElement('li');
          inline(item, li);
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
            inline(cell, th);
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
            inline(cell, td);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        root.appendChild(table);
        break;
      }
      case 'src': {
        if (typst !== undefined && isTypstDiagram(node)) {
          // Static diagram: build-time SVG, never an editor or a kernel.
          const figure = document.createElement('figure');
          figure.className = 'lw-figure lw-diagram';
          const svg = typst.artifacts.diagrams[diagramKey(node.code)];
          if (svg === undefined) {
            const miss = document.createElement('pre');
            miss.className = 'lw-diagram-missing';
            miss.textContent = `typst diagram not pre-rendered (run pnpm build)\n${node.code}`;
            figure.appendChild(miss);
          } else {
            figure.innerHTML = svg; // build-time engine output (trusted)
          }
          root.appendChild(figure);
          lastBlock = null;
          break;
        }
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
