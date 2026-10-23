// The x86-64 machine: one Unicorn instance, program loading, exact
// single-stepping, run-to-end with an instruction budget, syscall
// interception, register/flag/memory snapshots and reset.
//
// Engine constraints verified against @alexaltea/unicorn-js@2.1.4 (wasm32):
//  - emu_start MUST be called with timeout=0 and count=0: a nonzero timeout
//    tries to spawn a timer thread ("qemu_thread_create: Not supported" →
//    abort) and count>0 crashes the module (RuntimeError in invoke_iijjii).
//  - until=0 makes emu_start return without executing anything (begin==until),
//    so we always pass an unreachable sentinel address instead.
//  - Single-stepping therefore uses a HOOK_CODE callback that stops emulation
//    just before the *second* instruction of the run — exactly one instruction
//    executes, whatever control flow it uses.
//  - All 64-bit register values are BigInt (WASM_BIGINT build); addresses in
//    JS stay below 2^53 so Number is safe for mem_* calls.

import { CODE_BASE, CODE_SIZE, DATA_BASE, DATA_SIZE, type AssembledProgram } from './asm';
import type { CapstoneDisassembler, UnicornInstance, UnicornModule } from './vendor';

const STACK_BASE = 0x7f0000000000;
const STACK_SIZE = 0x100000;
const STACK_INIT_RSP = 0x7f00000ff000;
/** Unreachable stop address handed to emu_start as `until` (must be non-zero). */
const RUN_SENTINEL = 0x600000000000;
const OUTPUT_LIMIT = 1 << 20;
const MEMORY_VIEW_BYTES = 256;

export const GPR_NAMES = [
  'rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
] as const;

export const FLAG_DEFS: ReadonlyArray<{ name: string; bit: bigint; title: string }> = [
  { name: 'ZF', bit: 1n << 6n, title: 'zero' },
  { name: 'CF', bit: 1n << 0n, title: 'carry' },
  { name: 'SF', bit: 1n << 7n, title: 'sign' },
  { name: 'OF', bit: 1n << 11n, title: 'overflow' },
  { name: 'PF', bit: 1n << 2n, title: 'parity' },
  { name: 'AF', bit: 1n << 4n, title: 'auxiliary carry' },
];

export interface Registers {
  gpr: Readonly<Record<string, bigint>>;
  rip: bigint;
  eflags: bigint;
}

export interface DisasmRow {
  addr: number;
  size: number;
  bytes: Uint8Array;
  text: string;
  line: number | null;
}

export type MachinePhase = 'empty' | 'loaded' | 'paused' | 'finished' | 'error';

export interface MachineEvents {
  onOutput?: (text: string) => void;
  onNote?: (text: string) => void;
}

function zeroRegs(): Registers {
  const gpr: Record<string, bigint> = {};
  for (const name of GPR_NAMES) gpr[name] = 0n;
  return { gpr, rip: 0n, eflags: 0n };
}

function toUnsigned64(v: bigint): bigint {
  return BigInt.asUintN(64, v);
}

export function formatHex64(v: bigint): string {
  return '0x' + toUnsigned64(v).toString(16).padStart(16, '0');
}

export function formatDec64(v: bigint): string {
  return BigInt.asIntN(64, v).toString(10);
}

/** Map unicorn errors to friendly teaching messages. */
function friendlyFault(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/UC_ERR_READ_UNMAPPED|code 6\b/.test(raw)) {
    return 'the program read memory that is not mapped — check your buffer pointers';
  }
  if (/UC_ERR_WRITE_UNMAPPED|code 7\b/.test(raw)) {
    return 'the program wrote to memory that is not mapped — is the destination inside .data or the stack?';
  }
  if (/UC_ERR_FETCH_UNMAPPED|code 8\b/.test(raw)) {
    return 'execution jumped outside the loaded code — check your jump and call targets';
  }
  if (/UC_ERR_INSN_INVALID|code 10\b/.test(raw)) {
    return 'the CPU hit an invalid instruction';
  }
  if (err instanceof Error && err.name === 'RuntimeError') {
    return 'the emulator hit an internal fault (often a wild jump into data). Press Reset, then Run again';
  }
  return raw.slice(0, 200);
}

export class Machine {
  phase: MachinePhase = 'empty';
  finished = false;
  exitCode: number | null = null;
  budgetExceeded = false;
  error: string | null = null;
  rows: DisasmRow[] = [];
  totalInsns = 0;
  outputText = '';

  private program: AssembledProgram | null = null;
  private uc: UnicornInstance | null = null;
  private initCtx: unknown = null;
  private regsBefore: Registers = zeroRegs();
  private regsNow: Registers = zeroRegs();
  private changed = new Set<string>();
  private decoder = new TextDecoder('utf-8');
  private outputBytes = 0;
  private stepMode = false;
  private stepArmed = false;
  private budgetLeft: number | null = null;
  private trapAddr: number | null = null;

  private readonly ucMod: UnicornModule;
  private readonly disasm: CapstoneDisassembler;
  private readonly events: MachineEvents;

  constructor(ucMod: UnicornModule, disasm: CapstoneDisassembler, events: MachineEvents = {}) {
    this.ucMod = ucMod;
    this.disasm = disasm;
    this.events = events;
  }

  get loaded(): boolean {
    return this.program !== null;
  }

  get rip(): bigint {
    return this.regsNow.rip;
  }

  get entry(): number {
    return this.program?.entry ?? CODE_BASE;
  }

  private reg(name: string): number {
    const table = this.ucMod as unknown as Record<string, unknown>;
    return table['X86_REG_' + name.toUpperCase()] as number;
  }

  private createInstance(): UnicornInstance {
    const uc = new this.ucMod.Unicorn(this.ucMod.ARCH_X86, this.ucMod.MODE_64);
    uc.mem_map(CODE_BASE, CODE_SIZE, this.ucMod.PROT_ALL);
    uc.mem_map(DATA_BASE, DATA_SIZE, this.ucMod.PROT_ALL);
    uc.mem_map(STACK_BASE, STACK_SIZE, this.ucMod.PROT_ALL);
    uc.hook_add(this.ucMod.HOOK_CODE, (_handle, addr) => this.onCodeHook(addr), {}, 1, 0);
    uc.hook_add(
      this.ucMod.HOOK_INSN,
      () => this.onSyscallHook(),
      {},
      1,
      0,
      this.ucMod.X86_INS_SYSCALL,
    );
    this.initCtx = uc.context_alloc();
    return uc;
  }

  private disposeInstance(): void {
    if (!this.uc) return;
    try {
      this.uc.close();
    } catch {
      // a crashed instance may refuse; drop it either way
    }
    this.uc = null;
    this.initCtx = null;
  }

  load(program: AssembledProgram): void {
    this.program = program;
    this.disposeInstance();
    this.uc = this.createInstance();
    // A `jmp $` trap follows the program: when Unicorn stops mid translation
    // block (e.g. from the syscall hook), the rest of the block still runs —
    // with zero padding that would decode as `add [rax], al` over unmapped
    // memory and crash the WASM. The trap keeps such tails harmless and turns
    // programs that run off the end into a clean stop.
    this.trapAddr = CODE_BASE + program.code.length;
    this.uc.mem_write(CODE_BASE, new Uint8Array(CODE_SIZE)); // clear stale bytes
    this.uc.mem_write(DATA_BASE, new Uint8Array(DATA_SIZE));
    this.uc.mem_write(CODE_BASE, this.buildImage());
    if (program.data.length > 0) this.uc.mem_write(DATA_BASE, program.data);
    for (const name of GPR_NAMES) this.uc.reg_write_i64(this.reg(name), 0n);
    this.uc.reg_write_i64(this.reg('eflags'), 0x202n);
    this.uc.reg_write_i64(this.reg('rsp'), BigInt(STACK_INIT_RSP));
    this.uc.reg_write_i64(this.reg('rip'), BigInt(program.entry));
    this.uc.context_save(this.initCtx);
    this.rows = this.buildRows(program);
    this.resetDynamicState();
    this.phase = 'loaded';
    this.regsBefore = this.readRegs();
    this.regsNow = this.readRegs();
    this.changed.clear();
  }

  private buildImage(): Uint8Array {
    const code = this.program?.code ?? new Uint8Array(0);
    const image = new Uint8Array(code.length + 2);
    image.set(code, 0);
    image[image.length - 2] = 0xeb; // jmp $
    image[image.length - 1] = 0xfe;
    return image;
  }

  private resetDynamicState(): void {
    this.finished = false;
    this.exitCode = null;
    this.budgetExceeded = false;
    this.error = null;
    this.totalInsns = 0;
    this.outputText = '';
    this.outputBytes = 0;
    this.decoder = new TextDecoder('utf-8');
  }

  reset(): void {
    if (!this.program) return;
    if (!this.uc) {
      // previous fatal fault: rebuild from the stored program image
      this.load(this.program);
      return;
    }
    this.uc.context_restore(this.initCtx);
    this.uc.mem_write(CODE_BASE, this.buildImage());
    this.uc.mem_write(DATA_BASE, new Uint8Array(DATA_SIZE));
    if (this.program.data.length > 0) this.uc.mem_write(DATA_BASE, this.program.data);
    this.resetDynamicState();
    this.phase = 'loaded';
    this.regsBefore = this.readRegs();
    this.regsNow = this.readRegs();
    this.changed.clear();
  }

  /** Execute exactly one instruction. */
  step(): void {
    if (!this.uc || !this.program) return;
    if (this.phase === 'error') return;
    if (this.finished) {
      this.events.onNote?.('the program has already exited — press ⟲ Reset to run it again');
      return;
    }
    this.regsBefore = this.readRegs();
    this.stepMode = true;
    this.stepArmed = false;
    this.invoke(() =>
      this.uc!.emu_start(Number(this.regsBefore.rip), RUN_SENTINEL, 0, 0),
    );
    this.stepMode = false;
    this.afterRun(this.finished ? 'finished' : 'paused');
  }

  /** Execute until the program exits or the instruction budget runs out. */
  run(budget: number): void {
    if (!this.uc || !this.program) return;
    if (this.phase === 'error') return;
    if (this.finished) {
      this.events.onNote?.('the program has already exited — press ⟲ Reset to run it again');
      return;
    }
    this.regsBefore = this.readRegs();
    this.budgetLeft = budget;
    this.invoke(() => this.uc!.emu_start(Number(this.regsBefore.rip), RUN_SENTINEL, 0, 0));
    this.budgetLeft = null;
    if (this.budgetExceeded) {
      this.phase = 'error';
      this.afterRun('error');
    } else {
      this.afterRun(this.finished ? 'finished' : 'paused');
    }
  }

  private invoke(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.error = friendlyFault(e);
      this.phase = 'error';
      if (e instanceof Error && e.name === 'RuntimeError') this.disposeInstance();
    }
  }


  private afterRun(next: MachinePhase): void {
    this.regsNow = this.readRegs();
    this.changed.clear();
    for (const name of GPR_NAMES) {
      if (this.regsNow.gpr[name] !== this.regsBefore.gpr[name]) this.changed.add(name);
    }
    if (this.regsNow.rip !== this.regsBefore.rip) this.changed.add('rip');
    if (!this.finished && this.outsideCode(this.regsNow.rip)) {
      this.finished = true;
      this.exitCode = null;
      this.events.onNote?.('execution left the loaded code region — treating the program as finished');
    }
    if (this.phase !== 'error') this.phase = next;
  }

  private outsideCode(rip: bigint): boolean {
    if (!this.program) return true;
    const r = Number(rip);
    return r < CODE_BASE || r >= CODE_BASE + this.program.code.length;
  }

  private onCodeHook(addr?: bigint): void {
    const uc = this.uc;
    if (!uc) return;
    try {
      const at = addr !== undefined ? Number(addr) : -1;
      if (!this.finished && this.trapAddr !== null && at === this.trapAddr) {
        this.finished = true;
        this.events.onNote?.('execution ran past the last instruction (no exit syscall) — stopped');
        uc.emu_stop();
        return;
      }
      if (this.stepMode) {
        if (this.stepArmed) {
          // Second hook hit of the run: stop BEFORE this instruction executes,
          // so it is only peeked at and must not be counted.
          uc.emu_stop();
          return;
        }
        this.stepArmed = true;
      } else if (this.budgetLeft !== null && --this.budgetLeft < 0) {
        this.budgetExceeded = true;
        uc.emu_stop();
        return;
      }
      this.totalInsns++;
    } catch {
      try {
        uc.emu_stop();
      } catch {
        // emulation is unwinding anyway
      }
    }
  }

  private onSyscallHook(): void {
    const uc = this.uc;
    if (!uc) return;
    try {
      const nr = uc.reg_read_i64(this.reg('rax'));
      if (nr === 1n || nr === 2n) {
        // write(fd, buf, count) — stdout/stderr both go to the console
        const buf = uc.reg_read_i64(this.reg('rsi'));
        const len = uc.reg_read_i64(this.reg('rdx'));
        let n = Number(len);
        if (n < 0) n = 0;
        if (n > OUTPUT_LIMIT) n = OUTPUT_LIMIT;
        let bytes: Uint8Array | null = null;
        if (n > 0) {
          try {
            bytes = uc.mem_read(Number(buf), n);
          } catch {
            this.events.onNote?.(
              `write() pointed at unmapped memory (rsi=${formatHex64(buf)}) — nothing written`,
            );
          }
        }
        if (bytes) {
          const chunk = this.decoder.decode(bytes, { stream: true });
          this.outputText += chunk;
          this.outputBytes += bytes.length;
          if (this.outputBytes >= OUTPUT_LIMIT) {
            this.events.onNote?.('output truncated at 1 MiB');
          }
          this.events.onOutput?.(chunk);
        }
        uc.reg_write_i64(this.reg('rax'), BigInt(n));
      } else if (nr === 60n || nr === 231n) {
        // exit / exit_group
        this.finished = true;
        this.exitCode = Number(BigInt.asUintN(8, uc.reg_read_i64(this.reg('rdi'))));
        uc.emu_stop();
      } else {
        uc.reg_write_i64(this.reg('rax'), -38n); // -ENOSYS
        this.events.onNote?.(`syscall ${nr} is not implemented here — rax set to -ENOSYS (-38)`);
      }
    } catch (e) {
      this.error = friendlyFault(e);
      this.phase = 'error';
      try {
        uc.emu_stop();
      } catch {
        // unwinding
      }
    }
  }

  private readRegs(): Registers {
    if (!this.uc) return zeroRegs();
    const gpr: Record<string, bigint> = {};
    for (const name of GPR_NAMES) gpr[name] = this.uc.reg_read_i64(this.reg(name));
    return {
      gpr,
      rip: this.uc.reg_read_i64(this.reg('rip')),
      eflags: this.uc.reg_read_i64(this.reg('eflags')),
    };
  }

  snapshot(): Registers {
    return this.loaded ? this.regsNow : zeroRegs();
  }

  changedSinceLastStep(): ReadonlySet<string> {
    return this.changed;
  }

  isFlagSet(bit: bigint): boolean {
    // Read EFLAGS live from the instance on every call: the snapshot taken in
    // afterRun can briefly lag the emulated CPU when Unicorn materializes
    // lazy eflags late after a hook stop (stale-flag glitch D4).
    const raw = this.uc ? this.uc.reg_read_i64(this.reg('eflags')) : this.regsNow.eflags;
    return (toUnsigned64(raw) & bit) !== 0n;
  }

  currentRowIndex(): number {
    const rip = Number(this.regsNow.rip);
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (rip >= r.addr && rip < r.addr + r.size) return i;
    }
    return -1;
  }

  currentSourceLine(): number | null {
    const rip = Number(this.regsNow.rip);
    for (const cl of this.program?.sourceLines ?? []) {
      if (rip >= cl.addr && rip < cl.addr + cl.size) return cl.line;
    }
    return null;
  }

  dataView(): Uint8Array {
    if (!this.uc) return new Uint8Array(MEMORY_VIEW_BYTES);
    try {
      return this.uc.mem_read(DATA_BASE, MEMORY_VIEW_BYTES);
    } catch {
      return new Uint8Array(MEMORY_VIEW_BYTES);
    }
  }

  private buildRows(program: AssembledProgram): DisasmRow[] {
    const byAddr = new Map<number, number>();
    for (const cl of program.sourceLines) byAddr.set(cl.addr, cl.line);
    try {
      const insns = this.disasm.disasm(program.code, CODE_BASE);
      return insns.map((i) => ({
        addr: Number(i.address),
        size: i.size,
        bytes: i.bytes,
        text: (i.mnemonic + (i.op_str ? ' ' + i.op_str : '')).trimEnd(),
        line: byAddr.get(Number(i.address)) ?? null,
      }));
    } catch {
      // Capstone refuses the whole buffer on any bad byte; fall back to the
      // statements we assembled ourselves.
      return program.sourceLines
        .filter((cl) => cl.size > 0 && cl.addr >= CODE_BASE && cl.addr < CODE_BASE + program.code.length)
        .map((cl) => ({
          addr: cl.addr,
          size: cl.size,
          bytes: program.code.slice(cl.addr - CODE_BASE, cl.addr - CODE_BASE + cl.size),
          text: cl.text,
          line: cl.line,
        }));
    }
  }

  dispose(): void {
    this.disposeInstance();
    try {
      this.disasm.close();
    } catch {
      // already closed
    }
  }
}
