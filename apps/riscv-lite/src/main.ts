// main.ts — app wiring: org lesson + assembler + simulator + machine panel.
//
// Interaction model (docs/design.md "Behavior"):
//  ▶ Run   — first click: assemble the active block and load it (no exec);
//            second click (unchanged code): run to completion.
//            The per-block ▶ Run button always assembles fresh + runs.
//  ⤵ Step — one instruction; when not loaded, assemble then execute insn #1.
//  ⟲ Reset — restore initial machine state, clear output, keep the code.
// The machine panel always reflects the ACTIVE block (last focused/run).

import lessonRaw from "./lesson.org?raw";
import { assemble, hex32, type Assembled } from "./asm";
import { Cpu } from "./cpu";
import { parseOrg } from "./org";
import {
  MachineUI,
  buildShell,
  renderLesson,
  type BlockInstance,
  type Shell,
} from "./render";

const RUN_BUDGET = 1_000_000;
const SLICE = 100_000; // instructions between animation frames
const ZEROS = new Int32Array(32);
const NO_CHANGE = new Set<number>();

interface BlockState {
  inst: BlockInstance;
  program: Assembled | null;
  /** Editor text at last successful assemble (detect edits → re-assemble). */
  loadedDoc: string | null;
  cpu: Cpu | null;
  output: string;
}

const app = document.getElementById("app") as HTMLElement;
const shell: Shell = buildShell(app);
const machine = new MachineUI(shell.machineHost);
const doc = parseOrg(lessonRaw);

const states: BlockState[] = [];
const byInst = new Map<BlockInstance, BlockState>();

const callbacks = {
  onRun(inst: BlockInstance) {
    const b = byInst.get(inst);
    if (b === undefined || running) return;
    setActive(b);
    // block-level Run = fresh assemble + run to completion
    if (assembleBlock(b)) void runAll(b);
  },
  onFocus(inst: BlockInstance) {
    if (running) return;
    const b = byInst.get(inst);
    if (b !== undefined) setActive(b);
  },
  onResetCode(inst: BlockInstance) {
    const b = byInst.get(inst);
    if (b === undefined) return;
    b.inst.editor.setText(b.inst.defaultText);
    hideError(b);
    if (b.program !== null) {
      // the loaded program no longer matches the text; drop it
      b.program = null;
      b.cpu = null;
      b.loadedDoc = null;
      b.output = "";
    }
    setActive(b);
    setStatus("idle");
  },
};

let active: BlockState;
let running = false;

renderLesson(shell.lessonHost, doc, callbacks).forEach((inst) => {
  const b: BlockState = { inst, program: null, loadedDoc: null, cpu: null, output: "" };
  states.push(b);
  byInst.set(inst, b);
});
active = states[0]!;

// ─────────────────────────── status chip ───────────────────────────

type ChipKind = "idle" | "ok" | "busy" | "warn" | "err";

function setStatus(text: string, kind: ChipKind = "idle"): void {
  shell.statusChip.textContent = text;
  shell.statusChip.className = "chip " + kind;
}

function setStatusFor(b: BlockState): void {
  if (b.program === null) {
    setStatus("idle");
    return;
  }
  const cpu = b.cpu;
  if (cpu !== null && cpu.error !== null) {
    setStatus(`runtime error${cpu.errorLine !== null ? ` · line ${cpu.errorLine}` : ""}: ${cpu.error}`, "err");
    return;
  }
  if (cpu !== null && cpu.halted !== null) {
    haltStatus(cpu);
    return;
  }
  if (cpu !== null && cpu.steps > 0) {
    setStatus(`step ${cpu.steps} · pc ${hex32(cpu.pc)}`, "ok");
    return;
  }
  setStatus(`loaded · ${b.program.insns.length} instructions`, "ok");
}

function haltStatus(cpu: Cpu): void {
  switch (cpu.halted) {
    case "exit":
      setStatus(`finished · exit ecall · ${cpu.steps} steps`, "ok");
      break;
    case "ebreak":
      setStatus(`finished · ebreak · ${cpu.steps} steps`, "ok");
      break;
    case "end":
      setStatus(`finished · fell off end of .text · ${cpu.steps} steps`, "warn");
      break;
    case "budget":
      setStatus(`halted · step budget (${RUN_BUDGET.toLocaleString("en-US")}) exceeded`, "warn");
      break;
  }
}

// ─────────────────────────── panel refresh ───────────────────────────

function byteReader(cpu: Cpu): (addr: number) => number {
  return (a) => cpu.readByte(a);
}

/** Address the current-instr marker should sit on (null = none). */
function currentAddr(b: BlockState): number | null {
  const cpu = b.cpu;
  if (cpu === null || cpu.halted !== null || cpu.error !== null) return null;
  return b.program!.insnAt.has(cpu.pc) ? cpu.pc : null;
}

function syncEditorLine(b: BlockState): void {
  states.forEach((s) => s.inst.editor.setCurrentLine(null));
  const addr = currentAddr(b);
  if (addr !== null) {
    const line = b.program!.insnAt.get(addr)!.sourceLine;
    b.inst.editor.setCurrentLine(line);
    b.inst.editor.scrollToLine(line);
  }
}

function refreshMachine(b: BlockState): void {
  const cpu = b.cpu;
  machine.setProgram(b.program);
  if (cpu !== null) {
    machine.updateRegisters(cpu.regs, cpu.pc, NO_CHANGE);
    machine.updateBranch(cpu.lastBranch);
    machine.updateMemory(byteReader(cpu), b.program!.hasData ? b.program!.dataStart : null);
  } else {
    machine.updateRegisters(ZEROS, 0, NO_CHANGE);
    machine.updateBranch(null);
    machine.updateMemory(null, null);
  }
  machine.setCurrent(currentAddr(b));
  machine.setOutput(b.output);
  syncEditorLine(b);
}

function setActive(b: BlockState): void {
  if (active === b) return;
  active = b;
  refreshMachine(b);
  setStatusFor(b);
}

// ─────────────────────────── errors ───────────────────────────

function showError(b: BlockState, line: number | null, message: string): void {
  b.inst.errorBox.hidden = false;
  b.inst.errorBox.textContent = line === null ? message : `line ${line}: ${message}`;
  b.inst.editor.setErrorLine(line);
}

function hideError(b: BlockState): void {
  b.inst.errorBox.hidden = true;
  b.inst.editor.setErrorLine(null);
}

// ─────────────────────────── assemble / load ───────────────────────────

function assembleBlock(b: BlockState): boolean {
  const src = b.inst.editor.getText();
  const r = assemble(src);
  if (!r.ok) {
    b.program = null;
    b.cpu = null;
    b.loadedDoc = null;
    b.output = "";
    showError(b, r.error.line, r.error.message);
    machine.setProgram(null);
    machine.updateRegisters(ZEROS, 0, NO_CHANGE);
    machine.updateBranch(null);
    machine.updateMemory(null, null);
    machine.setCurrent(null);
    machine.setOutput("");
    b.inst.editor.setCurrentLine(null);
    setStatus(`error · line ${r.error.line}: ${r.error.message}`, "err");
    return false;
  }
  hideError(b);
  b.program = r.program;
  b.loadedDoc = src;
  b.cpu = new Cpu(r.program);
  b.output = "";
  b.inst.resultsBody.textContent = "";
  machine.setProgram(r.program);
  refreshMachine(b);
  setStatus(`loaded · ${r.program.insns.length} instructions`, "ok");
  return true;
}

// ─────────────────────────── execution ───────────────────────────

function drainOutput(b: BlockState, cpu: Cpu): void {
  const chunk = cpu.takeOutput();
  if (chunk !== "") {
    b.output += chunk;
    machine.appendOutput(chunk);
    b.inst.resultsBody.textContent += chunk;
  }
}

function doStep(): void {
  const b = active;
  if (running) return;
  const src = b.inst.editor.getText();
  if (b.cpu === null || b.loadedDoc !== src) {
    if (!assembleBlock(b)) return;
  }
  const cpu = b.cpu!;
  if (cpu.halted !== null || cpu.error !== null) {
    setStatusFor(b);
    return;
  }
  const r = cpu.step(true);
  drainOutput(b, cpu);

  machine.updateRegisters(cpu.regs, cpu.pc, new Set(r.changed));
  machine.updateBranch(cpu.lastBranch);
  machine.setCurrent(currentAddr(b));
  machine.updateMemory(byteReader(cpu), b.program!.hasData ? b.program!.dataStart : null);
  syncEditorLine(b);

  if (cpu.error !== null) {
    showError(b, cpu.errorLine, cpu.error);
    machine.appendSystemNote(`\u26a0 ${cpu.error}`);
    setStatusFor(b);
    return;
  }
  if (cpu.halted !== null) {
    machine.appendSystemNote(haltNote(cpu));
    setStatusFor(b);
    return;
  }
  setStatus(`step ${cpu.steps} · pc ${hex32(cpu.pc)}`, "ok");
}

function nextFrame(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => resolve());
  return promise;
}

function haltNote(cpu: Cpu): string {
  switch (cpu.halted) {
    case "exit":
      return `\u2500\u2500 exit (ecall 10/93), ${cpu.steps} steps \u2500\u2500`;
    case "ebreak":
      return `\u2500\u2500 ebreak, ${cpu.steps} steps \u2500\u2500`;
    case "end":
      return `\u2500\u2500 fell off the end of .text (no exit ecall), ${cpu.steps} steps \u2500\u2500`;
    case "budget":
      return `\u2500\u2500 halted: ${RUN_BUDGET.toLocaleString("en-US")}-step budget exceeded \u2500\u2500`;
    default:
      return `\u2500\u2500 halted \u2500\u2500`;
  }
}


function setControls(enabled: boolean): void {
  shell.runBtn.disabled = !enabled;
  shell.stepBtn.disabled = !enabled;
  shell.resetBtn.disabled = !enabled;
  document
    .querySelectorAll<HTMLButtonElement>('[data-test="block-run"]')
    .forEach((btn) => (btn.disabled = !enabled));
}

/** Run to completion in animation-frame slices, streaming output. */
async function runAll(b: BlockState): Promise<void> {
  const cpu = b.cpu!;
  if (cpu.halted !== null || cpu.error !== null) {
    setStatusFor(b);
    return;
  }
  running = true;
  setControls(false);
  setStatus("running\u2026", "busy");

  while (cpu.halted === null && cpu.error === null && cpu.steps < RUN_BUDGET) {
    for (let k = 0; k < SLICE && cpu.halted === null && cpu.error === null; k++) {
      if (cpu.steps >= RUN_BUDGET) break;
      cpu.step(false);
    }
    drainOutput(b, cpu);
    if (cpu.halted === null && cpu.error === null && cpu.steps < RUN_BUDGET) {
      setStatus(`running\u2026 ${cpu.steps.toLocaleString("en-US")}`, "busy");
      await nextFrame();
    }
  }
  if (cpu.halted === null && cpu.error === null) {
    cpu.halted = "budget"; // runaway loop guard
  }
  drainOutput(b, cpu);

  machine.updateRegisters(cpu.regs, cpu.pc, NO_CHANGE);
  machine.updateBranch(cpu.lastBranch);
  machine.setCurrent(currentAddr(b));
  machine.updateMemory(byteReader(cpu), b.program!.hasData ? b.program!.dataStart : null);
  syncEditorLine(b);

  if (cpu.error !== null) {
    showError(b, cpu.errorLine, cpu.error);
    machine.appendSystemNote(`\u26a0 ${cpu.error}`);
  } else {
    machine.appendSystemNote(haltNote(cpu));
  }
  setStatusFor(b);
  running = false;
  setControls(true);
}

function doToolbarRun(): void {
  const b = active;
  if (running) return;
  const src = b.inst.editor.getText();
  if (b.cpu === null || b.loadedDoc !== src) {
    assembleBlock(b); // first click: load only (design.md behavior 1 → 3)
    return;
  }
  void runAll(b);
}

function doReset(): void {
  const b = active;
  if (running) return;
  if (b.program !== null) {
    b.cpu = new Cpu(b.program);
  } else {
    b.cpu = null;
  }
  b.output = "";
  machine.clearOutput();
  machine.setProgram(b.program);
  refreshMachine(b);
  b.inst.resultsBody.textContent = b.inst.cannedResults ?? "";
  setStatusFor(b);
}

// ─────────────────────────── boot ───────────────────────────

shell.runBtn.addEventListener("click", doToolbarRun);
shell.stepBtn.addEventListener("click", doStep);
shell.resetBtn.addEventListener("click", doReset);

refreshMachine(active);
setStatus("idle");

// deep link to a named block: #hello or #sum-loop
const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
if (hash !== "") {
  const b = states.find((s) => s.inst.name === hash);
  if (b !== undefined) {
    setActive(b);
    b.inst.frame.scrollIntoView({ block: "start" });
    b.inst.editor.focus();
  }
}
