// matlab.test.ts — behavioral tests for the MATLAB-flavored teaching
// interpreter: exact console bytes, exact panel contents, exact
// line-mapped errors. Each test pins one real behavior from the lesson.

import { describe, expect, it } from 'vitest';
import { matlabKernel } from '../src/kernel';
import type { LoadResult, Panel, RunResult, Session } from '../src/types';

type FieldsPanel = Extract<Panel, { kind: 'fields' }>;
type ListingPanel = Extract<Panel, { kind: 'listing' }>;

function out(panels: Panel[]): string {
  const c = panels.find((p) => p.id === 'console');
  return c !== undefined && c.kind === 'console' ? c.text : '';
}

function fields(panels: Panel[]): FieldsPanel['fields'] {
  const p = panels.find((x) => x.id === 'workspace');
  return p !== undefined && p.kind === 'fields' ? p.fields : [];
}

function rows(panels: Panel[], id: string): ListingPanel['rows'] {
  const p = panels.find((x) => x.id === id);
  return p !== undefined && p.kind === 'listing' ? p.rows : [];
}

async function session(src: string): Promise<Session> {
  const s = matlabKernel.createSession();
  const load: LoadResult = await s.load(src);
  if (!load.ok) throw new Error(`load failed: line ${load.line}: ${load.message}`);
  return s;
}

async function run(src: string, bps?: number[]): Promise<{ r: RunResult; s: Session }> {
  const s = await session(src);
  const r = await s.run(bps);
  return { r, s };
}

async function runOut(src: string): Promise<string> {
  const { r, s } = await run(src);
  expect(r.error).toBeUndefined();
  return out(s.state()).trimEnd();
}

describe('matlab kernel registration', () => {
  it('is the octave-syntax matlab kernel with stepping and breakpoints', () => {
    expect(matlabKernel.id).toBe('matlab');
    expect(matlabKernel.label).toBe('MATLAB · interpreter');
    expect(matlabKernel.editorSyntax).toBe('octave');
    expect(matlabKernel.features).toEqual({ breakpoints: true, stepping: true });
  });
});

describe('literals, shapes, and the column-major layout', () => {
  it('builds [1 2; 3 4] with size 2x2 and 4 elements', async () => {
    expect(await runOut(`A = [1 2; 3 4];
disp(size(A))
disp(numel(A))
disp(length(A))`)).toBe('2  2\n4\n2');
  });

  it('linear indexing counts DOWN the columns (A(2) is 3, A(3) is 2)', async () => {
    expect(await runOut(`A = [1 2; 3 4];
disp(A(1))
disp(A(2))
disp(A(3))
disp(A(4))`)).toBe('1\n3\n2\n4');
  });

  it('A(:) sweeps the elements in storage order', async () => {
    expect(await runOut(`A = [1 2; 3 4];
disp(A(:)')`)).toBe('1  3  2  4');
  });

  it('transpose swaps shape and values', async () => {
    expect(await runOut(`A = [1 2 3; 4 5 6];
B = A';
disp(size(B))
disp(B)`)).toBe('3  2\n1  4\n2  5\n3  6');
  });

  it('nested [ ] concatenates blocks with matching shapes', async () => {
    expect(await runOut(`u = [1 2];
v = [3 4];
disp([u; v])
disp([u' v'])
disp([[1; 2] [3; 4]])`)).toBe('1  2\n3  4\n1  3\n2  4\n1  3\n2  4');
  });

  it('ranges step by 1, by a fraction, and backwards', async () => {
    expect(await runOut(`disp(1:5)
disp(1:0.5:3)
disp(5:-2:1)
disp(3:1)`)).toBe('1  2  3  4  5\n  1  1.5    2  2.5    3\n5  3  1');
  });

  it('prints 0.5 as 0.5, never 0.50 (integers plain, 4 decimals trimmed)', async () => {
    expect(await runOut(`x = 0.5;
disp(x)
disp(1/3)
disp(2/3)
disp(sqrt(2))
disp(10 / 4)`)).toBe('0.5\n0.3333\n0.6667\n1.4142\n2.5');
  });
});

describe('arithmetic: matrix ops versus elementwise', () => {
  it('matrix * is row-by-column; .* multiplies in place', async () => {
    expect(await runOut(`A = [1 2; 3 4];
B = [5 6; 7 8];
disp(A * B)
disp(A .* B)`)).toBe('19  22\n43  50\n 5  12\n21  32');
  });

  it('scalar broadcasting works for + - *', async () => {
    expect(await runOut(`disp([1 2; 3 4] + 10)
disp(2 * [1 2] - 1)`)).toBe('11  12\n13  14\n1  3');
  });

  it('refuses mismatched inner dimensions with the line named', async () => {
    const { r } = await run(`x = [1 2] * [1; 2; 3];`);
    expect(r.error).toBe("line 1: inner dimensions must agree for '*' (1x2 * 3x1)");
  });

  it('.^ squares elementwise; ^ is matrix power by repeated squaring', async () => {
    expect(await runOut(`E = [1 2; 3 4];
disp(E .^ 2)
disp(E ^ 2)
disp(E ^ 0)
disp(E ^ 3)`)).toBe(' 1   4\n 9  16\n 7  10\n15  22\n1  0\n0  1\n 37   54\n 81  118');
  });

  it('refuses ^ with a non-integer or negative exponent', async () => {
    const a = await run(`E = [1 2; 3 4];
x = E ^ 1.5;`);
    expect(a.r.error).toBe(
      "line 2: not in the teaching subset: '^' needs a square matrix and a non-negative integer exponent (use .^ for elementwise power)",
    );
    const b = await run(`E = [1 2; 3 4];
x = E ^ -1;`);
    expect(b.r.error).toContain("'^' needs a square matrix");
  });

  it('A/b divides elementwise by a scalar; comparisons yield 0/1 matrices', async () => {
    expect(await runOut(`disp([2 4 6] / 2)
disp([1 2] == [1 3])
disp([1 2] < 2)`)).toBe('1  2  3\n1  0\n1  0');
  });

  it('.\\ divides elementwise with the operands flipped: y divided by x', async () => {
    expect(await runOut(`disp([2 4] .\\ [1 2])`)).toBe('0.5  0.5');
  });

});

describe('solving systems (the \\ story)', () => {
  it('solves a 3x3 system with a known answer via elimination', async () => {
    // interpolation through (1,6) (2,14) (3,36): p(x) = 12 - 13x + 7x^2
    expect(await runOut(`A = [1 1 1; 1 2 4; 1 3 9];
b = [6; 14; 36];
c = A \\ b;
disp(c')`)).toBe(' 12  -13    7');
  });

  it('solves right-division x*B = A as the transposed left-division', async () => {
    expect(await runOut(`A = [2 1; 1 3];
B = [1 2; 3 4];
X = A / B;
disp(X)
disp(X * B)`)).toBe('-2.5   1.5\n 2.5  -0.5\n2  1\n1  3');
  });

  it('names the line of a singular \\', async () => {
    const { r } = await run(`A = [1 2; 2 4];
b = [1; 2];
x = A \\ b;`);
    expect(r.error).toBe('line 3: matrix is singular to working precision — cannot solve A\\b');
  });

  it('det and inv agree (and inv refuses singular input)', async () => {
    expect(await runOut(`disp(det([1 2; 3 4]))
disp(inv([1 2; 3 4]))
disp(inv([1 2; 3 4]) * [1 2; 3 4])`)).toBe('-2\n  -2     1\n 1.5  -0.5\n1  0\n0  1');
    const { r } = await run(`x = inv([1 2; 2 4]);`);
    expect(r.error).toBe('line 1: matrix is singular to working precision');
  });
});

describe('indexing, slicing, and writes', () => {
  it('reads submatrices with ranges and end', async () => {
    expect(await runOut(`A = [1 2 3; 4 5 6];
disp(A(1:2, 2:end))
disp(A(:, 2))
disp(A(1, :))
disp(A(2, end))`)).toBe('2  3\n5  6\n2\n5\n1  2  3\n6');
  });

  it('gathers an index list into a column (column-major)', async () => {
    expect(await runOut(`A = [1 2; 3 4];
disp(A([1 3]))
disp(A([4 1]))`)).toBe('1\n2\n4\n1');
  });

  it('writes A(i,j), A(1,:)=row, A(:,j)=col and linear indices', async () => {
    expect(await runOut(`A = zeros(2, 3);
A(2, 2) = 42;
A(1, :) = [10 20 30];
A(:, 3) = [7; 8];
A(4) = 99;
disp(A)`)).toBe('10  20   7\n 0  99   8');
  });

  it('deletes a whole column with A(:,2)=[] and a row with A(2,:)=[]', async () => {
    expect(await runOut(`A = [1 2 3; 4 5 6];
A(:, 2) = [];
disp(A)
A(2, :) = [];
disp(A)
disp(size(A))`)).toBe('1  3\n4  6\n1  3\n1  2');
  });

  it('refuses A(i,j)=[] and out-of-bounds writes, with lines', async () => {
    const a = await run(`A = [1 2];
A(1, 1) = [];`);
    expect(a.r.error).toBe(
      "line 2: deleting with [] works on whole rows or columns only — write A(i,:) = [] or A(:,j) = []",
    );
    const b = await run(`A = [1 2];
A(3) = 9;`);
    expect(b.r.error).toBe('line 2: linear index 3 (A has 2 elements) is out of bounds');
    const c = await run(`A = [1 2];
A(1, :) = [1 2 3];`);
    expect(c.r.error).toBe(
      'line 2: cannot assign a 1x3 matrix to the 1x2 target of A',
    );
  });

  it('assignment copies: writes through B never touch A', async () => {
    expect(await runOut(`A = [1 2; 3 4];
B = A;
B(1, 1) = 100;
disp(A(1, 1))`)).toBe('1');
  });
});

describe('control flow', () => {
  it('if / elseif / else picks one arm', async () => {
    expect(await runOut(`x = 2;
if x > 10
  disp('big')
elseif x > 1
  disp('middle')
else
  disp('small')
end`)).toBe('middle');
  });

  it('&& and || short-circuit on scalars; a matrix condition needs all nonzero', async () => {
    expect(await runOut(`x = 3;
disp(x > 1 && x < 5)
disp(x < 1 || x == 3)
if [1 1; 1 1]
  disp('all true')
end
if [1 0]
  disp('never')
end`)).toBe('1\n1\nall true');
  });

  it('while runs until the condition fails; break leaves early', async () => {
    expect(await runOut(`i = 1;
s = 0;
while i <= 4
  s = s + i;
  i = i + 1;
end
disp(s)
while 1
  i = i - 1;
  if i == 0
    break
  end
end
disp(i)`)).toBe('10\n0');
  });

  it('for over a matrix iterates its COLUMNS (MATLAB truth)', async () => {
    expect(await runOut(`A = [1 2; 3 4];
for c = A
  disp(c')
end
t = 0;
for k = 1:3
  t = t + k;
end
disp(t)`)).toBe('1  3\n2  4\n6');
  });
});

describe('functions and workspaces', () => {
  it('returns two outputs with [q, r] = name(a, b)', async () => {
    expect(await runOut(`function [q, r] = divmod(a, b)
  q = floor(a / b);
  r = a - b * q;
end
[q, r] = divmod(17, 5);
fprintf('q=%d r=%d\\n', q, r);`)).toBe('q=3 r=2');
  });

  it('function locals never touch the base workspace (panel-verified)', async () => {
    // Breakpoint INSIDE the function: the call stack shows twice's own
    // workspace; the Workspace panel still lists only y from the script.
    const { r, s } = await run(`function t = twice(x)
  local = x * 2;
  t = local;
end
y = [1 2];
w = twice(y);`, [3]);
    expect(r.pausedAt).toBe(3);
    const ws = fields(s.state()).map((f) => f.key);
    expect(ws).toEqual(['y']);
    const stack = rows(s.state(), 'stack').map((row) => row.text);
    expect(stack).toEqual([
      'script · base workspace',
      'twice · own workspace: x, local',
    ]);
    const done = await s.run();
    expect(done.error).toBeUndefined();
    expect(fields(s.state()).map((f) => f.key)).toEqual(['y', 'w']);
    expect(await runOut(`function f(x)
  y = x + 1;
end
y = 5;
f(2);
disp(y)`)).toBe('5');
  });

  it('errors name the line when arguments or outputs do not match', async () => {
    const a = await run(`function f(a, b)
  f = a + b;
end
x = f(1);`);
    expect(a.r.error).toBe("line 4: function 'f' expects 2 arguments, got 1");
    const b = await run(`function [q, r] = pair(a)
  q = a;
end
x = pair(1);`);
    expect(b.r.error).toBe("line 1: function 'pair' never assigned output 'r'");
  });

  it('return leaves the function early; recursion is budget-bounded', async () => {
    expect(await runOut(`function f = fib(n)
  if n <= 2
    f = 1;
    return
  end
  f = fib(n - 1) + fib(n - 2);
end
disp(fib(10))`)).toBe('55');
  });

  it('refuses a function defined below script statements', async () => {
    const load = await matlabKernel.createSession().load(`x = 1;
function y = f()
  y = x;
end`);
    expect(load).toEqual({
      ok: false,
      line: 2,
      message: 'functions must be defined at the top of the block — scripts come after',
    });
  });
});

describe('builtins (deterministic — no rand)', () => {
  it('constructors: zeros ones eye diag linspace', async () => {
    expect(await runOut(`disp(zeros(2, 3))
disp(ones(2))
disp(eye(3))
disp(diag([1 2 3]))
A = [1 2 3; 4 5 6];
disp(diag(A)')
disp(linspace(0, 1, 5))`)).toBe(
      '0  0  0\n0  0  0\n1  1\n1  1\n1  0  0\n0  1  0\n0  0  1\n1  0  0\n0  2  0\n0  0  3\n1  5\n   0  0.25   0.5  0.75     1',
    );
  });

  it('reductions: sum(A) vs sum(A,2), mean, max/min with dim', async () => {
    expect(await runOut(`A = [1 2 3; 4 5 6];
disp(sum(A))
disp(sum(A, 2))
disp(sum(A(:)))
disp(mean(A))
disp(max(A))
disp(max(A, [], 2)')
disp(min(A, [], 1))`)).toBe(
      '5  7  9\n 6\n15\n21\n2.5  3.5  4.5\n4  5  6\n3  6\n1  2  3',
    );
  });

  it('elementwise math and reshaping: abs floor ceil round sqrt exp sin cos sort fliplr flipud', async () => {
    expect(await runOut(`disp(floor(1.7))
disp(ceil(1.2))
disp(round(2.5))
disp(abs(-3))
disp(sqrt([4 9]))
disp(round(exp(0)))
disp(round(sin(0) + cos(0)))
disp(sort([3 1 2]))
disp(sort([3 1 2; 6 5 4]))
disp(fliplr([1 2 3]))
disp(flipud([1; 2]))`)).toBe(
      '1\n2\n3\n3\n2  3\n1\n1\n1  2  3\n3  1  2\n6  5  4\n3  2  1\n2\n1',
    );
  });

  it('refuses rand by name, deterministically', async () => {
    const { r } = await run(`x = rand(3);`);
    expect(r.error).toBe("line 1: not in the teaching subset: 'rand' — the interpreter is deterministic on purpose");
  });
});

describe('display: disp, fprintf, and the echo', () => {
  it('disp prints the matrix rows; strings print bare', async () => {
    expect(await runOut(`disp([1 2; 3 4])
disp('plain text')
disp(5)`)).toBe('1  2\n3  4\nplain text\n5');
  });

  it('an unsuppressed assignment echoes MATLAB-style; ; is silent', async () => {
    expect(await runOut(`A = [1 2]
B = [3 4];`)).toBe('A =\n\n1  2');
  });

  it('a bare expression names its result ans', async () => {
    expect(await runOut(`[2 4] / 2;
disp(ans)`)).toBe('1  2');
  });

  it('fprintf formats %d, %.2f, %% and \\n exactly', async () => {
    expect(await runOut(`fprintf('ints: %d %d\\n', 42, -3);
fprintf('fixed: %.2f %.1f\\n', 1 / 3, 2.5);
fprintf('100%% done\\n');
fprintf('no newline')`)).toBe(
      'ints: 42 -3\nfixed: 0.33 2.5\n100% done\nno newline',
    );
  });

  it('error() stops the block with its line and the formatted message', async () => {
    const { r } = await run(`x = 2;
error('x was %d, too big', x)
disp('never');`);
    expect(r.error).toBe('line 2: x was 2, too big');
    expect(r.finished).toBe(false);
  });

  it('strings are display text only — assigning or adding one is refused', async () => {
    const a = await run(`s = 'text';`);
    expect(a.r.error).toBe(
      "line 1: not in the teaching subset: strings are display text only — pass them to disp(), fprintf() or error()",
    );
    const b = await run(`disp('a' == 'a');`);
    expect(b.r.error).toContain('strings are display text only');
  });
});

describe('panels: Workspace, Matrices, Call stack', () => {
  it('Workspace lists shape + preview with changed marks', async () => {
    const s = await session(`A = [1 2 3; 4 5 6];
x = 5;`);
    await s.step(); // A = …
    await s.step(); // x = 5
    const fs = fields(s.state());
    expect(fs.map((f) => [f.key, f.value])).toEqual([
      ['A', '2x3 [1 2 3; 4 5 6]'],
      ['x', '1x1 5'],
    ]);
    expect(fs.map((f) => f.changed)).toEqual([false, true]);
  });

  it('previews truncate long matrices with …', async () => {
    const s = await session(`A = 1:10;
B = (1:6)';
C = [1 2 3 4 5 6; 7 8 9 10 11 12];`);
    await s.run();
    const map = new Map(fields(s.state()).map((f) => [f.key, f.value] as const));
    expect(map.get('A')).toBe('1x10 [1 2 3 4 …]');
    expect(map.get('B')).toBe('6x1 [1; 2; …]');
    expect(map.get('C')).toBe('2x6 [1 2 3 4 …; 7 8 9 10 …]');
  });

  it('Matrices shows every element with its column-major address and hex bytes', async () => {
    const s = await session(`A = [1 2; 3 4];`);
    await s.run();
    const rs = rows(s.state(), 'matrix');
    expect(rs.map((r) => [r.addr, r.text])).toEqual([
      [0, 'A(1,1) = 1'],
      [1, 'A(2,1) = 3'],
      [2, 'A(1,2) = 2'],
      [3, 'A(2,2) = 4'],
    ]);
    expect(rs.map((r) => r.bytes)).toEqual([
      '3ff0000000000000', // 1.0
      '4008000000000000', // 3.0
      '4000000000000000', // 2.0
      '4010000000000000', // 4.0
    ]);
    expect(rs.every((r) => r.current)).toBe(true); // the write touched all
  });

  it('only the elements the LAST statement wrote are marked current', async () => {
    const s = await session(`M = zeros(2, 3);
M(2, 2) = 42;
M(1, :) = [7 8 9];`);
    await s.run();
    const marked = rows(s.state(), 'matrix')
      .filter((r) => r.current)
      .map((r) => r.text);
    expect(marked).toEqual(['M(1,1) = 7', 'M(1,2) = 8', 'M(1,3) = 9']);
  });

  it('Call stack names each function frame and its own workspace', async () => {
    const { r, s } = await run(`function inner(b)
  half = b / 2;
end
function outer(a)
  q = inner(a);
end
outer(8);`, [2]);
    expect(r.pausedAt).toBe(2);
    expect(rows(s.state(), 'stack').map((row) => row.text)).toEqual([
      'script · base workspace',
      'outer · own workspace: a',
      'inner · own workspace: b',
    ]);
  });
});

describe('stepping, breakpoints, reset, budget', () => {
  it('steps one statement at a time and reports the next line', async () => {
    const s = await session(`A = 1;
B = 2;
C = A + B;`);
    const st1 = await s.step();
    expect(st1).toEqual({ ran: true, result: { finished: false, steps: 2, pausedAt: 2 } });
    const st2 = await s.step();
    expect(st2.ran).toBe(true);
    expect(st2.result?.pausedAt).toBe(3);
    const st3 = await s.step();
    expect(st3.result?.finished).toBe(true);
    const st4 = await s.step();
    expect(st4.ran).toBe(false);
    expect(st4.result?.exit).toBe('exit(0)');
  });

  it('pauses before a breakpoint line, inside loops and functions, and resumes', async () => {
    const { r, s } = await run(`t = 0;
for k = 1:5
  t = t + k;
end
disp(t)`, [3]);
    expect(r.pausedAt).toBe(3);
    expect(out(s.state())).toBe('');
    const hits: number[] = [];
    for (;;) {
      const res = await s.run([3]);
      if (res.pausedAt === undefined) {
        expect(res.exit).toBe('exit(0)');
        break;
      }
      hits.push(res.pausedAt);
    }
    // five trips in total: the run above plus four more (the last
    // resume finishes the loop without re-tripping line 3)
    expect(hits).toEqual([3, 3, 3, 3]);
    expect(out(s.state()).trimEnd()).toBe('15');
  });

  it('reset() rewinds to the start: same output twice', async () => {
    const s = await session(`x = 2;
disp(x * 3)`);
    const first = await s.run();
    s.reset();
    const second = await s.run();
    expect(first).toEqual(second);
    expect(first.steps).toBe(2);
  });

  it('a crashed run keeps reporting its error until reset', async () => {
    const s = await session(`x = 1 / 0;
y = [1 2] + [1 2 3];`);
    const r1 = await s.run();
    expect(r1.error).toContain('matrix dimensions must agree');
    const r2 = await s.run();
    expect(r2.error).toBe(r1.error);
    expect(r2.finished).toBe(false);
    s.reset();
    const r3 = await s.run();
    expect(r3.error).toBe(r1.error); // deterministic: same source, same crash
  });

  it('stops a runaway while 1 at 1,000,000 units with the line named', async () => {
    const { r } = await run(`n = 0;
while 1
  n = n + 1;
end`);
    expect(r.error).toBe(
      'line 2: run budget exceeded (1,000,000 evaluation units) — the program never finished',
    );
    expect(r.steps).toBe(1_000_001);
  });

  it('bounds a huge range request cleanly', async () => {
    const { r } = await run(`x = 1:1000000000;`);
    expect(r.error).toBe(
      'line 1: matrix too large for the teaching interpreter: 1x1000000000 is 1,000,000,000 elements (limit 1,000,000)',
    );
  });
});

describe('refusals and parse errors are line-mapped', () => {
  it('refuses cells, function handles, structs, global, try/catch before running', async () => {
    const cases: [string, string, number][] = [
      ['c = {1 2};', 'not in the teaching subset: cell arrays ({}) — matrices are the only data structure', 1],
      ['f = @(x) x;', 'not in the teaching subset: anonymous functions (@)', 1],
      ['A = [1 2];\nb = A.x;', 'not in the teaching subset: structs (a.b) — matrices are the only data structure', 2],
      ['global g;', "not in the teaching subset: 'global' — functions own their workspace; scripts share the base workspace", 1],
      ['try\n  x = 1\ncatch\nend', 'not in the teaching subset: try/catch — an error stops the block and names its line', 1],
    ];
    for (const [src, message, line] of cases) {
      const load = await matlabKernel.createSession().load(src);
      expect(load, src).toEqual({ ok: false, line, message });
    }
  });

  it('refuses double-quoted strings with the line named', async () => {
    const load = await matlabKernel.createSession().load(`x = 1;\ndisp("oops");`);
    expect(load).toEqual({
      ok: false,
      line: 2,
      message: "not in the teaching subset: double-quoted strings — use 'single quotes'",
    });
  });

  it('maps syntax errors to their source line', async () => {
    const cases: [string, number, RegExp][] = [
      ['A = [1 2\n', 2, /missing ']' to close the matrix literal/],
      ['x = 1 + ;', 1, /expected a value, name/],
      ['if x > 0\n  y = 1;', 2, /missing 'end' — every if\/for\/while\/function block needs one/],
      ['f( = 2', 1, /expected a value, name/],
      ['x = 1 2', 1, /expected ';' \(silent\), ',' or a new line after the statement/],
      ['end', 1, /'end' without a matching if\/for\/while\/function/],
      ['1 < 2 < 3', 1, /chained comparisons are not in the teaching subset/],
      ['x = 1:2:3:4;', 1, /too many ':'/],
    ];
    for (const [src, line, re] of cases) {
      const load = await matlabKernel.createSession().load(src);
      expect(load.ok, src).toBe(false);
      if (!load.ok) {
        expect(load.line, src).toBe(line);
        expect(load.message, src).toMatch(re);
      }
    }
  });

  it('refuses arithmetic inside [ ] honestly: [1-2] is the row [1, -2]', async () => {
    expect(await runOut(`disp([1 -2])
disp([(1 - 2)])`)).toBe(' 1  -2\n-1');
  });

  it('comments run from % to the end of the line', async () => {
    expect(await runOut(`x = 5; % set x
% a whole line
disp(x) % show it`)).toBe('5');
  });
});

describe('review fixes: stack depth, big inputs, honest refusals', () => {
  it('infinite recursion dies with the clean line-mapped "call stack too deep", not a raw JS RangeError', async () => {
    const { r } = await run(`function y = r(x)
  y = r(x);
end
disp(r(1));`);
    expect(r.error).toBe('line 2: call stack too deep (over 512 nested calls) — recursion needs a base case');
  });

  it('legit recursion still works at the lower depth: fact(10) and fib(15)', async () => {
    expect(await runOut(`function f = fact(n)
  if n <= 1
    f = 1;
  else
    f = n * fact(n - 1);
  end
end
function f = fib(n)
  if n < 2
    f = n;
  else
    f = fib(n - 1) + fib(n - 2);
  end
end
disp(fact(10))
disp(fib(15))`)).toBe('3628800\n610');
  });

  it('max folds instead of spreading: max(1:1000000) completes', async () => {
    expect(await runOut(`disp(max(1:1000000))`)).toBe('1000000');
  });

  it('det folds its scale instead of spreading: det(ones(50)) is 0 by elimination', async () => {
    expect(await runOut(`A = ones(50);
disp(det(A))`)).toBe('0');
  });

  it('[r, c] = size(A) is refused honestly, not "undefined function size"', async () => {
    const { r } = await run(`A = [1 2 3; 4 5 6];
[r, c] = size(A);`);
    expect(r.error).toBe(
      'line 2: not in the teaching subset: two outputs from builtins — use s = size(A), then s(1) and s(2)',
    );
  });
});

describe('load summaries', () => {
  it('counts functions and statements', async () => {
    const script = matlabKernel.createSession();
    expect(await script.load('x = 1;\ny = 2;')).toEqual({
      ok: true,
      summary: 'loaded · 2 statements',
    });
    const withFn = matlabKernel.createSession();
    const load = await withFn.load(`function y = f(x)
  y = x;
end
z = f(1);`);
    expect(load).toEqual({ ok: true, summary: 'loaded · 1 function, 1 statement' });
  });
});
