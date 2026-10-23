// main.ts — wiring: builds the page, renders the lesson, mounts a CodeMirror 6
// editor per executable block, and implements the toolbar behaviors from
// docs/design.md (assemble-on-Run, exact single-Step, run-to-completion,
// Reset) against the active block.

import "../styles.css";
import lessonSrc from "./lesson.org?raw";

import { basicSetup } from "codemirror";
import { EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

import { assemble } from "./asm";
import { asmHighlighting, asmLanguage } from "./asm-lang";
import { Machine } from "./cpu";
import { parseOrg } from "./org";
import {
  buildPage, renderDocument, setDisassembly, updateDisasmCurrent, updateFlags, updateMemory,
  updateOutput, updateRegisters,
  type BlockHandle, type PageChrome,
} from "./render";

// ---------------------------------------------------------------------------
// editor decorations: current-instruction line + assemble-error line
// ---------------------------------------------------------------------------

const setMark = StateEffect.define<{ active: number | null; error: number | null }>();

const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMark)) {
        const marks: Range<Decoration>[] = [];
        if (e.value.error !== null && e.value.error >= 1 && e.value.error <= tr.state.doc.lines) {
          marks.push(Decoration.line({ class: "cm-errorLine" }).range(tr.state.doc.line(e.value.error).from));
        }
        if (e.value.active !== null && e.value.active >= 1 && e.value.active <= tr.state.doc.lines) {
          marks.push(Decoration.line({ class: "cm-activeInstr" }).range(tr.state.doc.line(e.value.active).from));
        }
        value = Decoration.set(marks);
      }
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// ---------------------------------------------------------------------------
// app state
// ---------------------------------------------------------------------------

interface Block extends BlockHandle {
  view: EditorView;
  machine: Machine | null;
  loadedSource: string;
  activeLine: number | null;
  errorLine: number | null;
}

const decoder = new TextDecoder();
let chrome: PageChrome;
let blocks: Block[] = [];
let active: Block | null = null;
let memMode: "data" | "stack" = "data";

function setStatus(kind: "idle" | "ok" | "error" | "done", text: string): void {
  chrome.statusChip.textContent = text;
  chrome.statusChip.className = `chip ${kind}`;
}

function refreshPanels(): void {
  if (active === null) return;
  const b = active;
  const m = b.machine;
  updateRegisters(chrome, m);
  updateFlags(chrome, m);
  const prog = m !== null ? m.prog : null;
  if (chrome.disasmProg !== prog) {
    setDisassembly(chrome, prog);
    chrome.disasmProg = prog;
  }
  updateDisasmCurrent(chrome, m);
  updateMemory(chrome, m, memMode);
  updateOutput(chrome, m);
  if (m !== null && m.out.length > 0) {
    b.resultsEl.hidden = false;
    b.resultPre.textContent = decoder.decode(Uint8Array.from(m.out));
  }
}

function setEditorMarks(b: Block, scroll = false): void {
  const effects: StateEffect<unknown>[] = [setMark.of({ active: b.activeLine, error: b.errorLine })];
  if (scroll && b.activeLine !== null) {
    const ln = Math.min(Math.max(1, b.activeLine), b.view.state.doc.lines);
    effects.push(EditorView.scrollIntoView(b.view.state.doc.line(ln).from, { y: "center" }));
  }
  b.view.dispatch({ effects });
}

/** Refresh the status chip to reflect the given (newly active) block's own state. */
function syncStatusFor(b: Block): void {
  if (b.machine === null && b.errorLine !== null) {
    setStatus("error", b.errEl.textContent ?? `line ${b.errorLine}: assembly error`);
    return;
  }
  const m = b.machine;
  if (m === null) {
    setStatus("idle", "not loaded");
  } else if (m.status === "error") {
    setStatus("error", m.error ?? "runtime error");
  } else if (m.status === "finished") {
    setStatus("done", `finished · ${m.finishNote ?? "done"} · ${m.steps} steps`);
  } else {
    setStatus("ok", `loaded · ${m.prog.insns.length} instructions`);
  }
}

function setActive(b: Block): void {
  if (active === b) return;
  const prev = active;
  active = b;
  if (prev !== null) {
    prev.blockEl.removeAttribute("data-active");
    prev.activeLine = null;
    setEditorMarks(prev);
  }
  b.blockEl.setAttribute("data-active", "true");
  setEditorMarks(b);
  refreshPanels();
  syncStatusFor(b);
}

function showAsmError(b: Block, line: number, message: string): void {
  b.machine = null;
  b.activeLine = null;
  b.errorLine = line;
  b.errEl.hidden = false;
  b.errEl.textContent = `line ${line}: ${message}`;
  setEditorMarks(b, true);
  setStatus("error", `line ${line}: ${message}`);
}

function clearAsmError(b: Block): void {
  b.errEl.hidden = true;
  b.errEl.textContent = "";
  b.errorLine = null;
}

/** (Re)assemble the block's current source; on success load + reset machine. */
function ensureLoaded(b: Block): boolean {
  const src = b.view.state.doc.toString();
  if (b.machine !== null && b.loadedSource === src) return true;
  clearAsmError(b);
  const res = assemble(src);
  if (!res.ok) {
    showAsmError(b, res.line, res.message);
    refreshPanels();
    return false;
  }
  b.machine = new Machine(res.program);
  b.loadedSource = src;
  const first = b.machine.insnAt();
  b.activeLine = first !== undefined ? first.line : null;
  setEditorMarks(b, true);
  setStatus("ok", `loaded · ${res.program.insns.length} instructions`);
  refreshPanels();
  return true;
}

function afterExecution(b: Block): void {
  const m = b.machine;
  if (m === null) return;
  if (m.status === "error") {
    setStatus("error", m.error ?? "runtime error");
    b.activeLine = null;
  } else if (m.status === "finished") {
    setStatus("done", `finished · ${m.finishNote ?? "done"} · ${m.steps} steps`);
    b.activeLine = null;
  } else {
    setStatus("ok", `running · step ${m.steps}`);
    const ins = m.insnAt();
    b.activeLine = ins !== undefined ? ins.line : null;
  }
  setEditorMarks(b, true);
  refreshPanels();
}

/** ▶ Run: first click assembles + loads; further clicks run to completion. */
function doRun(): void {
  if (active === null) return;
  const b = active;
  const src = b.view.state.doc.toString();
  const loaded = b.machine !== null && b.machine.status === "loaded" && b.loadedSource === src;
  if (loaded) {
    b.machine!.run();
    afterExecution(b);
  } else {
    ensureLoaded(b);
  }
}

/** ⤵ Step: assemble if needed, then execute exactly one instruction. */
function doStep(): void {
  if (active === null) return;
  const b = active;
  const src = b.view.state.doc.toString();
  const loaded = b.machine !== null && b.machine.status === "loaded" && b.loadedSource === src;
  if (!loaded && !ensureLoaded(b)) return;
  b.machine!.step();
  afterExecution(b);
}

/** ⟲ Reset: initial machine state, cleared output, code kept. */
function doReset(): void {
  if (active === null) return;
  const b = active;
  clearAsmError(b);
  if (b.machine !== null) {
    b.machine.reset();
    const first = b.machine.insnAt();
    b.activeLine = first !== undefined ? first.line : null;
    setStatus("ok", `loaded · ${b.machine.prog.insns.length} instructions`);
    b.resultsEl.hidden = true;
    b.resultPre.textContent = "";
  } else {
    b.activeLine = null;
    setStatus("idle", "not loaded");
    b.resultsEl.hidden = true;
    b.resultPre.textContent = "";
  }
  setEditorMarks(b);
  refreshPanels();
}

/** "Reset code" link on a block: restore the authored sample. */
function resetCode(b: Block): void {
  b.view.dispatch({ changes: { from: 0, to: b.view.state.doc.length, insert: b.defaultCode } });
  b.machine = null;
  b.loadedSource = "";
  clearAsmError(b);
  b.activeLine = null;
  b.resultsEl.hidden = true;
  b.resultPre.textContent = "";
  setEditorMarks(b);
  if (active === b) {
    setStatus("idle", "code restored · not loaded");
    refreshPanels();
  }
}

function boot(): void {
  const root = document.getElementById("app");
  if (root === null) return;
  chrome = buildPage(root);
  const handles = renderDocument(chrome.docContainer, parseOrg(lessonSrc));

  blocks = handles.map((h, idx) => {
    const block: Block = {
      ...h,
      machine: null,
      loadedSource: "",
      activeLine: null,
      errorLine: null,
      view: null as unknown as EditorView,
    };
    block.view = new EditorView({
      state: EditorState.create({
        doc: h.defaultCode,
        extensions: [
          basicSetup,
          asmLanguage,
          asmHighlighting,
          markField,
          EditorView.lineWrapping,
          EditorView.updateListener.of((v) => {
            if (v.focusChanged && v.view.hasFocus) setActive(blocks[idx]!);
          }),
        ],
      }),
      parent: h.editorHost,
    });
    return block;
  });

  chrome.runBtn.addEventListener("click", doRun);
  chrome.stepBtn.addEventListener("click", doStep);
  chrome.resetBtn.addEventListener("click", doReset);
  const setMemMode = (mode: "data" | "stack") => {
    memMode = mode;
    chrome.memBtnData.classList.toggle("active", mode === "data");
    chrome.memBtnStack.classList.toggle("active", mode === "stack");
    updateMemory(chrome, active !== null ? active.machine : null, memMode);
  };
  chrome.memBtnData.addEventListener("click", () => setMemMode("data"));
  chrome.memBtnStack.addEventListener("click", () => setMemMode("stack"));

  for (const b of blocks) {
    b.runBtn.addEventListener("click", () => {
      setActive(b);
      doRun();
    });
    b.resetLink.addEventListener("click", (ev) => {
      ev.preventDefault();
      resetCode(b);
    });
  }

  if (blocks.length > 0) {
    active = blocks[0]!;
    active.blockEl.setAttribute("data-active", "true");
    active.activeLine = null;
    setStatus("idle", "not loaded");
  } else {
    setStatus("idle", "no executable asm blocks in this lesson");
  }
  refreshPanels();
}

boot();
