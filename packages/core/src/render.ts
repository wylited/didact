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

/** Resolve an internal link target (org `[[target]]` without a URL
 *  scheme) to a site fragment (`#/<page>/<section>`); null means
 *  unresolved. */
export type LinkResolver = (target: string) => string | null;

/** Everything the renderer needs from its host. Kept as one object because
 *  the parameters are orthogonal and usually absent. */
export interface RenderOptions {
  resolveLink?: LinkResolver;
  typst?: TypstRenderOptions;
  /** Document used to create DOM nodes (defaults to `into.ownerDocument ?? document`). */
  doc?: Document;
}

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

/** Missing math keys already reported; pages share one console. */
const missingMathKeys = new Set<string>();

/** Text node, or one wrapper per math span looked up in the artifacts. */
function appendText(
  text: string,
  into: HTMLElement,
  doc: Document,
  typst?: TypstRenderOptions,
): void {
  if (typst === undefined) {
    into.appendChild(doc.createTextNode(text));
    return;
  }
  for (const part of splitTypstMath(text)) {
    if (part.kind === 'text') {
      into.appendChild(doc.createTextNode(part.text));
      continue;
    }
    const wrapper = doc.createElement('span');
    wrapper.className = part.display ? 'lw-math lw-math-block' : 'lw-math';
    wrapper.dataset.test = 'math';
    const art = typst.artifacts.math[mathKey(part.src, part.display)];
    if (art === undefined) {
      // A missing artifact is a build bug; show the source instead of a hole
      // and report it once so the console names the exact key.
      if (!missingMathKeys.has(part.src)) {
        missingMathKeys.add(part.src);
        console.error(`typst math not pre-rendered (run pnpm build): ${part.src}`);
      }
      wrapper.classList.add('lw-math-missing');
      wrapper.textContent = part.display ? `$$${part.src}$$` : `$${part.src}$`;
    } else {
      // Explicit mode wins; otherwise MathML where the browser has it and
      // the pixel-exact SVG fallback where it does not (older engines).
      const svg = typst.math === 'svg'
        || (typst.math !== 'mathml' && typeof MathMLElement === 'undefined');
      // Build-time engine output; same trusted-markup rule as panels.
      wrapper.innerHTML = svg ? art.svg : art.mathml;
      // MathML has no source annotation from Typst, and the SVG fallback is
      // an anonymous graphic; both need the formula text as their name.
      if (svg) {
        wrapper.setAttribute('role', 'img');
        wrapper.setAttribute('aria-label', part.src);
      } else {
        wrapper.querySelector('math')?.setAttribute('alttext', part.src);
      }
    }
    into.appendChild(wrapper);
  }
}

/** Render one link. External targets are real anchors; an internal
 *  target the resolver does not know stays text, marked broken — it must
 *  never navigate somewhere unrelated. */
function renderLink(
  target: string,
  label: string,
  into: HTMLElement,
  doc: Document,
  resolveLink: LinkResolver | undefined,
  typst: TypstRenderOptions | undefined,
): void {
  const external = RE_EXTERNAL.test(target);
  const href = external ? target : resolveLink?.(target) ?? null;
  if (href === null) {
    const broken = doc.createElement('span');
    broken.className = 'lw-link lw-link-broken';
    broken.dataset.test = 'link-broken';
    broken.title = `Unresolved link: ${target}`;
    renderInline(label, broken, { resolveLink, typst, doc });
    into.appendChild(broken);
    return;
  }
  const a = doc.createElement('a');
  a.className = 'lw-link';
  a.href = href;
  if (/^https?:\/\//i.test(target)) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.classList.add('lw-link-external');
  }
  renderInline(label, a, { resolveLink, typst, doc }); // =code=, *bold* inside the label
  into.appendChild(a);
}

/** Emphasis inside one link-free run of text (links are extracted first,
 *  so an emphasis span cannot cross a link). */
function renderEmphasis(
  text: string,
  into: HTMLElement,
  doc: Document,
  resolveLink: LinkResolver | undefined,
  typst: TypstRenderOptions | undefined,
): void {
  for (const part of text.split(RE_INLINE)) {
    if (part === '') continue;
    const m = /^(\*|\/|=|~)([\s\S]+)\1$/.exec(part);
    if (m === null) {
      appendText(part, into, doc, typst);
      continue;
    }
    const el = doc.createElement(
      m[1] === '*' ? 'strong' : m[1] === '/' ? 'em' : 'code');
    el.classList.add('lw-inline');
    // Emphasis nests (/see =la= here/); code and verbatim are literal, so a
    // `$` inside =…= must never become math.
    if (m[1] === '*' || m[1] === '/') {
      renderInline(m[2]!, el, { resolveLink, typst, doc });
    } else {
      el.textContent = m[2]!;
    }
    into.appendChild(el);
  }
}

/** Render org inline markup and links into DOM children of `into`. */
export function renderInline(
  text: string,
  into: HTMLElement,
  options: RenderOptions = {},
): void {
  const { resolveLink, typst } = options;
  const doc = options.doc ?? into.ownerDocument ?? document;
  let rest = text;
  let m: RegExpExecArray | null;
  while ((m = RE_LINK.exec(rest)) !== null) {
    renderEmphasis(rest.slice(0, m.index), into, doc, resolveLink, typst);
    const target = m[1]!;
    const desc = m[2];
    // org's default description hides the file: scheme; an empty `[[target][]]`
    // falls back to the target instead of rendering an empty anchor.
    const label = desc !== undefined && desc !== ''
      ? desc
      : target.replace(/^file:/i, '');
    renderLink(target, label, into, doc, resolveLink, typst);
    rest = rest.slice(m.index + m[0].length);
  }
  renderEmphasis(rest, into, doc, resolveLink, typst);
}

export function renderDocument(
  orgDoc: OrgDoc,
  isExecutable: (lang: string) => boolean,
  options: RenderOptions = {},
): RenderedDoc {
  const { typst } = options;
  const dom = options.doc ?? document;
  const inlineOptions: RenderOptions = { ...options, doc: dom };
  const root = dom.createElement('article');
  root.className = 'lw-doc';
  const inline = (text: string, into: HTMLElement): void =>
    renderInline(text, into, inlineOptions);
  const blocks: RenderedBlock[] = [];
  let execIndex = 0;
  let lastBlock: RenderedBlock | null = null;

  // Fold bodies append to the same document-order accumulators: executable
  // indices stay continuous and #+RESULTS: pairs with the nearest preceding
  // block across fold boundaries.
  const renderNodes = (nodes: OrgDoc, parent: HTMLElement): void => {
    for (const node of nodes) {
      switch (node.kind) {
        case 'title': {
          const h = dom.createElement('h1');
          h.className = 'lw-title';
          inline(node.text, h);
          parent.appendChild(h);
          break;
        }
        case 'subtitle': {
          const p = dom.createElement('p');
          p.className = 'lw-subtitle';
          inline(node.text, p);
          parent.appendChild(p);
          break;
        }
        case 'para': {
          const p = dom.createElement('p');
          p.className = 'lw-para';
          inline(node.text, p);
          parent.appendChild(p);
          break;
        }
        case 'heading': {
          const h = dom.createElement(
            node.level <= 1 ? 'h2' : node.level === 2 ? 'h3' : 'h4');
          h.className = 'lw-heading';
          inline(node.text, h);
          parent.appendChild(h);
          break;
        }
        case 'list': {
          const ul = dom.createElement('ul');
          ul.className = 'lw-list';
          for (const item of node.items) {
            const li = dom.createElement('li');
            inline(item, li);
            ul.appendChild(li);
          }
          parent.appendChild(ul);
          break;
        }
        case 'table': {
          const table = dom.createElement('table');
          table.className = 'lw-table';
          if (node.head.length > 0) {
            const thead = dom.createElement('thead');
            const tr = dom.createElement('tr');
            for (const cell of node.head) {
              const th = dom.createElement('th');
              inline(cell, th);
              tr.appendChild(th);
            }
            thead.appendChild(tr);
            table.appendChild(thead);
          }
          const tbody = dom.createElement('tbody');
          for (const row of node.rows) {
            const tr = dom.createElement('tr');
            for (const cell of row) {
              const td = dom.createElement('td');
              inline(cell, td);
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
          parent.appendChild(table);
          break;
        }
        case 'src': {
          if (typst !== undefined && isTypstDiagram(node)) {
            // Static diagram: build-time SVG, never an editor or a kernel.
            const figure = dom.createElement('figure');
            figure.className = 'lw-figure lw-diagram';
            const svg = typst.artifacts.diagrams[diagramKey(node.code)];
            if (svg === undefined) {
              // A missing artifact is a build bug; keep reader-facing text
              // neutral and put the diagnostic where authors will see it.
              const key = diagramKey(node.code);
              const first = key.split('\n', 1)[0]!;
              console.error(
                `typst diagram not pre-rendered (run pnpm build): ` +
                  `${first.length > 80 ? `${first.slice(0, 77)}...` : first}` +
                  (key.length > first.length ? ' (block continues)' : ''),
              );
              const miss = dom.createElement('pre');
              miss.className = 'lw-diagram-missing';
              miss.textContent = 'Figure unavailable.';
              figure.appendChild(miss);
            } else {
              figure.innerHTML = svg; // build-time engine output (trusted)
            }
            if (node.caption !== null) {
              const caption = dom.createElement('figcaption');
              caption.className = 'lw-caption';
              inline(node.caption, caption);
              figure.appendChild(caption);
            }
            parent.appendChild(figure);
            lastBlock = null;
            break;
          }
          const figure = dom.createElement('figure');
          figure.className = 'lw-src';
          if (isExecutable(node.lang)) {
            execIndex += 1;
            const mount = dom.createElement('div');
            mount.className = 'lw-block-slot';
            figure.appendChild(mount);
            parent.appendChild(figure);
            lastBlock = { index: execIndex, node, mount, resultsEl: null };
            blocks.push(lastBlock);
          } else {
            const head = dom.createElement('figcaption');
            head.className = 'lw-ro-head';
            head.textContent = node.lang;
            figure.appendChild(head);
            const pre = dom.createElement('pre');
            pre.className = 'lw-ro-code';
            pre.textContent = node.code;
            figure.appendChild(pre);
            parent.appendChild(figure);
            lastBlock = null;
          }
          break;
        }
        case 'fold': {
          // Native <details> gives keyboard access and a closed default; the
          // body is marked like any other document subtree.
          const details = dom.createElement('details');
          details.className = `lw-fold lw-${node.variant}`;
          details.dataset.test = `fold-${node.variant}`;
          const summary = dom.createElement('summary');
          summary.textContent = node.variant === 'hint' ? 'Show hint' : 'Show solution';
          const body = dom.createElement('div');
          body.className = 'lw-fold-body';
          details.appendChild(summary);
          details.appendChild(body);
          renderNodes(node.doc, body);
          parent.appendChild(details);
          break;
        }
        case 'results': {
          const slot = dom.createElement('div');
          slot.className = 'lw-results';
          slot.dataset.test = 'results';
          if (node.canned !== '') {
            const pre = dom.createElement('pre');
            pre.textContent = node.canned;
            slot.appendChild(pre);
          }
          parent.appendChild(slot);
          const target = node.name !== null
            ? blocks.find((b) => b.node.name === node.name) ?? null
            : lastBlock;
          if (target !== null) target.resultsEl = slot;
          break;
        }
      }
    }
  };

  renderNodes(orgDoc, root);
  return { root, blocks };
}
