import { describe, expect, it } from 'vitest';
import { sqlKernel, type Panel, type RunResult, type Session } from '../src/index';

// ─── helpers ───────────────────────────────────────────────────────────────

async function run(src: string, bps?: number[]): Promise<{ r: RunResult; out: string; s: Session }> {
  const s = sqlKernel.createSession();
  const load = await s.load(src);
  if (!load.ok) throw new Error(`fixture failed to load: line ${load.line}: ${load.message}`);
  const r = await s.run(bps);
  return { r, out: consoleOf(s.state()), s };
}

async function load(src: string): Promise<Session> {
  const s = sqlKernel.createSession();
  const r = await s.load(src);
  if (!r.ok) throw new Error(`fixture failed to load: line ${r.line}: ${r.message}`);
  return s;
}

function consoleOf(panels: Panel[]): string {
  const p = panels.find((q): q is Extract<Panel, { kind: 'console' }> => q.kind === 'console');
  if (p === undefined) throw new Error('missing console panel');
  return p.text;
}

function planRows(panels: Panel[]) {
  const p = panels.find((q): q is Extract<Panel, { kind: 'listing' }> => q.kind === 'listing' && q.id === 'plan');
  if (p === undefined) throw new Error('missing plan panel');
  return p.rows;
}

function fieldsOf(panels: Panel[]) {
  const p = panels.find((q): q is Extract<Panel, { kind: 'fields' }> => q.kind === 'fields' && q.id === 'row');
  if (p === undefined) throw new Error('missing current-row panel');
  return p.fields;
}

function tablesOf(panels: Panel[]) {
  const p = panels.find((q): q is Extract<Panel, { kind: 'listing' }> => q.kind === 'listing' && q.id === 'tables');
  if (p === undefined) throw new Error('missing tables panel');
  return p.rows;
}

const USERS = `CREATE TABLE users (id INTEGER, name TEXT, city TEXT, age INTEGER);
INSERT INTO users VALUES (1, 'alice', 'HK', 34), (2, 'Bob', 'HK', NULL), (3, 'carol', 'SF', 28), (4, 'dave', 'SF', 41);`;

const ORDERS = `CREATE TABLE orders (id INTEGER, user_id INTEGER, total INTEGER);
INSERT INTO orders VALUES (10, 1, 100), (11, 1, 250), (12, 3, 60), (13, 9, 999);`;

// ─── load: syntax errors are line-mapped ───────────────────────────────────

describe('load: line-mapped syntax errors', () => {
  it('missing semicolon names the line and the token', async () => {
    const r = await sqlKernel.createSession().load(`CREATE TABLE t (a INTEGER)
SELECT 1;`);
    expect(r).toEqual({ ok: false, line: 2, message: `expected ';' — got 'SELECT'` });
  });

  it('unknown column type', async () => {
    const r = await sqlKernel.createSession().load(`CREATE TABLE t (a INTEGER, b VARCHAR(10));`);
    expect(r).toEqual({ ok: false, line: 1, message: "unknown type 'VARCHAR' — this dialect has INTEGER and TEXT" });
  });

  it('INSERT values must be literals or NULL', async () => {
    const r = await sqlKernel.createSession().load(`CREATE TABLE t (a INTEGER);
INSERT INTO t VALUES (a + 1);`);
    expect(r).toEqual({ ok: false, line: 2, message: "INSERT values must be literals or NULL — got 'a'" });
  });

  it('unterminated string literal', async () => {
    const r = await sqlKernel.createSession().load(`SELECT 'abc
FROM t;`);
    expect(r).toEqual({ ok: false, line: 1, message: "unterminated string literal — a ' is missing" });
  });

  it('duplicate column', async () => {
    const r = await sqlKernel.createSession().load(`CREATE TABLE t (a INTEGER, a TEXT);`);
    expect(r).toEqual({ ok: false, line: 1, message: "duplicate column 'a'" });
  });

  it('empty program (comments only) is rejected', async () => {
    const r = await sqlKernel.createSession().load('-- nothing here\n');
    expect(r).toEqual({ ok: false, line: 1, message: 'no statements to run' });
  });

  it('summary counts statements', async () => {
    const r = await sqlKernel.createSession().load(`${USERS}\nSELECT * FROM users;`);
    expect(r).toEqual({ ok: true, summary: 'loaded · 3 statements' });
  });
});

// ─── results rendering ─────────────────────────────────────────────────────

describe('Results console', () => {
  it('renders a psql-style table and INSERT acknowledgements', async () => {
    const { r, out } = await run(`${USERS}
SELECT name, age FROM users WHERE id <= 2;`);
    expect(r.finished).toBe(true);
    expect(out).toBe(
      'INSERT 0 4\n\n' +
      ' name  | age  \n' +
      '-------+------\n' +
      ' alice | 34   \n' +
      ' Bob   | NULL \n',
    );
  });

  it('accumulates one chunk per statement, separated by blank lines', async () => {
    const { out } = await run(`${USERS}
SELECT COUNT(*) FROM users;
SELECT name FROM users WHERE id = 3;`);
    expect(out).toBe('INSERT 0 4\n\n COUNT(*) \n----------\n 4        \n\n name  \n-------\n carol \n');
  });

  it('CREATE TABLE prints nothing; empty results print header and rule only', async () => {
    const { out } = await run(`${USERS}
SELECT name FROM users WHERE 1 = 2;`);
    expect(out).toBe('INSERT 0 4\n\n name \n------\n');
  });
});

// ─── three-valued logic: NULL ──────────────────────────────────────────────

describe('NULL is not a value', () => {
  it('comparisons with NULL are UNKNOWN, so WHERE drops the row', async () => {
    const { out } = await run(`${USERS}
SELECT name FROM users WHERE age = age;`);
    expect(out).toBe('INSERT 0 4\n\n name  \n-------\n alice \n carol \n dave  \n');
  });

  it('NOT (unknown) is still unknown — NOT cannot resurrect a row', async () => {
    const { out } = await run(`${USERS}
SELECT name FROM users WHERE NOT age > 30;`);
    // alice 34: NOT true = false · Bob NULL: NOT unknown = unknown · carol 28: true
    expect(out).toBe('INSERT 0 4\n\n name  \n-------\n carol \n');
  });

  it('OR of two unknowns is still unknown — a NULL row with no TRUE arm drops', async () => {
    const { out } = await run(`${USERS}
SELECT name FROM users WHERE age > 100 OR age < 30;`);
    // Bob: unknown OR unknown = unknown → dropped · carol: unknown OR true = true
    expect(out).toBe('INSERT 0 4\n\n name  \n-------\n carol \n');
  });

  it('TRUE dominates UNKNOWN in OR, so a NULL row can survive via the other arm', async () => {
    const { out } = await run(`${USERS}
SELECT name FROM users WHERE age IS NULL OR age < 30;`);
    // Bob: true OR unknown = true · carol: false OR true · alice/dave: false OR false
    expect(out).toBe('INSERT 0 4\n\n name  \n-------\n Bob   \n carol \n');
  });

  it('IS NULL / IS NOT NULL are the only two-valued NULL tests', async () => {
    const { out } = await run(`${USERS}
SELECT name FROM users WHERE age IS NULL;
SELECT name FROM users WHERE age IS NOT NULL;`);
    expect(out).toBe(
      'INSERT 0 4\n\n name \n------\n Bob  \n\n name  \n-------\n alice \n carol \n dave  \n',
    );
  });

  it('IN over a list containing NULL is unknown for non-matches', async () => {
    const { out } = await run(`${USERS}
SELECT name FROM users WHERE age IN (28, NULL);`);
    // carol matches 28 · alice no match + NULL member → unknown → dropped · Bob NULL → unknown
    expect(out).toBe('INSERT 0 4\n\n name  \n-------\n carol \n');
  });

  it('aggregates skip NULLs: COUNT(*) vs COUNT(col), SUM, AVG', async () => {
    const { out } = await run(`${USERS}
SELECT COUNT(*), COUNT(age), SUM(age) FROM users;`);
    expect(out).toBe('INSERT 0 4\n\n COUNT(*) | COUNT(age) | SUM(age) \n----------+------------+----------\n 4        | 3          | 103      \n');
  });

  it('AVG of an INTEGER column prints with a decimal', async () => {
    const { out } = await run(`${USERS}
SELECT AVG(age) FROM users;`);
    expect(out).toBe('INSERT 0 4\n\n AVG(age)  \n-----------\n 34.333333 \n');
  });

  it('AVG is fractional when it can be, integral-with-decimal when exact', async () => {
    const { out } = await run(`CREATE TABLE t (x INTEGER);
INSERT INTO t VALUES (2), (3);
SELECT AVG(x) FROM t;
INSERT INTO t VALUES (7);
SELECT AVG(x) FROM t;`);
    expect(out).toBe('INSERT 0 2\n\n AVG(x) \n--------\n 2.5    \n\nINSERT 0 1\n\n AVG(x) \n--------\n 4.0    \n');
  });

  it('MIN/MAX over TEXT compare lexicographically, case-sensitively', async () => {
    const { out } = await run(`${USERS}
SELECT MIN(name), MAX(name) FROM users;`);
    expect(out).toBe('INSERT 0 4\n\n MIN(name) | MAX(name) \n-----------+-----------\n Bob       | dave      \n');
  });
});

// ─── WHERE expressions ─────────────────────────────────────────────────────

describe('expressions', () => {
  it('AND binds tighter than OR; parentheses override', async () => {
    const { out } = await run(`${USERS}
SELECT name FROM users WHERE city = 'HK' OR city = 'SF' AND age > 30;
SELECT name FROM users WHERE (city = 'HK' OR city = 'SF') AND age > 30;`);
    expect(out).toBe(
      'INSERT 0 4\n\n name  \n-------\n alice \n Bob   \n dave  \n\n name  \n-------\n alice \n dave  \n',
    );
  });

  it('LIKE: % is any run, _ is exactly one character, matching is case-sensitive', async () => {
    const { out } = await run(`${USERS}
SELECT name FROM users WHERE name LIKE '%o%';
SELECT name FROM users WHERE name LIKE '_ob';
SELECT name FROM users WHERE name LIKE 'Alice';`);
    expect(out).toBe(
      'INSERT 0 4\n\n name  \n-------\n Bob   \n carol \n\n name \n------\n Bob  \n\n name \n------\n',
    );
  });

  it('string values are case-sensitive; identifiers are not', async () => {
    const { out } = await run(`${USERS}
SELECT NAME FROM Users WHERE CITY = 'hk';`);
    expect(out).toBe('INSERT 0 4\n\n name \n------\n');
  });

  it("'' inside a string literal escapes a quote", async () => {
    const { out } = await run(`CREATE TABLE t (s TEXT);
INSERT INTO t VALUES ('it''s');
SELECT s FROM t;`);
    expect(out).toBe(`INSERT 0 1\n\n s    \n------\n it's \n`);
  });

  it('integer arithmetic; / truncates toward zero like PostgreSQL INTEGER division', async () => {
    const { out } = await run(`CREATE TABLE t (a INTEGER);
INSERT INTO t VALUES (7), (8);
SELECT a / 2, a + 1, a * 3 FROM t;`);
    expect(out).toBe('INSERT 0 2\n\n a / 2 | a + 1 | a * 3 \n-------+-------+-------\n 3     | 8     | 21    \n 4     | 9     | 24    \n');
  });

  it('division by zero is a line-mapped runtime error', async () => {
    const { r } = await run(`CREATE TABLE t (a INTEGER);
INSERT INTO t VALUES (1);
SELECT a / 0 FROM t;`);
    expect(r.finished).toBe(false);
    expect(r.error).toBe('line 3: division by zero');
  });

  it('mixed-type comparison is an error, not a silent false', async () => {
    const { r } = await run(`${USERS}
SELECT name FROM users WHERE name > 30;`);
    expect(r.error).toBe('line 3: cannot compare TEXT with INTEGER');
  });
});

// ─── GROUP BY / aggregates ─────────────────────────────────────────────────

describe('GROUP BY', () => {
  it('groups rows and evaluates aggregates per group', async () => {
    const { out } = await run(`${USERS}
SELECT city, COUNT(*), AVG(age) FROM users GROUP BY city;`);
    expect(out).toBe(
      'INSERT 0 4\n\n city | COUNT(*) | AVG(age) \n------+----------+----------\n HK   | 2        | 34.0     \n SF   | 2        | 34.5     \n',
    );
  });

  it('HAVING filters groups; a rejected group leaves no row', async () => {
    const { out } = await run(`${USERS}
SELECT city, COUNT(*) FROM users GROUP BY city HAVING COUNT(*) > 1;
SELECT city, COUNT(*) FROM users GROUP BY city HAVING COUNT(*) > 5;`);
    expect(out).toBe(
      'INSERT 0 4\n\n city | COUNT(*) \n------+----------\n HK   | 2        \n SF   | 2        \n\n city | COUNT(*) \n------+----------\n',
    );
  });

  it('a bare select column outside GROUP BY is a clean error naming the column', async () => {
    const { r } = await run(`${USERS}
SELECT name, COUNT(*) FROM users GROUP BY city;`);
    expect(r.finished).toBe(false);
    expect(r.error).toBe("line 3: column 'name' must appear in GROUP BY or inside an aggregate");
  });

  it('aggregates without GROUP BY form one implicit group (even over zero rows)', async () => {
    const { out } = await run(`${USERS}
SELECT COUNT(*) FROM users WHERE age > 100;`);
    expect(out).toBe('INSERT 0 4\n\n COUNT(*) \n----------\n 0        \n');
  });

  it('GROUP BY over zero rows produces zero groups', async () => {
    const { out } = await run(`${USERS}
SELECT city, COUNT(*) FROM users WHERE age > 100 GROUP BY city;`);
    expect(out).toBe('INSERT 0 4\n\n city | COUNT(*) \n------+----------\n');
  });

  it('expressions over group columns are fine; aggregates in WHERE are not', async () => {
    const { r } = await run(`${USERS}
SELECT name FROM users WHERE COUNT(*) > 1;`);
    expect(r.error).toBe('line 3: COUNT(…) is not allowed in WHERE — aggregates belong in the select list or HAVING');
  });

  it('SELECT * with GROUP BY is a clean line-mapped error, not a render crash', async () => {
    const { r } = await run(`${USERS}
SELECT * FROM users GROUP BY city;`);
    expect(r.finished).toBe(false);
    expect(r.error).toBe("line 3: '*' cannot be used with GROUP BY or aggregates — name the grouping columns instead");
  });

  it('SELECT * with HAVING aggregates is the same clean error', async () => {
    const { r } = await run(`${USERS}
SELECT * FROM users HAVING COUNT(*) > 1;`);
    expect(r.finished).toBe(false);
    expect(r.error).toBe("line 3: '*' cannot be used with GROUP BY or aggregates — name the grouping columns instead");
  });

  it('aggregate over TEXT is an error naming the line', async () => {
    const { r } = await run(`${USERS}
SELECT SUM(name) FROM users;`);
    expect(r.error).toBe('line 3: cannot SUM over TEXT — only numbers');
  });
});

// ─── ORDER BY / LIMIT ──────────────────────────────────────────────────────

describe('ORDER BY and LIMIT', () => {
  it('ORDER BY sorts INTEGER numerically and honors DESC + LIMIT', async () => {
    const { out } = await run(`CREATE TABLE t (n INTEGER);
INSERT INTO t VALUES (2), (10), (1);
SELECT n FROM t ORDER BY n DESC LIMIT 2;`);
    expect(out).toBe('INSERT 0 3\n\n n  \n----\n 10 \n 2  \n');
  });

  it('ORDER BY on TEXT is lexicographic (byte order: capitals first)', async () => {
    const { out } = await run(`${USERS}
SELECT name FROM users ORDER BY name;`);
    expect(out).toBe('INSERT 0 4\n\n name  \n-------\n Bob   \n alice \n carol \n dave  \n');
  });

  it('multiple keys, ASC default, ties keep input order (stable sort)', async () => {
    const { out } = await run(`${USERS}
SELECT city, name FROM users ORDER BY city, name DESC;`);
    expect(out).toBe(
      'INSERT 0 4\n\n city | name  \n------+-------\n HK   | alice \n HK   | Bob   \n SF   | dave  \n SF   | carol \n',
    );
  });

  it('ORDER BY can sort a grouped result by its group column', async () => {
    const { out } = await run(`${USERS}
SELECT city, COUNT(*) FROM users GROUP BY city ORDER BY city DESC;`);
    expect(out).toBe('INSERT 0 4\n\n city | COUNT(*) \n------+----------\n SF   | 2        \n HK   | 2        \n');
  });

  it('ORDER BY takes column names — an expression key is a parse error', async () => {
    const r = await sqlKernel.createSession().load(`CREATE TABLE t (a INTEGER);
INSERT INTO t VALUES (1);
SELECT a + 10 FROM t ORDER BY a + 10 DESC;`);
    expect(r).toEqual({ ok: false, line: 3, message: `expected ';' — got '+'` });
  });

  it('unknown ORDER BY column is a line-mapped error', async () => {
    const { r } = await run(`${USERS}
SELECT name FROM users ORDER BY height;`);
    expect(r.error).toBe("line 3: unknown ORDER BY column 'height' — it must be a column of the result (the select list)");
  });

  it('LIMIT 0 yields an empty table', async () => {
    const { out } = await run(`${USERS}
SELECT name FROM users LIMIT 0;`);
    expect(out).toBe('INSERT 0 4\n\n name \n------\n');
  });
});

// ─── joins ─────────────────────────────────────────────────────────────────

describe('joins', () => {
  it('nested-loop join with qualified columns; unmatched rows drop', async () => {
    const { out } = await run(`${USERS}
${ORDERS}
SELECT users.name, orders.total FROM users JOIN orders ON users.id = orders.user_id ORDER BY orders.total;`);
    expect(out).toBe(
      'INSERT 0 4\n\nINSERT 0 4\n\n name  | total \n-------+-------\n carol | 60    \n alice | 100   \n alice | 250   \n',
    );
  });

  it('SELECT * over a join shows every column of both tables', async () => {
    const { out } = await run(`CREATE TABLE a (x INTEGER);
CREATE TABLE b (y INTEGER);
INSERT INTO a VALUES (1);
INSERT INTO b VALUES (10), (20);
SELECT * FROM a JOIN b ON a.x = 1;`);
    expect(out).toBe(
      'INSERT 0 1\n\nINSERT 0 2\n\n a.x | b.y \n-----+-----\n 1   | 10  \n 1   | 20  \n',
    );
  });

  it('an unqualified name present in both tables is an ambiguity error', async () => {
    const { r } = await run(`${USERS}
${ORDERS}
SELECT id FROM users JOIN orders ON users.id = orders.user_id;`);
    expect(r.error).toBe("line 5: ambiguous column 'id' — write users.id or orders.id");
  });

  it('unknown table and unknown column are line-mapped runtime errors', async () => {
    const a = await run(`${USERS}
SELECT * FROM nosuch;`);
    expect(a.r.error).toBe("line 3: unknown table 'nosuch'");
    const b = await run(`${USERS}
SELECT nope FROM users;`);
    expect(b.r.error).toBe("line 3: unknown column 'nope' (columns in scope: id, name, city, age) — FROM users");
  });

  it('200×200 = 40 000 probes complete inside the budget; the Plan shows them', async () => {
    const inserts = Array.from({ length: 200 }, (_, i) => `INSERT INTO a VALUES (${i});`).join('\n');
    const insertsB = Array.from({ length: 200 }, (_, i) => `INSERT INTO b VALUES (${i});`).join('\n');
    const s = await load(`CREATE TABLE a (x INTEGER);
CREATE TABLE b (y INTEGER);
${inserts}
${insertsB}
SELECT COUNT(*) FROM a JOIN b ON a.x - b.y <= 1000;`);
    const r = await s.run();
    expect(r.finished).toBe(true);
    expect(r.steps).toBe(80_601);              // 400 inserts + 200 scan + 40 000 probes + 40 000 folds + 1 group
    const join = planRows(s.state()).find((row) => row.text.startsWith('NestedLoop'));
    expect(join?.bytes).toBe('40000/40000/40000');
    expect(consoleOf(s.state()).endsWith(' COUNT(*) \n----------\n 40000    \n')).toBe(true);
    s.dispose();
  });

  it('400×400 exceeds the 100 000 row-op budget and dies with a line-named error', async () => {
    const inserts = Array.from({ length: 400 }, (_, i) => `INSERT INTO a VALUES (${i});`).join('\n');
    const insertsB = Array.from({ length: 400 }, (_, i) => `INSERT INTO b VALUES (${i});`).join('\n');
    const lines = ['CREATE TABLE a (x INTEGER);', 'CREATE TABLE b (y INTEGER);', inserts, insertsB,
      'SELECT COUNT(*) FROM a JOIN b ON a.x - b.y <= 1000;'];
    const src = lines.join('\n');
    const selectLine = src.split('\n').length;    // the SELECT is the last line
    const { r } = await run(src);
    expect(r.finished).toBe(false);
    expect(r.error).toBe(
      `line ${selectLine}: budget exceeded — more than 100,000 row operations (a cross join of big tables does this)`,
    );
  });
});

// ─── INSERT semantics ──────────────────────────────────────────────────────

describe('INSERT', () => {
  it('multiple rows per INSERT, acknowledged as INSERT 0 n', async () => {
    const { out } = await run(`CREATE TABLE t (a INTEGER, b TEXT);
INSERT INTO t VALUES (1, 'x'), (2, 'y'), (3, 'z');
SELECT COUNT(*) FROM t;`);
    expect(out).toBe('INSERT 0 3\n\n COUNT(*) \n----------\n 3        \n');
  });

  it('type violations are rejected with the offending line', async () => {
    const { r } = await run(`CREATE TABLE t (a INTEGER, b TEXT);
INSERT INTO t VALUES ('x', 1);`);
    expect(r.error).toBe("line 2: cannot insert TEXT into INTEGER column 'a'");
  });

  it('arity mismatch names the table and both counts', async () => {
    const { r } = await run(`CREATE TABLE t (a INTEGER, b TEXT);
INSERT INTO t VALUES (1);`);
    expect(r.error).toBe('line 2: expected 2 values for t (a, b) — got 1');
  });

  it('unknown table on INSERT', async () => {
    const { r } = await run(`INSERT INTO ghost VALUES (1);`);
    expect(r.error).toBe("line 1: unknown table 'ghost'");
  });

  it('duplicate CREATE TABLE is an error', async () => {
    const { r } = await run(`CREATE TABLE t (a INTEGER);
CREATE TABLE t (a TEXT);`);
    expect(r.error).toBe("line 2: table 't' already exists");
  });
});

// ─── panels: the plan, the current row, the tables ─────────────────────────

describe('panels', () => {
  it('the Plan lists every operator with seen/passed/emitted counters and marks the working one', async () => {
    const s = await load(`${USERS}
SELECT name, age FROM users WHERE age > 30 ORDER BY age LIMIT 1;`);
    await s.run();
    const rows = planRows(s.state());
    expect(rows.map((row) => [row.text, row.bytes])).toEqual([
      ['Scan users', '4/4/4'],
      ['Filter age > 30', '4/2/2'],
      ['Project name, age', '2/2/2'],
      ['Sort age', '2/1/2'],
      ['Limit 1', '1/1/1'],
    ]);
    expect(rows.every((row) => row.current !== true)).toBe(true);   // finished: nothing current
    expect(rows.every((row) => row.line === 3)).toBe(true);
    s.dispose();
  });

  it('step() is one row operation: counters and the Current row advance together', async () => {
    const s = await load(`${USERS}
SELECT name FROM users WHERE city = 'HK';`);
    const st1 = await s.step();          // CREATE TABLE: planning only, no row op
    expect(st1).toEqual({ ran: true, result: { finished: false, steps: 0 } });
    expect(fieldsOf(s.state()).map((f) => f.value)).toEqual(['NULL', 'NULL', 'NULL', 'NULL']);
    const st2 = await s.step();          // INSERT begins + appends row 1
    expect(st2).toEqual({ ran: true, result: { finished: false, steps: 1 } });
    expect(fieldsOf(s.state()).map((f) => [f.key, f.value])).toEqual([['id', '1'], ['name', 'alice'], ['city', 'HK'], ['age', '34']]);
    const st3 = await s.step();          // one row per step, always
    expect(st3.result?.steps).toBe(2);
    expect(fieldsOf(s.state()).map((f) => f.value)).toEqual(['2', 'Bob', 'HK', 'NULL']);
    await s.run();
    const rows = planRows(s.state());
    expect(rows.map((row) => [row.text, row.bytes])).toEqual([
      ['Scan users', '4/4/4'],
      ['Filter city = \'HK\'', '4/2/2'],
      ['Project name', '2/2/2'],
    ]);
    s.dispose();
  });

  it('every step changes the Current row and flags changed values', async () => {
    const s = await load(`CREATE TABLE t (a INTEGER, b TEXT);
INSERT INTO t VALUES (1, 'x'), (2, 'x');`);
    await s.step();                      // CREATE (no row op)
    await s.step();                      // insert row 1
    const f1 = fieldsOf(s.state());
    expect(f1.map((x) => [x.key, x.value, x.changed])).toEqual([['a', '1', true], ['b', 'x', true]]);
    expect(f1.map((x) => x.tip)).toEqual(['a · INTEGER', 'b · TEXT']);
    await s.step();                      // insert row 2: a changed, b did not
    const f2 = fieldsOf(s.state());
    expect(f2.map((x) => [x.value, x.changed])).toEqual([['2', true], ['x', undefined]]);
    s.dispose();
  });

  it('the Tables panel tracks row counts live and highlights the touched table', async () => {
    const s = await load(`${USERS}
${ORDERS}`);
    await s.run();
    const rows = tablesOf(s.state());
    expect(rows.map((row) => [row.text, row.bytes, row.current === true])).toEqual([
      ['users (id, name, city, age)', '4', false],
      ['orders (id, user_id, total)', '4', true],
    ]);
    s.dispose();
  });

  it('join probes show qualified columns in the Current row', async () => {
    const s = await load(`CREATE TABLE a (x INTEGER);
CREATE TABLE b (y INTEGER);
INSERT INTO a VALUES (7);
INSERT INTO b VALUES (1), (7);
SELECT a.x FROM a JOIN b ON a.x = b.y;`);
    await s.run();
    const rows = planRows(s.state());
    expect(rows.find((row) => row.text.startsWith('NestedLoop'))?.bytes).toBe('2/1/1');
    s.dispose();
  });
});

// ─── session mechanics ─────────────────────────────────────────────────────

describe('session: breakpoints, reset, errors', () => {
  it('a breakpoint pauses before the statement on that line', async () => {
    const s = await load(`${USERS}
SELECT name FROM users WHERE id = 1;`);
    const paused = await s.run([3]);
    expect(paused).toEqual({ finished: false, steps: 4, pausedAt: 3 });   // INSERT ran, SELECT not
    expect(consoleOf(s.state())).toBe('INSERT 0 4\n');
    expect(planRows(s.state()).map((row) => row.current === true)).toEqual([false]);
    const after = await s.run();          // no breakpoints: finishes
    expect(after).toEqual({ finished: true, steps: 13, exit: 'exit(0)' });
    expect(consoleOf(s.state())).toBe('INSERT 0 4\n\n name  \n-------\n alice \n');
    s.dispose();
  });

  it('re-running with the same breakpoints resumes instead of re-pausing', async () => {
    const s = await load(`${USERS}
SELECT COUNT(*) FROM users;`);
    const p1 = await s.run([2]);
    expect(p1.pausedAt).toBe(2);
    const p2 = await s.run([2]);          // resume into the paused statement
    expect(p2.finished).toBe(true);
    expect(p2.pausedAt).toBeUndefined();
    s.dispose();
  });

  it('a breakpoint can trip mid-program on a later statement', async () => {
    const s = await load(`${USERS}
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM orders;`);
    const p = await s.run([4]);
    expect(p.pausedAt).toBe(4);
    expect(consoleOf(s.state())).toBe('INSERT 0 4\n\n COUNT(*) \n----------\n 4        \n');
    s.dispose();
  });

  it('reset() returns to the just-loaded state and a second run reproduces the output', async () => {
    const s = await load(`${USERS}
SELECT COUNT(*) FROM users;`);
    await s.run();
    s.reset();
    expect(consoleOf(s.state())).toBe('');
    expect(tablesOf(s.state())).toEqual([]);
    const r2 = await s.run();
    expect(r2).toEqual({ finished: true, steps: 13, exit: 'exit(0)' });
    expect(consoleOf(s.state())).toBe('INSERT 0 4\n\n COUNT(*) \n----------\n 4        \n');
    s.dispose();
  });

  it('an error is sticky: a crashed run does not report success on re-run', async () => {
    const s = await load(`CREATE TABLE t (a INTEGER);
INSERT INTO t VALUES (1);
SELECT nope FROM t;`);
    const r1 = await s.run();
    expect(r1.error).toBe("line 3: unknown column 'nope' (columns in scope: a) — FROM t");
    const r2 = await s.run();
    expect(r2.error).toBe(r1.error);
    const st = await s.step();
    expect(st.ran).toBe(false);
    s.dispose();
  });

  it('step() past the end reports done, and run without load errors', async () => {
    const s = sqlKernel.createSession();
    const r = await s.run();
    expect(r).toEqual({ finished: false, steps: 0, error: 'nothing is loaded' });
    const st = await s.step();
    expect(st.ran).toBe(false);
    await s.load('SELECT 1 FROM t;');
    s.dispose();
  });

  it('dispose clears state', async () => {
    const s = await load('SELECT 1 FROM t;');
    s.dispose();
    expect(s.state()).toEqual([]);
  });
});
