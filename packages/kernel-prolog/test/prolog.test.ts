// prolog.test.ts — behavioral tests for @didact/kernel-prolog (exact values).

import { describe, expect, it } from 'vitest';
import { prologKernel } from '../src/index';
import type { Panel, RunResult, Session } from '../src/index';

async function loaded(src: string): Promise<Session> {
  const s = prologKernel.createSession();
  const l = await s.load(src);
  expect(l.ok).toBe(true);
  return s;
}

function consoleOf(panels: Panel[]): string {
  const c = panels.find((p) => p.kind === 'console');
  return c !== undefined && c.kind === 'console' ? c.text : '';
}

async function runOnce(src: string): Promise<{ text: string; result: RunResult }> {
  const s = await loaded(src);
  const result = await s.run();
  return { text: consoleOf(s.state()), result };
}

const MEMBER = `member(X, [X|_]).
member(X, [_|T]) :- member(X, T).
`;

const APPEND = `append([], Ys, Ys).
append([X|Xs], Ys, [X|Zs]) :- append(Xs, Ys, Zs).
`;

describe('unification', () => {
  it('binds query variables and reports the first solution', async () => {
    const { text } = await runOnce(`likes(ada, prolog).
likes(ada, lisp).
?- likes(ada, X).`);
    expect(text).toBe('Yes.\nX = prolog\n');
  });

  it('structural unification of compound terms', async () => {
    const { text } = await runOnce(`?- point(X, Y) = point(3, 4).`);
    expect(text).toBe('Yes.\nX = 3\nY = 4\n');
  });

  it('refuses X = f(X) with a clean line-mapped occurs-check error', async () => {
    const s = prologKernel.createSession();
    const l = await s.load(`goal(fine).\ngoal(other).\n?- X = f(X).`);
    expect(l.ok).toBe(true);
    const r = await s.run();
    expect(r.finished).toBe(false);
    expect(r.error).toContain('occurs check');
    expect(r.error).toContain('line 3');
  });
});

describe('backtracking order and findall', () => {
  it('member collects solutions in clause order', async () => {
    const { text } = await runOnce(`${MEMBER}?- findall(X, member(X, [a, b, c]), Xs).`);
    expect(text).toBe('Yes.\nX = X\nXs = [a, b, c]\n');
  });

  it('append mode 1: enumerate decompositions', async () => {
    const { text } = await runOnce(`${APPEND}?- findall(p(Xs, Ys), append(Xs, Ys, [1, 2]), Ps).`);
    expect(text).toBe('Yes.\nXs = Xs\nYs = Ys\nPs = [p([], [1, 2]), p([1], [2]), p([1, 2], [])]\n');
  });

  it('append mode 2: does a suffix append to a prefix?', async () => {
    const no = await runOnce(`${APPEND}?- append([b, c], [d], [a, b, c, d]).`);
    expect(no.text).toBe('No.\n');
    const yes = await runOnce(`${APPEND}?- append([a, b], [c], [a, b, c]).`);
    expect(yes.text).toBe('Yes.\n');
  });

  it('append mode 3: construction', async () => {
    const { text } = await runOnce(`${APPEND}?- append([1, 2], [3, 4], Zs).`);
    expect(text).toBe('Yes.\nZs = [1, 2, 3, 4]\n');
  });
});

describe('cut', () => {
  const CUT = `max3(X, Y, X) :- X >= Y, !.
max3(_, Y, Y).
`;
  const NOCUT = `maxu(X, Y, X) :- X >= Y.
maxu(_, Y, Y).
`;

  it('with cut: one solution', async () => {
    const { text } = await runOnce(`${CUT}?- findall(M, max3(5, 3, M), WithCut).`);
    expect(text).toBe('Yes.\nM = M\nWithCut = [5]\n');
  });

  it('without cut: the same query yields more solutions', async () => {
    const { text } = await runOnce(`${NOCUT}?- findall(M, maxu(5, 3, M), WithoutCut).`);
    expect(text).toBe('Yes.\nM = M\nWithoutCut = [5, 3]\n');
  });

  it('cut prunes only its parent goal\u2019s choices, not the disjunction\u2019s', async () => {
    // ! inside first/2 must not kill the ;/2 alternative that was created
    // BEFORE first/2 was invoked — that is parent-goal semantics.
    const { text } = await runOnce(`first([X|_], X) :- !.
first([_|T], X) :- first(T, X).
member2(X, [X|_]).
member2(X, [_|T]) :- member2(X, T).
?- findall(X, (first([a, b], X) ; member2(X, [z])), Ls).`);
    expect(text).toBe('Yes.\nX = X\nLs = [a, z]\n');
  });
});

describe('arithmetic', () => {
  it('is evaluates, honoring * precedence and // and mod', async () => {
    const { text } = await runOnce('?- X is 3 + 4 * 2, Y is 17 // 5, Z is 17 mod 5.');
    expect(text).toBe('Yes.\nX = 11\nY = 3\nZ = 2\n');
  });

  it('= unifies without evaluating; =:= evaluates both sides', async () => {
    const unify = await runOnce('?- X = 2 + 2.');
    expect(unify.text).toBe('Yes.\nX = 2 + 2\n');
    const evalEq = await runOnce('?- X is 2 + 2.');
    expect(evalEq.text).toBe('Yes.\nX = 4\n');
    const yes = await runOnce('?- 4 =:= 2 + 2.');
    expect(yes.text).toBe('Yes.\n');
    const no = await runOnce('?- 4 = 2 + 2.');
    expect(no.text).toBe('No.\n');
  });

  it('comparison builtins', async () => {
    const { text } = await runOnce('?- 3 < 5, 5 =< 5, 6 > 2, 4 =\\= 5.');
    expect(text).toBe('Yes.\n');
  });
});

describe('variables', () => {
  it('each _ is a fresh variable', async () => {
    const { text } = await runOnce('?- _ = 1, _ = 2.');
    expect(text).toBe('Yes.\n');
  });

  it('a named variable keeps its identity across the conjunction', async () => {
    const { text } = await runOnce('?- X = 1, X = 2.');
    expect(text).toBe('No.\n');
  });
});

describe('errors and budget', () => {
  it('left recursion dies with a budget error, not a hang', async () => {
    const s = await loaded(`p :- p.\n?- p.`);
    const start = Date.now();
    const r = await s.run();
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(r.finished).toBe(false);
    expect(r.error).toContain('budget exceeded');
    expect(r.error).toContain('line 1');
  }, 30_000);

  it('calling an undefined predicate is a line-mapped error', async () => {
    const s = await loaded(`warmup(ok).\ngoal(X) :- nope(X).\n?- goal(1).`);
    const r = await s.run();
    expect(r.finished).toBe(false);
    expect(r.error).toContain('undefined predicate nope/1');
    expect(r.error).toContain('line 2');
  });

  it('parse errors carry the 1-based line', async () => {
    const s = prologKernel.createSession();
    const l = await s.load('ok(1).\nbroken here');
    expect(l.ok).toBe(false);
    if (!l.ok) expect(l.line).toBe(2);
  });
});

describe('run/continue semantics', () => {
  it('run() finds the first solution; further run()s find more; then no', async () => {
    const s = await loaded(`${MEMBER}?- member(X, [a, b]).`);
    const r1 = await s.run();
    expect(r1).toMatchObject({ finished: true, exit: 'yes' });
    expect(consoleOf(s.state())).toBe('Yes.\nX = a\n');
    const r2 = await s.run();
    expect(r2).toMatchObject({ finished: true, exit: 'yes' });
    expect(consoleOf(s.state())).toBe('Yes.\nX = a\nYes.\nX = b\n');
    const r3 = await s.run();
    expect(r3).toMatchObject({ finished: true, exit: 'no' });
    expect(consoleOf(s.state())).toBe('Yes.\nX = a\nYes.\nX = b\nNo.\n');
  });

  it('one block may hold several queries; each is answered once', async () => {
    const { text } = await runOnce(`a(1).\nb(2).\n?- a(X).\n?- b(Y).`);
    expect(text).toBe('Yes.\nX = 1\nYes.\nY = 2\n');
  });

  it('a failing query reports No. and the block finishes', async () => {
    const { text, result } = await runOnce(`a(1).\n?- a(2).`);
    expect(text).toBe('No.\n');
    expect(result).toMatchObject({ finished: true, exit: 'no' });
  });
});

describe('stepping and panels', () => {
  it('each step() performs exactly one resolution action (panels change)', async () => {
    const s = await loaded(`p(X) :- q(X), X > 1.\nq(2).\nq(3).\n?- p(V).`);
    let prev = '';
    let steps = 0;
    let transitions = 0;
    for (let i = 0; i < 30; i++) {
      const st = await s.step();
      if (!st.ran) break;
      steps++;
      const cur = JSON.stringify(s.state().slice(0, 3));
      if (cur !== prev) transitions++;
      prev = cur;
      if (st.result?.exit === 'yes' || st.result?.error !== undefined) break;
    }
    expect(steps).toBeGreaterThanOrEqual(5);
    expect(transitions).toBe(steps); // every single step moved the panels
  });

  it('exposes the goal stack with the current goal marked', async () => {
    const s = await loaded(`p(X) :- q(X), write(done).\nq(1).\n?- p(V).`);
    await s.step(); // resolve p → q(V), write(done)
    await s.step(); // resolve q
    const goals = s.state().find((p) => p.id === 'goals');
    expect(goals).toBeDefined();
    if (goals !== undefined && goals.kind === 'listing') {
      expect(goals.rows.some((r) => r.current)).toBe(true);
      expect(goals.rows.some((r) => r.text.includes('write(done)'))).toBe(true);
    }
  });

  it('choice points list open alternatives, newest first', async () => {
    const s = await loaded(`${MEMBER}?- member(X, [a, b]).`);
    await s.run();
    // first solution found via clause 1; the clause-2 alternative is open
    const cps = s.state().find((p) => p.id === 'choices');
    expect(cps).toBeDefined();
    if (cps !== undefined && cps.kind === 'listing') {
      expect(cps.rows.length).toBeGreaterThan(0);
      expect(cps.rows[0]!.text).toContain('member/2');
      expect(cps.rows[0]!.text).toContain('clause 2');
    }
  });

  it('bindings panel shows only the query\u2019s named variables', async () => {
    const s = await loaded(`${MEMBER}?- member(X, [a, b]).`);
    await s.run();
    const b = s.state().find((p) => p.id === 'bindings');
    expect(b).toBeDefined();
    if (b !== undefined && b.kind === 'fields') {
      expect(b.fields.map((f) => f.key)).toEqual(['X']);
      expect(b.fields[0]!.value).toBe('a');
    }
  });

  it('write/nl produce console output', async () => {
    const { text } = await runOnce(`?- write(hello), nl, write(world).`);
    expect(text).toBe('hello\nworldYes.\n');
  });
});

describe('breakpoints', () => {
  it('pauses before a rule\u2019s line fires', async () => {
    const s = await loaded(`p(X) :- q(X), X > 1.\n\nq(2).\nq(3).\n?- p(V).`);
    const r = await s.run([1]);
    expect(r.pausedAt).toBe(1);
    expect(r.finished).toBe(false);
    // the goal stack still shows the full resolvent: p(V) hasn't resolved
    const goals = s.state().find((p) => p.id === 'goals');
    if (goals !== undefined && goals.kind === 'listing') {
      expect(goals.rows[0]!.text).toContain('p(V)');
    }
  });

  it('resumes to the first solution after the pause', async () => {
    const s = await loaded(`p(X) :- q(X), X > 1.\n\nq(2).\nq(3).\n?- p(V).`);
    await s.run([1]);
    const r = await s.run();
    expect(r).toMatchObject({ finished: true, exit: 'yes' });
    expect(consoleOf(s.state())).toBe('Yes.\nV = 2\n');
  });
});

describe('session lifecycle', () => {
  it('reset() returns to the just-consulted state', async () => {
    const s = await loaded(`${MEMBER}?- member(X, [a, b]).`);
    await s.run();
    s.reset();
    expect(consoleOf(s.state())).toBe('');
    const r = await s.run();
    expect(r).toMatchObject({ exit: 'yes' });
    expect(consoleOf(s.state())).toBe('Yes.\nX = a\n');
  });

  it('load reports the consult summary', async () => {
    const s = prologKernel.createSession();
    const l = await s.load(`a(1).\nb(X) :- a(X).\n?- a(Y).`);
    expect(l.ok).toBe(true);
    if (l.ok) expect(l.summary).toBe('consulted · 2 clauses · 1 query');
  });

  it('run without load is an error', async () => {
    const s = prologKernel.createSession();
    const r = await s.run();
    expect(r.error).toBe('nothing is loaded');
  });
});
