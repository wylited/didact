// render.ts — DOM rendering: lesson document (org nodes), CodeMirror 6
// editors for executable blocks, and the right-hand machine panel.

import { EditorState, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";
import { basicSetup } from "codemirror";
import { MNEMONIC_SET, REG_ABI, hex32, type Assembled } from "./asm";
import type { BranchInfo } from "./cpu";
import type { OrgDoc } from "./org";

// ─────────────────────────── app shell ───────────────────────────

export interface Shell {
  runBtn: HTMLButtonElement;
  stepBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
  statusChip: HTMLElement;
  lessonHost: HTMLElement;
  machineHost: HTMLElement;
}

const SHELL_HTML = `
  <header class="toolbar">
    <button class="tb-btn primary" data-test="run" title="Assemble, then run to completion">&#9654; Run</button>
    <button class="tb-btn" data-test="step" title="Execute exactly one instruction">&#10549; Step</button>
    <button class="tb-btn" data-test="reset" title="Restore initial machine state">&#10226; Reset</button>
    <span class="tb-spacer"></span>
    <span class="chip" data-test="status">idle</span>
  </header>
  <main class="layout">
    <section class="lesson-pane" id="lesson"></section>
    <aside class="machine-pane" id="machine"></aside>
  </main>`;

export function buildShell(root: HTMLElement): Shell {
  root.innerHTML = SHELL_HTML;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  return {
    runBtn: q<HTMLButtonElement>('[data-test="run"]'),
    stepBtn: q<HTMLButtonElement>('[data-test="step"]'),
    resetBtn: q<HTMLButtonElement>('[data-test="reset"]'),
    statusChip: q<HTMLElement>('[data-test="status"]'),
    lessonHost: q<HTMLElement>("#lesson"),
    machineHost: q<HTMLElement>("#machine"),
  };
}

// ─────────────────────────── CodeMirror editor ───────────────────────────

const setErrorLine = StateEffect.define<number | null>();
const setCurrentLine = StateEffect.define<number | null>();

function lineDeco(doc: Text, n: number | null, cls: string): DecorationSet {
  if (n === null || n < 1 || n > doc.lines) return Decoration.none;
  return Decoration.set([Decoration.line({ class: cls }).range(doc.line(n).from)]);
}

const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorLine)) value = lineDeco(tr.newDoc, e.value, "cm-err-line");
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const currentLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setCurrentLine)) value = lineDeco(tr.newDoc, e.value, "cm-cur-line");
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** RISC-V assembly stream parser: # comments, labels, registers, immediates. */
const riscvAsmMode: StreamParser<null> = {
  name: "asm-riscv",
  token(stream: StringStream): string | null {
    if (stream.eatSpace()) return null;
    if (stream.match(/^[#;]/)) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.sol() && stream.match(/^[A-Za-z_.$][A-Za-z0-9_.$]*\s*:/)) return "tag";
    if (stream.match(/^"(\\.|[^"\\])*"/)) return "string";
    if (stream.match(/^'(\\.|[^'\\])'/)) return "string";
    if (stream.match(/^\.[A-Za-z][A-Za-z0-9]*/)) return "keyword";
    if (stream.match(/^(x[0-9]{1,2}|zero|ra|sp|gp|tp|fp|t[0-6]|s1[01]|s[0-9]|a[0-7])(?![A-Za-z0-9_])/)) {
      return "variable";
    }
    if (stream.match(/^[+-]?(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)/)) return "number";
    const word = stream.match(/^[A-Za-z_.$][A-Za-z0-9_.$]*/);
    if (word) {
      return MNEMONIC_SET.has((word as RegExpMatchArray)[0]!.toLowerCase()) ? "keyword" : "variable";
    }
    stream.next();
    return null;
  },
};

export interface EditorHandle {
  getText(): string;
  setText(t: string): void;
  setErrorLine(n: number | null): void;
  setCurrentLine(n: number | null): void;
  scrollToLine(n: number): void;
  focus(): void;
}

export function makeEditor(host: HTMLElement, initial: string): EditorHandle {
  const view = new EditorView({
    state: EditorState.create({
      doc: initial,
      extensions: [
        basicSetup,
        StreamLanguage.define(riscvAsmMode),
        errorLineField,
        currentLineField,
      ],
    }),
    parent: host,
  });
  return {
    getText: () => view.state.doc.toString(),
    setText(t: string) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } });
    },
    setErrorLine(n: number | null) {
      view.dispatch({ effects: setErrorLine.of(n) });
    },
    setCurrentLine(n: number | null) {
      view.dispatch({ effects: setCurrentLine.of(n) });
    },
    scrollToLine(n: number) {
      if (n >= 1 && n <= view.state.doc.lines) {
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(n).from, { y: "center" }) });
      }
    },
    focus: () => view.focus(),
  };
}

// ─────────────────────────── lesson rendering ───────────────────────────

export interface BlockInstance {
  name: string | null;
  index: number;
  frame: HTMLElement;
  editor: EditorHandle;
  runBtn: HTMLButtonElement;
  resultsBody: HTMLElement;
  errorBox: HTMLElement;
  /** The authored sample (for the "Reset code" link). */
  defaultText: string;
  cannedResults: string | null;
}

export interface LessonCallbacks {
  onRun(inst: BlockInstance): void;
  onFocus(inst: BlockInstance): void;
  onResetCode(inst: BlockInstance): void;
}

/** Inline org markup: *bold*, /italic/, =code=, ~verbatim~. */
function appendInline(target: HTMLElement, text: string): void {
  const re = /(\*[^*\s][^*]*\*|\/[^/\s][^/]*\/|=[^=\s][^=]*=|~[^~\s][^~]*~)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) target.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    const el = document.createElement(
      tok.startsWith("*") ? "strong" : tok.startsWith("/") ? "em" : "code",
    );
    el.textContent = tok.slice(1, -1);
    if (el.tagName === "CODE") el.className = "inline-code";
    target.appendChild(el);
    last = m.index + tok.length;
  }
  if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
}

export function renderLesson(
  root: HTMLElement,
  doc: OrgDoc,
  cb: LessonCallbacks,
): BlockInstance[] {
  root.innerHTML = "";
  const blocks: BlockInstance[] = [];

  if (doc.title !== null) {
    const h = document.createElement("h1");
    h.className = "doc-title";
    h.textContent = doc.title;
    root.appendChild(h);
  }
  if (doc.subtitle !== null) {
    const p = document.createElement("p");
    p.className = "doc-subtitle";
    p.textContent = doc.subtitle;
    root.appendChild(p);
  }

  doc.nodes.forEach((node) => {
    switch (node.t) {
      case "heading": {
        const h = document.createElement(`h${Math.min(node.depth + 1, 6)}`);
        h.className = "org-heading";
        h.textContent = node.text;
        root.appendChild(h);
        break;
      }
      case "para": {
        const p = document.createElement("p");
        p.className = "org-para";
        appendInline(p, node.text);
        root.appendChild(p);
        break;
      }
      case "list": {
        const ul = document.createElement("ul");
        ul.className = "org-list";
        node.items.forEach((item) => {
          const li = document.createElement("li");
          appendInline(li, item);
          ul.appendChild(li);
        });
        root.appendChild(ul);
        break;
      }
      case "table": {
        if (node.rows.length === 0) break;
        const table = document.createElement("table");
        table.className = "org-table";
        const thead = document.createElement("thead");
        const hr = document.createElement("tr");
        node.rows[0]!.forEach((cell) => {
          const th = document.createElement("th");
          appendInline(th, cell);
          hr.appendChild(th);
        });
        thead.appendChild(hr);
        table.appendChild(thead);
        const tbody = document.createElement("tbody");
        node.rows.slice(1).forEach((row) => {
          const tr = document.createElement("tr");
          row.forEach((cell) => {
            const td = document.createElement("td");
            appendInline(td, cell);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        root.appendChild(table);
        break;
      }
      case "example": {
        const pre = document.createElement("pre");
        pre.className = "org-example";
        pre.textContent = node.lines.join("\n");
        root.appendChild(pre);
        break;
      }
      case "src": {
        const block = node.block;
        if (!block.executable) {
          const wrap = document.createElement("div");
          wrap.className = "ro-src";
          const label = document.createElement("div");
          label.className = "ro-src-lang";
          label.textContent = block.lang + (block.name !== null ? ` · ${block.name}` : "");
          wrap.appendChild(label);
          const pre = document.createElement("pre");
          pre.textContent = block.lines.join("\n");
          wrap.appendChild(pre);
          root.appendChild(wrap);
          break;
        }

        const frame = document.createElement("div");
        frame.className = "block";
        frame.id = "block-" + (block.name ?? String(blocks.length));

        const head = document.createElement("div");
        head.className = "block-head";
        const lang = document.createElement("span");
        lang.className = "block-lang";
        lang.textContent = block.lang;
        head.appendChild(lang);
        if (block.name !== null) {
          const nm = document.createElement("span");
          nm.className = "block-name";
          nm.textContent = block.name;
          head.appendChild(nm);
        }
        const spacer = document.createElement("span");
        spacer.className = "block-spacer";
        head.appendChild(spacer);

        const resetLink = document.createElement("button");
        resetLink.type = "button";
        resetLink.className = "reset-code";
        resetLink.textContent = "Reset code";
        resetLink.title = "Restore the original sample program";
        head.appendChild(resetLink);

        const runBtn = document.createElement("button");
        runBtn.type = "button";
        runBtn.className = "block-run";
        runBtn.setAttribute("data-test", "block-run");
        runBtn.textContent = "\u25B6 Run";
        head.appendChild(runBtn);
        frame.appendChild(head);

        const host = document.createElement("div");
        host.className = "editor-host";
        host.setAttribute("data-test", "editor");
        frame.appendChild(host);

        const errorBox = document.createElement("div");
        errorBox.className = "block-error";
        errorBox.hidden = true;
        frame.appendChild(errorBox);

        const results = document.createElement("div");
        results.className = "results";
        const resultsBody = document.createElement("div");
        resultsBody.className = "results-body";
        resultsBody.setAttribute("data-test", "results");
        resultsBody.textContent = block.results ?? "";
        results.appendChild(resultsBody);
        frame.appendChild(results);

        root.appendChild(frame);

        const editor = makeEditor(host, block.lines.join("\n"));
        const inst: BlockInstance = {
          name: block.name,
          index: blocks.length,
          frame,
          editor,
          runBtn,
          errorBox,
          resultsBody,
          defaultText: block.lines.join("\n"),
          cannedResults: block.results,
        };
        frame.addEventListener("focusin", () => cb.onFocus(inst));
        runBtn.addEventListener("click", () => cb.onRun(inst));
        resetLink.addEventListener("click", () => cb.onResetCode(inst));
        blocks.push(inst);
        break;
      }
    }
  });
  return blocks;
}

// ─────────────────────────── machine panel ───────────────────────────

interface RegCell {
  nameEl: HTMLElement;
  hexEl: HTMLElement;
  decEl: HTMLElement;
  cell: HTMLElement;
}

export class MachineUI {
  private readonly regCells: RegCell[] = [];
  private readonly pcHex: HTMLElement;
  private readonly pcDec: HTMLElement;
  private readonly pcCell: HTMLElement;
  private readonly branchEl: HTMLElement;
  private readonly disasmEl: HTMLElement;
  private readonly memoryEl: HTMLElement;
  private readonly consoleEl: HTMLElement;
  private readonly rowAtAddr = new Map<number, HTMLElement>();
  private currentRow: HTMLElement | null = null;
  private lastProgram: Assembled | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <section class="panel">
        <h2>Registers</h2>
        <div class="reg-grid" data-test="registers"></div>
      </section>
      <section class="panel">
        <h2>Branch context</h2>
        <div class="branch-ctx" data-test="branch-context">no branch executed yet</div>
      </section>
      <section class="panel">
        <h2>Disassembly</h2>
        <div class="disasm" data-test="disassembly"></div>
      </section>
      <section class="panel">
        <h2>Memory &middot; .data</h2>
        <div class="memory" data-test="memory"></div>
      </section>
      <section class="panel">
        <h2>Output</h2>
        <div class="console" data-test="output"></div>
      </section>`;
    const grid = root.querySelector<HTMLElement>('[data-test="registers"]')!;
    REG_ABI.forEach((name) => {
      const cell = document.createElement("div");
      cell.className = "reg";
      cell.setAttribute("data-test", "reg-" + name);
      const nameEl = document.createElement("span");
      nameEl.className = "reg-name";
      nameEl.textContent = name;
      const hexEl = document.createElement("span");
      hexEl.className = "reg-hex";
      hexEl.textContent = "0x00000000";
      const decEl = document.createElement("span");
      decEl.className = "reg-dec";
      decEl.textContent = "0";
      cell.appendChild(nameEl);
      cell.appendChild(hexEl);
      cell.appendChild(decEl);
      grid.appendChild(cell);
      this.regCells.push({ nameEl, hexEl, decEl, cell });
    });
    const pcCell = document.createElement("div");
    pcCell.className = "reg reg-pc";
    pcCell.setAttribute("data-test", "reg-pc");
    const pcName = document.createElement("span");
    pcName.className = "reg-name";
    pcName.textContent = "pc";
    this.pcHex = document.createElement("span");
    this.pcHex.className = "reg-hex";
    this.pcHex.textContent = "0x00000000";
    this.pcDec = document.createElement("span");
    this.pcDec.className = "reg-dec";
    this.pcDec.textContent = "0";
    pcCell.appendChild(pcName);
    pcCell.appendChild(this.pcHex);
    pcCell.appendChild(this.pcDec);
    grid.appendChild(pcCell);
    this.pcCell = pcCell;

    this.branchEl = root.querySelector<HTMLElement>('[data-test="branch-context"]')!;
    this.disasmEl = root.querySelector<HTMLElement>('[data-test="disassembly"]')!;
    this.memoryEl = root.querySelector<HTMLElement>('[data-test="memory"]')!;
    this.consoleEl = root.querySelector<HTMLElement>('[data-test="output"]')!;

    this.updateRegisters(new Int32Array(32), 0, new Set<number>(), false);
    this.setProgram(null);
    this.updateMemory(null, null);
  }

  updateRegisters(regs: Int32Array, pc: number, changed: ReadonlySet<number>, pcChanged: boolean): void {
    for (let i = 0; i < 32; i++) {
      const c = this.regCells[i]!;
      c.hexEl.textContent = hex32(regs[i]!);
      c.decEl.textContent = String(regs[i]!);
      c.cell.classList.toggle("changed", changed.has(i));
    }
    this.pcHex.textContent = hex32(pc);
    this.pcDec.textContent = String(pc >>> 0);
    this.pcCell.classList.toggle("changed", pcChanged);
  }

  updateBranch(info: BranchInfo | null): void {
    if (info === null) {
      this.branchEl.textContent = "no branch executed yet";
      this.branchEl.classList.remove("taken");
      return;
    }
    this.branchEl.textContent = `${info.op} ${info.rs1}, ${info.rs2} \u00b7 ${info.rs1}=${info.v1}, ${info.rs2}=${info.v2} \u00b7 ${info.taken ? "taken" : "not taken"}`;
    this.branchEl.classList.toggle("taken", info.taken);
  }

  /** Rebuild the disassembly listing (call whenever a new program is loaded). */
  setProgram(prog: Assembled | null): void {
    if (prog === this.lastProgram) return;
    this.lastProgram = prog;
    this.rowAtAddr.clear();
    this.currentRow = null;
    this.disasmEl.innerHTML = "";
    if (prog === null) {
      const empty = document.createElement("div");
      empty.className = "empty-note";
      empty.textContent = "\u2014 no program loaded \u2014";
      this.disasmEl.appendChild(empty);
      return;
    }
    prog.insns.forEach((ins) => {
      const row = document.createElement("div");
      row.className = "dis-row";
      const addr = document.createElement("span");
      addr.className = "dis-addr";
      addr.textContent = hex32(ins.addr);
      const bytes = document.createElement("span");
      bytes.className = "dis-bytes";
      bytes.textContent = ins.bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
      const mn = document.createElement("span");
      mn.className = "dis-mn";
      if (ins.labels.length > 0) {
        const lbl = document.createElement("span");
        lbl.className = "dis-label";
        lbl.textContent = ins.labels[0] + ":";
        mn.appendChild(lbl);
      }
      mn.appendChild(document.createTextNode(" " + ins.text));
      row.appendChild(addr);
      row.appendChild(bytes);
      row.appendChild(mn);
      this.disasmEl.appendChild(row);
      this.rowAtAddr.set(ins.addr, row);
    });
  }

  /** Move the current-instruction marker; auto-scrolls it into view. */
  setCurrent(addr: number | null): void {
    if (this.currentRow !== null) {
      this.currentRow.classList.remove("current");
      this.currentRow.removeAttribute("data-test");
    }
    this.currentRow = addr === null ? null : this.rowAtAddr.get(addr) ?? null;
    if (this.currentRow !== null) {
      this.currentRow.classList.add("current");
      this.currentRow.setAttribute("data-test", "current-instr");
      this.currentRow.scrollIntoView({ block: "nearest" });
    }
  }

  /** 8 rows × 16 bytes over .data, with an ASCII column. */
  updateMemory(read: ((addr: number) => number) | null, start: number | null): void {
    this.memoryEl.innerHTML = "";
    if (read === null || start === null) {
      this.renderMemoryRows(() => 0, 0x1000);
      return;
    }
    this.renderMemoryRows(read, start);
  }

  private renderMemoryRows(read: (addr: number) => number, start: number): void {
    const base = start & ~0xf;
    for (let row = 0; row < 8; row++) {
      const addr = base + row * 16;
      const rowEl = document.createElement("div");
      rowEl.className = "mem-row";
      const addrEl = document.createElement("span");
      addrEl.className = "mem-addr";
      addrEl.textContent = hex32(addr);
      const bytesEl = document.createElement("span");
      bytesEl.className = "mem-bytes";
      const asciiEl = document.createElement("span");
      asciiEl.className = "mem-ascii";
      let ascii = "";
      for (let k = 0; k < 16; k++) {
        const b = read(addr + k);
        bytesEl.textContent += b.toString(16).padStart(2, "0") + (k === 7 ? "  " : " ");
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "\u00b7";
      }
      asciiEl.textContent = ascii;
      rowEl.appendChild(addrEl);
      rowEl.appendChild(bytesEl);
      rowEl.appendChild(asciiEl);
      this.memoryEl.appendChild(rowEl);
    }
  }

  setOutput(text: string): void {
    this.consoleEl.textContent = text;
    this.consoleEl.scrollTop = this.consoleEl.scrollHeight;
  }

  appendOutput(text: string): void {
    this.consoleEl.appendChild(document.createTextNode(text));
    this.consoleEl.scrollTop = this.consoleEl.scrollHeight;
  }

  appendSystemNote(text: string): void {
    const note = document.createElement("div");
    note.className = "sys-note";
    note.textContent = text;
    this.consoleEl.appendChild(note);
    this.consoleEl.scrollTop = this.consoleEl.scrollHeight;
  }

  clearOutput(): void {
    this.consoleEl.textContent = "";
  }
}
