// The python kernel's under-the-hood panels: pure logic over fixed inputs.
//
// Everything asserted here is a rule the panel has to obey, checked by
// construction: grouping order, the changed-marking diff, the exact bytes a
// row's name/value/subrenders, the trace table's HTML and the flow summary's
// sentence. No Pyodide, no DOM, no snapshots — a failure names the rule.
import { describe, expect, it } from 'vitest';
import {
  annotationFields,
  buildPanels,
  escapeHtml,
  flowSummary,
  groupedFields,
  orderedNames,
  progressPanel,
  sourceLines,
  traceHtml,
  tracebackRows,
  varRow,
  type AnnotationRow,
  type FlowData,
  type TraceRow,
  type VarInfo,
  type XrayData,
} from '../src/xray';
import type { Field, Panel } from '../src/types';

const v = (group: VarInfo['group'], type: string, repr: string, size: number | null = null): VarInfo => ({ group, type, repr, size });

describe('orderedNames', () => {
  it('sorts names the way Python sorts strings (Unicode code units)', () => {
    expect(orderedNames(['b', 'A', 'a', 'B', '_x', 'ä'])).toEqual(['A', 'B', '_x', 'a', 'b', 'ä']);
    expect(orderedNames([])).toEqual([]);
  });
});

describe('groupedFields', () => {
  const vars = new Map<string, VarInfo>([
    ['total', v('scalar', 'int', '42')],
    ['name', v('scalar', 'str', "'ada'")],
    ['squares', v('collection', 'list', '[1, 4, 9]', 3)],
    ['lookup', v('collection', 'dict', "{'a': 1}", 1)],
    ['word', v('collection', 'str', "'hi'", 2)],
    ['fib', v('function', 'function', '<function fib at 0x1>')],
    ['Node', v('class', 'type', "<class '__main__.Node'>")],
    ['math', v('module', 'module', '<module math>')],
  ]);

  it('emits the groups in a fixed order, each sorted by name, with a count label', () => {
    const fields = groupedFields(vars, null);
    expect(fields.map((f) => f.key)).toEqual([
      'scalars · 2', 'name', 'total',
      'collections · 3', 'lookup', 'squares', 'word',
      'functions · 1', 'fib',
      'classes · 1', 'Node',
      'modules-imported · 1', 'math',
    ]);
  });

  it('writes length and a short summary into the row sub, never into the value', () => {
    const fields = groupedFields(vars, null);
    const byKey = new Map(fields.map((f) => [f.key, f] as const));
    expect(byKey.get('squares')!.value).toBe('[1, 4, 9]');
    expect(byKey.get('squares')!.sub).toBe('list · len 3 · 3 items');
    expect(byKey.get('lookup')!.sub).toBe('dict · len 1 · 1 key');
    expect(byKey.get('word')!.sub).toBe('str · len 2 · 2 chars');
    expect(byKey.get('total')!.sub).toBe('int');
    expect(byKey.get('fib')!.sub).toBe('function');
  });

  it('marks exactly the variables whose repr changed since the previous snapshot', () => {
    const prev = new Map([['total', '41'], ['squares', '[1, 4, 9]'], ['name', "'ada'"]]);
    const fields = groupedFields(vars, prev);
    const changed = fields.filter((f) => f.changed === true).map((f) => f.key);
    // total moved (41 → 42); squares and name kept their repr; every name the
    // previous snapshot did not have at all is new, so it is marked too.
    expect(changed).toEqual(['total', 'lookup', 'word', 'fib', 'Node', 'math']);
    // untouched rows and group labels never read as changes
    for (const label of fields.filter((f) => f.value === '')) expect(label.changed).toBe(false);
  });

  it('treats the first snapshot as "everything appeared just now"', () => {
    // no baseline (the block has not run yet) == the empty namespace:
    // every row is something this run created, so every row is marked
    for (const prev of [null, new Map<string, string>()]) {
      const fields = groupedFields(vars, prev);
      expect(fields.filter((f) => f.value !== '').every((f) => f.changed === true)).toBe(true);
      expect(fields.filter((f) => f.value === '').every((f) => f.changed === false)).toBe(true);
    }
  });

  it('caps a large namespace and says how many names were withheld', () => {
    const big = new Map<string, VarInfo>();
    for (let i = 0; i < 230; i++) big.set(`v${String(i).padStart(3, '0')}`, v('scalar', 'int', String(i)));
    const fields = groupedFields(big, null, { limit: 200 });
    const values = fields.filter((f) => f.value !== '');
    expect(values).toHaveLength(200);
    expect(fields[fields.length - 1]!.key).toBe('… 30 more names');
  });

  it('keeps the full repr in the tip when the helper trimmed it', () => {
    const long = 'x'.repeat(199) + '…';
    const fields = groupedFields(new Map([['s', v('scalar', 'str', long)]]), null, {
      full: new Map([['s', "'" + 'x'.repeat(400) + "'"]]),
    });
    const row = fields.find((f) => f.key === 's')!;
    expect(row.value).toBe(long);
    expect(row.tip).toContain('x'.repeat(400));
  });

  it('shows an empty repr as ∅ so an empty-string value is still visible', () => {
    const row = varRow('s', v('scalar', 'str', ''), null);
    expect(row.value).toBe('∅');
    expect(row.tip).toBe('s is a str');
  });
});

describe('flowSummary', () => {
  const flow = (hits: number, loops: [number, number][], branches: [number, [number, number]][], overflow = false): FlowData =>
    ({ hits, overflow, loops, branches });

  it('names every loop iteration count and every branch tally, in line order', () => {
    expect(flowSummary(flow(42, [[2, 5], [17, 2]], [[9, [1, 0]]]))).toBe(
      '42 lines executed · loop at line 2: 5 iterations · loop at line 17: 2 iterations · if at line 9: then 1×, else 0×',
    );
  });

  it('uses singular forms for one', () => {
    expect(flowSummary(flow(1, [[5, 1]], []))).toBe('1 line executed · loop at line 5: 1 iteration');
  });

  it('says so when nothing ran, and when the trace budget stopped it', () => {
    expect(flowSummary(flow(0, [], []))).toBe('no lines executed');
    expect(flowSummary(flow(200000, [], [], true))).toBe(
      '200000 lines executed · trace stopped at the record budget',
    );
  });
});

describe('traceHtml', () => {
  const source = sourceLines("squares = []\nfor n in range(1, 3):\n    squares.append(n)\nprint(squares)\n");
  const rows: TraceRow[] = [
    { line: 1, stmt: 1, hits: 1, outer: true, end: 1 },
    { line: 2, stmt: 2, hits: 3, outer: true, end: 3, loop: 2, head: true },
    { line: 3, stmt: 2, hits: 2, loop: 2, tail: true },
    { line: 4, stmt: 3, hits: 1, outer: true, end: 4 },
  ];

  it('renders one row per line in source order with its hit count and text', () => {
    const html = traceHtml(rows, source, { hits: 7, overflow: false, loops: [[2, 2]], branches: [] });
    expect(html).toContain('<td class="py-num">1</td><td class="py-hits">1</td><td class="py-code">squares = []</td>');
    expect(html).toContain('<td class="py-num">2</td><td class="py-hits">3</td><td class="py-code">for n in range(1, 3):</td>');
    expect(html).toContain('<td class="py-num">3</td><td class="py-hits">2</td><td class="py-code">    squares.append(n)</td>');
    // the flow sentence leads the section
    expect(html.startsWith('<div class="py-flow">7 lines executed · loop at line 2: 2 iterations</div>')).toBe(true);
  });

  it('marks the failing line as failed and never also as current', () => {
    const html = traceHtml(rows, source, { hits: 7, overflow: false, loops: [], branches: [] },
      { current: 4, failureLine: 4 });
    const failed = html.match(/<tr class="([^"]*py-failed[^"]*)"/);
    expect(failed).not.toBeNull();
    expect(failed![1]).not.toContain('py-current');
    expect(html).not.toMatch(/class="[^"]*py-current/);
  });

  it('prints the exception under the table on the failing line', () => {
    const html = traceHtml(rows, source, { hits: 7, overflow: false, loops: [], branches: [] }, {
      failureLine: 3,
      failure: { error: 'ValueError: <bad>', traceback: [['<module>', 3]] },
    });
    expect(html).toContain('<div class="py-fail">ValueError: &lt;bad&gt;</div>');
    expect(html).toMatch(/<tr class="py-row [^"]*py-failed/);
  });

  it('escapes the source text and the tooltip text', () => {
    const html = traceHtml([{ line: 1, stmt: 1, hits: 1, outer: true }], ['if a < b and "x":'], flowEmpty());
    expect(html).toContain('if a &lt; b and &quot;x&quot;:');
  });

  it('gives every row a data-tip only when there is something to say', () => {
    const html = traceHtml(rows, source, flowEmpty());
    expect(html).toMatch(/<tr class="[^"]*py-outer[^"]*" data-line="\d+" data-hits="\d+" data-tip="top-level statement">/);
    expect(html).toMatch(/data-tip="top-level statement · loop header · one hit per iteration of the loop at line 2"/);
    expect(html).toMatch(/data-tip="loop body's last line · one hit per pass through the loop at line 2"/);
  });

  const flowEmpty = (): FlowData => ({ hits: 0, overflow: false, loops: [], branches: [] });
});

describe('tracebackRows', () => {
  it('lists frames innermost last and marks the deepest as current', () => {
    const rows = tracebackRows({ error: 'ZeroDivisionError: division by zero', traceback: [['<module>', 9], ['f', 2]] });
    expect(rows.map((r) => [r.addr, r.bytes, r.text, r.line, r.current])).toEqual([
      [9, '<module>', 'the block at line 9', 9, false],
      [2, 'f', 'f() at line 2', 2, true],
    ]);
  });
});

describe('annotationFields', () => {
  it('shows declared → observed, marking mismatches as changed rows', () => {
    const rows: AnnotationRow[] = [
      ['f(n)', 'int', 'float', false],
      ['count', 'int', 'int', true],
    ];
    const fields = annotationFields(rows);
    expect(fields.map((f) => [f.key, f.value, f.changed])).toEqual([
      ['count', 'int → int', false],
      ['f(n)', 'int → float', true],
    ]);
    expect(fields[1]!.sub).toBe('observed type does not match the annotation');
    expect(fields[1]!.tip).toContain('annotations are not enforced at run time');
  });
});

describe('progressPanel', () => {
  it('names the statement range and the fraction done', () => {
    const p = progressPanel({ from: 3, to: 4, done: 2, total: 8, live: true });
    expect(p.title).toBe('Progress · running');
    const fields = p.kind === 'fields' ? p.fields : [];
    expect(fields[0]!.value).toBe('2/8');
    expect(fields[0]!.sub).toBe('25% · lines 3–4');
  });

  it('reads as the last run once it is not live', () => {
    const p = progressPanel({ from: 3, to: 3, done: 2, total: 8, live: false });
    expect(p.title).toBe('Progress · last run');
    const fields = p.kind === 'fields' ? p.fields : [];
    expect(fields[0]!.sub).toBe('25% · line 3');
    expect(fields[0]!.changed).toBe(false);
  });
});

describe('buildPanels', () => {
  const base: XrayData = {
    source: ['x = 1'],
    trace: [{ line: 1, stmt: 1, hits: 1, outer: true, end: 1 }],
    flow: { hits: 1, overflow: false, loops: [], branches: [] },
    vars: new Map([['x', v('scalar', 'int', '1')]]),
    prevVars: new Map(),
    frames: [['<module>', 1]],
    failure: null,
    locals: new Map(),
    annotations: [],
    console: '',
    running: false,
  };

  const ids = (panels: Panel[]): string[] => panels.map((p) => p.id);

  it('lays the snapshot out in reading order', () => {
    expect(ids(buildPanels(base))).toEqual(['py-trace', 'py-stack', 'py-vars', 'py-console']);
  });

  it('adds the failure story: traceback listing and failing-frame locals', () => {
    const panels = buildPanels({
      ...base,
      failure: { error: 'ZeroDivisionError: division by zero', traceback: [['<module>', 1]] },
      locals: new Map([['d', v('scalar', 'int', '0')]]),
    });
    expect(ids(panels)).toEqual(['py-trace', 'py-stack', 'py-traceback', 'py-vars', 'py-locals', 'py-console']);
    const traceback = panels.find((p) => p.id === 'py-traceback')!;
    expect(traceback.kind === 'listing' ? traceback.tip : '').toBe('ZeroDivisionError: division by zero');
  });

  it('shows the heartbeat first while a run is streaming', () => {
    const panels = buildPanels({
      ...base,
      running: true,
      progress: { from: 1, to: 1, done: 1, total: 3, live: true },
    });
    expect(ids(panels)[0]).toBe('py-progress');
  });

  it('omits sections with nothing to say', () => {
    const panels = buildPanels({ ...base, vars: new Map(), frames: [] });
    expect(ids(panels)).toEqual(['py-trace', 'py-console']);
  });

  it('keeps a row shape the generic panel renderer understands', () => {
    const panels = buildPanels(base);
    const fields = panels.find((p) => p.kind === 'fields')!;
    const vars = fields.kind === 'fields' ? fields.fields : [];
    for (const f of vars) {
      const typed: Field = f;
      expect(typeof typed.key).toBe('string');
      expect(typeof typed.value).toBe('string');
      expect(typed.sub === undefined || typeof typed.sub === 'string').toBe(true);
    }
  });
});

describe('escapeHtml / sourceLines', () => {
  it('escapes the four HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;\'&lt;/a&gt;');
  });

  it('counts lines exactly as Python does (no phantom trailing line)', () => {
    expect(sourceLines('a = 1\nb = 2\n')).toEqual(['a = 1', 'b = 2']);
    expect(sourceLines('a = 1\n\nb = 2')).toEqual(['a = 1', '', 'b = 2']);
    expect(sourceLines('')).toEqual([]);
  });
});
