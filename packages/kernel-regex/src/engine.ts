// engine.ts — the state-set simulation. Instead of guessing one path
// and backtracking, the engine keeps the SET of every state reachable
// so far and moves the whole set one character at a time:
//
//   step  = consume one character, then take the epsilon-closure.
//
// Capture tables travel with the states: crossing a group-open marker
// writes the current position into the table, crossing the close writes
// the end. When two paths reach the same state with different tables,
// `better` picks the winner deterministically (a closed span beats an
// open one, a longer closed span beats a shorter one, ties prefer the
// earlier start) — the same last-iteration answer a greedy backtracker
// gives, without ever backtracking.
//
// Matching is POSIX-flavored leftmost-longest: start offsets are tried
// in order, and each attempt reports the furthest end ever seen. The
// engine is resumable one character at a time; `settle` does all the
// zero-character bookkeeping (dead attempts, finished lines) so `step`
// is exactly one character consumption.

import type { Nfa, NfaState } from './nfa';

/** One test input: its decoded text and 1-based source line. */
export interface InputLine {
  text: string;
  line: number;
}

/** The verdict for one completed input line. groups[i - 1] is group i. */
export interface LineResult {
  input: string;
  line: number;
  matched: boolean;
  start: number;
  end: number;
  groups: Array<[number, number] | null>;
}

/** Capture spans: start[g]/end[g] for g in 1..groups.
 *  start < 0: never opened. start ≥ 0, end < 0: open at start. */
export interface Table {
  start: number[];
  end: number[];
}

export const MAX_CHAR_STEPS = 100_000;
export const MAX_CLOSURE_VISITS = 5_000_000;

/** Internal unwind for the closure budget (never leaves the engine). */
class BudgetStop extends Error {}

type SettleStatus = 'ready' | 'finished' | 'paused' | 'error';

export function emptyTable(groups: number): Table {
  return { start: new Array<number>(groups + 1).fill(-1), end: new Array<number>(groups + 1).fill(-1) };
}

function cloneTable(t: Table): Table {
  return { start: [...t.start], end: [...t.end] };
}

function tableEq(a: Table, b: Table): boolean {
  for (let g = 1; g < a.start.length; g += 1) {
    if (a.start[g] !== b.start[g] || a.end[g] !== b.end[g]) return false;
  }
  return true;
}

function withStart(t: Table, g: number, p: number): Table {
  const next = cloneTable(t);
  next.start[g] = p;
  next.end[g] = -1; // reopening forgets the previous close
  return next;
}

function withEnd(t: Table, g: number, p: number): Table {
  const next = cloneTable(t);
  next.end[g] = p;
  return next;
}

/** The merge rule when paths collide at a state; see the header. */
function better(a: Table, b: Table): Table {
  for (let g = 1; g < a.start.length; g += 1) {
    const as = a.start[g];
    const ae = a.end[g];
    const bs = b.start[g];
    const be = b.end[g];
    // rank: closed (2) > open (1) > never-opened (0)
    const ra = ae >= 0 ? 2 : as >= 0 ? 1 : 0;
    const rb = be >= 0 ? 2 : bs >= 0 ? 1 : 0;
    if (ra !== rb) return ra > rb ? a : b;
    if (ra === 0) continue;
    if (ra === 1) {
      if (as !== bs) return as < bs ? a : b;
      continue;
    }
    if (ae !== be) return ae > be ? a : b;
    if (as !== bs) return as < bs ? a : b;
  }
  return a;
}

function spansOf(t: Table): Array<[number, number] | null> {
  const spans: Array<[number, number] | null> = [];
  for (let g = 1; g < t.start.length; g += 1) {
    spans.push(t.start[g]! >= 0 && t.end[g]! >= 0 ? [t.start[g]!, t.end[g]!] : null);
  }
  return spans;
}

export class RegexEngine {
  steps = 0;
  error: string | null = null;
  finished = false;
  /** Index into inputs of the line being worked on. */
  lineIdx = 0;
  /** Absolute position within the current line. */
  pos = 0;
  /** Start offset of the current match attempt. */
  offset = 0;
  /** Live states after the latest closure. A completed attempt stays
   *  frozen here for display until the next attempt initializes. */
  set: Map<number, Table> | null = null;
  /** Position the current/frozen set was closed at — markers in the
   *  set render their spans against this, not the live pos. */
  setPos = 0;
  /** The furthest match end seen in the current attempt. */
  best: { end: number; table: Table } | null = null;
  /** False until the current line consumes its first character. */
  lineStarted = false;
  /** Source line of the last breakpoint pause (re-pause guard). */
  pausedLine: number | null = null;
  /** True when the current attempt still needs its initial closure. */
  private needInit = true;
  readonly results: LineResult[] = [];
  /** State ids displayed by the previous step — drives `current` marks. */
  prevVisible = new Set<number>();

  private visits = 0;

  constructor(
    private readonly nfa: Nfa,
    readonly inputs: InputLine[],
  ) {}

  private empty(): Table {
    return emptyTable(this.nfa.groups);
  }

  /**
   * Run the zero-character bookkeeping until the engine is ready to
   * consume, finished, paused at a breakpoint (`isBp` says which source
   * lines pause), or carrying an error. Never consumes.
   */
  settle(isBp: (line: number) => boolean): SettleStatus {
    if (this.error !== null) return 'error';
    try {
      for (;;) {
        if (this.lineIdx >= this.inputs.length) {
          this.finished = true;
          return 'finished';
        }
        const inp = this.inputs[this.lineIdx]!;
        if (!this.lineStarted && this.pausedLine !== inp.line && isBp(inp.line)) {
          this.pausedLine = inp.line;
          return 'paused';
        }
        if (this.needInit) {
          if (this.offset > inp.text.length) {
            this.recordResult(false, 0, 0, null);
            this.advanceLine();
            continue;
          }
          this.pos = this.offset;
          this.best = null;
          this.set = this.closure([[this.nfa.start, this.empty()]], this.pos, inp.text.length);
          this.setPos = this.pos;
          this.needInit = false;
          // Everything is "new" at a fresh attempt.
          this.prevVisible = new Set();
          const acc = this.set.get(this.nfa.accept);
          if (acc !== undefined) this.best = { end: this.pos, table: acc };
        }
        const canConsume = this.pos < inp.text.length && this.hasConsumer();
        if (!canConsume) {
          if (this.best !== null) {
            this.recordResult(true, this.offset, this.best.end, this.best.table);
            this.advanceLine();
          } else {
            this.offset += 1;
            this.needInit = true;
          }
          continue;
        }
        return 'ready';
      }
    } catch (e) {
      if (e instanceof BudgetStop) return 'error';
      throw e;
    }
  }

  /** Consume exactly one character of the current line and take the
   *  epsilon-closure that follows. The caller ensured 'ready'. */
  consume(): void {
    const inp = this.inputs[this.lineIdx]!;
    this.prevVisible = new Set(this.visibleIds());
    const seeds: Array<[number, Table]> = [];
    const ch = inp.text[this.pos]!;
    for (const [id, table] of this.set!) {
      if (this.matches(this.nfa.states[id]!, ch)) seeds.push([this.nfa.states[id]!.outs[0]!, table]);
    }
    this.pos += 1;
    this.lineStarted = true;
    this.steps += 1;
    if (this.steps > MAX_CHAR_STEPS) {
      this.error = `run budget exceeded: ${MAX_CHAR_STEPS} char-steps (line ${inp.line})`;
      this.set = new Map();
      return;
    }
    this.set = this.closure(seeds, this.pos, inp.text.length);
    this.setPos = this.pos;
    if (this.error !== null) return;
    const acc = this.set.get(this.nfa.accept);
    if (acc !== undefined) this.best = { end: this.pos, table: acc };
  }

  /** Displayed (non-split) states of the current set, ascending. */
  visibleIds(): number[] {
    if (this.set === null) return [];
    const ids: number[] = [];
    for (const id of this.set.keys()) {
      if (this.nfa.states[id]!.kind !== 'split') ids.push(id);
    }
    return ids.sort((a, b) => a - b);
  }

  /** The table the Captures panel shows: the live merged table while an
   *  attempt runs; after the run, the last reported match's spans. */
  displayTable(): Table {
    if (this.set !== null) {
      let acc = this.empty();
      for (const table of this.set.values()) acc = better(acc, table);
      return acc;
    }
    if (this.finished && this.results.length > 0) {
      const last = this.results[this.results.length - 1]!;
      if (last.matched) {
        const table = this.empty();
        for (let g = 1; g <= last.groups.length; g += 1) {
          const span = last.groups[g - 1];
          if (span !== null) {
            table.start[g] = span[0];
            table.end[g] = span[1];
          }
        }
        return table;
      }
    }
    return this.empty();
  }

  /** Text of the line being worked on (the last one once finished). */
  currentText(): string {
    const idx = Math.min(this.lineIdx, this.inputs.length - 1);
    return idx >= 0 ? this.inputs[idx]!.text : '';
  }

  private advanceLine(): void {
    this.lineIdx += 1;
    this.pos = 0;
    this.offset = 0;
    // The completed attempt's set stays frozen for display until the
    // next attempt's initial closure replaces it.
    this.best = null;
    this.lineStarted = false;
    this.needInit = true;
  }

  private recordResult(matched: boolean, start: number, end: number, table: Table | null): void {
    const inp = this.inputs[this.lineIdx]!;
    this.results.push({
      input: inp.text,
      line: inp.line,
      matched,
      start,
      end,
      groups: table === null ? [] : spansOf(table),
    });
  }

  private hasConsumer(): boolean {
    for (const id of this.set!.keys()) {
      const kind = this.nfa.states[id]!.kind;
      if (kind === 'char' || kind === 'any' || kind === 'class') return true;
    }
    return false;
  }

  private matches(st: NfaState, ch: string): boolean {
    switch (st.kind) {
      case 'char':
        return st.ch === ch;
      case 'any':
        return ch !== '\n';
      case 'class': {
        let inSet = false;
        for (const { lo, hi } of st.cls!.items) {
          if (ch >= lo && ch <= hi) {
            inSet = true;
            break;
          }
        }
        return st.cls!.negated ? !inSet : inSet;
      }
      default:
        return false;
    }
  }

  /**
   * Epsilon-closure with capture tables. Failing anchors are dropped
   * (their path is dead); crossed markers/anchors stay in the set for
   * display while their continuations are followed. Re-visiting a state
   * with a table that loses the merge is a no-op, so the worklist
   * terminates; the global visit budget is the belt-and-braces bound.
   */
  private closure(seeds: Array<[number, Table]>, pos: number, len: number): Map<number, Table> {
    const visited = new Map<number, Table>();
    const stack: Array<[number, Table]> = [...seeds];
    while (stack.length > 0) {
      const [id, incoming] = stack.pop()!;
      this.visits += 1;
      if (this.visits > MAX_CLOSURE_VISITS) {
        this.error = `run budget exceeded: ${MAX_CLOSURE_VISITS} state visits (line ${this.inputs[this.lineIdx]!.line})`;
        throw new BudgetStop();
      }
      const st = this.nfa.states[id]!;
      if (st.kind === 'anchor') {
        const holds = st.which === '^' ? pos === 0 : pos === len;
        if (!holds) continue; // dead path: not even displayed
      }
      const existing = visited.get(id);
      let table = incoming;
      if (existing !== undefined) {
        if (tableEq(existing, incoming)) continue;
        table = better(existing, incoming);
        if (tableEq(table, existing)) continue; // lost the merge
        visited.set(id, table); // improved: propagate again
      } else {
        visited.set(id, incoming);
      }
      switch (st.kind) {
        case 'split':
          for (const out of st.outs) if (out >= 0) stack.push([out, table]);
          break;
        case 'anchor':
          stack.push([st.outs[0]!, table]);
          break;
        case 'groupOpen':
          stack.push([st.outs[0]!, withStart(table, st.group!, pos)]);
          break;
        case 'groupClose':
          stack.push([st.outs[0]!, withEnd(table, st.group!, pos)]);
          break;
        default:
          break; // char/any/class/accept wait for input
      }
    }
    return visited;
  }
}
