// nfa.ts — Thompson construction: AST → states and arrows. Every
// consuming atom becomes one state; alternation and quantifiers become
// split states (epsilon, both ways at once); capturing groups get
// zero-width open/close marker states; the whole pattern ends in one
// ACCEPT state. {n,m} quantifiers are expanded into literal copies of
// the sub-pattern, so a{2,3} is a a a? in machine form. The machine is
// capped at MAX_STATES — a{100000} is refused at load, not compiled.

import { RegexError, type Pattern, type PatternNode } from './pattern';

export type NfaStateKind =
  | 'char'
  | 'any'
  | 'class'
  | 'anchor'
  | 'split'
  | 'groupOpen'
  | 'groupClose'
  | 'accept';

export interface NfaClass {
  negated: boolean;
  items: { lo: string; hi: string }[];
  src: string;
}

export interface NfaState {
  kind: NfaStateKind;
  /** char: the literal character. */
  ch?: string;
  /** anchor: '^' | '$'. */
  which?: '^' | '$';
  /** groupOpen/groupClose: the group number. */
  group?: number;
  /** class: its members. */
  cls?: NfaClass;
  /** Out-edges; split has two, everything else one. */
  outs: number[];
}

export interface Nfa {
  states: NfaState[];
  start: number;
  accept: number;
  groups: number;
}

export const MAX_STATES = 4096;

/** A partially-built machine: its entry state plus the dangling out
 *  slots (holes) that must be connected to whatever comes next. */
interface Frag {
  start: number;
  holes: Array<[id: number, outIdx: number]>;
}

class Compiler {
  readonly states: NfaState[] = [];

  constructor(private readonly line: number) {}

  push(state: Omit<NfaState, 'outs'>, outCount: number): number {
    if (this.states.length >= MAX_STATES) {
      throw new RegexError(
        `pattern is too large: it expands past ${MAX_STATES} NFA states — reduce the {n,m} counts`,
        this.line,
      );
    }
    const outs = new Array<number>(outCount).fill(-1);
    this.states.push({ ...state, outs });
    return this.states.length - 1;
  }

  patch(frag: Frag, target: number): void {
    for (const [id, outIdx] of frag.holes) this.states[id]!.outs[outIdx] = target;
  }

  epsilon(): Frag {
    // A split with one out is a plain epsilon jump (used for the empty
    // pattern, empty branches, and {0}).
    const id = this.push({ kind: 'split' }, 1);
    return { start: id, holes: [[id, 0]] };
  }

  chain(frags: Frag[]): Frag {
    if (frags.length === 0) return this.epsilon();
    let frag = frags[0]!;
    for (let i = 1; i < frags.length; i += 1) {
      const next = frags[i]!;
      this.patch(frag, next.start);
      frag = { start: frag.start, holes: next.holes };
    }
    return frag;
  }

  compile(node: PatternNode): Frag {
    switch (node.kind) {
      case 'char': {
        const id = this.push({ kind: 'char', ch: node.ch }, 1);
        return { start: id, holes: [[id, 0]] };
      }
      case 'any': {
        const id = this.push({ kind: 'any' }, 1);
        return { start: id, holes: [[id, 0]] };
      }
      case 'class': {
        const id = this.push({ kind: 'class', cls: { negated: node.negated, items: node.items, src: node.src } }, 1);
        return { start: id, holes: [[id, 0]] };
      }
      case 'anchor': {
        const id = this.push({ kind: 'anchor', which: node.which }, 1);
        return { start: id, holes: [[id, 0]] };
      }
      case 'group': {
        if (node.index === null) return this.compile(node.body);
        const open = this.push({ kind: 'groupOpen', group: node.index }, 1);
        const body = this.compile(node.body);
        const close = this.push({ kind: 'groupClose', group: node.index }, 1);
        this.patch({ start: open, holes: [[open, 0]] }, body.start);
        this.patch(body, close);
        return { start: open, holes: [[close, 0]] };
      }
      case 'alt': {
        const branches = node.branches.map((b) => this.compile(b));
        if (branches.length === 1) return branches[0]!;
        // split_0 → (branch_0 | split_1), …, split_last → (branch_last-1 | branch_last)
        const splits: number[] = [];
        for (let i = 0; i + 1 < branches.length; i += 1) {
          splits.push(this.push({ kind: 'split' }, 2));
        }
        const last = branches.length - 1;
        for (let i = 0; i < splits.length; i += 1) {
          this.states[splits[i]!]!.outs[0] = branches[i]!.start;
          this.states[splits[i]!]!.outs[1] = i + 1 < splits.length ? splits[i + 1]! : branches[last]!.start;
        }
        const holes = branches.flatMap((b) => b.holes);
        return { start: splits[0]!, holes };
      }
      case 'concat': {
        return this.chain(node.parts.map((p) => this.compile(p)));
      }
      case 'repeat': {
        return this.compileRepeat(node.min, node.max, node.body);
      }
    }
  }

  private compileRepeat(min: number, max: number, body: PatternNode): Frag {
    const copies: Frag[] = [];
    for (let i = 0; i < min; i += 1) copies.push(this.compile(body));
    if (max === Infinity) {
      // min mandatory copies, then a loop: L → (body | exit), body → L.
      const loop = this.push({ kind: 'split' }, 2);
      const loopBody = this.compile(body);
      this.states[loop]!.outs[0] = loopBody.start;
      this.patch(loopBody, loop);
      const tail: Frag = { start: loop, holes: [[loop, 1]] };
      return this.chain([...copies, tail]);
    }
    // max - min optional copies: opt_i → (body_i | opt_{i+1}), body_i → opt_{i+1}.
    const optionalCount = max - min;
    const optional: number[] = [];
    for (let i = 0; i < optionalCount; i += 1) optional.push(this.push({ kind: 'split' }, 2));
    const holes: Array<[number, number]> = [];
    for (let i = 0; i < optionalCount; i += 1) {
      const next = i + 1 < optionalCount ? optional[i + 1]! : -1;
      this.states[optional[i]!]!.outs[1] = next; // the skip edge
      const bodyFrag = this.compile(body);
      this.states[optional[i]!]!.outs[0] = bodyFrag.start;
      if (next === -1) holes.push(...bodyFrag.holes, [optional[i]!, 1]);
      else this.patch(bodyFrag, next);
    }
    const tail: Frag = optionalCount === 0
      ? { start: -1, holes: [] }
      : { start: optional[0]!, holes };
    if (optionalCount === 0) return this.chain(copies);
    if (copies.length === 0) return tail;
    return this.chain([...copies, tail]);
  }
}

/** Compile a parsed pattern into its Thompson NFA. */
export function compilePattern(pattern: Pattern, line: number): Nfa {
  const c = new Compiler(line);
  const frag = c.compile(pattern.root);
  const accept = c.push({ kind: 'accept' }, 0);
  c.patch(frag, accept);
  return { states: c.states, start: frag.start, accept, groups: pattern.groups };
}
