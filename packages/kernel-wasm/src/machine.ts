// machine.ts — the interpreter. One step() = one flat instruction, over an
// explicit operand stack, control stack and call stack you can watch in the
// panels. All i32 arithmetic wraps at 32 bits; div-by-zero, unreachable,
// out-of-bounds memory and the 1 000 000-instruction budget trap cleanly
// with the offending source line.

import type { FuncDef, Instr, Module } from './compile';
import { BUDGET, MAX_PAGES, PAGE_SIZE } from './compile';

/** A runtime fault: reported as `message (line N)`. */
class Trap extends Error {}

interface CtlFrame {
  kind: 'block' | 'loop' | 'if' | 'func';
  height: number;      // operand-stack height at entry
  labelArity: number;  // values a br to this label carries (loops: 0)
  startPc: number;     // loops: the pc of the loop marker (br target)
  endPc: number;       // pc of the matching end
  label: string | null;
}

export interface CallFrame {
  func: FuncDef;
  pc: number;               // index of the next instruction to run
  locals: number[];         // params then locals, int32 values
  localsDirty: boolean[];   // written since the last panel snapshot
  stackBase: number;        // operand-stack height when the call happened
  retLine: number | null;   // caller line execution resumes at
  ctl: CtlFrame[];          // control stack; [0] is the function frame
}

export class Machine {
  readonly module: Module;
  frames: CallFrame[] = [];
  valueStack: number[] = [];   // int32 values, bottom → top
  memory: Uint8Array;
  pages: number;
  globals: number[];
  globalsDirty: boolean[];
  output = '';
  steps = 0;
  error: string | null = null;
  finished = false;
  exitValue: number | null = null; // main's result, when it has one
  /** Byte range touched by the most recent store, for the memory panel. */
  lastWrite: { min: number; max: number } | null = null;

  private view: DataView;

  constructor(module: Module) {
    this.module = module;
    this.pages = module.memoryPages < 0 ? 0 : module.memoryPages;
    this.memory = new Uint8Array(this.pages * PAGE_SIZE);
    this.view = new DataView(this.memory.buffer);
    this.globals = module.globals.map((g) => g.init);
    this.globalsDirty = module.globals.map(() => false);
    this.frames = [this.makeFrame(module.funcs[module.mainIndex]!, [], null)];
  }

  private makeFrame(func: FuncDef, args: number[], retLine: number | null): CallFrame {
    const locals = args.slice(0, func.paramCount);
    while (locals.length < func.paramCount + func.localCount) locals.push(0);
    return {
      func,
      pc: 0,
      locals,
      // Params were set by the caller's call instruction — that step
      // created them, so they render `changed` until the next snapshot.
      localsDirty: locals.map((_, i) => i < func.paramCount),
      stackBase: this.valueStack.length,
      retLine,
      ctl: [{
        kind: 'func',
        height: this.valueStack.length,
        labelArity: func.resultArity,
        startPc: -1,
        endPc: func.code.length - 1,
        label: null,
      }],
    };
  }

  /** The line of the next instruction to run (for breakpoints, budget). */
  currentLine(): number | null {
    const f = this.frames[this.frames.length - 1];
    if (f === undefined) return null;
    return f.func.code[f.pc]?.line ?? null;
  }

  /** The function whose flat code the listing panel should show. */
  displayFunc(): FuncDef {
    const f = this.frames[this.frames.length - 1];
    return f === undefined ? this.module.funcs[this.module.mainIndex]! : f.func;
  }

  /** Execute exactly one instruction. */
  step(): void {
    if (this.finished || this.error !== null) return;
    const frame = this.frames[this.frames.length - 1]!;
    if (this.steps >= BUDGET) {
      this.error = `instruction budget exceeded (${BUDGET}) (line ${frame.func.code[frame.pc]?.line ?? frame.func.line})`;
      return;
    }
    const instr = frame.func.code[frame.pc]!;
    frame.pc++;
    this.steps++;
    try {
      this.execute(frame, instr, frame.pc - 1);
    } catch (e) {
      this.error = e instanceof Trap ? `${e.message} (line ${instr.line})` : `internal error: ${String(e)}`;
    }
  }

  private execute(frame: CallFrame, ins: Instr, ownPc: number): void {
    const push = (v: number): void => {
      this.valueStack.push(v | 0);
    };
    const pop = (): number => {
      const v = this.valueStack.pop();
      if (v === undefined) throw new Trap('operand stack is empty');
      return v;
    };
    const bin = (f: (a: number, b: number) => number): void => {
      const b = pop();
      const a = pop();
      push(f(a, b));
    };

    switch (ins.op) {
      case 'i32.const':
        push(ins.imm!);
        break;
      case 'i32.add': bin((a, b) => a + b); break;
      case 'i32.sub': bin((a, b) => a - b); break;
      case 'i32.mul': bin((a, b) => Math.imul(a, b)); break;
      case 'i32.div_s': {
        const b = pop();
        const a = pop();
        if (b === 0) throw new Trap('integer divide by zero');
        if (a === -2147483648 && b === -1) throw new Trap('integer overflow');
        push(Math.trunc(a / b));
        break;
      }
      case 'i32.div_u': {
        const b = pop();
        const a = pop();
        if (b === 0) throw new Trap('integer divide by zero');
        push(Math.floor((a >>> 0) / (b >>> 0)));
        break;
      }
      case 'i32.rem_s': {
        const b = pop();
        const a = pop();
        if (b === 0) throw new Trap('integer divide by zero');
        push(a % b);
        break;
      }
      case 'i32.rem_u': {
        const b = pop();
        const a = pop();
        if (b === 0) throw new Trap('integer divide by zero');
        push((a >>> 0) % (b >>> 0));
        break;
      }
      case 'i32.and': bin((a, b) => a & b); break;
      case 'i32.or': bin((a, b) => a | b); break;
      case 'i32.xor': bin((a, b) => a ^ b); break;
      case 'i32.shl': bin((a, b) => a << (b & 31)); break;
      case 'i32.shr_s': bin((a, b) => a >> (b & 31)); break;
      case 'i32.shr_u': bin((a, b) => (a >>> (b & 31)) | 0); break;
      case 'i32.eqz': push(pop() === 0 ? 1 : 0); break;
      case 'i32.eq': bin((a, b) => (a === b ? 1 : 0)); break;
      case 'i32.ne': bin((a, b) => (a !== b ? 1 : 0)); break;
      case 'i32.lt_s': bin((a, b) => (a < b ? 1 : 0)); break;
      case 'i32.lt_u': bin((a, b) => ((a >>> 0) < (b >>> 0) ? 1 : 0)); break;
      case 'i32.gt_s': bin((a, b) => (a > b ? 1 : 0)); break;
      case 'i32.gt_u': bin((a, b) => ((a >>> 0) > (b >>> 0) ? 1 : 0)); break;
      case 'i32.le_s': bin((a, b) => (a <= b ? 1 : 0)); break;
      case 'i32.le_u': bin((a, b) => ((a >>> 0) <= (b >>> 0) ? 1 : 0)); break;
      case 'i32.ge_s': bin((a, b) => (a >= b ? 1 : 0)); break;
      case 'i32.ge_u': bin((a, b) => ((a >>> 0) >= (b >>> 0) ? 1 : 0)); break;
      case 'drop':
        pop();
        break;
      case 'select': {
        const c = pop();
        const b = pop();
        const a = pop();
        push(c !== 0 ? a : b);
        break;
      }
      case 'nop':
        break;
      case 'unreachable':
        throw new Trap('unreachable executed');
      case 'local.get':
        push(frame.locals[ins.imm!]!);
        break;
      case 'local.set':
        frame.locals[ins.imm!] = pop();
        frame.localsDirty[ins.imm!] = true;
        break;
      case 'local.tee':
        frame.locals[ins.imm!] = this.valueStack[this.valueStack.length - 1]!;
        frame.localsDirty[ins.imm!] = true;
        break;
      case 'global.get':
        push(this.globals[ins.imm!]!);
        break;
      case 'global.set':
        this.globals[ins.imm!] = pop();
        this.globalsDirty[ins.imm!] = true;
        break;
      case 'i32.load':
      case 'i32.load8_s':
      case 'i32.load8_u':
      case 'i32.load16_s':
      case 'i32.load16_u': {
        const ea = this.effectiveAddress(pop(), ins);
        if (ins.op === 'i32.load') push(this.view.getInt32(ea, true));
        else if (ins.op === 'i32.load8_s') push(this.view.getInt8(ea));
        else if (ins.op === 'i32.load8_u') push(this.view.getUint8(ea));
        else if (ins.op === 'i32.load16_s') push(this.view.getInt16(ea, true));
        else push(this.view.getUint16(ea, true));
        break;
      }
      case 'i32.store':
      case 'i32.store8':
      case 'i32.store16': {
        const value = pop();
        const ea = this.effectiveAddress(pop(), ins);
        if (ins.op === 'i32.store') this.view.setInt32(ea, value, true);
        else if (ins.op === 'i32.store8') this.view.setUint8(ea, value & 0xff);
        else this.view.setUint16(ea, value & 0xffff, true);
        this.lastWrite = {
          min: ea,
          max: ea + (ins.op === 'i32.store' ? 4 : ins.op === 'i32.store16' ? 2 : 1) - 1,
        };
        break;
      }
      case 'memory.size':
        push(this.pages);
        break;
      case 'memory.grow': {
        const n = pop();
        if (n >= 0 && this.pages + n <= MAX_PAGES) {
          const grown = new Uint8Array((this.pages + n) * PAGE_SIZE);
          grown.set(this.memory);
          this.memory = grown;
          this.view = new DataView(grown.buffer);
          push(this.pages);
          this.pages += n;
        } else {
          push(-1);
        }
        break;
      }
      case 'block':
        frame.ctl.push({ kind: 'block', height: this.valueStack.length, labelArity: ins.arity!, startPc: -1, endPc: ins.match!, label: ins.label ?? null });
        break;
      case 'loop':
        frame.ctl.push({ kind: 'loop', height: this.valueStack.length, labelArity: 0, startPc: ownPc, endPc: ins.match!, label: ins.label ?? null });
        break;
      case 'if': {
        const cond = pop();
        frame.ctl.push({ kind: 'if', height: this.valueStack.length, labelArity: ins.arity!, startPc: -1, endPc: ins.match!, label: ins.label ?? null });
        if (cond === 0) frame.pc = ins.imm! + 1; // first instruction of the else branch
        break;
      }
      case 'else':
        frame.pc = ins.match!; // then-branch fell through: skip to the end
        break;
      case 'end':
        if (ins.funcKind === 'func') this.returnFromFrame();
        else frame.ctl.pop();
        break;
      case 'br':
        this.branch(ins.imm!);
        break;
      case 'br_if':
        if (pop() !== 0) this.branch(ins.imm!);
        break;
      case 'return':
        this.returnFromFrame();
        break;
      case 'call': {
        const callee = this.module.funcs[ins.imm!]!;
        if (callee.import) {
          this.hostCall(callee);
          break;
        }
        const args = this.valueStack.splice(this.valueStack.length - callee.paramCount, callee.paramCount);
        if (this.frames.length >= 10000) throw new Trap('call stack exhausted');
        const next = frame.func.code[frame.pc];
        this.frames.push(this.makeFrame(callee, args, next?.line ?? ins.line));
        break;
      }
      default:
        throw new Trap(`internal: no executor for ${ins.op}`);
    }
  }

  private hostCall(func: FuncDef): void {
    const v = this.valueStack.pop();
    if (v === undefined) throw new Trap('operand stack is empty');
    if (func.name === '$print') {
      this.output += `${v}\n`;
      return;
    }
    const cp = v >>> 0;
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      throw new Trap(`print_char: ${v} is not a valid code point`);
    }
    this.output += String.fromCodePoint(cp);
  }

  /** effective address + bounds check for a memory access. */
  private effectiveAddress(addr: number, ins: Instr): number {
    const ea = (addr >>> 0) + (ins.imm ?? 0);
    const size = ins.op.includes('store')
      ? (ins.op === 'i32.store' ? 4 : ins.op === 'i32.store16' ? 2 : 1)
      : (ins.op === 'i32.load' ? 4 : ins.op === 'i32.load16_s' || ins.op === 'i32.load16_u' ? 2 : 1);
    if (ea + size > this.memory.length) {
      throw new Trap(`out of bounds memory access: address ${ea} + ${size} bytes is past the end (${this.memory.length} bytes)`);
    }
    return ea;
  }

  /** Branch to the label `depth` levels out — loops repeat, blocks exit,
   *  the function label returns. */
  private branch(depth: number): void {
    const frame = this.frames[this.frames.length - 1]!;
    const idx = frame.ctl.length - 1 - depth;
    const target = frame.ctl[idx]!;
    if (target.kind === 'func') {
      this.returnFromFrame();
      return;
    }
    const carried: number[] = [];
    for (let i = 0; i < target.labelArity; i++) carried.push(this.valueStack.pop()!);
    this.valueStack.length = target.height;
    for (const v of carried) this.valueStack.push(v);
    if (target.kind === 'loop') {
      frame.ctl.length = idx; // the loop marker re-pushes its own frame
      frame.pc = target.startPc;
    } else {
      frame.ctl.length = idx + 1; // its end marker pops the frame
      frame.pc = target.endPc;
    }
  }

  private returnFromFrame(): void {
    const frame = this.frames.pop()!;
    const results: number[] = [];
    for (let i = 0; i < frame.ctl[0]!.labelArity; i++) results.push(this.valueStack.pop()!);
    this.valueStack.length = frame.stackBase;
    for (const v of results) this.valueStack.push(v);
    if (this.frames.length === 0) {
      this.finished = true;
      this.exitValue = results.length === 1 ? results[0]! : null;
    }
  }
}
