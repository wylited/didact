import { describe, expect, it } from 'vitest';
import { jsKernel, looseEquals, strictEquals, toNumber, type Panel, type RunResult, type Session } from '../src/index';

/** load+run a fixture and return [runResult, consoleText, session]. */
async function run(src: string, bps?: number[]): Promise<{ r: RunResult; out: string; session: Session }> {
  const session = jsKernel.createSession();
  const load = await session.load(src);
  if (!load.ok) throw new Error(`fixture failed to load: line ${load.line}: ${load.message}`);
  const r = await session.run(bps);
  const out = consoleOf(session.state());
  return { r, out, session };
}

function consoleOf(panels: Panel[]): string {
  const p = panels.find((q): q is Extract<Panel, { kind: 'console' }> => q.kind === 'console');
  if (p === undefined) throw new Error('missing console panel');
  return p.text;
}

function fieldsOf(panels: Panel[]): Map<string, { value: string; changed?: boolean; tip?: string }> {
  const p = panels.find((q): q is Extract<Panel, { kind: 'fields' }> => q.kind === 'fields' && q.id === 'scopes');
  if (p === undefined) throw new Error('missing scopes panel');
  return new Map(p.fields.map((f) => [f.key, f] as const));
}

function rowsOf(panels: Panel[], id: string): { addr: number; text: string; line?: number; current?: boolean; tip?: string }[] {
  const p = panels.find((q): q is Extract<Panel, { kind: 'listing' }> => q.kind === 'listing' && q.id === id);
  if (p === undefined) throw new Error(`missing ${id} panel`);
  return p.rows;
}

// ─── hoisting ──────────────────────────────────────────────────────────────

describe('hoisting', () => {
  it('var declarations exist as undefined before their line; function declarations are fully callable', async () => {
    const { out } = await run(`
console.log(x, typeof x, typeof f);
var x = 'assigned';
function f() { return 'hoisted fn'; }
var g = function () { return 'expr not hoisted'; };
console.log(x, f(), g());
`);
    expect(out).toBe('undefined undefined function\nassigned hoisted fn expr not hoisted\n');
  });

  it('var inside a block hoists to function scope (no block scope for var)', async () => {
    const { out } = await run(`
function scope() {
  if (true) { var y = 1; }
  return y;
}
console.log(scope());
`);
    expect(out).toBe('1\n');
  });
});

// ─── closures ──────────────────────────────────────────────────────────────

describe('closures', () => {
  it('a counter closure keeps private state across calls', async () => {
    const { out } = await run(`
function makeCounter() {
  var n = 0;
  return function () {
    n = n + 1;
    return n;
  };
}
var next = makeCounter();
console.log(next(), next(), next());
`);
    expect(out).toBe('1 2 3\n');
  });

  it('two counters from the same factory have independent environments', async () => {
    const { out } = await run(`
function makeCounter() {
  var n = 0;
  return function () { n = n + 1; return n; };
}
var a = makeCounter();
var b = makeCounter();
a(); a();
console.log(a(), b());
`);
    expect(out).toBe('3 1\n');
  });
});

// ─── == coercion ───────────────────────────────────────────────────────────

describe('loose equality (abstract op) vs strict equality', () => {
  it('[] == false: [] → "" → 0, false → 0, so true; === stays false', () => {
    expect(looseEquals([], false)).toBe(true);
    expect(strictEquals([], false)).toBe(false);
  });
  it("'' == 0 and '1' == 1: string → number via ToNumber", () => {
    expect(looseEquals('', 0)).toBe(true);
    expect(looseEquals('1', 1)).toBe(true);
    expect(strictEquals('1', 1)).toBe(false);
  });
  it('null == undefined is true and they equal nothing else', () => {
    expect(looseEquals(null, undefined)).toBe(true);
    expect(looseEquals(undefined, null)).toBe(true);
    expect(looseEquals(null, 0)).toBe(false);
    expect(looseEquals(undefined, 0)).toBe(false);
  });
  it('NaN is not equal to anything, including itself, under either operator', () => {
    expect(looseEquals(NaN, NaN)).toBe(false);
    expect(strictEquals(NaN, NaN)).toBe(false);
  });
  it('ToNumber corner cases used by the coercion table', () => {
    expect(toNumber([])).toBe(0);
    expect(toNumber([7])).toBe(7);
    expect(toNumber([1, 2])).toBe(NaN);
    expect(toNumber(' 12 ')).toBe(12);
    expect(toNumber('x')).toBe(NaN);
  });

  it('the interpreter produces the same table at runtime', async () => {
    const { out } = await run(`
console.log([] == false, '' == 0, '1' == 1, null == undefined, NaN == NaN, [] === false);
`);
    expect(out).toBe('true true true true false false\n');
  });
});

// ─── TDZ ───────────────────────────────────────────────────────────────────

describe('let/const temporal dead zone', () => {
  it('reading a let above its declaration is a line-mapped error on the read line', async () => {
    const { r } = await run(`console.log(a);
let a = 1;`);
    expect(r.finished).toBe(false);
    expect(r.error).toBe("line 1: Cannot access 'a' before initialization");
  });

  it('typeof does not rescue a TDZ binding', async () => {
    const { r } = await run(`var t = typeof b;
const b = 2;`);
    expect(r.error).toBe("line 1: Cannot access 'b' before initialization");
  });
});

// ─── event loop ────────────────────────────────────────────────────────────

describe('event loop ordering', () => {
  it('sync body, then all microtasks, then macrotasks', async () => {
    const { out, r } = await run(`
console.log('sync');
setTimeout(function () { console.log('macro'); }, 0);
Promise.resolve().then(function () { console.log('micro'); });
console.log('still sync');
`);
    expect(r.finished).toBe(true);
    expect(out).toBe('sync\nstill sync\nmicro\nmacro\n');
  });

  it('.then chains queue in order and setTimeout is FIFO regardless of delay', async () => {
    const { out } = await run(`
setTimeout(function () { console.log('late'); }, 9999);
setTimeout(function () { console.log('early'); }, 0);
Promise.resolve(1).then(function (n) { return n + 1; }).then(function (n) { console.log('then', n); });
`);
    // delays are clamped away: macrotasks run in the order they were queued
    expect(out).toBe('then 2\nlate\nearly\n');
  });

  it('a microtask scheduled from a macrotask runs before the next macrotask', async () => {
    const { out } = await run(`
setTimeout(function one() { console.log('macro1'); Promise.resolve().then(function () { console.log('micro2'); }); }, 0);
setTimeout(function two() { console.log('macro2'); }, 0);
`);
    expect(out).toBe('macro1\nmicro2\nmacro2\n');
  });

  it('the Event loop panel shows both queues with the micro head as current phase', async () => {
    const session = jsKernel.createSession();
    await session.load(`setTimeout(function onTimeout() { }, 0);
Promise.resolve().then(function micro1() { });
console.log('queued');`);
    const r = await session.run([3]);
    expect(r.pausedAt).toBe(3);
    const rows = rowsOf(session.state(), 'loop');
    expect(rows.map((x) => x.text)).toEqual(['microtask · micro1', 'macrotask · onTimeout']);
    expect(rows[0]!.current).toBe(true);
    expect(rows[0]!.line).toBe(2);
    expect(rows[1]!.line).toBe(1);
    session.dispose();
  });
});

// ─── control flow ──────────────────────────────────────────────────────────

describe('loops', () => {
  it('for with break stops mid-loop; continue skips the rest of the body', async () => {
    const { out } = await run(`
var sum = 0;
for (var i = 1; i <= 10; i = i + 1) {
  if (i === 4) { continue; }
  if (i === 7) { break; }
  sum = sum + i;
}
console.log(sum, i);
`);
    expect(out).toBe('17 7\n'); // 1+2+3+5+6, 4 skipped, break at 7
  });

  it('for-let gives each iteration a fresh binding (the var-vs-let lesson)', async () => {
    const { out } = await run(`
var withVar = [];
var withLet = [];
for (var i = 0; i < 3; i = i + 1) { withVar.push(function () { return i; }); }
for (let j = 0; j < 3; j = j + 1) { withLet.push(function () { return j; }); }
console.log(withVar[0](), withVar[2](), withLet[0](), withLet[2]());
`);
    expect(out).toBe('3 3 0 2\n');
  });
});

// ─── expressions ───────────────────────────────────────────────────────────

describe('expressions', () => {
  it('template literals interpolate expressions with ToString', async () => {
    const { out } = await run(`
var name = 'world';
var ns = [1, 2];
console.log(\`hi \${name} · \${1 + 1} · \${ns}\`);
`);
    expect(out).toBe('hi world · 2 · 1,2\n');
  });

  it('arrow functions close over parameters and have expression bodies', async () => {
    const { out } = await run(`
var add = (a, b) => a + b;
var double = n => n * 2;
console.log(add(2, 3), double(add(1, 1)));
`);
    expect(out).toBe('5 4\n');
  });

  it('typeof distinguishes the primitive kinds', async () => {
    const { out } = await run(`
console.log(typeof undefined, typeof null, typeof 1, typeof 's', typeof [], typeof {}, typeof console.log);
`);
    expect(out).toBe('undefined null number string object object function\n');
  });

  it('object literals, member and computed access', async () => {
    const { out } = await run(`
var point = { x: 3, y: 4 };
var key = 'y';
console.log(point.x, point[key], point['x']);
point.x = 10;
console.log(point.x);
`);
    expect(out).toBe('3 4 3\n10\n');
  });

  it('Math and Number builtins', async () => {
    const { out } = await run(`
console.log(Math.floor(2.7), Math.ceil(2.1), Math.abs(-5), Math.max(1, 9, 3), Math.min(1, 9, 3), Math.sqrt(16), Math.pow(2, 10));
console.log(Number.isInteger(4), Number.isInteger(4.5));
`);
    expect(out).toBe('2 3 5 9 1 4 1024\ntrue false\n');
  });

  it('string methods', async () => {
    const { out } = await run(`
var s = 'Hello';
console.log(s.toUpperCase(), s.toLowerCase(), s.indexOf('l'), s.slice(1, 3), 'a,b,c'.split(',').length);
`);
    expect(out).toBe('HELLO hello 2 el 3\n');
  });
});

// ─── arrays ────────────────────────────────────────────────────────────────

describe('array methods', () => {
  it('map and filter run interpreter callbacks over each element', async () => {
    const { out } = await run(`
var ns = [1, 2, 3, 4, 5, 6];
var evens = ns.filter(function (n) { return n % 2 === 0; });
var doubled = evens.map(function (n) { return n * 2; });
console.log(evens, doubled);
console.log(evens.join(' + '), doubled.indexOf(8), doubled.slice(1), doubled.pop(), doubled.length);
`);
    expect(out).toBe('[ 2, 4, 6 ] [ 4, 8, 12 ]\n2 + 4 + 6 1 [ 8, 12 ] 12 2\n');
  });

  it('push mutates and returns the new length', async () => {
    const { out } = await run(`
var a = [];
console.log(a.push('x'), a.push('y'), a.length, a[0], a.indexOf('y'));
`);
    expect(out).toBe('1 2 2 x 1\n');
  });
});

// ─── stepping ──────────────────────────────────────────────────────────────

describe('step()', () => {
  it('walks a 3-line program one statement at a time with pausedAt values', async () => {
    const session = jsKernel.createSession();
    await session.load(`var x = 1;
x = x + 2;
console.log(x);`);
    const s1 = await session.step();
    expect(s1.ran).toBe(true);
    expect(s1.result?.pausedAt).toBe(2); // next up: line 2
    expect(fieldsOf(session.state()).get('global.x')?.value).toBe('1');
    const s2 = await session.step();
    expect(s2.result?.pausedAt).toBe(3);
    expect(fieldsOf(session.state()).get('global.x')?.value).toBe('3');
    const s3 = await session.step();
    expect(s3.ran).toBe(true);
    expect(s3.result?.pausedAt).toBeUndefined();
    expect(consoleOf(session.state())).toBe('3\n');
    const s4 = await session.step();
    expect(s4.ran).toBe(false);
    expect(s4.result?.finished).toBe(true);
    expect(s4.result?.exit).toBe('exit(0)');
    session.dispose();
  });

  it('between tasks, one step runs one whole task invocation', async () => {
    const session = jsKernel.createSession();
    await session.load(`console.log('sync');
setTimeout(function a() { console.log('A'); }, 0);
setTimeout(function b() { console.log('B'); }, 0);`);
    const paused = await session.run([1]);
    expect(paused.pausedAt).toBe(1);
    await session.step(); // line 1: console.log('sync')
    await session.step(); // line 2: setTimeout(a)
    await session.step(); // line 3: setTimeout(b) — body done, next: task a
    expect(consoleOf(session.state())).toBe('sync\n');
    const st = await session.step(); // one step = one whole macrotask
    expect(st.ran).toBe(true);
    expect(consoleOf(session.state())).toBe('sync\nA\n');
    await session.step();
    expect(consoleOf(session.state())).toBe('sync\nA\nB\n');
    const done = await session.step();
    expect(done.ran).toBe(false);
    expect(done.result?.finished).toBe(true);
    session.dispose();
  });

  it('scopes flag the binding changed by the last step', async () => {
    const session = jsKernel.createSession();
    await session.load(`var m = 1;
var n = 100;`);
    await session.step();
    let fields = fieldsOf(session.state());
    expect(fields.get('global.m')?.value).toBe('1');
    expect(fields.get('global.m')?.changed).toBe(true);
    await session.step();
    fields = fieldsOf(session.state());
    expect(fields.get('global.m')?.changed).toBe(false); // untouched by step 2
    expect(fields.get('global.n')?.value).toBe('100');
    expect(fields.get('global.n')?.changed).toBe(true);
    session.dispose();
  });
});

// ─── breakpoints ───────────────────────────────────────────────────────────

describe('breakpoints', () => {
  it('pauses before executing the line, with the old binding value still visible', async () => {
    const session = jsKernel.createSession();
    await session.load(`var total = 0;
var k = 0;
while (k < 3) {
  total = total + k;
  k = k + 1;
}
console.log(total);`);
    const r = await session.run([4]); // total = total + k
    expect(r.pausedAt).toBe(4);
    expect(r.finished).toBe(false);
    expect(fieldsOf(session.state()).get('global.total')?.value).toBe('0');
    const st = await session.step(); // executes the paused line
    expect(st.ran).toBe(true);
    expect(fieldsOf(session.state()).get('global.total')?.value).toBe('0'); // 0 + 0
    // re-trips on the next iteration with the updated value
    const r2 = await session.run([4]);
    expect(r2.pausedAt).toBe(4);
    await session.step();
    expect(fieldsOf(session.state()).get('global.total')?.value).toBe('1');
    const r3 = await session.run();
    expect(r3.finished).toBe(true);
    expect(r3.exit).toBe('exit(0)');
    expect(consoleOf(session.state())).toBe('3\n');
    session.dispose();
  });

  it('breakpoints land inside called functions and show the call stack', async () => {
    const session = jsKernel.createSession();
    await session.load(`function inner(n) {
  return n * 2;
}
function outer(n) {
  return inner(n) + 1;
}
console.log(outer(5));`);
    const r = await session.run([2]);
    expect(r.pausedAt).toBe(2);
    const stack = rowsOf(session.state(), 'stack');
    expect(stack.map((s) => s.text)).toEqual(['global (script)', 'outer (line 5)', 'inner (line 2)']);
    expect(stack[2]!.current).toBe(true);
    const r2 = await session.run();
    expect(r2.finished).toBe(true);
    expect(consoleOf(session.state())).toBe('11\n');
    session.dispose();
  });
});

// ─── budget & errors ───────────────────────────────────────────────────────

describe('run budget and runtime errors', () => {
  it('an infinite loop is stopped by the 1,000,000-step budget with a clean error', async () => {
    const { r } = await run('while (true) { }');
    expect(r.finished).toBe(false);
    expect(r.error).toContain('budget');
    expect(r.steps).toBeGreaterThanOrEqual(1_000_000);
  });

  it('calling a non-function is a line-mapped error', async () => {
    const { r } = await run(`var notFn = 3;
notFn();`);
    expect(r.error).toBe('line 2: 3 is not a function');
  });

  it('undeclared variables are ReferenceErrors, not implicit globals', async () => {
    const { r } = await run('console.log(nope);');
    expect(r.error).toBe('line 1: nope is not defined');
  });

  it('assignment to a const is a line-mapped error', async () => {
    const { r } = await run(`const frozen = 1;
frozen = 2;`);
    expect(r.error).toBe('line 2: Assignment to constant variable.');
  });
});

// ─── load-time subset enforcement ──────────────────────────────────────────

describe('subset enforcement at load time', () => {
  const rejects = (name: string, src: string, line: number, construct: string): void => {
    it(`${name} → line ${line}, naming the construct`, async () => {
      const session = jsKernel.createSession();
      const load = await session.load(src);
      expect(load.ok).toBe(false);
      if (!load.ok) {
        expect(load.line).toBe(line);
        expect(load.message).toContain(construct);
        expect(load.message).toContain('is not in the teaching subset');
      }
      session.dispose();
    });
  };

  rejects('class', 'var x = 1;\nclass Foo {}', 2, "'class'");
  rejects('this', 'function f() {\n  return this;\n}', 2, "'this'");
  rejects('async functions', 'async function f() { }', 1, 'async');
  rejects('await', 'function f() {\n  await g();\n}', 2, 'await');
  rejects('generators', 'function* g() { }', 1, 'generators');
  rejects('for-in', 'var o = { a: 1 };\nfor (var k in o) { console.log(k); }', 2, 'for-in');
  rejects('array destructuring', 'var [a, b] = [1, 2];', 1, 'destructuring');
  rejects('object destructuring', 'var { a } = { a: 1 };', 1, 'destructuring');
  rejects('spread in calls', 'console.log(...[1, 2]);', 1, 'spread');
  rejects('increment', 'var i = 0;\ni++;', 2, "'++'");
  rejects('ternary', 'var a = true ? 1 : 2;', 1, "conditional operator '?:'");
});

// ─── panels shape ──────────────────────────────────────────────────────────

describe('panels', () => {
  it('state() returns scopes, call stack, event loop and console panels', async () => {
    const { session } = await run('console.log("hi");');
    const panels = session.state();
    expect(panels.map((p) => p.id)).toEqual(['scopes', 'stack', 'loop', 'console']);
    expect(rowsOf(panels, 'stack')).toEqual([
      { addr: 0, bytes: '', text: 'global (script)', line: 1, current: true, tip: 'top-level script scope' },
    ]);
    expect(rowsOf(panels, 'loop')[0]!.text).toBe('both queues empty');
    session.dispose();
  });
});
