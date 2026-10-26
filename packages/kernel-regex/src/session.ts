// session.ts — the Kernel/Session contract over the NFA engine.
// Panels tell the under-the-hood story the lesson teaches:
//   The machine — the whole compiled Thompson NFA, one row per state,
//                 edges as → targets; live states highlighted.
//   NFA states  — the current state set, each state rendered as its
//                 meaning; states that arrived with the latest
//                 character are highlighted.
//   Input       — one row per test line: caret position, and the match
//                 bracketed once the line is done.
//   Captures    — per group: none / open at p / [a,b), changed marks.
//   console     — one verdict per input line.

import { parseBlock } from './block';
import { RegexEngine, type Table } from './engine';
import { compilePattern, type Nfa, type NfaState } from './nfa';
import { RegexError, parsePattern } from './pattern';
import type { Field, ListingRow, LoadResult, Panel, RunResult, Session } from './types';

/** Verdict text for one completed line. */
export function renderVerdict(r: { matched: boolean; start: number; end: number; groups: Array<[number, number] | null> }): string {
  if (!r.matched) return 'no match';
  let text = `match [${r.start},${r.end})`;
  if (r.groups.length > 0) {
    const parts = r.groups.map((span, i) =>
      span === null ? `${i + 1}=none` : `${i + 1}=[${span[0]},${span[1]})`);
    text += ` groups: ${parts.join(' ')}`;
  }
  return text;
}

const DISPLAY_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\t': '\\t',
  '\r': '\\r',
  '\f': '\\f',
  '\v': '\\v',
  '\\': '\\\\',
};

/** Make an input (slice) visible: escapes for untypeable characters. */
export function encodeText(s: string): string {
  let out = '';
  for (const ch of s) out += DISPLAY_ESCAPES[ch] ?? ch;
  return out;
}

function quoteChar(ch: string): string {
  return `'${DISPLAY_ESCAPES[ch] ?? ch}'`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export class RegexSession implements Session {
  private engine: RegexEngine | null = null;
  private nfa: Nfa | null = null;
  /** Capture display the `changed` flags diff against. */
  private prevCaptures = new Map<string, string>();

  async load(src: string): Promise<LoadResult> {
    const block = parseBlock(src);
    if (!block.ok) return { ok: false, line: block.line, message: block.message };
    try {
      const pattern = parsePattern(block.pattern, block.patternLine);
      const nfa = compilePattern(pattern, block.patternLine);
      this.engine = new RegexEngine(nfa, block.inputs);
      this.nfa = nfa;
      this.prevCaptures = new Map();
      return {
        ok: true,
        summary: `loaded · ${block.patternText} · ${plural(nfa.states.length, 'state')} · ${plural(nfa.groups, 'group')} · ${plural(block.inputs.length, 'input')}`,
      };
    } catch (e) {
      if (e instanceof RegexError) return { ok: false, line: e.line, message: e.message };
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async run(breakpoints?: number[]): Promise<RunResult> {
    const eng = this.engine;
    if (eng === null) return { finished: false, steps: 0, error: 'nothing is loaded' };
    if (eng.error !== null) return { finished: false, steps: eng.steps, error: eng.error };
    this.snapshotCaptures();
    const bps = breakpoints !== undefined ? new Set(breakpoints) : null;
    for (;;) {
      const status = eng.settle((line) => bps?.has(line) ?? false);
      if (status === 'ready') {
        eng.consume();
        if (eng.error !== null) return { finished: false, steps: eng.steps, error: eng.error };
        continue;
      }
      return this.resultOf(status);
    }
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    const eng = this.engine;
    if (eng === null) return { ran: false, result: { finished: false, steps: 0, error: 'nothing is loaded' } };
    if (eng.error !== null) return { ran: false, result: { finished: false, steps: eng.steps, error: eng.error } };
    this.snapshotCaptures();
    let status = eng.settle(() => false);
    if (status !== 'ready') return { ran: false, result: this.resultOf(status) };
    eng.consume();
    if (eng.error !== null) return { ran: true, result: { finished: false, steps: eng.steps, error: eng.error } };
    // Resolve line completion so the press that consumes the last
    // character also reports the verdict and `finished`.
    status = eng.settle(() => false);
    return { ran: true, result: this.resultOf(status) };
  }

  reset(): void {
    if (this.engine === null || this.nfa === null) return;
    this.engine = new RegexEngine(this.nfa, this.engine.inputs);
    this.prevCaptures = new Map();
  }

  state(): Panel[] {
    const eng = this.engine;
    if (eng === null) return [{ kind: 'console', id: 'console', title: 'console', text: '' }];
    return [
      this.machinePanel(),
      this.statesPanel(),
      this.inputPanel(),
      this.capturesPanel(),
      {
        kind: 'console',
        id: 'console',
        title: 'console',
        text: eng.results.map(renderVerdict).join('\n'),
      },
    ];
  }

  dispose(): void {
    this.engine = null;
    this.nfa = null;
    this.prevCaptures = new Map();
  }

  // -- driver helpers -----------------------------------------------------

  private resultOf(status: 'finished' | 'paused' | 'error' | 'ready'): RunResult {
    const eng = this.engine!;
    if (status === 'finished') return { finished: true, steps: eng.steps, exit: 'exit(0)' };
    if (status === 'paused') return { finished: false, steps: eng.steps, pausedAt: eng.pausedLine ?? undefined };
    if (status === 'error') return { finished: false, steps: eng.steps, error: eng.error ?? 'engine error' };
    return { finished: false, steps: eng.steps };
  }

  private snapshotCaptures(): void {
    this.prevCaptures = new Map(this.captureEntries().map((f) => [f.key, f.value] as const));
  }

  // -- panels -------------------------------------------------------------

  /** The whole compiled NFA; live states highlighted. */
  private machinePanel(): Panel {
    const eng = this.engine!;
    const nfa = this.nfa!;
    const live = new Set(eng.visibleIds());
    const rows: ListingRow[] = nfa.states.map((st, id) => ({
      addr: id,
      bytes: tagOf(st),
      text: machineText(st),
      ...(live.has(id) ? { current: true } : {}),
      tip: tipOf(st),
    }));
    return {
      kind: 'listing',
      id: 'machine',
      title: `The machine · ${nfa.states.length} states`,
      tip: 'The compiled Thompson NFA. Highlighted rows are live right now; splits are routing and take both ways at once.',
      rows,
    };
  }

  /** The current state set, each state as its meaning. */
  private statesPanel(): Panel {
    const eng = this.engine!;
    const ids = eng.visibleIds();
    const rows: ListingRow[] = ids.map((id) => {
      const st = this.nfa!.states[id]!;
      const table = eng.set?.get(id);
      return {
        addr: id,
        bytes: tagOf(st),
        text: liveText(st, table, eng.setPos),
        ...(eng.prevVisible.has(id) ? {} : { current: true }),
        tip: tipOf(st),
      };
    });
    return {
      kind: 'listing',
      id: 'states',
      title: `NFA states · ${ids.length} live`,
      tip: eng.finished
        ? 'Run finished.'
        : `States occupied after ${plural(eng.steps, 'char')}; highlighted rows arrived with the latest character.`,
      rows,
    };
  }

  /** One row per test input: caret while running, brackets when done. */
  private inputPanel(): Panel {
    const eng = this.engine!;
    const rows: ListingRow[] = eng.inputs.map((inp, i) => {
      const done = i < eng.results.length;
      const active = i === eng.lineIdx && !eng.finished;
      const result = done ? eng.results[i]! : null;
      let bytes: string;
      let text: string;
      let tip: string;
      if (result !== null) {
        bytes = result.matched ? 'match' : 'no match';
        text = result.matched
          ? `${encodeText(inp.text.slice(0, result.start))}[${encodeText(inp.text.slice(result.start, result.end))}]${encodeText(inp.text.slice(result.end))}`
          : encodeText(inp.text);
        tip = result.matched
          ? `source line ${inp.line} · matched [${result.start},${result.end})`
          : `source line ${inp.line} · no offset matched`;
      } else if (active) {
        bytes = `${eng.pos}/${inp.text.length}`;
        text = `${encodeText(inp.text.slice(0, eng.pos))}│${encodeText(inp.text.slice(eng.pos))}`;
        tip = `source line ${inp.line} · match attempt at start offset ${eng.offset} · ${eng.pos - eng.offset} chars consumed this attempt`;
      } else {
        bytes = `0/${inp.text.length}`;
        text = `│${encodeText(inp.text)}`;
        tip = `source line ${inp.line} · waiting`;
      }
      return { addr: i, bytes, text, line: inp.line, ...(active ? { current: true } : {}), tip };
    });
    return {
      kind: 'listing',
      id: 'input',
      title: 'Input',
      tip: 'One row per test line; │ marks the next character to consume. Unanchored search restarts at each start offset.',
      rows,
    };
  }

  /** Per-group spans of the leading path, with changed marks. */
  private capturesPanel(): Panel {
    const groups = this.nfa?.groups ?? 0;
    let fields: Field[];
    if (groups === 0) {
      fields = [{ key: 'groups', value: 'none', tip: 'this pattern has no (…) capturing groups' }];
    } else {
      fields = this.captureEntries().map((f) => ({
        ...f,
        ...(this.prevCaptures.get(f.key) === f.value ? {} : { changed: true }),
      }));
    }
    return {
      kind: 'fields',
      id: 'captures',
      title: 'Captures',
      tip: 'Half-open [start,end) spans. When paths merge, the span written most recently wins.',
      fields,
    };
  }

  /** Captures without changed flags — also the snapshot source. */
  private captureEntries(): Field[] {
    const eng = this.engine;
    if (eng === null) return [];
    const table: Table = eng.displayTable();
    const text = eng.currentText();
    const fields: Field[] = [];
    for (let g = 1; g <= (this.nfa?.groups ?? 0); g += 1) {
      const s = table.start[g]!;
      const e = table.end[g]!;
      let value: string;
      let sub: string | undefined;
      if (s < 0) {
        value = 'none';
      } else if (e < 0) {
        value = `open at ${s}`;
        sub = encodeText(text.slice(s, eng.setPos));
      } else {
        value = `[${s},${e})`;
        sub = encodeText(text.slice(s, e));
      }
      fields.push({ key: String(g), value, ...(sub === undefined ? {} : { sub }), tip: `capturing group ${g}, numbered by opening parenthesis` });
    }
    return fields;
  }
}

// ─── state rendering ───────────────────────────────────────────────────────

function tagOf(st: NfaState): string {
  switch (st.kind) {
    case 'char': return 'char';
    case 'any': return 'any';
    case 'class': return 'class';
    case 'anchor': return 'anchor';
    case 'split': return 'split';
    case 'groupOpen': return 'open';
    case 'groupClose': return 'close';
    case 'accept': return 'accept';
  }
}

function machineText(st: NfaState): string {
  const to = st.outs.length > 0 && st.outs[0]! >= 0 ? ` → ${st.outs.join(' | ')}` : '';
  switch (st.kind) {
    case 'char': return `char ${quoteChar(st.ch!)}${to}`;
    case 'any': return `any but \\n${to}`;
    case 'class': return `class ${st.cls!.src}${to}`;
    case 'anchor': return `anchor ${st.which}${to}`;
    case 'groupOpen': return `group ${st.group} open${to}`;
    case 'groupClose': return `group ${st.group} close${to}`;
    case 'split': return `split${to}`;
    case 'accept': return 'ACCEPT';
  }
}

/** Meaning of a state in the live set (no edges — those are routing). */
function liveText(st: NfaState, table: Table | undefined, pos: number): string {
  switch (st.kind) {
    case 'char': return `char ${quoteChar(st.ch!)}`;
    case 'any': return 'any but \\n';
    case 'class': return `class ${st.cls!.src}`;
    case 'anchor': return `anchor ${st.which}`;
    case 'groupOpen': return `group ${st.group} open at ${pos}`;
    case 'groupClose': {
      const g = st.group ?? 0;
      const start = table !== undefined && table.start[g] !== undefined && table.start[g]! >= 0 ? table.start[g]! : pos;
      return `group ${st.group} close [${start},${pos})`;
    }
    case 'accept': return 'ACCEPT';
    case 'split': return 'split';
  }
}

function tipOf(st: NfaState): string {
  switch (st.kind) {
    case 'char': return `consumes the character ${quoteChar(st.ch!)} and moves on`;
    case 'any': return 'consumes any one character except newline';
    case 'class': return classTip(st);
    case 'anchor':
      return st.which === '^'
        ? 'zero-width: holds only at position 0 of the test line — no multiline mode'
        : 'zero-width: holds only at the end of the test line — no multiline mode';
    case 'split': return 'epsilon: the engine takes both branches at once — no backtracking';
    case 'groupOpen': return `zero-width marker: group ${st.group} starts here`;
    case 'groupClose': return `zero-width marker: group ${st.group} ends here`;
    case 'accept': return 'the whole pattern has matched; the span ends here';
  }
}

function classTip(st: NfaState): string {
  const cls = st.cls!;
  if (cls.src === '\\d') return 'consumes one digit — exactly [0-9]';
  if (cls.src === '\\D') return 'consumes one non-digit — the complement of [0-9]';
  if (cls.src === '\\w') return 'consumes one word character — exactly [A-Za-z0-9_]';
  if (cls.src === '\\W') return 'consumes one non-word character — the complement of [A-Za-z0-9_]';
  if (cls.src === '\\s') return 'consumes one space — exactly [ \\t\\r\\n\\f\\v]';
  if (cls.src === '\\S') return 'consumes one non-space — the complement of [ \\t\\r\\n\\f\\v]';
  return `consumes one character ${cls.negated ? 'outside' : 'in'} ${cls.src}`;
}
