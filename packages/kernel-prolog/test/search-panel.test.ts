// search-panel.test.ts — the Search panel's behavioural contract: one row
// per engine transition, the clause line the cursor will try next, and the
// choice-point depth. Every expected string below comes from the SLD
// trace of a two-clause grandparent query, not from the panel code.

import { describe, expect, it } from 'vitest';
import { describeStep, prologKernel } from '../src/index';
import type { Field, Panel, Session } from '../src/index';

const FAMILY = `parent(tom, mary).
parent(mary, ann).
grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
?- grandparent(tom, G).`;

function searchFields(s: Session): Field[] {
  const p: Panel | undefined = s.state().find((x) => x.id === 'search');
  if (p === undefined || p.kind !== 'fields') throw new Error('no Search panel');
  return p.fields;
}

/** "key=value" per field, in panel order. */
function searchRows(s: Session): string[] {
  return searchFields(s).map((f) => `${f.key}=${f.value}`);
}

describe('describeStep', () => {
  it('names every transition the engine can record', () => {
    expect(describeStep('resolve').what).toBe('resolve');
    expect(describeStep('mismatch').what).toBe('mismatch');
    expect(describeStep('backtrack').what).toBe('backtrack');
    expect(describeStep('redo').what).toBe('redo');
    expect(describeStep('cut').what).toBe('cut');
    expect(describeStep('builtin').what).toBe('builtin');
    expect(describeStep('builtin-fail').what).toBe('builtin failed');
    expect(describeStep('solution').what).toBe('solution');
    expect(describeStep('no').what).toBe('no');
  });

  it('reads a missing trace as no step, not as a transition', () => {
    expect(describeStep(null)).toEqual({ what: '—', tip: 'no step taken yet' });
  });

  it('gives cut and backtrack distinct explanations', () => {
    expect(describeStep('cut').tip).not.toBe(describeStep('backtrack').tip);
  });
});

describe('Search panel during an SLD trace', () => {
  it('walks grandparent(tom, G) step by step', async () => {
    const s = prologKernel.createSession();
    expect(await s.load(FAMILY)).toMatchObject({ ok: true });

    // load() alone: nothing has been tried yet.
    expect(searchRows(s)).toEqual(['last step=—', 'next clause=line 3', 'choice points=0']);

    // First step only selects the query — no clause has unified yet.
    await s.step();
    expect(searchRows(s)).toEqual(['last step=—', 'next clause=line 3', 'choice points=0']);

    // grandparent/2 has one clause: the resolvent becomes its body.
    await s.step();
    expect(searchRows(s)).toEqual(['last step=resolve', 'next clause=line 1', 'choice points=0']);

    // parent(tom, Y): first clause unifies, and a retry alternative opens.
    await s.step();
    expect(searchRows(s)).toEqual(['last step=resolve', 'next clause=line 1', 'choice points=1']);

    // parent(mary, Z): line 1 is parent(tom, _) — mary ≠ tom, so a mismatch
    // and the cursor moves on to line 2.
    await s.step();
    expect(searchRows(s)).toEqual(['last step=mismatch', 'next clause=line 2', 'choice points=1']);

    // The last goal resolves, and the resolved goal leaves no cursor behind.
    await s.step();
    expect(searchRows(s)).toEqual(['last step=resolve', 'choice points=1']);

    // Empty resolvent: a solution, with the retry still open for redo.
    const done = await s.step();
    expect(done.result).toEqual({ finished: true, steps: 5, exit: 'yes' });
    expect(searchRows(s)).toEqual(['last step=solution', 'choice points=1']);
  });

  it('reports exhaustion as last step=no with an empty stack', async () => {
    const s = prologKernel.createSession();
    await s.load(`p(a).\n?- p(b).`);
    const r = await s.run();
    expect(r).toMatchObject({ finished: true, exit: 'no' });
    expect(searchRows(s)).toEqual(['last step=no', 'choice points=0']);
  });

  it('marks the step that unifies with a clause line as the breakpoint line', async () => {
    const s = prologKernel.createSession();
    await s.load(FAMILY);
    const r = await s.run([2]);
    // The engine stops before the clause on line 2 is tried.
    expect(r.pausedAt).toBe(2);
    expect(searchFields(s).find((f) => f.key === 'next clause')?.value).toBe('line 2');
  });

  it('explains every field for hover teaching text', async () => {
    const s = prologKernel.createSession();
    await s.load(FAMILY);
    await s.step();
    const tips = searchFields(s).map((f) => f.tip);
    expect(tips.every((t) => typeof t === 'string' && t.length > 10)).toBe(true);
    expect(tips).toContain('open alternatives on the stack — 0 means the next failure backtracks to "No."');
  });
});
