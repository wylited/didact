// Renders the parsed org document into the left pane: prose, headings,
// lists, tables, read-only blocks and — for `asm` blocks — editable
// CodeMirror 6 editors with per-block Run button, error box, output area and
// a `#+RESULTS:` slot.

import { basicSetup } from 'codemirror';
import { EditorView } from '@codemirror/view';
import type { OrgDoc, OrgNode, SrcNode } from './org';
import { syntaxHighlighting } from '@codemirror/language';
import { asmHighlightStyle, asmLanguage, editorTheme, makeLineHighlight, type LineHighlighter } from './highlight';

export interface BlockEvents {
  onRun: (block: BlockHandle) => void;
  onActivate: (block: BlockHandle) => void;
  onResetCode: (block: BlockHandle) => void;
}

export interface BlockHandle {
  name: string;
  editor: EditorView;
  /** Source text this block was last loaded into the machine from. */
  loadedSource: string | null;
  dirty: boolean;
  results: { pre: HTMLPreElement; canned: string | null } | null;
  focus(): void;
  getSource(): string;
  setSource(text: string): void;
  markError(line: number | null, message: string | null): void;
  markCurrent(line: number | null): void;
  showOutput(text: string): void;
  hideOutput(): void;
  restoreResults(): void;
  setResults(text: string): void;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const INLINES: ReadonlyArray<[RegExp, string]> = [
  [/(?<![\w*~=/])\*([^*\n]+)\*(?![\w*])/g, '<strong>$1</strong>'],
  [/(?<![\w*~=/])\/([^/\n]+)\/(?![\w*])/g, '<em>$1</em>'],
  [/(?<![\w*~=/])=([^=\n]+)=(?![\w*])/g, '<code>$1</code>'],
  [/(?<![\w*~=/])~([^~\n]+)~(?![\w*])/g, '<code class="verbatim">$1</code>'],
];

/** Apply inline org markup to already-escaped HTML text. */
function renderInline(text: string): string {
  let html = escapeHtml(text);
  for (const [re, replacement] of INLINES) html = html.replace(re, replacement);
  return html;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function renderLesson(doc: OrgDoc, host: HTMLElement, asmLang: string, events: BlockEvents): BlockHandle[] {
  host.replaceChildren();
  const blocks: BlockHandle[] = [];

  if (doc.title) {
    const h = el('h1', 'doc-title');
    h.textContent = doc.title;
    host.appendChild(h);
  }
  if (doc.subtitle) {
    const p = el('p', 'doc-subtitle');
    p.textContent = doc.subtitle;
    host.appendChild(p);
  }

  let executableCount = 0;
  for (const node of doc.nodes) {
    if (node.kind === 'src' && node.lang === asmLang) {
      blocks.push(makeExecutableBlock(node, host, events, executableCount));
      executableCount++;
      continue;
    }
    renderStaticNode(node, host);
  }
  return blocks;
}

function renderStaticNode(node: OrgNode, host: HTMLElement): void {
  switch (node.kind) {
    case 'heading': {
      const level = Math.min(node.depth + 1, 6);
      const h = el(('h' + level) as 'h2');
      h.innerHTML = renderInline(node.text);
      host.appendChild(h);
      return;
    }
    case 'paragraph': {
      const p = el('p');
      p.innerHTML = renderInline(node.text);
      host.appendChild(p);
      return;
    }
    case 'list': {
      const ul = el('ul');
      for (const item of node.items) {
        const li = el('li');
        li.innerHTML = renderInline(item);
        ul.appendChild(li);
      }
      host.appendChild(ul);
      return;
    }
    case 'table': {
      const table = el('table', 'org-table');
      const thead = el('thead');
      const headRow = el('tr');
      for (const cell of node.header) {
        const th = el('th');
        th.innerHTML = renderInline(cell);
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = el('tbody');
      for (const row of node.rows) {
        const tr = el('tr');
        for (const cell of row) {
          const td = el('td');
          td.innerHTML = renderInline(cell);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      host.appendChild(table);
      return;
    }
    case 'example': {
      const pre = el('pre', 'example');
      pre.textContent = node.lines.join('\n');
      host.appendChild(pre);
      return;
    }
    case 'results': {
      // A results slot not attached to any src block renders verbatim.
      const pre = el('pre', 'results');
      pre.textContent = node.lines.join('\n');
      host.appendChild(pre);
      return;
    }
    case 'src': {
      const wrap = el('div', 'ro-block');
      const head = el('div', 'ro-head');
      const lang = el('span', 'block-lang');
      lang.textContent = `${node.lang} · read-only`;
      head.appendChild(lang);
      if (node.name) {
        const name = el('span', 'block-name');
        name.textContent = node.name;
        head.appendChild(name);
      }
      const pre = el('pre');
      pre.textContent = node.code;
      wrap.appendChild(head);
      wrap.appendChild(pre);
      host.appendChild(wrap);
      return;
    }
    default:
      return;
  }
}

function makeExecutableBlock(node: SrcNode, host: HTMLElement, events: BlockEvents, ordinal: number): BlockHandle {
  const section = el('section', 'block');
  const blockName = node.name ?? `block-${ordinal + 1}`;
  if (node.name) section.id = `block-${node.name}`;

  const head = el('div', 'block-head');
  const name = el('span', 'block-name');
  name.textContent = blockName;
  const lang = el('span', 'block-lang');
  lang.textContent = 'asm · x86-64 · editable';
  const resetLink = el('a', 'reset-code');
  resetLink.textContent = 'Reset code';
  resetLink.href = '#';
  resetLink.title = 'Restore the original sample code';
  const runBtn = el('button', 'block-run');
  runBtn.textContent = '▶ Run';
  runBtn.dataset.test = 'block-run';
  head.append(name, lang, resetLink, runBtn);

  const editorHost = el('div', 'editor-host');
  editorHost.dataset.test = 'editor';

  const errorBox = el('div', 'block-error');
  errorBox.hidden = true;

  const outputBox = el('div', 'block-output');
  outputBox.hidden = true;
  const outputPre = el('pre');
  outputBox.appendChild(outputPre);

  const resultsPre = el('pre', 'results');
  resultsPre.textContent = node.results ?? '';
  const resultsSlot: { pre: HTMLPreElement; canned: string | null } = { pre: resultsPre, canned: node.results };

  const currentHighlight = makeLineHighlight('cm-current-instr');
  const errorHighlight = makeLineHighlight('cm-error-line');

  const editor = new EditorView({
    doc: node.code,
    parent: editorHost,
    extensions: [
      basicSetup,
      asmLanguage,
      syntaxHighlighting(asmHighlightStyle),
      editorTheme,
      currentHighlight.extension,
      errorHighlight.extension,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) handle.dirty = true;
      }),
    ],
  });

  section.append(head, editorHost, errorBox, outputBox, resultsPre);
  host.appendChild(section);


  const handle: BlockHandle = {
    name: blockName,
    editor,
    loadedSource: null,
    dirty: true,
    results: resultsSlot,
    focus() {
      editor.focus();
    },
    getSource() {
      return editor.state.doc.toString();
    },
    setSource(text: string) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
      handle.dirty = true;
    },
    markError(line, message) {
      if (message === null) {
        errorBox.hidden = true;
        errorBox.replaceChildren();
        errorHighlight.set(editor, null);
        return;
      }
      errorBox.hidden = false;
      const at = line !== null ? `line ${line}: ` : '';
      errorBox.textContent = `${at}${message}`;
      if (line !== null) {
        highlightAndScroll(editor, errorHighlight, line);
      }
    },
    markCurrent(line) {
      if (line === null) {
        currentHighlight.set(editor, null);
        return;
      }
      highlightAndScroll(editor, currentHighlight, line);
    },
    showOutput(text: string) {
      outputPre.textContent = text;
      outputBox.hidden = false;
    },
    hideOutput() {
      outputBox.hidden = true;
      outputPre.replaceChildren();
    },
    restoreResults() {
      resultsSlot.pre.textContent = resultsSlot.canned ?? '';
      resultsSlot.pre.classList.remove('live');
    },
    setResults(text: string) {
      resultsSlot.pre.textContent = text;
      resultsSlot.pre.classList.add('live');
    },
  };

  runBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    events.onRun(handle);
  });
  resetLink.addEventListener('click', (ev) => {
    ev.preventDefault();
    handle.setSource(node.code);
    handle.markError(null, null);
    handle.markCurrent(null);
    events.onResetCode(handle);
  });
  editorHost.addEventListener('focusin', () => events.onActivate(handle));

  return handle;
}

/**
 * Set the line highlight and scroll the line into view in ONE transaction:
 * separate dispatches would leave a window where the scroll-only transaction
 * interacts with the highlight state, and one transaction is cheaper anyway.
 */
function highlightAndScroll(editor: EditorView, highlighter: LineHighlighter, line: number): void {
  const clamped = Math.min(Math.max(line, 1), editor.state.doc.lines);
  editor.dispatch({
    effects: [
      highlighter.effect.of(clamped),
      EditorView.scrollIntoView(editor.state.doc.line(clamped).from, { y: 'center' }),
    ],
  });
}
