// smoke.ts — bun smoke test for @didact/kernel-regex.
// Run: `bun packages/kernel-regex/test/smoke.ts`.
// Covers: matching semantics (leftmost-longest, captures, anchors,
// exact \d \w \s), line-mapped refusals and parse errors, the Session
// contract (panels, stepping, breakpoints, reset, dispose), budget
// linearity on the (a*)* demo, and a round-trip of every lesson block
// against its #+RESULTS.

import { regexKernel, parseBlock, decodeInput } from '../src/index';
import type { Panel } from '../src/index';

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1;
  } else {
    failures.push(detail === '' ? name : `${name} — ${detail}`);
  }
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${String(got)} want ${String(want)}`);
}

/** Load + run; returns [console text, run result]. */
async function runSession(src: string): Promise<{ text: string; result: { finished: boolean; steps: number; error?: string; pausedAt?: number; exit?: string }; panels: Panel[] }> {
  const s = regexKernel.createSession();
  const load = await s.load(src);
  if (!load.ok) throw new Error(`load failed: line ${load.line}: ${load.message}`);
  const result = await s.run();
  const panels = s.state();
  const con = panels.find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
  s.dispose();
  return { text: con?.text ?? '', result, panels };
}

async function verdict(src: string): Promise<string> {
  return (await runSession(src)).text;
}

// ─── semantics ──────────────────────────────────────────────────────────────
console.log('semantics · leftmost-longest, spans, captures');
eq('literal span', await verdict('/ab/\nxxabx'), 'match [2,4)');
eq('class span', await verdict('/[abc]+/\nzzabcaz'), 'match [2,6)');
eq('negated class', await verdict('/[^0-9]+/\n12ab3'), 'match [2,4)');
eq('alternation keeps the longest', await verdict('/a|ab/\nab'), 'match [0,2)');
eq('either order agrees', await verdict('/ab|a/\nab'), 'match [0,2)');
eq('counted quantifier', await verdict('/a{2,3}/\naaaa'), 'match [0,3)');
eq('open counted quantifier', await verdict('/a{2,}/\naaaaa'), 'match [0,5)');
eq('nested captures', await verdict('/(a(b))c/\nxabc'), 'match [1,4) groups: 1=[1,3) 2=[2,3)');
eq('last iteration of a group', await verdict('/(ab)+/\nabab'), 'match [0,4) groups: 1=[2,4)');
eq('dead branch group is none', await verdict('/(a)|b/\nb'), 'match [0,1) groups: 1=none');
eq('non-capturing group', await verdict('/(?:ab)+c/\nababc'), 'match [0,5)');
eq('caret anchors at 0 only', await verdict('/^ab/\nxab'), 'no match');
eq('dollar anchors at end only', await verdict('/c$/\nabcx'), 'no match');
eq('dot refuses newline', await verdict('/a.b/\na\\nb'), 'no match');
eq('dot accepts anything else', await verdict('/.*/\nab\\ncd'), 'match [0,2)');
eq('literal newline via \\n', await verdict('/\\n/\na\\nb'), 'match [1,2)');
eq('no multiline', await verdict('/^b$/\na\\nb'), 'no match');
eq('exact \\d', await verdict('/\\d/\nx9'), 'match [1,2)');
eq('exact \\w with underscore', await verdict('/\\w+/\n ab_1 '), 'match [1,5)');
eq('exact \\s on tab', await verdict('/\\s/\na\\tb'), 'match [1,2)');
eq('escaped punctuation', await verdict('/\\//\na/b'), 'match [1,2)');
eq('empty match', await verdict('/a?/\nb'), 'match [0,0)');
eq('unanchored search walks offsets', await verdict('/aa/\naxaa'), 'match [2,4)');
console.log('semantics: spans, groups, anchors, classes exact');

// ─── block format and errors ────────────────────────────────────────────────
console.log('errors · block format, refusals, parse errors');
{
  const block = parseBlock('# comment\n/ab/\nab\n\n# more\nba');
  check(
    'block parses pattern and inputs',
    block.ok && block.inputs.length === 2 && block.pattern === 'ab' && block.patternLine === 2,
  );
  eq('input escapes decode', decodeInput('a\\nb\\t\\\\c'), 'a\nb\t\\c');
  const s = regexKernel.createSession();
  const load = await s.load('/ab/\nab');
  check('load summary', load.ok && load.summary === 'loaded · /ab/ · 3 states · 0 groups · 1 input', load.ok ? load.summary : load.message);
  s.dispose();
}
{
  const cases: Array<[string, string, number]> = [
    ['/(a)\\1/\naa', 'backreferences (\\1) are not supported', 1],
    ['/a(?=b)/\nab', 'lookahead (?=…)', 1],
    ['/a*?/\naa', "lazy quantifier '*?'", 1],
    ['/(?<n>a)/\na', 'named groups', 1],
    ['/\\p{L}/\na', 'unicode classes', 1],
    ['/\\bx/\nx', 'word boundaries', 1],
    ['/*/\na', "quantifier '*' has nothing to repeat", 1],
    ['/(ab/\nab', "unclosed group", 1],
    ['/ab)/\nab', "unmatched ')'", 1],
    ['/a{2,1}/\naa', 'bad quantifier', 1],
    ['/a{x}/\naa', "bad quantifier '{x}'", 1],
    ['/[]/\nab', 'empty class', 1],
    ['/[z-a]/\nab', "bad range 'z-a'", 1],
    ['# c\n\n/(ab)/\nab', 'should load with leading comments', -1],
  ];
  for (const [src, want, line] of cases) {
    const s = regexKernel.createSession();
    const load = await s.load(src);
    if (line === -1) {
      check(`loads: ${src.split('\n')[2]}`, load.ok, load.ok ? '' : load.message);
    } else {
      check(`refuses: ${want}`, !load.ok && load.ok === false && load.message.includes(want) && load.line === line,
        !load.ok ? `line ${load.line}: ${load.message}` : 'loaded unexpectedly');
    }
    s.dispose();
  }
}
console.log('errors: every refusal is line-mapped and names the feature');

// ─── session contract ───────────────────────────────────────────────────────
console.log('contract · stepping, panels, breakpoints, reset, dispose');
{
  const s = regexKernel.createSession();
  await s.load('/abc/\nabc');
  const texts: string[] = [];
  let i = 0;
  for (;;) {
    const { ran, result } = await s.step();
    if (!ran) {
      eq('step then bookkeeping reports finished', result!.finished, true);
      break;
    }
    i += 1;
    const states = s.state().find((p): p is Extract<Panel, { kind: 'listing' }> => p.kind === 'listing' && p.id === 'states');
    texts.push(states!.rows.map((r) => r.text).join(','));
  }
  eq('N chars are N steps', i, 3);
  eq('panel text changes every step', texts.join('|'), "char 'b'|char 'c'|ACCEPT");
  const con = s.state().find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
  eq('verdict lands in console', con!.text, 'match [0,3)');
  s.dispose();
  eq('dispose empties the run', (await s.run()).error, 'nothing is loaded');
}
{
  const s = regexKernel.createSession();
  await s.load('/ab/\nab\naab\nab');
  const paused = await s.run([3]);
  eq('breakpoint pauses before input line 3', paused.pausedAt, 3);
  eq('earlier lines have verdicts', s.state().find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console')!.text, 'match [0,2)');
  const done = await s.run();
  eq('resume finishes', done.finished, true);
  const again = await s.run([3]);
  check('finished run does not pause again', again.finished && again.pausedAt === undefined);
  s.reset();
  const rerun = await s.run();
  eq('reset restores the fresh machine', rerun.steps, 8);
}
{
  const s = regexKernel.createSession();
  await s.load('/(a)(b)/\nab');
  await s.step();
  const caps = s.state().find((p): p is Extract<Panel, { kind: 'fields' }> => p.id === 'captures');
  eq('captures after one char', caps!.fields.map((f) => `${f.key}=${f.value}`).join(','), '1=[0,1),2=open at 1');
  const states = s.state().find((p): p is Extract<Panel, { kind: 'listing' }> => p.id === 'states');
  eq('marker states visible', states!.rows.map((r) => r.text).join('|'), 'group 1 close [0,1)|group 2 open at 1|char \'b\'');
  s.dispose();
}

// ─── budget and linearity ───────────────────────────────────────────────────
console.log('bounds · (a*)* is linear, budgets are hard');
{
  const r = await runSession(`/(a*)*/\n${'a'.repeat(1000)}b`);
  eq('1001-char input, 1001 steps', r.result.steps, 1001);
  eq('(a*)* verdict', r.text, 'match [0,1000) groups: 1=[0,1000)');
  const shorter = await runSession(`/(a*)*/\n${'a'.repeat(100)}b`);
  eq('101-char input, 101 steps', shorter.result.steps, 101);
}
{
  const s = regexKernel.createSession();
  await s.load(`/x{50}y/\n${'x'.repeat(2500)}`);
  const r = await s.run();
  check('runaway search hits the budget', !r.finished && r.error === 'run budget exceeded: 100000 char-steps (line 2)', r.error ?? 'finished');
  const sticky = await s.run();
  eq('budget error is sticky', sticky.error, r.error);
}
{
  const s = regexKernel.createSession();
  const load = await s.load(`/a{5000}/\n${'a'.repeat(10)}`);
  check('state cap refuses at load', !load.ok && load.ok === false && load.line === 1 && load.message.includes('4096 NFA states'),
    !load.ok ? load.message : 'compiled unexpectedly');
}

// ─── lesson/lesson.org: every block runs and matches its #+RESULTS ─────────
console.log('session · lesson round-trip');
{
  const blocks: string[] = [];
  const expected: string[] = [];
  const org = await Bun.file(`${import.meta.dir}/../lesson/lesson.org`).text();
  const lines = org.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('#+BEGIN_SRC regex')) {
      const body: string[] = [];
      for (let j = i + 1; !lines[j]!.startsWith('#+END_SRC'); j++) body.push(lines[j]!);
      blocks.push(body.join('\n'));
    }
    if (lines[i]!.startsWith('#+RESULTS:')) {
      const body: string[] = [];
      for (let j = i + 1; lines[j] !== undefined && lines[j]!.startsWith(': '); j++) {
        body.push(lines[j]!.slice(2));
      }
      expected.push(body.join('\n'));
    }
  }
  eq('lesson has 11 executable blocks', blocks.length, 11);
  eq('lesson has 11 results slots', expected.length, 11);
  for (let k = 0; k < blocks.length; k++) {
    const s = regexKernel.createSession();
    const load = await s.load(blocks[k]!);
    check(`lesson block ${k + 1} loads`, load.ok, load.ok ? '' : `line ${load.line}: ${load.message}`);
    const r = await s.run();
    check(`lesson block ${k + 1} finishes`, r.finished && r.error === undefined, r.error ?? '');
    const con = s.state().find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
    eq(`lesson block ${k + 1} output = ${JSON.stringify(expected[k])}`, con?.text.trim() ?? '', expected[k]!);
    s.dispose();
  }
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} FAILED / ${pass} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`all ${pass} checks passed`);
