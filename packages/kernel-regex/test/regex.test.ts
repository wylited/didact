import { describe, expect, it } from 'vitest';
import {
  regexKernel, RegexSession, parsePattern, compilePattern, RegexError,
  type LoadResult, type Panel, type RunResult,
} from '../src/index';

/** Load + run a block; returns console text, run result and panels. */
async function runSession(src: string): Promise<{ text: string; result: RunResult; panels: Panel[] }> {
  const s = regexKernel.createSession();
  const load = await s.load(src);
  if (!load.ok) throw new Error(`load failed: line ${load.line}: ${load.message}`);
  const result = await s.run();
  const panels = s.state();
  const con = panels.find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
  return { text: con?.text ?? '', result, panels };
}

/** Load a broken block; asserts and returns its failure shape. */
async function loadFailure(src: string): Promise<Extract<LoadResult, { ok: false }>> {
  const s = regexKernel.createSession();
  const load = await s.load(src);
  expect(load.ok).toBe(false);
  return load as Extract<LoadResult, { ok: false }>;
}

function listingOf(panels: Panel[], id: string): Extract<Panel, { kind: 'listing' }> {
  const p = panels.find((q): q is Extract<Panel, { kind: 'listing' }> => q.id === id && q.kind === 'listing');
  if (p === undefined) throw new Error(`missing listing panel ${id}`);
  return p;
}

function fieldsOf(panels: Panel[], id: string): Extract<Panel, { kind: 'fields' }> {
  const p = panels.find((q): q is Extract<Panel, { kind: 'fields' }> => q.id === id && q.kind === 'fields');
  if (p === undefined) throw new Error(`missing fields panel ${id}`);
  return p;
}

describe('registration and load', () => {
  it('declares the org id, label, syntax, and features', () => {
    expect(regexKernel.id).toBe('regex');
    expect(regexKernel.label).toBe('Regex · NFA engine');
    expect(regexKernel.editorSyntax).toBe('plain');
    expect(regexKernel.features).toEqual({ breakpoints: true, stepping: true });
  });

  it('summarizes the machine and the inputs', async () => {
    const s = regexKernel.createSession();
    const load = await s.load('/ab/\nab\naab');
    expect(load).toEqual({ ok: true, summary: 'loaded · /ab/ · 3 states · 0 groups · 2 inputs' });
    s.dispose();
    expect(await s.run()).toEqual({ finished: false, steps: 0, error: 'nothing is loaded' });
    expect(s.state()).toEqual([{ kind: 'console', id: 'console', title: 'console', text: '' }]);
  });

  it('comments and blank lines between inputs are ignored', async () => {
    const s = regexKernel.createSession();
    const load = await s.load('/a/\n# before\na\n\n# between\nba\n');
    expect(load).toEqual({ ok: true, summary: 'loaded · /a/ · 2 states · 0 groups · 2 inputs' });
  });

  it('refuses blocks with no pattern or no inputs, 1-based', async () => {
    const noPattern = await loadFailure('');
    expect(noPattern.line).toBe(1);
    expect(noPattern.message).toBe('no pattern line: start the block with the pattern between slashes');
    const firstBad = await loadFailure('ab\nab');
    expect(firstBad.line).toBe(1);
    expect(firstBad.message).toContain('the first line must be the pattern between slashes');
    const noInputs = await loadFailure('/ab/');
    expect(noInputs.line).toBe(1);
    expect(noInputs.message).toBe('no test inputs — add one input line after the pattern');
    const noClose = await loadFailure('/ab\nab');
    expect(noClose.line).toBe(1);
    expect(noClose.message).toBe('the pattern line is missing its closing /');
    const flags = await loadFailure('/ab/i\nab');
    expect(flags.line).toBe(1);
    expect(flags.message).toBe("flags after the closing / are not supported in v1 (found 'i') — there is no i, g or m");
  });
});

describe('literals, classes, and spans', () => {
  it('matches class runs with exact leftmost-longest spans', async () => {
    const r = await runSession('/[abc]+/\nzzabcaz\nzzz');
    expect(r.text).toBe('match [2,6)\nno match');
    expect(r.result).toEqual({ finished: true, steps: 10, exit: 'exit(0)' });
  });

  it('negated classes and ranges', async () => {
    expect((await runSession('/[^0-9]+/\n12ab3')).text).toBe('match [2,4)');
    expect((await runSession('/[a-z]{3}/\nxabcd')).text).toBe('match [0,3)');
    expect((await runSession('/[-a]+/\na-b')).text).toBe('match [0,2)');
  });

  it('literals match themselves; escapes undo metacharacters', async () => {
    expect((await runSession('/ab/\nxxabx')).text).toBe('match [2,4)');
    expect((await runSession('/a\\.b/\na.b\naxb')).text).toBe('match [0,3)\nno match');
    expect((await runSession('/a\\*/\naa*')).text).toBe('match [1,3)');
    expect((await runSession('/\\//\na/b')).text).toBe('match [1,2)');
    expect((await runSession('/\\\\/\na\\\\b')).text).toBe('match [1,2)');
  });
});

describe('alternation is leftmost-longest, not first-branch', () => {
  it('a|ab on "ab" matches the longer alternative', async () => {
    expect((await runSession('/a|ab/\nab')).text).toBe('match [0,2)');
    expect((await runSession('/ab|a/\nab\na\nxab')).text).toBe('match [0,2)\nmatch [0,1)\nmatch [1,3)');
  });

  it('unanchored search walks the offsets left to right', async () => {
    expect((await runSession('/aa/\naaa')).text).toBe('match [0,2)');
    expect((await runSession('/b+/\nabbbc')).text).toBe('match [1,4)');
    expect((await runSession('/aa/\naxaa')).text).toBe('match [2,4)');
  });
});

describe('quantifiers, including counted {n,m}', () => {
  it('{n} {n,} {n,m} expand into copies', async () => {
    expect((await runSession('/a{2,3}/\naaaa\naa\na')).text).toBe('match [0,3)\nmatch [0,2)\nno match');
    expect((await runSession('/a{2}/\naaa')).text).toBe('match [0,2)');
    expect((await runSession('/a{2,}/\naaaaa\na')).text).toBe('match [0,5)\nno match');
    expect((await runSession('/colou?r/\ncolor\ncolour\ncolr')).text).toBe('match [0,5)\nmatch [0,6)\nno match');
  });

  it('an empty match reports a zero-width span', async () => {
    expect((await runSession('/a?/\nb')).text).toBe('match [0,0)');
  });
});

describe('groups and capture spans', () => {
  it('nested groups report nested half-open spans', async () => {
    expect((await runSession('/(a(b))c/\nxabc')).text).toBe('match [1,4) groups: 1=[1,3) 2=[2,3)');
  });

  it('a repeated group keeps its last iteration', async () => {
    expect((await runSession('/(ab)+/\nabab\nab')).text)
      .toBe('match [0,4) groups: 1=[2,4)\nmatch [0,2) groups: 1=[0,2)');
  });

  it('a group on a dead branch reports none', async () => {
    expect((await runSession('/(a)|b/\nb')).text).toBe('match [0,1) groups: 1=none');
  });

  it('(?:…) groups without capturing', async () => {
    expect((await runSession('/(?:ab)+c/\nababc')).text).toBe('match [0,5)');
  });
});

describe('anchors pin the whole string', () => {
  it('^ and $ hold only at 0 and at the end', async () => {
    expect((await runSession('/^ab/\nabx\nxab')).text).toBe('match [0,2)\nno match');
    expect((await runSession('/c$/\nabc\nabcx')).text).toBe('match [2,3)\nno match');
    expect((await runSession('/^abc$/\nabc\nxabc')).text).toBe('match [0,3)\nno match');
    expect((await runSession('/^$/\na')).text).toBe('no match');
  });

  it('. matches anything except newline; \\n is matchable literally', async () => {
    expect((await runSession('/a.b/\na\\nb\naxb')).text).toBe('no match\nmatch [0,3)');
    expect((await runSession('/.*/\nab\\ncd')).text).toBe('match [0,2)');
    expect((await runSession('/./\n\\n\n\\t')).text).toBe('no match\nmatch [0,1)');
    expect((await runSession('/\\n/\na\\nb')).text).toBe('match [1,2)');
    expect((await runSession('/^b$/\na\\nb')).text).toBe('no match');
  });
});

describe('the predefined classes are exact', () => {
  it('\\d is [0-9] and nothing else', async () => {
    expect((await runSession('/\\d/\nx9')).text).toBe('match [1,2)');
    expect((await runSession('/\\d+/\nabc123')).text).toBe('match [3,6)');
    expect((await runSession('/\\D/\n9x')).text).toBe('match [1,2)');
  });

  it('\\w is [A-Za-z0-9_], underscores included', async () => {
    expect((await runSession('/\\w+/\n ab_1 ')).text).toBe('match [1,5)');
    expect((await runSession('/\\W/\na-b')).text).toBe('match [1,2)');
    expect((await runSession('/\\w+ \\d+/\nroom 404\nroom 4o4')).text).toBe('match [0,8)\nmatch [0,6)');
  });

  it('\\s is exactly blank, \\t, \\r, \\n, \\f, \\v', async () => {
    expect((await runSession('/\\s/\na b\na\\tb')).text).toBe('match [1,2)\nmatch [1,2)');
    expect((await runSession('/\\s/\na\\rb')).text).toBe('match [1,2)');
    expect((await runSession('/\\s/\na\\fb')).text).toBe('match [1,2)');
    expect((await runSession('/\\s/\na\\vb')).text).toBe('match [1,2)');
    expect((await runSession('/\\s/\na-b')).text).toBe('no match');
    expect((await runSession('/\\s[a-z]+/\nhi there\nhi\\tthere')).text).toBe('match [2,8)\nmatch [2,8)');
  });
});

describe('features outside the subset refuse with the pattern line', () => {
  it('backreferences name the NFA reason and the line', async () => {
    const backref = await loadFailure('# comment\n\n/(a)\\1/\naa');
    expect(backref.line).toBe(3);
    expect(backref.message).toBe(
      'backreferences (\\1) are not supported: an NFA has no memory of what an earlier group matched — that takes unbounded store, which finite automata do not have',
    );
  });

  it('lookahead and lookbehind', async () => {
    expect((await loadFailure('/a(?=b)/\nab')).message)
      .toBe('lookahead (?=…) is not supported: it needs a sub-match peeking ahead — v1 keeps the engine strictly one pass, left to right');
    expect((await loadFailure('/a(?!b)/\nab')).message).toContain('negative lookahead (?!…)');
    expect((await loadFailure('/a(?<=b)/\nab')).message).toContain('lookbehind (?<=…)');
    expect((await loadFailure('/a(?<!b)/\nab')).message).toContain('negative lookbehind (?<!…)');
  });

  it('lazy quantifiers, named groups, unicode classes, word boundaries', async () => {
    expect((await loadFailure('/a*?/\naa')).message)
      .toBe("lazy quantifier '*?' is not supported: matching here is leftmost-longest, so there is no try-shortest-first");
    expect((await loadFailure('/a+?/\naa')).message).toContain("lazy quantifier '+?'");
    expect((await loadFailure('/a{2,3}?/\naa')).message).toContain('lazy quantifier');
    expect((await loadFailure('/(?<year>\\d)/\n1')).message)
      .toBe('named groups (?<name>…) are not supported in v1 — use plain (…)');
    expect((await loadFailure('/(?P<year>\\d)/\n1')).message)
      .toBe('named groups (?P<name>…) are not supported in v1 — use plain (…)');
    expect((await loadFailure('/\\p{L}/\na')).message)
      .toBe('unicode classes (\\p{L}) are not supported in v1 — write the characters out in a class, or use \\d \\w \\s');
    expect((await loadFailure('/\\bword\\b/\nword')).message).toContain('word boundaries (\\b)');
  });
});

describe('parse errors are line-mapped to the pattern', () => {
  it('structural errors name the construct', async () => {
    expect((await loadFailure('/*abc/\nabc')).message).toBe("quantifier '*' has nothing to repeat");
    expect((await loadFailure('/a|*/\nabc')).message).toBe("quantifier '*' has nothing to repeat");
    expect((await loadFailure('/(ab/\nab')).message).toBe("unclosed group: the '(' is never closed");
    expect((await loadFailure('/(?:ab/\nab')).message).toBe("unclosed group: the '(' is never closed");
    expect((await loadFailure('/ab)/\nab')).message).toBe("unmatched ')' — escape a literal ) as \\)");
    expect((await loadFailure('/[ab/\nab')).message).toBe("unclosed class: '[' is never closed");
    expect((await loadFailure('/[]/\nab')).message).toContain('empty class');
    expect((await loadFailure('/[a-\\d]/\nab')).message).toContain('escapes inside classes are not supported');
  });

  it('counted quantifier errors name the braces', async () => {
    expect((await loadFailure('/a{2,1}/\naa')).message)
      .toBe('bad quantifier \'{2,1}\' — the minimum 2 is greater than the maximum 1');
    expect((await loadFailure('/a{x}/\naa')).message)
      .toBe("bad quantifier '{x}' — expected {n}, {n,} or {n,m} (a literal { is \\{)");
    expect((await loadFailure('/a{,3}/\naa')).message).toContain("bad quantifier '{,3}'");
    expect((await loadFailure('/a{/\naa')).message).toBe("'{' is never closed — a quantifier looks like {n}, {n,} or {n,m} (a literal { is \\{)");
    expect((await loadFailure('/*/\na')).message).toBe("quantifier '*' has nothing to repeat");
    expect((await loadFailure('/a}/\naa')).message).toBe("unmatched '}' — a literal } is written \\}");
  });

  it('class range errors', async () => {
    expect((await loadFailure('/[z-a]/\nab')).message).toBe("bad range 'z-a': the start must not come after the end");
  });

  it('the error line is the pattern line wherever it sits', async () => {
    const late = await loadFailure('# intro\n\n# more\n/(ab/\nab');
    expect(late.line).toBe(4);
  });

  it('a pattern past the state cap refuses at load', async () => {
    const big = await loadFailure(`/a{5000}/\n${'a'.repeat(100)}`);
    expect(big.line).toBe(1);
    expect(big.message).toBe('pattern is too large: it expands past 4096 NFA states — reduce the {n,m} counts');
  });
});

describe('stepping is one character per step', () => {
  it('N characters are N steps, panels change every step', async () => {
    const s = regexKernel.createSession();
    expect(await s.load('/abc/\nabc')).toEqual({ ok: true, summary: 'loaded · /abc/ · 4 states · 0 groups · 1 input' });
    const seen: string[][] = [];
    for (let i = 1; i <= 3; i += 1) {
      const { ran, result } = await s.step();
      expect(ran).toBe(true);
      expect(result?.steps).toBe(i);
      seen.push(listingOf(s.state(), 'states').rows.map((r) => r.text));
    }
    expect(seen).toEqual([["char 'b'"], ["char 'c'"], ['ACCEPT']]);
    // every row arrived with its character: all are marked current
    const rows = listingOf(s.state(), 'states').rows;
    expect(rows[0]).toMatchObject({ addr: 3, text: 'ACCEPT', current: true });
    const done = await s.step();
    expect(done.ran).toBe(false);
    expect(done.result).toEqual({ finished: true, steps: 3, exit: 'exit(0)' });
    const con = s.state().find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
    expect(con?.text).toBe('match [0,3)');
  });

  it('captures open and close visibly while stepping', async () => {
    const s = regexKernel.createSession();
    await s.load('/(a)(b)/\nab');
    await s.step();
    const afterA = listingOf(s.state(), 'states').rows.map((r) => r.text);
    expect(afterA).toEqual(['group 1 close [0,1)', 'group 2 open at 1', "char 'b'"]);
    const capA = fieldsOf(s.state(), 'captures').fields;
    expect(capA).toEqual([
      { key: '1', value: '[0,1)', sub: 'a', changed: true, tip: 'capturing group 1, numbered by opening parenthesis' },
      { key: '2', value: 'open at 1', sub: '', changed: true, tip: 'capturing group 2, numbered by opening parenthesis' },
    ]);
    await s.step();
    const afterB = listingOf(s.state(), 'states').rows.map((r) => r.text);
    expect(afterB).toEqual(['group 2 close [1,2)', 'ACCEPT']);
    const capB = fieldsOf(s.state(), 'captures').fields;
    expect(capB.map((f) => [f.key, f.value, f.sub])).toEqual([['1', '[0,1)', 'a'], ['2', '[1,2)', 'b']]);
    // group 1 did not change on this step; group 2 did
    expect(capB[0]!.changed).toBeUndefined();
    expect(capB[1]!.changed).toBe(true);
  });

  it('the machine panel shows the compiled NFA with edges', async () => {
    const s = regexKernel.createSession();
    await s.load('/a|b/\nab');
    const machine = listingOf(s.state(), 'machine');
    expect(machine.rows.map((r) => r.text)).toEqual([
      "char 'a' → 3",
      "char 'b' → 3",
      'split → 0 | 1',
      'ACCEPT',
    ]);
    await s.run();
    const live = listingOf(s.state(), 'machine').rows.filter((r) => r.current);
    expect(live.map((r) => r.text)).toEqual(['ACCEPT']);
  });

  it('the input panel tracks the caret and brackets the match', async () => {
    const s = regexKernel.createSession();
    await s.load('/ab/\naaab');
    const before = listingOf(s.state(), 'input').rows;
    expect(before).toEqual([{ addr: 0, bytes: '0/4', text: '│aaab', line: 2, current: true, tip: 'source line 2 · match attempt at start offset 0 · 0 chars consumed this attempt' }]);
    await s.step();
    expect(listingOf(s.state(), 'input').rows[0]).toMatchObject({ bytes: '1/4', text: 'a│aab', current: true });
    await s.run();
    const doneRow = listingOf(s.state(), 'input').rows[0]!;
    expect(doneRow).toMatchObject({ bytes: 'match', text: 'aa[ab]' });
    expect(doneRow.current).toBeUndefined();
  });

  it('unanchored restarts are visible in the input tip', async () => {
    const s = regexKernel.createSession();
    await s.load('/bc/\nabc');
    await s.step(); // consumes 'a', attempt at offset 0 dies
    await s.step(); // consumes 'b' at offset 1
    const row = listingOf(s.state(), 'input').rows[0]!;
    expect(row.bytes).toBe('2/3');
    expect(row.tip).toBe('source line 2 · match attempt at start offset 1 · 1 chars consumed this attempt');
  });
});

describe('breakpoints pause before an input line', () => {
  it('pauses with the line number and resumes', async () => {
    const s = regexKernel.createSession();
    await s.load('/ab/\nab\naab\nab');
    const paused = await s.run([3]);
    expect(paused).toEqual({ finished: false, steps: 2, pausedAt: 3 });
    const con = s.state().find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
    expect(con?.text).toBe('match [0,2)');
    const rows = listingOf(s.state(), 'input').rows;
    expect(rows.map((r) => [r.bytes, r.current])).toEqual([['match', undefined], ['0/3', true], ['0/2', undefined]]);
    const done = await s.run();
    expect(done).toEqual({ finished: true, steps: 8, exit: 'exit(0)' });
    const con2 = s.state().find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
    expect(con2?.text).toBe('match [0,2)\nmatch [1,3)\nmatch [0,2)');
    // a finished run does not pause again
    expect(await s.run([3])).toEqual({ finished: true, steps: 8, exit: 'exit(0)' });
  });

  it('pauses before the first line too', async () => {
    const s = regexKernel.createSession();
    await s.load('/a/\na\nba');
    const paused = await s.run([2]);
    expect(paused).toEqual({ finished: false, steps: 0, pausedAt: 2 });
  });
});

describe('linear by construction: (a*)* cannot explode', () => {
  it('1000 a’s and a b take exactly 1001 steps', async () => {
    const src = `/(a*)*/\n${'a'.repeat(1000)}b`;
    const r = await runSession(src);
    expect(r.result).toEqual({ finished: true, steps: 1001, exit: 'exit(0)' });
    expect(r.text).toBe('match [0,1000) groups: 1=[0,1000)');
  });

  it('a shorter input takes length+1 steps — the growth is linear', async () => {
    const r = await runSession(`/(a*)*/\n${'a'.repeat(100)}b`);
    expect(r.result.steps).toBe(101);
    expect(r.text).toBe('match [0,100) groups: 1=[0,100)');
  });

  it('the 100 000 char-step budget stops runaway searches with the line', async () => {
    const s = regexKernel.createSession();
    await s.load(`/x{50}y/\n${'x'.repeat(2500)}`);
    const r = await s.run();
    expect(r.finished).toBe(false);
    expect(r.steps).toBe(100_001);
    expect(r.error).toBe('run budget exceeded: 100000 char-steps (line 2)');
    // the error is sticky until reset, like a crashed program
    const again = await s.run();
    expect(again.error).toBe(r.error);
    s.reset();
    const fresh = await s.run();
    expect(fresh.error).toBe(r.error); // same input, same runaway search
    expect(fresh.steps).toBe(100_001);
  });
});

describe('reset returns to the just-loaded machine', () => {
  it('re-runs identically after reset', async () => {
    const s = regexKernel.createSession();
    await s.load('/(a|b)+/\nabb');
    const first = await s.run();
    expect(first).toEqual({ finished: true, steps: 3, exit: 'exit(0)' });
    s.reset();
    const second = await s.run();
    expect(second).toEqual(first);
    const con = s.state().find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
    expect(con?.text).toBe('match [0,3) groups: 1=[2,3)');
  });
});

describe('parser and compiler units', () => {
  it('numbering follows opening parentheses, not nesting', () => {
    const pat = parsePattern('(a(b))(c)', 1);
    expect(pat.groups).toBe(3);
    const nfa = compilePattern(pat, 1);
    expect(nfa.states.filter((st) => st.kind === 'groupOpen').map((st) => st.group)).toEqual([1, 2, 3]);
    expect(nfa.start).toBe(0);
    expect(nfa.states[nfa.accept]!.kind).toBe('accept');
  });

  it('RegexError carries the line', () => {
    expect(() => parsePattern('a**', 7)).toThrow(RegexError);
    try {
      parsePattern('a**', 7);
    } catch (e) {
      if (e instanceof RegexError) {
        expect(e.line).toBe(7);
        expect(e.message).toBe("quantifier '*' has nothing to repeat");
      }
    }
  });

  it('empty alternation branches and empty groups match the empty string', async () => {
    expect((await runSession('/a|/\nb')).text).toBe('match [0,0)');
    expect((await runSession('/(?:)/\nab')).text).toBe('match [0,0)');
  });
});

describe('session contract edges', () => {
  it('the built-in session class behaves like the kernel factory', async () => {
    const s = new RegexSession();
    expect((await s.load('/a/\na')).ok).toBe(true);
    expect((await s.run()).finished).toBe(true);
    s.dispose();
    expect((await s.run()).error).toBe('nothing is loaded');
  });

  it('run after finishing is idempotent', async () => {
    const s = regexKernel.createSession();
    await s.load('/a/\na');
    await s.run();
    expect(await s.run()).toEqual({ finished: true, steps: 1, exit: 'exit(0)' });
  });
});
