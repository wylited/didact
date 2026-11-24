// render.ts — turns an OrgDoc into DOM. Executable src blocks leave a mount
// point that site.ts fills with a BlockRuntime; read-only languages render
// as a static listing. Results slots pair with the nearest preceding src
// block (by #+NAME: when given).
//
// Links: `[[target][description]]` (description optional). http(s)/mailto
// targets become real anchors; every other target goes through the
// caller's LinkResolver, which returns a site fragment (or null for an
// unresolved link, rendered inert and visibly broken).

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

/** Resolve an internal link target (org `[[target]]` without a URL
 *  scheme) to a site fragment (`#/<page>/<section>`); null means
 *  unresolved. */
export type LinkResolver = (target: string) => string | null;

// Inline markup: *bold* /italic/ =code= ~verbatim~. Org emphasis border
// rules: an opening marker must not follow a word character or `/` (so
// `add/addu/sub` and `src/core/main.ts` stay plain), and a closing marker
// must not precede one (so `x/y` mid-word never closes an italic).
const RE_INLINE =
  /(?<![\w/])(\*[^*\s][^*]*\*|\/[^/\s][^/]*\/|=[^=\s][^=]*=|~[^~\s][^~]*~)(?![\w/])/g;

// Org link: `[[target]]` or `[[target][description]]`. Targets and
// descriptions cannot contain `[`/`]`; that is org's own limitation.
const RE_LINK = /\[\[([^\[\]]+)\](?:\[([^\]]*)\])?\]/;
const RE_EXTERNAL = /^(?:https?:\/\/|mailto:)/i;

/** Render one link. External targets are real anchors; an internal
 *  target the resolver does not know stays text, marked broken — it must
 *  never navigate somewhere unrelated. */
function renderLink(
  target: string,
  label: string,
  into: HTMLElement,
  resolveLink: LinkResolver | undefined,
): void {
  const external = RE_EXTERNAL.test(target);
  const href = external ? target : resolveLink?.(target) ?? null;
  if (href === null) {
    const broken = document.createElement('span');
    broken.className = 'lw-link lw-link-broken';
    broken.dataset.test = 'link-broken';
    broken.title = `Unresolved link: ${target}`;
    renderInline(label, broken, resolveLink);
    into.appendChild(broken);
    return;
  }
  const a = document.createElement('a');
  a.className = 'lw-link';
  a.href = href;
  if (/^https?:\/\//i.test(target)) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.classList.add('lw-link-external');
  }
  renderInline(label, a, resolveLink); // =code=, *bold* inside the label
  into.appendChild(a);
}

/** Emphasis inside one link-free run of text (links are extracted first,
 *  so an emphasis span cannot cross a link). */
function renderEmphasis(
  text: string,
  into: HTMLElement,
  resolveLink: LinkResolver | undefined,
): void {
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
    renderInline(m[2]!, el, resolveLink); // markup nests: /see =la= here/
    into.appendChild(el);
  }
}

/** Render org inline markup and links into DOM children of `into`. */
export function renderInline(
  text: string,
  into: HTMLElement,
  resolveLink?: LinkResolver,
): void {
  let rest = text;
  let m: RegExpExecArray | null;
  while ((m = RE_LINK.exec(rest)) !== null) {
    renderEmphasis(rest.slice(0, m.index), into, resolveLink);
    const target = m[1]!;
    // org's default description hides the file: scheme
    renderLink(target, m[2] ?? target.replace(/^file:/i, ''), into, resolveLink);
    rest = rest.slice(m.index + m[0].length);
  }
  renderEmphasis(rest, into, resolveLink);
}

export function renderDocument(
  doc: OrgDoc,
  isExecutable: (lang: string) => boolean,
  resolveLink?: LinkResolver,
): RenderedDoc {
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
        renderInline(node.text, p, resolveLink);
        root.appendChild(p);
        break;
      }
      case 'para': {
        const p = document.createElement('p');
        p.className = 'lw-para';
        renderInline(node.text, p, resolveLink);
        root.appendChild(p);
        break;
      }
      case 'heading': {
        const h = document.createElement(
          node.level <= 1 ? 'h2' : node.level === 2 ? 'h3' : 'h4');
        h.className = 'lw-heading';
        renderInline(node.text, h, resolveLink);
        root.appendChild(h);
        break;
      }
      case 'list': {
        const ul = document.createElement('ul');
        ul.className = 'lw-list';
        for (const item of node.items) {
          const li = document.createElement('li');
          renderInline(item, li, resolveLink);
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
            renderInline(cell, th, resolveLink);
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
            renderInline(cell, td, resolveLink);
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
