// App bootstrap: parse the embedded lesson, render it, load the vendored
// engines, and wire the toolbar + machine panel to the active block.
import '../styles.css';
import lessonSrc from './lesson.org?raw';
import { assemble, DATA_BASE } from './asm';


import { parseOrg } from './org';
import { renderLesson, type BlockHandle } from './render';
import { FLAG_DEFS, GPR_NAMES, Machine, formatDec64, formatHex64 } from './machine';
import { KeystoneFacade, loadEngines } from './vendor';

const RUN_BUDGET = 1_000_000;
const ASM_LANG = 'asm';

function must<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`missing element ${selector}`);
  return node;
}

const statusEl = must<HTMLElement>('#status');
const runBtn = must<HTMLButtonElement>('#btn-run');
const stepBtn = must<HTMLButtonElement>('#btn-step');
const resetBtn = must<HTMLButtonElement>('#btn-reset');
const lessonHost = must<HTMLElement>('#lesson');
const registersEl = must<HTMLElement>('#registers');
const flagsEl = must<HTMLElement>('#flags');
const disasmEl = must<HTMLElement>('#disasm');
const memoryEl = must<HTMLElement>('#memory');
const outputEl = must<HTMLElement>('#output');

type StatusKind = 'muted' | 'ok' | 'busy' | 'error' | 'accent';

function setStatus(text: string, kind: StatusKind = 'muted'): void {
  statusEl.textContent = text;
  statusEl.className = `status status-${kind}`;
}

// ---------------------------------------------------------------------------
// Machine panel scaffolding (registers grid + flag chips)
// ---------------------------------------------------------------------------

interface RegCell {
  cell: HTMLElement;
  hex: HTMLElement;
  dec: HTMLElement;
}

const regCells = new Map<string, RegCell>();
for (const name of GPR_NAMES) {
  const cell = document.createElement('div');
  cell.className = 'reg';
  cell.dataset.test = `reg-${name}`;
  const nameEl = document.createElement('span');
  nameEl.className = 'reg-name';
  nameEl.textContent = name;
  const hex = document.createElement('span');
  hex.className = 'reg-hex';
  hex.textContent = formatHex64(0n);
  const dec = document.createElement('span');
  dec.className = 'reg-dec';
  dec.textContent = '0';
  cell.append(nameEl, hex, dec);
  registersEl.appendChild(cell);
  regCells.set(name, { cell, hex, dec });
}
{
  const cell = document.createElement('div');
  cell.className = 'reg reg-pc';
  cell.dataset.test = 'reg-rip';
  const nameEl = document.createElement('span');
  nameEl.className = 'reg-name';
  nameEl.textContent = 'rip';
  const hex = document.createElement('span');
  hex.className = 'reg-hex';
  hex.textContent = formatHex64(0n);
  const dec = document.createElement('span');
  dec.className = 'reg-dec';
  dec.textContent = 'not loaded';
  cell.append(nameEl, hex, dec);
  registersEl.appendChild(cell);
  regCells.set('rip', { cell, hex, dec });
}

const flagEls = new Map<string, HTMLElement>();
for (const flag of FLAG_DEFS) {
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.textContent = flag.name;
  chip.title = flag.title;
  flagsEl.appendChild(chip);
  flagEls.set(flag.name, chip);
}

// ---------------------------------------------------------------------------
// Lesson + blocks
// ---------------------------------------------------------------------------

const doc = parseOrg(lessonSrc);
let machine: Machine | null = null;
let assembler: KeystoneFacade | null = null;
let activeBlock: BlockHandle | null = null;
let machineBlock: BlockHandle | null = null;
const blocks: BlockHandle[] = renderLesson(doc, lessonHost, ASM_LANG, {
  onRun: (block) => doRun(block),
  onActivate: (block) => activate(block),
  onResetCode: (block) => doResetCode(block),
});
if (blocks.length > 0) activeBlock = blocks[0];

// ---------------------------------------------------------------------------
// Engine loading
// ---------------------------------------------------------------------------

loadEngines()
  .then((engines) => {
    assembler = new KeystoneFacade(engines.keystone);
    machine = new Machine(engines.unicorn, new engines.capstone.Capstone(engines.capstone.ARCH_X86, engines.capstone.MODE_64), {
      onNote: (text) => setStatus(text, 'accent'),
    });
    setStatus('ready — press ▶ Run or ⤵ Step', 'ok');
    renderPanel();
  })
  .catch((err: unknown) => {
    setStatus(`failed to load engines: ${err instanceof Error ? err.message : String(err)}`, 'error');
  });

// ---------------------------------------------------------------------------
// Assemble / run / step / reset
// ---------------------------------------------------------------------------

/** Assemble `block` and load it into the machine. Returns success. */
function assembleAndLoad(block: BlockHandle): boolean {
  if (!machine || !assembler) {
    setStatus('engines are still loading…', 'muted');
    return false;
  }
  const source = block.getSource();
  const result = assemble(source, assembler);
  if (!result.ok) {
    const first = result.errors[0];
    block.markError(first ? first.line : null, first ? first.message : 'assembly failed');
    setStatus(`error · ${first ? `line ${first.line}: ${first.message}` : 'assembly failed'}`, 'error');
    return false;
  }
  block.markError(null, null);
  block.loadedSource = source;
  block.dirty = false;
  machine.load(result.program);
  machineBlock = block;
  return true;
}

function needsLoad(block: BlockHandle): boolean {
  return (
    block.dirty ||
    machineBlock !== block ||
    machine === null ||
    !machine.loaded ||
    machine.phase === 'error'
  );
}


function doRun(block: BlockHandle): void {
  activeBlock = block;
  if (!machine) {
    setStatus('engines are still loading…', 'muted');
    return;
  }
  if (needsLoad(block)) {
    if (!assembleAndLoad(block)) return;
    setStatus(`loaded · ${machine.rows.length} instructions`, 'ok');
    renderPanel();
    return; // first click assembles and loads; a second click executes
  }
  if (machine.finished) machine.reset();
  setStatus('running…', 'busy');
  machine.run(RUN_BUDGET);
  afterExecution(block);
}

function doStep(block: BlockHandle): void {
  activeBlock = block;
  if (!machine) {
    setStatus('engines are still loading…', 'muted');
    return;
  }
  if (needsLoad(block)) {
    if (!assembleAndLoad(block)) return;
  }
  machine.step();
  afterExecution(block);
}

function afterExecution(block: BlockHandle): void {
  if (!machine) return;
  if (machine.phase === 'error') {
    const reason = machine.budgetExceeded
      ? `stopped · instruction budget of ${RUN_BUDGET.toLocaleString('en-US')} exceeded — is there an infinite loop?`
      : `error · ${machine.error ?? 'execution fault'}`;
    setStatus(reason, 'error');
  } else if (machine.finished) {
    const why =
      machine.exitCode !== null
        ? `finished · exit(${machine.exitCode}) · ${machine.totalInsns} insns`
        : `finished · ${machine.totalInsns} insns`;
    setStatus(why, 'ok');
  } else {
    setStatus(`paused · rip ${formatHex64(machine.rip)} · ${machine.totalInsns} insns`, 'accent');
  }
  block.showOutput(machine.outputText);
  if (machine.outputText.length > 0) block.setResults(machine.outputText);
  renderPanel();
}

function doReset(): void {
  for (const block of blocks) {
    block.markError(null, null);
    block.markCurrent(null);
    block.hideOutput();
    block.restoreResults();
  }
  if (machine && machine.loaded) {
    machine.reset();
    setStatus(`loaded · ${machine.rows.length} instructions`, 'ok');
  } else {
    setStatus(machine ? 'ready — not loaded' : 'engines are still loading…', machine ? 'ok' : 'muted');
  }
  renderPanel();
}

/**
 * "Reset code" restored a block's sample: re-assemble and load it so the
 * status chip and machine panel reflect the restored (error-free) source
 * instead of keeping a stale error state.
 */
function doResetCode(block: BlockHandle): void {
  activeBlock = block;
  if (!machine || !assembler) {
    setStatus('engines are still loading…', 'muted');
    return;
  }
  if (assembleAndLoad(block)) {
    setStatus(`loaded · ${machine.rows.length} instructions`, 'ok');
    renderPanel();
  }
}

function activate(block: BlockHandle): void {
  activeBlock = block;
  // The machine panel reflects the active block: if another block was loaded,
  // re-assemble this one (without executing) so registers/disassembly match.
  if (!machine || !assembler) return;
  if (machineBlock === block && !block.dirty) return;
  if (assembleAndLoad(block)) {
    setStatus(`loaded · ${machine.rows.length} instructions`, 'ok');
    renderPanel();
  }
}

runBtn.addEventListener('click', () => {
  if (activeBlock) doRun(activeBlock);
});
stepBtn.addEventListener('click', () => {
  if (activeBlock) doStep(activeBlock);
});
resetBtn.addEventListener('click', () => doReset());

// ---------------------------------------------------------------------------
// Panel rendering
// ---------------------------------------------------------------------------

function renderPanel(): void {
  const snap = machine ? machine.snapshot() : null;
  const changed = machine ? machine.changedSinceLastStep() : new Set<string>();

  for (const name of GPR_NAMES) {
    const cell = regCells.get(name);
    if (!cell || !snap) continue;
    const value = snap.gpr[name];
    cell.hex.textContent = formatHex64(value);
    cell.dec.textContent = formatDec64(value);
    cell.cell.classList.toggle('changed', changed.has(name));
  }
  const ripCell = regCells.get('rip');
  if (ripCell) {
    ripCell.hex.textContent = machine && machine.loaded ? formatHex64(snap!.rip) : formatHex64(0n);
    ripCell.dec.textContent = machine && machine.loaded ? 'pc' : 'not loaded';
    ripCell.cell.classList.toggle('changed', changed.has('rip'));
  }

  for (const flag of FLAG_DEFS) {
    const chip = flagEls.get(flag.name);
    if (!chip) continue;
    chip.classList.toggle('on', machine ? machine.isFlagSet(flag.bit) : false);
  }

  renderDisasm();
  renderMemory();
  outputEl.textContent = machine ? machine.outputText : '';

  const line = machine && machine.loaded ? machine.currentSourceLine() : null;
  if (machineBlock) machineBlock.markCurrent(line);
}

function renderDisasm(): void {
  if (!machine || machine.rows.length === 0) {
    disasmEl.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'run a block to populate the listing';
    disasmEl.appendChild(empty);
    return;
  }
  disasmEl.replaceChildren();
  const current = machine.currentRowIndex();
  for (let i = 0; i < machine.rows.length; i++) {
    const row = machine.rows[i];
    const div = document.createElement('div');
    div.className = 'drow' + (i === current ? ' current' : '');
    if (i === current) div.dataset.test = 'current-instr';
    const addr = document.createElement('span');
    addr.className = 'daddr';
    addr.textContent = '0x' + row.addr.toString(16).padStart(6, '0');
    const bytes = document.createElement('span');
    bytes.className = 'dbytes';
    bytes.textContent = Array.from(row.bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    const text = document.createElement('span');
    text.className = 'dtext';
    text.textContent = row.text;
    div.append(addr, bytes, text);
    disasmEl.appendChild(div);
    if (i === current) requestAnimationFrame(() => div.scrollIntoView({ block: 'nearest' }));
  }
}

function renderMemory(): void {
  memoryEl.replaceChildren();
  if (!machine) return;
  const view = machine.dataView();
  for (let base = 0; base < view.length; base += 16) {
    const row = document.createElement('div');
    row.className = 'mrow';
    const addr = document.createElement('span');
    addr.className = 'maddr';
    addr.textContent = '0x' + (DATA_BASE + base).toString(16);
    const hex = document.createElement('span');
    hex.className = 'mhex';
    hex.textContent = Array.from(view.slice(base, base + 16))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    const ascii = document.createElement('span');
    ascii.className = 'mascii';
    let text = '';
    for (let j = 0; j < 16 && base + j < view.length; j++) {
      const b = view[base + j];
      text += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
    }
    ascii.textContent = text;
    row.append(addr, hex, ascii);
    memoryEl.appendChild(row);
  }
}

// Zeroed panel before the first run (design.md: machine UI always renders).
setStatus('loading engines…', 'muted');
renderPanel();
