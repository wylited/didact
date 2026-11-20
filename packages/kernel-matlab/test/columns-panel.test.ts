// columns-panel.test.ts — the Columns panel: `for v = M` walks M's COLUMNS.
// Pinned twice, like the Lua Values panel:
//   1. the pure builder (columns-panel.ts) over hand-written loop state, and
//   2. the interpreter tracking the innermost loop over real block runs.

import { describe, expect, it } from 'vitest';
import { matlabKernel } from '../src/index';
import { columnNote, columnsPanel, COLUMN_TRUTH, type ColumnsInput } from '../src/columns-panel';
import type { LoopState } from '../src/interp';
import type { Field, Panel, Session } from '../src/types';

const FOR_LOOP: LoopState = { kind: 'for', over: 'v', iter: 2, total: 3, line: 2 };

function rows(fields: Field[]): string[] {
  return fields.map((f) => `${f.key}=${f.value}${f.sub === undefined ? '' : ` [${f.sub}]`}${f.changed === true ? ' *' : ''}`);
}

function columnsPanelOf(s: Session): Panel {
  const p = s.state().find((x) => x.id === 'columns');
  if (p === undefined || p.kind !== 'fields') throw new Error('no Columns panel');
  return p;
}

async function stepped(src: string, steps: number): Promise<Session> {
  const s = matlabKernel.createSession();
  const load = await s.load(src);
  if (!load.ok) throw new Error(`load failed: ${load.message}`);
  for (let i = 0; i < steps - 1; i++) {
    await s.step();
    s.state(); // one view per change: `changed` diffs against the last view
  }
  await s.step();
  return s;
}

const FOR_M = `M = [1 2 3; 4 5 6]
for v = M
  total = v(1) + v(2)
end
`;

describe('columnsPanel builder over plain data', () => {
  it('says no loop runs at top level', () => {
    expect(rows((columnsPanel({ loop: null, walked: null }) as Extract<Panel, { kind: 'fields' }>).fields))
      .toEqual(['loop=none']);
  });

  it('names the loop variable and which column it holds this pass', () => {
    const input: ColumnsInput = { loop: FOR_LOOP, walked: { name: 'M', rows: 2, cols: 3 } };
    const panel = columnsPanel(input);
    if (panel.kind !== 'fields') throw new Error('unreachable');
    expect(panel.fields.map((f) => f.key)).toEqual(['loop variable', 'column', 'walked matrix', 'column start']);
    expect(panel.fields[1]).toMatchObject({ value: '2 of 3', changed: true });
  });

  it('shows where the column starts in column-major memory', () => {
    const panel = columnsPanel({ loop: FOR_LOOP, walked: { name: 'M', rows: 2, cols: 3 } });
    if (panel.kind !== 'fields') throw new Error('unreachable');
    // column 2 of a 2x3 starts at linear element 3 → address 2
    expect(rows(panel.fields).at(-1)).toBe('column start=A(3) [addr 2 · (col-1)*rows + row - 1]');
  });

  it('omits the column-start row for a single-column matrix', () => {
    const panel = columnsPanel({ loop: { ...FOR_LOOP, iter: 1, total: 1 }, walked: { name: 'c', rows: 3, cols: 1 } });
    if (panel.kind !== 'fields') throw new Error('unreachable');
    expect(panel.fields.map((f) => f.key)).not.toContain('column start');
  });

  it('counts a while loop passes instead of columns', () => {
    const panel = columnsPanel({ loop: { kind: 'while', over: 'condition', iter: 3, total: null, line: 5 }, walked: null });
    if (panel.kind !== 'fields') throw new Error('unreachable');
    expect(rows(panel.fields)).toEqual(['loop=while · pass 3 *']);
    expect(panel.fields[0]!.tip).toContain('no iterator to bind');
  });

  it('states the for-loop truth once, in the note and the tip', () => {
    expect(COLUMN_TRUTH).toBe(
      'for v = M runs once per COLUMN of M: v is rows(M) x 1, so A(i) also walks down column 1 first',
    );
    expect(columnNote(FOR_LOOP, { name: 'M', rows: 2, cols: 3 })).toBe(
      'column 2 of M (2x3) is element A(3) onward — 2 elements of column-major memory sit before it',
    );
  });
});

describe('interpreter loop tracking over real blocks', () => {
  it('walks M column by column, one iteration per column', async () => {
    // step 1: M = …; step 2: the first loop pass (column 1) is running.
    const seen: string[] = [];
    for (const n of [2, 3, 4]) {
      const s = await stepped(FOR_M, n);
      const panel = columnsPanelOf(s);
      if (panel.kind !== 'fields') throw new Error('unreachable');
      seen.push(rows(panel.fields).join(' | '));
    }
    expect(seen).toEqual([
      'loop variable=v | column=1 of 3 * | walked matrix=M · 2x3 | column start=A(1) [addr 0 · (col-1)*rows + row - 1]',
      'loop variable=v | column=2 of 3 * | walked matrix=M · 2x3 | column start=A(3) [addr 2 · (col-1)*rows + row - 1]',
      'loop variable=v | column=3 of 3 * | walked matrix=M · 2x3 | column start=A(5) [addr 4 · (col-1)*rows + row - 1]',
    ]);
  });

  it('names the walked matrix, not the loop variable rebound to the column', async () => {
    // Inside the body `v` is a 2x1 column; the panel must still say M is
    // the 2x3 matrix the loop walks (the bug a naive lookup shows).
    const s = await stepped(FOR_M, 2);
    const panel = columnsPanelOf(s);
    if (panel.kind !== 'fields') throw new Error('unreachable');
    expect(panel.fields.find((f) => f.key === 'walked matrix')?.value).toBe('M · 2x3');
  });

  it('reports no loop after the for statement finishes', async () => {
    // step 5: the `end`; the loop state is cleared on the way out.
    const s = await stepped(FOR_M, 5);
    const panel = columnsPanelOf(s);
    if (panel.kind !== 'fields') throw new Error('unreachable');
    expect(rows(panel.fields)).toEqual(['loop=none']);
  });

  it('counts while-loop passes, including the one that fails the test', async () => {
    const src = `i = 0
while i < 2
  i = i + 1
end
`;
    // step 1: i = 0; step 2: pass 1 (0 < 2 true, body); step 3: pass 2.
    const a = await stepped(src, 2);
    const b = await stepped(src, 3);
    const fa = columnsPanelOf(a) as Extract<Panel, { kind: 'fields' }>;
    const fb = columnsPanelOf(b) as Extract<Panel, { kind: 'fields' }>;
    expect(rows(fa.fields)).toEqual(['loop=while · pass 1 *']);
    expect(rows(fb.fields)).toEqual(['loop=while · pass 2 *']);
  });
});
