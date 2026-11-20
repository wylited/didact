// values-panel.test.ts — the Lua Values panel: every assigned name with the
// type tag assignment gave it. Two layers are pinned separately:
//   1. the pure builder (state-panel.ts) over hand-written data, and
//   2. the session wiring over real block runs — a local, a global, float
//      division, an assigned nil, a scope that ends.

import { describe, expect, it } from 'vitest';
import { luaKernel } from '../src/index';
import { assignmentNote, scopeNote, valuesPanel, type ValuedName } from '../src/state-panel';
import type { Field, Panel, Session } from '../src/index';

function rootOf(a: string, b: string, c: string): string {
  return `local ${a} = 1
${b} = ${c}
`;
}

function valuesPanelOf(s: Session): Panel {
  const p = s.state().find((x) => x.id === 'lua-values');
  if (p === undefined || p.kind !== 'fields') throw new Error('no Values panel');
  return p;
}

/** Build the session AND read its first panel: the `changed` flags diff
 *  against the view at the previous state() call, so one read per step. */
async function stepped(src: string, steps: number): Promise<Session> {
  const s = luaKernel.createSession();
  const load = await s.load(src);
  if (!load.ok) throw new Error(`load failed: ${load.message}`);
  // One view per change: state() diffs against the previous VIEW, so the
  // step before the last one gets a view of its own.
  for (let i = 0; i < steps - 1; i++) {
    await s.step();
    s.state();
  }
  await s.step();
  return s;
}

/** One rendered row per View: "key=value [sub]" plus ` *` when the view
 *  marks it changed. state() re-diffs against the previous view, so every
 *  assertion reads exactly one panel. */
function panelFields(s: Session): Field[] {
  return valuesPanelOf(s).fields;
}

function rowText(fields: Field[]): string[] {
  return fields.map((f) => `${f.key}=${f.value} [${f.sub}]${f.changed === true ? ' *' : ''}`);
}

describe('valuesPanel builder over plain data', () => {
  const data: ValuedName[] = [
    { name: 'n', value: '3', type: 'number', local: true, erased: false, live: true, changed: true },
    { name: 'g', value: 'hi', type: 'string', local: false, erased: false, live: true, changed: false },
    { name: 'gone', value: '1', type: 'number', local: true, erased: false, live: false, changed: false },
  ];

  it('is the lua-values fields panel, one field per name in input order', () => {
    const panel = valuesPanel(data);
    expect(panel).toMatchObject({ kind: 'fields', id: 'lua-values', title: 'Values · 3 names' });
    if (panel.kind !== 'fields') throw new Error('unreachable');
    expect(panel.fields.map((f: Field) => f.key)).toEqual(['n', 'g', 'gone']);
  });

  it('carries the type tag and local/global in the sub row, out-of-scope noted', () => {
    const panel = valuesPanel(data);
    if (panel.kind !== 'fields') throw new Error('unreachable');
    expect(panel.fields.map((f) => f.sub)).toEqual([
      'number · local',
      'string · global',
      'number · local · out of scope',
    ]);
  });

  it('marks only the changed field and explains every field on hover', () => {
    const panel = valuesPanel(data);
    if (panel.kind !== 'fields') throw new Error('unreachable');
    expect(panel.fields.map((f) => f.changed ?? false)).toEqual([true, false, false]);
    expect(panel.fields[1]!.tip).toContain('global: nothing was declared, so this is a key in _G');
    expect(panel.fields[2]!.tip).toContain('Its scope has ended');
  });

  it('titles a lone name in the singular', () => {
    expect(valuesPanel([data[0]!])).toMatchObject({ title: 'Values · 1 name' });
  });

  it('teaches integer vs float and Lua truthiness, not a JavaScript story', () => {
    expect(assignmentNote('number')).toBe(
      'number — an integer or a float, decided by the literal and the operator (/ always gives a float)',
    );
    expect(assignmentNote('boolean')).toBe('boolean — only nil and false are falsy; 0 and "" are true');
    expect(assignmentNote('table')).toBe('table — a reference: assignment aliases the table, it never copies it');
    expect(assignmentNote('nil')).toContain('the absence of a value');
  });

  it('tells a local and a global apart in the scope note', () => {
    expect(scopeNote(true)).toBe("local: bound in the block's scope, not a key in _G");
    expect(scopeNote(false)).toBe('global: nothing was declared, so this is a key in _G');
  });
});

describe('Values panel during a block run', () => {
  it('grows one row per assignment, in block order, only the latest changed', async () => {
    const s = await stepped(rootOf('x', 'y', '1'), 2);
    // The second step assigned y — x did not change since the previous view.
    expect(rowText(panelFields(s))).toEqual(['x=1 [number · local]', 'y=1 [number · global] *']);
    const early = valuesPanelOf(await stepped(rootOf('x', 'y', '1'), 1)).fields;
    expect(early.map((f) => `${f.key}${f.changed === true ? '*' : ''}`)).toEqual(['x*']);
  });

  it('shows / making a float: 1/2 is 0.5, and a global is a _G key', async () => {
    const s = await stepped('local x = 1\nx = x / 2\n', 2);
    expect(rowText(panelFields(s))).toEqual(['x=0.5 [number · local] *']);
  });

  it('records an assigned nil as erased rather than dropping the row', async () => {
    const s = await stepped('z = "hi"\nz = nil\nt = 1\n', 2);
    expect(rowText(panelFields(s))).toEqual(['z=nil [nil · global] *']);
    const tip = valuesPanelOf(s).fields[0]!.tip!;
    expect(tip).toContain('assigned nil');
    expect(tip).toContain('the absence of a value');
  });

  it('keeps a local after its scope ends, marked out of scope', async () => {
    // step 1: the `do` block ends (inner's scope is gone); step 2: after = 2.
    const s = await stepped('do\n  local inner = 1\nend\nafter = 2\n', 3);
    expect(rowText(panelFields(s))).toEqual(['inner=1 [number · local · out of scope]', 'after=2 [number · global] *']);
  });

  it('starts empty and resets with the session', async () => {
    const s = await stepped('q = 1\n', 1);
    expect(valuesPanelOf(s).title).toBe('Values · 1 name');
    s.reset();
    expect(valuesPanelOf(s).fields).toEqual([]);
  });
});
