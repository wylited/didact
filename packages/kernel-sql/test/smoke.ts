// smoke.ts (bun run): every lesson block loads, runs, and reproduces its
// #+RESULTS byte-for-byte (trailing psql padding included); plus a few
// end-to-end session checks that need no DOM.
import { sqlKernel } from '../src/index';
import type { Panel, RunResult, Session } from '../src/index';

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; return; }
  failures.push(detail === '' ? name : `${name} — ${detail}`);
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

function consoleOf(panels: Panel[]): string {
  const p = panels.find((q): q is Extract<Panel, { kind: 'console' }> => q.kind === 'console');
  if (p === undefined) throw new Error('missing console panel');
  return p.text;
}

async function load(src: string): Promise<Session> {
  const s = sqlKernel.createSession();
  const r = await s.load(src);
  if (!r.ok) throw new Error(`fixture failed to load: line ${r.line}: ${r.message}`);
  return s;
}

// ─── session end-to-end ────────────────────────────────────────────────────

console.log('session · plan, step, breakpoints, budget');
{
  const s = await load(`CREATE TABLE t (a INTEGER, b TEXT);
INSERT INTO t VALUES (1, 'x'), (2, 'y'), (3, 'z');
SELECT a + 1 FROM t WHERE a >= 2;`);
  const r = await s.run();
  eq('run finishes', r.finished, true);
  eq('run steps = row ops (3 insert + 3 scan + 3 filter + 2 project)', r.steps, 11);
  eq('console', consoleOf(s.state()),
    'INSERT 0 3\n\n a + 1 \n-------\n 3     \n 4     \n');
  const plan = s.state().find((q): q is Extract<Panel, { kind: 'listing' }> => q.kind === 'listing' && q.id === 'plan');
  check('plan panel exists', plan !== undefined);
  if (plan !== undefined) {
    eq('plan rows', plan.rows.map((row) => `${row.text} [${row.bytes}]`).join(' | '),
      'Scan t [3/3/3] | Filter a >= 2 [3/2/2] | Project a + 1 [2/2/2]');
  }
  s.dispose();

  const b = await load(`CREATE TABLE t (a INTEGER);
INSERT INTO t VALUES (1), (2);
SELECT a FROM t WHERE a = 2;`);
  const paused = await b.run([3]);
  eq('breakpoint pauses before the SELECT line', paused.pausedAt, 3);
  eq('console holds earlier statements only', consoleOf(b.state()), 'INSERT 0 2\n');
  const done = await b.run();
  eq('run after pause finishes', done.finished, true);
  eq('full console', consoleOf(b.state()), 'INSERT 0 2\n\n a \n---\n 2 \n');
  b.dispose();

  const rows = Array.from({ length: 60 }, (_, i) => `INSERT INTO a VALUES (${i});`).join('\n');
  const rowsB = Array.from({ length: 80 }, (_, i) => `INSERT INTO b VALUES (${i});`).join('\n');
  const cross = await load(`CREATE TABLE a (x INTEGER);
CREATE TABLE b (y INTEGER);
${rows}
${rowsB}
SELECT COUNT(*) FROM a JOIN b ON a.x - b.y <= 10000;`);
  const cr = await cross.run();
  check('cross join 60×80 = 4800 probes completes', cr.finished === true && cr.steps === 60 + 80 + 60 + 4800 + 4800 + 1, JSON.stringify(cr));
  cross.dispose();

  const big = `CREATE TABLE a (x INTEGER);\nCREATE TABLE b (y INTEGER);\n${Array.from({ length: 400 }, (_, i) => `INSERT INTO a VALUES (${i});`).join('\n')}\n${Array.from({ length: 400 }, (_, i) => `INSERT INTO b VALUES (${i});`).join('\n')}\nSELECT COUNT(*) FROM a JOIN b ON a.x - b.y <= 100000;`;
  const bs = await load(big);
  const br = await bs.run();
  const lastLine = big.split('\n').length;
  check('400×400 dies on the budget with a line-named error',
    br.finished === false && br.error === `line ${lastLine}: budget exceeded — more than 100,000 row operations (a cross join of big tables does this)`,
    br.error ?? '');
  bs.dispose();

  const st = await load(`CREATE TABLE t (a INTEGER);
INSERT INTO t VALUES (1), (2);`);
  let steps = 0;
  for (;;) {
    const one = await st.step();
    if (!one.ran) break;
    steps++;
  }
  eq('stepping does exactly one row op each (0 create + 2 insert)', steps, 3);
  eq('stepped console', consoleOf(st.state()), 'INSERT 0 2\n');
  st.reset();
  const rr: RunResult = await st.run();
  eq('reset restores just-loaded state, run works again', rr.finished && consoleOf(st.state()) === 'INSERT 0 2\n', true);
  st.dispose();
}

// ─── lesson/lesson.org: every block runs and matches its #+RESULTS ─────────

console.log('session · lesson round-trip');
{
  const blocks: string[] = [];
  const expected: string[] = [];
  const org = await Bun.file(`${import.meta.dir}/../lesson/lesson.org`).text();
  const lines = org.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('#+BEGIN_SRC sql')) {
      const body: string[] = [];
      for (let j = i + 1; !lines[j]!.startsWith('#+END_SRC'); j++) body.push(lines[j]!);
      blocks.push(body.join('\n'));
    }
    if (lines[i]!.startsWith('#+RESULTS:')) {
      const body: string[] = [];
      for (let j = i + 1; lines[j] !== undefined && (lines[j]!.startsWith(': ') || lines[j]!.startsWith(':')); j++) {
        body.push(lines[j]!.replace(/^: ?/, ''));
      }
      expected.push(body.join('\n'));
    }
  }
  eq('lesson has 6 executable blocks', blocks.length, 6);
  eq('lesson has 6 results slots', expected.length, 6);
  // Block 4 (grouping-rule) deliberately stops with the GROUP BY error; its
  // #+RESULTS are everything printed before the statement began.
  const expectError = [false, false, false, true, false, false];
  for (let k = 0; k < blocks.length; k++) {
    const s = sqlKernel.createSession();
    const loadR = await s.load(blocks[k]!);
    check(`lesson block ${k + 1} loads`, loadR.ok, loadR.ok ? '' : `line ${loadR.line}: ${loadR.message}`);
    const r = await s.run();
    if (expectError[k]) {
      check(`lesson block ${k + 1} stops with the grouping rule`,
        (r.error ?? '').includes("column 'name' must appear in GROUP BY or inside an aggregate"), r.error ?? '');
    } else {
      check(`lesson block ${k + 1} finishes`, r.finished && r.error === undefined, r.error ?? '');
    }
    eq(`lesson block ${k + 1} output = #+RESULTS`, consoleOf(s.state()).replace(/\n$/, ''), expected[k]!);
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
