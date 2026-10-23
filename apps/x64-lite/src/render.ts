// render.ts — pure DOM layer: page chrome (toolbar + machine panels), the
// rendered org document with executable blocks, and panel update functions.
// All wiring (events, CodeMirror, machine) lives in main.ts.

import { REG64, STACK_TOP, TEXT_BASE, type Program } from "./asm";
import type { Machine } from "./cpu";
import type { OrgNode } from "./org";

const FLAG_KEYS = ["zf", "cf", "sf", "of", "pf", "af"] as const;
type FlagsKey = (typeof FLAG_KEYS)[number];

// ---------------------------------------------------------------------------
// inline org markup: *bold* /italic/ =code= ~verbatim~
// ---------------------------------------------------------------------------

const MARK_TAGS: Record<string, string> = { "*": "strong", "/": "em", "=": "code", "~": "code" };
const isWordBoundary = (c: string | undefined): boolean =>
  c === undefined || /\s/.test(c) || "([{'\"".includes(c);

function renderInline(text: string, into: HTMLElement): void {
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf !== "") {
      into.appendChild(document.createTextNode(buf));
      buf = "";
    }
  };
  while (i < text.length) {
    const ch = text[i]!;
    const tag = MARK_TAGS[ch];
    if (tag !== undefined && isWordBoundary(text[i - 1])) {
      const close = text.indexOf(ch, i + 1);
      if (close > i + 1 && text[i + 1] !== " " && text[close - 1] !== " " && isWordBoundary(text[close + 1])) {
        flush();
        const el = document.createElement(tag);
        el.textContent = text.slice(i + 1, close);
        into.appendChild(el);
        i = close + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
}

// ---------------------------------------------------------------------------
// page chrome
// ---------------------------------------------------------------------------

export interface PageChrome {
  runBtn: HTMLButtonElement;
  stepBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
  statusChip: HTMLElement;
  docContainer: HTMLElement;
  regCells: HTMLElement[];
  ripCell: HTMLElement;
  flagCells: Record<FlagsKey, HTMLElement>;
  disasmEl: HTMLElement;
  disasmIndex: Map<number, number>;
  disasmRows: HTMLElement[];
  currentIdx: number;
  disasmProg: Program | null;
  memEl: HTMLElement;
  memTitle: HTMLElement;
  memBtnData: HTMLButtonElement;
  memBtnStack: HTMLButtonElement;
  outputEl: HTMLElement;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  return e;
};

function panel(label: string, body: HTMLElement): HTMLElement {
  const p = el("section", "panel");
  const head = el("div", "panel-head");
  head.appendChild(el("span", "panel-label")).textContent = label;

  p.appendChild(head);
  p.appendChild(body);
  return p;
}

export function buildPage(root: HTMLElement): PageChrome {
  root.innerHTML = "";

  const toolbar = el("header", "toolbar");
  const brand = el("div", "brand");
  brand.appendChild(el("span", "brand-name")).textContent = "x64-lite";
  brand.appendChild(el("span", "brand-sub")).textContent = "literate x86-64 · custom assembler + interpreter";
  const tools = el("div", "tools");
  const runBtn = el("button", "btn primary");
  runBtn.type = "button";
  runBtn.textContent = "▶ Run";
  runBtn.setAttribute("data-test", "run");
  const stepBtn = el("button", "btn");
  stepBtn.type = "button";
  stepBtn.textContent = "⤵ Step";
  stepBtn.setAttribute("data-test", "step");
  const resetBtn = el("button", "btn");
  resetBtn.type = "button";
  resetBtn.textContent = "⟲ Reset";
  resetBtn.setAttribute("data-test", "reset");
  const statusChip = el("span", "chip idle");
  statusChip.setAttribute("data-test", "status");
  statusChip.textContent = "not loaded";
  tools.append(runBtn, stepBtn, resetBtn, statusChip);
  toolbar.append(brand, tools);

  const main = el("div", "panes");
  const docPane = el("section", "doc-pane");
  const docContainer = el("article", "doc");
  docPane.appendChild(docContainer);
  const machinePane = el("aside", "machine-pane");

  // registers
  const regGrid = el("div", "reg-grid");
  const regCells: HTMLElement[] = [];
  for (const name of REG64) {
    const cell = el("div", "reg");
    cell.setAttribute("data-test", `reg-${name}`);
    const nm = el("span", "reg-name");
    nm.textContent = name;
    const hex = el("span", "reg-hex");
    const dec = el("span", "reg-dec");
    cell.append(nm, hex, dec);
    regGrid.appendChild(cell);
    regCells.push(cell);
  }
  const ripCell = el("div", "reg rip");
  ripCell.setAttribute("data-test", "reg-rip");
  const ripName = el("span", "reg-name");
  ripName.textContent = "rip";
  const ripHex = el("span", "reg-hex");
  const ripDec = el("span", "reg-dec");
  ripCell.append(ripName, ripHex, ripDec);
  regGrid.appendChild(ripCell);
  // flags
  const flagRow = el("div", "flag-row");
  const flagCells = {} as Record<FlagsKey, HTMLElement>;
  for (const f of FLAG_KEYS) {
    const c = el("span", "flag");
    c.textContent = f.toUpperCase();
    flagRow.appendChild(c);
    flagCells[f] = c;
  }

  // disassembly
  const disasmEl = el("div", "disasm");
  machinePane.append(
    panel("Registers", regGrid),
    panel("Flags", flagRow),
    panel("Disassembly", disasmEl),
  );

  // memory viewer with data/stack region choice
  const memPanel = el("section", "panel");
  const memHead = el("div", "panel-head");
  memHead.appendChild(el("span", "panel-label")).textContent = "Memory";
  const memBtns = el("div", "mem-btns");
  const memBtnData = el("button", "seg active");
  memBtnData.type = "button";
  memBtnData.textContent = ".data";
  const memBtnStack = el("button", "seg");
  memBtnStack.type = "button";
  memBtnStack.textContent = "stack";
  memBtns.append(memBtnData, memBtnStack);
  const memTitle = el("span", "mem-title");
  memHead.append(memBtns, memTitle);
  const memEl = el("pre", "memdump");
  memEl.setAttribute("data-test", "memory");
  memPanel.append(memHead, memEl);

  // output console
  const outputEl = el("pre", "console");
  outputEl.setAttribute("data-test", "output");
  machinePane.append(memPanel, panel("Output", outputEl));

  main.append(docPane, machinePane);
  root.append(toolbar, main);

  return {
    runBtn, stepBtn, resetBtn, statusChip, docContainer,
    regCells, ripCell, flagCells,
    disasmEl, disasmIndex: new Map(), disasmRows: [], currentIdx: -1, disasmProg: null,
    memEl, memTitle, memBtnData, memBtnStack, outputEl,
  };
}

// ---------------------------------------------------------------------------
// panel updates
// ---------------------------------------------------------------------------

const hex64 = (v: bigint): string => "0x" + (v & 0xffffffffffffffffn).toString(16).padStart(16, "0");

export function updateRegisters(c: PageChrome, m: Machine | null): void {
  REG64.forEach((name, i) => {
    const cell = c.regCells[i]!;
    const v = m ? m.regs[i]! : 0n;
    const hex = cell.querySelector<HTMLElement>(".reg-hex")!;
    hex.textContent = hex64(v);
    cell.querySelector<HTMLElement>(".reg-dec")!.textContent = BigInt.asIntN(64, v).toString();
    cell.classList.toggle("changed", m !== null && m.changed.has(i));
  });
  const rv = m ? m.rip : 0n;
  c.ripCell.querySelector<HTMLElement>(".reg-hex")!.textContent = hex64(rv);
  c.ripCell.querySelector<HTMLElement>(".reg-dec")!.textContent = BigInt.asIntN(64, rv).toString();
  c.ripCell.classList.toggle("changed", m !== null && m.changed.has(16));
}

export function updateFlags(c: PageChrome, m: Machine | null): void {
  for (const key of FLAG_KEYS) {
    c.flagCells[key].classList.toggle("lit", m !== null && m.flags[key]);
  }
}

export function setDisassembly(c: PageChrome, prog: Program | null): void {
  c.disasmEl.innerHTML = "";
  c.disasmRows = [];
  c.disasmIndex = new Map();
  c.currentIdx = -1;
  if (prog === null || prog.insns.length === 0) {
    const empty = el("div", "dis-empty");
    empty.textContent = "not loaded — press Run or Step to assemble the active block";
    c.disasmEl.appendChild(empty);
    return;
  }
  prog.insns.forEach((ins, idx) => {
    const row = el("div", "dis-row");
    const addr = el("span", "dis-addr");
    addr.textContent = "0x" + ins.addr.toString(16).padStart(8, "0");
    const bytes = el("span", "dis-bytes");
    const shown = ins.bytes.length > 9 ? ins.bytes.slice(0, 8) : ins.bytes;
    bytes.textContent = shown.map((b) => b.toString(16).padStart(2, "0")).join(" ") + (ins.bytes.length > 9 ? " …" : "");
    const text = el("span", "dis-text");
    text.textContent = ins.text;
    const line = el("span", "dis-line");
    line.textContent = String(ins.line);
    row.append(addr, bytes, text, line);
    c.disasmEl.appendChild(row);
    c.disasmRows.push(row);
    c.disasmIndex.set(ins.addr, idx);
  });
}

export function updateDisasmCurrent(c: PageChrome, m: Machine | null): void {
  const idx = m !== null ? (c.disasmIndex.get(Number(m.rip)) ?? -1) : -1;
  if (idx === c.currentIdx) return;
  const prev = c.disasmRows[c.currentIdx];
  if (prev !== undefined) {
    prev.removeAttribute("data-test");
    prev.classList.remove("current");
  }
  const cur = c.disasmRows[idx];
  if (cur !== undefined) {
    cur.setAttribute("data-test", "current-instr");
    cur.classList.add("current");
    cur.scrollIntoView({ block: "nearest" });
  }
  c.currentIdx = idx;
}

export function updateMemory(c: PageChrome, m: Machine | null, mode: "data" | "stack"): void {
  let base: number;
  if (mode === "data") {
    base = m !== null ? m.prog.dataBase : TEXT_BASE;
    c.memTitle.textContent = `.data @ 0x${base.toString(16)}`;
  } else {
    const rsp = m !== null ? Number(m.regs[4]!) : STACK_TOP;
    base = Math.max(0, (rsp - 0x40) & ~0xf);
    c.memTitle.textContent = `stack @ rsp−0x40`;
  }
  const mem = m?.mem;
  const lines: string[] = [];
  for (let row = 0; row < 16; row++) {
    const a = base + row * 16;
    let hexPart = "";
    let ascii = "";
    for (let i = 0; i < 16; i++) {
      const v = mem?.get(a + i) ?? 0;
      hexPart += v.toString(16).padStart(2, "0") + (i === 7 ? "  " : " ");
      ascii += v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : "·";
    }
    lines.push(`0x${a.toString(16).padStart(12, "0")}  ${hexPart} ${ascii}`);
  }
  c.memEl.textContent = lines.join("\n");
}

const decoder = new TextDecoder();

export function updateOutput(c: PageChrome, m: Machine | null): void {
  c.outputEl.textContent = m !== null && m.out.length > 0
    ? decoder.decode(Uint8Array.from(m.out))
    : "";
}

// ---------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------

export interface BlockHandle {
  name: string | null;
  defaultCode: string;
  blockEl: HTMLElement;
  editorHost: HTMLElement;
  runBtn: HTMLButtonElement;
  resetLink: HTMLAnchorElement;
  resultsEl: HTMLElement;
  resultPre: HTMLElement;
  errEl: HTMLElement;
}

export function renderDocument(container: HTMLElement, nodes: OrgNode[]): BlockHandle[] {
  container.innerHTML = "";
  const blocks: BlockHandle[] = [];
  for (const node of nodes) {
    switch (node.kind) {
      case "title": {
        const h = el("h1", "doc-title");
        renderInline(node.text, h);
        container.appendChild(h);
        break;
      }
      case "subtitle": {
        const p = el("p", "doc-subtitle");
        renderInline(node.text, p);
        container.appendChild(p);
        break;
      }
      case "heading": {
        const level = Math.min(node.level + 1, 4);
        const h = el(`h${level}` as "h1" | "h2" | "h3" | "h4", `doc-h doc-h${level}`);
        renderInline(node.text, h);
        container.appendChild(h);
        break;
      }
      case "para": {
        const p = el("p", "para");
        renderInline(node.text, p);
        container.appendChild(p);
        break;
      }
      case "list": {
        const ul = el("ul", "list");
        for (const item of node.items) {
          const li = el("li");
          renderInline(item, li);
          ul.appendChild(li);
        }
        container.appendChild(ul);
        break;
      }
      case "table": {
        const table = el("table", "org-table");
        if (node.head.length > 0) {
          const tr = el("tr");
          for (const cell of node.head) {
            const th = el("th");
            renderInline(cell, th);
            tr.appendChild(th);
          }
          table.appendChild(tr);
        }
        for (const row of node.rows) {
          const tr = el("tr");
          for (const cell of row) {
            const td = el("td");
            renderInline(cell, td);
            tr.appendChild(td);
          }
          table.appendChild(tr);
        }
        container.appendChild(table);
        break;
      }
      case "src": {
        if (node.executable) {
          container.appendChild(buildCodeBlock(node.name, node.code, blocks));
        } else {
          const wrap = el("div", "foreign-block");
          const bar = el("div", "foreign-bar");
          bar.textContent = node.lang + (node.name !== null ? ` · ${node.name}` : "") + " · read-only";
          const pre = el("pre", "foreign-code");
          pre.textContent = node.code;
          wrap.append(bar, pre);
          container.appendChild(wrap);
        }
        break;
      }
      case "results": {
        const target = node.name !== null
          ? blocks.find((b) => b.name === node.name)
          : blocks[blocks.length - 1];
        if (target !== undefined) {
          target.resultsEl.hidden = node.canned === "";
          target.resultPre.textContent = node.canned;
        }
        break;
      }
    }
  }
  return blocks;
}

function buildCodeBlock(name: string | null, code: string, blocks: BlockHandle[]): HTMLElement {
  const blockEl = el("div", "code-block");
  if (name !== null) blockEl.id = `block-${name}`;
  const bar = el("div", "block-bar");
  const tag = el("span", "block-tag");
  tag.textContent = "asm · editable";
  const actions = el("div", "block-actions");
  const resetLink = el("a", "reset-code");
  resetLink.href = "#";
  resetLink.textContent = "Reset code";
  const runBtn = el("button", "btn small primary");
  runBtn.type = "button";
  runBtn.textContent = "▶ Run";
  runBtn.setAttribute("data-test", "block-run");
  actions.append(resetLink, runBtn);
  bar.append(tag, actions);

  const editorHost = el("div", "editor-host");
  editorHost.setAttribute("data-test", "editor");
  const errEl = el("div", "block-error");
  errEl.hidden = true;
  const resultsEl = el("div", "block-results");
  resultsEl.setAttribute("data-test", "results");
  const resultPre = el("pre");
  resultsEl.appendChild(resultPre);

  blockEl.append(bar, editorHost, errEl, resultsEl);
  blocks.push({ name, defaultCode: code, blockEl, editorHost, runBtn, resetLink, resultsEl, resultPre, errEl });
  return blockEl;
}
