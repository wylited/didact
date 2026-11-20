// The Python helper, executed by a host CPython.
//
// `src/toolkit.py` is what the session installs into Pyodide. Quoting its
// source proves nothing, so when a host `python3` (3.12+) exists this file
// loads the real file, calls the same `lw_*` entry points the session
// calls, and asserts what a run leaves behind: which lines ran and how
// often, loop iterations and branch tallies, the grouped snapshot, the
// annotation mismatches, and the failure story.
//
// Without a host interpreter the suite skips (the Pyodide smoke test is the
// browser-engine check). A skip is reported as a skip — never as a pass.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOLKIT_SOURCE } from '../src/toolkit';
import type { AnnotationRow, FlowData, TraceRow, VarInfo } from '../src/xray';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLKIT = resolve(HERE, '../src/toolkit.py');

/**
 * A driver script: loads the helper, runs a scenario written by the test,
 * and prints one JSON document. The scenario is Python that may use
 * `tk.<lw_*>` and a fresh `ns` dict.
 */
function drive(body: string): string {
  const script = `
import json, sys
tk_ns = {'__name__': 'didact_tk'}
exec(compile(open(${JSON.stringify(TOOLKIT)}, encoding='utf-8').read(), 'toolkit.py', 'exec'), tk_ns)

def ok(value):
    return json.loads(value)

${body}
`;
  const run = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 60_000 });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) {
    throw new Error(`python3 failed (${run.status}):\n${run.stderr}\n${run.stdout}`);
  }
  return run.stdout;
}

function doc<T>(body: string): T {
  // the scenario prints exactly one JSON document on its last line
  const out = drive(body).trim().split('\n').pop() ?? '';
  return JSON.parse(out) as T;
}

const probe = spawnSync('python3', ['-c', 'import sys; print(sys.version_info >= (3, 12))'], { encoding: 'utf8' });
const host = probe.status === 0 && probe.stdout.trim() === 'True';
const hostVersion = spawnSync('python3', ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' }).stdout.trim();
const withMonitoring = spawnSync('python3', ['-c', 'import sys; print(hasattr(sys, "monitoring"))'], { encoding: 'utf8' }).stdout.trim() === 'True';

describe.skipIf(!host)('toolkit.py under host CPython', () => {
  it('runs on the CPython version this suite was written against', () => {
    expect(hostVersion).toMatch(/^3\.(1[2-9]|2[0-9])$/);
  });

  it('installs without touching the caller namespace beyond its own names', () => {
    const names = doc<string[]>(`
print(json.dumps(sorted(k for k in tk_ns if not k.startswith('__'))))
`);
    const publicNames = names.filter((n) => n.startsWith('lw_'));
    expect(publicNames).toContain('lw_compile');
    expect(publicNames).toContain('lw_trace');
    // everything else it defines is underscore-prefixed — except the two
    // constants the session reads (the module imports it reuses at call time
    // are bound locally by CPython, so nothing of theirs leaks in)
    const allowed = new Set(['FILENAME', 'TRACE_LIMIT', 'TRACE_LIMIT_FOR_RUN', 'REPR_LIMIT', 'ast', 'json', 'sys']);
    for (const n of names) {
      if (allowed.has(n)) continue;
      expect(n.startsWith('_') || n.startsWith('lw_')).toBe(true);
    }
  });

  describe('splitter', () => {
    it('cuts top-level statements at exact boundaries, with layout-stable text', () => {
      const split = doc<[string, number, number, number][]>(`
src = "x = 1\\nfor n in range(3):\\n    y = n\\n    if y:\\n        z = 1\\n\\nprint(y, z)\\n"
print(json.dumps(ok(tk_ns['lw_split'](src))))
`);
      expect(split.map(([, first, last]) => [first, last])).toEqual([[1, 1], [2, 5], [7, 7]]);
      expect(split[1]![0]).toBe('for n in range(3):\n    y = n\n    if y:\n        z = 1');
    });

    it('keeps decorators with their def and blank lines outside every statement', () => {
      const split = doc<[string, number, number, number][]>(`
src = "import math\\n\\n@staticmethod\\ndef f():\\n    return 1\\n\\n\\nclass K:\\n    pass\\n"
print(json.dumps(ok(tk_ns['lw_split'](src))))
`);
      expect(split.map(([, first, last]) => [first, last])).toEqual([[1, 1], [3, 5], [8, 9]]);
      expect(split[1]![0]).toBe('@staticmethod\ndef f():\n    return 1');
    });
  });

  describe('trace table', () => {
    it('counts exactly the lines a program executes, per statement', () => {
      const trace = doc<TraceRow[]>(`
prog = "squares = []\\nfor n in range(1, 6):\\n    squares.append(n * n)\\nprint(squares)\\n"
tk_ns['lw_compile'](prog)
ns = {'__name__': '__main__'}
tk_ns['lw_run'](ns)
print(json.dumps([dict(line=r[0], stmt=r[1], hits=r[2], meta=r[3]) for r in ok(tk_ns['lw_trace']())]))
`);
      const hits = new Map(trace.map((r) => [r.line, r.hits]));
      // line 1 once, the for header once per test (6), the body 5 times,
      // the print once — these are CPython's own counts
      expect(hits.get(1)).toBe(1);
      expect(hits.get(2)).toBe(6);
      expect(hits.get(3)).toBe(5);
      expect(hits.get(4)).toBe(1);
      // every row belongs to one of the four top-level statements
      expect(trace.map((r) => r.stmt)).toEqual([1, 2, 2, 3]);
    });

    it('leaves exactly one hit on the row of a statement that runs once', () => {
      const trace = doc<TraceRow[]>(`
tk_ns['lw_compile']("x = 1\\nx += 1\\nx += 1\\n")
tk_ns['lw_run']({'__name__': '__main__'})
print(json.dumps([dict(line=r[0], stmt=r[1], hits=r[2], meta=r[3]) for r in ok(tk_ns['lw_trace']())]))
`);
      expect(trace.map((r) => [r.line, r.stmt, r.hits])).toEqual([[1, 1, 1], [2, 2, 1], [3, 3, 1]]);
    });

    it('does not count function bodies or library code', () => {
      const trace = doc<TraceRow[]>(`
prog = "def f(n):\\n    return n * 2\\n\\ntotal = 0\\nfor i in range(4):\\n    total += f(i)\\n"
tk_ns['lw_compile'](prog)
tk_ns['lw_run']({'__name__': '__main__'})
print(json.dumps([dict(line=r[0], stmt=r[1], hits=r[2], meta=r[3]) for r in ok(tk_ns['lw_trace']())]))
`);
      // line 2 (the body of f) never runs at module level, so it is no row
      expect(trace.map((r) => r.line)).toEqual([1, 4, 5, 6]);
      expect(trace.find((r) => r.line === 5)!.hits).toBe(5);
    });

    it('marks the statement line as an outer row with the statement end', () => {
      const trace = doc<TraceRow[]>(`
tk_ns['lw_compile']("for i in range(2):\\n    pass\\n")
tk_ns['lw_run']({'__name__': '__main__'})
print(json.dumps([dict(line=r[0], stmt=r[1], hits=r[2], meta=r[3]) for r in ok(tk_ns['lw_trace']())]))
`);
      expect(trace[0]).toMatchObject({ line: 1, stmt: 1, meta: { outer: true, end: 2, loop: 1, head: true } });
      // the body line is re-read once per pass (2), so it is 2 — not the
      // statement count: it is the loop's iteration signal
      expect(trace[1]).toMatchObject({ line: 2, stmt: 1, hits: 2, meta: { tail: true } });
    });

    it('stops counting (and says so) when the record budget runs out', () => {
      const out = doc<{ overflow: boolean; hits: number }>(`
tk_ns['TRACE_LIMIT'] = 50
tk_ns['lw_compile']("for i in range(1000):\\n    pass\\n")
tk_ns['lw_run']({'__name__': '__main__'})
f = ok(tk_ns['lw_flow']()); print(json.dumps(dict(hits=f['hits'], overflow=f['overflow'], loops=f['loops'], branches=f['branches'])))
`);
      expect(out.overflow).toBe(true);
      expect(out.hits).toBe(50);
    });

    it('removes the hook at run end, so later code is not counted', () => {
      const trace = doc<TraceRow[]>(`
tk_ns['lw_compile']("x = 1\\n")
tk_ns['lw_run']({'__name__': '__main__'})
code = compile("y = 2\\n", 'lesson.py', 'exec')
exec(code, {'__name__': '__main__'})
print(json.dumps([dict(line=r[0], stmt=r[1], hits=r[2], meta=r[3]) for r in ok(tk_ns['lw_trace']())]))
`);
      expect(trace).toEqual([expect.objectContaining({ line: 1, hits: 1 })]);
    });

    it('runs unwatched when asked, leaving an empty but well-formed table', () => {
      const trace = doc<TraceRow[]>(`
tk_ns['lw_compile']("for i in range(3):\\n    pass\\n")
tk_ns['lw_run']({'__name__': '__main__'}, False)
print(json.dumps([dict(line=r[0], stmt=r[1], hits=r[2], meta=r[3]) for r in ok(tk_ns['lw_trace']())]))
`);
      expect(trace.map((r) => r.hits)).toEqual([0, 0]);
    });
  });

  describe('flow', () => {
    it('counts loop iterations and branch decisions', () => {
      const flow = doc<FlowData>(`
prog = """total = 0
for n in range(1, 6):
    if n % 2:
        total += n
    else:
        total -= 1
count = 0
while count < 3:
    count += 1
"""
tk_ns['lw_compile'](prog)
tk_ns['lw_run']({'__name__': '__main__'})
f = ok(tk_ns['lw_flow']()); print(json.dumps(dict(hits=f['hits'], overflow=f['overflow'], loops=f['loops'], branches=f['branches'])))
`);
      expect(flow.loops).toEqual([[2, 5], [8, 3]]);
      expect(flow.branches).toEqual([[3, [3, 2]]]);
      expect(flow.overflow).toBe(false);
    });

    it('counts zero iterations when the loop body never runs', () => {
      const flow = doc<FlowData>(`
tk_ns['lw_compile']("for i in range(0):\\n    pass\\n")
tk_ns['lw_run']({'__name__': '__main__'})
f = ok(tk_ns['lw_flow']()); print(json.dumps(dict(hits=f['hits'], overflow=f['overflow'], loops=f['loops'], branches=f['branches'])))
`);
      expect(flow.loops).toEqual([[1, 0]]);
    });
  });

  describe('snapshot', () => {
    it('groups every kind of name the block defines', () => {
      const snap = doc<Record<string, VarInfo>>(`
prog = "import json\\nn = 3\\nname = 'ada'\\nxs = [1, 2, 3]\\nd = {'a': 1}\\nf = len\\nclass K:\\n    pass\\npriv = 0\\n_hidden = 1\\n"
tk_ns['lw_compile'](prog)
ns = {'__name__': '__main__'}
tk_ns['lw_run'](ns)
print(json.dumps(ok(tk_ns['lw_snapshot'](ns))))
`);
      expect(snap['n']).toEqual({ group: 'scalar', type: 'int', repr: '3', size: null });
      expect(snap['name']).toMatchObject({ group: 'collection', type: 'str', size: 3 });
      expect(snap['xs']).toMatchObject({ group: 'collection', type: 'list', size: 3 });
      expect(snap['d']).toMatchObject({ group: 'collection', type: 'dict', size: 1 });
      expect(snap['f']).toMatchObject({ group: 'function' });
      expect(snap['K']).toMatchObject({ group: 'class' });
      expect(snap['json']).toMatchObject({ group: 'module' });
      // underscore names are the block's own business
      expect(snap).not.toHaveProperty('_hidden');
    });

    it('caps the repr at 200 characters with a single ellipsis', () => {
      const snap = doc<Record<string, VarInfo>>(`
tk_ns['lw_compile']("s = 'x' * 300\\n")
ns = {'__name__': '__main__'}
tk_ns['lw_run'](ns)
print(json.dumps(ok(tk_ns['lw_snapshot'](ns))))
`);
      expect(snap['s']!.repr).toHaveLength(200);
      expect(snap['s']!.repr.endsWith('…')).toBe(true);
      expect(snap['s']!.size).toBe(300);
    });
  });

  describe('annotations', () => {
    it('reports declared vs observed for annotated globals', () => {
      const anns = doc<AnnotationRow[]>(`
tk_ns['lw_compile']("count: int = 0\\nratio: float = 0.5\\nname: int = 'ada'\\n")
ns = {'__name__': '__main__'}
tk_ns['lw_run'](ns)
print(json.dumps(ok(tk_ns['lw_annotations'](ns))))
`);
      const rows = new Map(anns.map(([label, declared, observed, ok]) => [label, [declared, observed, ok]] as const));
      expect(rows.get('count')).toEqual(['int', 'int', true]);
      expect(rows.get('ratio')).toEqual(['float', 'float', true]);
      // the teaching signal: an annotation is not enforced
      expect(rows.get('name')).toEqual(['int', 'str', false]);
    });

    it('reports the first observed call type of an annotated parameter', () => {
      const anns = doc<{ anns: AnnotationRow[]; calls: Record<string, Record<string, string>> }>(`
tk_ns['lw_compile']("def f(n: int) -> int:\\n    return int(n * 2)\\n")
ns = {'__name__': '__main__'}
tk_ns['lw_run'](ns)
tk_ns['lw_record_call']('f', (2.0,), {})
tk_ns['lw_record_return']('f', 4)
print(json.dumps({'anns': ok(tk_ns['lw_annotations'](ns)), 'calls': ok(tk_ns['lw_calls']())}))
`);
      const byLabel = new Map(anns.anns.map(([label, declared, observed, ok]) => [label, [declared, observed, ok]] as const));
      expect(byLabel.get('f(n)')).toEqual(['int', 'float', false]);
      expect(byLabel.get('f →')).toEqual(['int', 'int', true]);
      expect(anns.calls['f']).toEqual({ arg0: 'float', '->': 'int' });
    });

    it('says "not called" rather than guessing when a function never ran', () => {
      const anns = doc<AnnotationRow[]>(`
tk_ns['lw_compile']("def g(n: int):\\n    return n\\n")
tk_ns['lw_run']({'__name__': '__main__'})
print(json.dumps(ok(tk_ns['lw_annotations']({'g': 0}))))
`);
      expect(anns.find(([label]) => label === 'g(n)')).toEqual(['g(n)', 'int', 'not called', true]);
    });
  });

  describe('failure story', () => {
    it('records the traceback, the failing line and that frame\'s locals', () => {
      const out = doc<{ error: string; traceback: [string, number][]; localNames: string[]; frames: [string, number][] }>(`
prog = """def mean(xs):
    total = 0
    for x in xs:
        total += x
    return total / len(xs)

mean([])
"""
tk_ns['lw_compile'](prog)
try:
    tk_ns['lw_run']({'__name__': '__main__'})
except ZeroDivisionError as exc:
    tb = json.loads(tk_ns['lw_fail'](exc))
    print(json.dumps({'error': tb['error'], 'traceback': tb['traceback'],
                      'localNames': sorted(json.loads(tk_ns['lw_locals']()).keys()),
                      'frames': json.loads(tk_ns['lw_traceback']())['traceback']}))
else:
    raise SystemExit('the run should have failed')
`);
      expect(out.error).toBe('ZeroDivisionError: division by zero');
      expect(out.traceback).toEqual([['<module>', 7], ['mean', 5]]);
      expect(out.localNames).toEqual(['total', 'xs']);
      expect(out.frames).toEqual([['<module>', 7], ['mean', 5]]);
    });

    it('leaves the error summary as the traceback\'s last line', () => {
      const out = doc<{ error: string; traceback: [string, number][] }>(`
tk_ns['lw_compile']("x = 0\\n1 / x\\n")
try:
    tk_ns['lw_run']({'__name__': '__main__'})
except ZeroDivisionError as exc:
    print(json.dumps(ok(tk_ns['lw_fail'](exc))))
`);
      expect(out.error.split('\\n').pop()).toBe('ZeroDivisionError: division by zero');
      expect(out.traceback).toEqual([['<module>', 2]]);
    });

    it('removes the hook when the program throws', () => {
      const trace = doc<TraceRow[]>(`
tk_ns['lw_compile']("a = 1\\nb = 1 / 0\\nc = 3\\n")
try:
    tk_ns['lw_run']({'__name__': '__main__'})
except ZeroDivisionError:
    pass
exec(compile("d = 4\\n", 'lesson.py', 'exec'), {'__name__': '__main__'})
print(json.dumps([dict(line=r[0], stmt=r[1], hits=r[2], meta=r[3]) for r in ok(tk_ns['lw_trace']())]))
`);
      expect(trace.map((r) => [r.line, r.hits])).toEqual([[1, 1], [2, 1], [3, 0]]);
    });
  });

  it('reports the hook mechanism it used (monitoring on this interpreter)', () => {
    const mode = doc<string>(`print(json.dumps(tk_ns['lw_mode']()))`);
    expect(mode).toBe(withMonitoring ? 'monitoring' : 'settrace');
  });
});

/* The embedded copy must be the file that is tested — a drift check that
 * runs even where no host interpreter exists. */
describe('toolkit embedding', () => {
  it('embeds src/toolkit.py verbatim', () => {
    expect(TOOLKIT_SOURCE).toBe(readFileSync(TOOLKIT, 'utf8'));
  });
});
