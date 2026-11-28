import { describe, expect, it } from 'vitest';
import type { PyodideInterface } from 'pyodide';
import { createPythonKernel, pythonKernel, PythonSession } from '../src/index';
import type { Panel } from '../src/types';

interface FakeProxy {
  readonly id: number;
  readonly payload: Record<string, unknown>;
  destroyed: boolean;
  destroy(): void;
}

/**
 * Deterministic stand-in for Pyodide that implements the exact surface
 * PythonSession exercises (toolkit install, namespace proxy creation/destruction,
 * compile/run helpers, stdout routing, and snapshot JSON).
 */
function makeFakePyodide() {
  let nextProxyId = 0;
  let runCount = 0;
  let compiledSrc = '';
  let hits = 0;
  let stdoutWrite: ((b: Uint8Array) => number) | null = null;
  const namespaces: FakeProxy[] = [];
  const compiledHistory: string[] = [];

  const py = {
    globals: {},
    toPy(obj: Record<string, unknown>): FakeProxy {
      const proxy: FakeProxy = {
        id: ++nextProxyId,
        payload: { ...obj },
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      if ('__name__' in obj) namespaces.push(proxy);
      return proxy;
    },
    setStdout(opts?: { write?: (b: Uint8Array) => number }) {
      stdoutWrite = opts?.write ?? null;
    },
    setStderr(_opts?: { write?: (b: Uint8Array) => number }) {
      // no-op for fake
    },
    runPython(_code: string) {
      return undefined;
    },
    async runPythonAsync(code: string, opts?: { locals?: FakeProxy }): Promise<unknown> {
      const locals = opts?.locals?.payload;
      if (code === 'lw_check(src)') return null;
      if (code === 'lw_compile(src)') {
        compiledSrc = String(locals?.src ?? '');
        compiledHistory.push(compiledSrc);
        hits = 0;
        return '1';
      }
      if (code === 'lw_split_json(src)') {
        return JSON.stringify([{ text: String(locals?.src ?? ''), first: 1, last: 1 }]);
      }
      if (code === 'lw_mode()') return 'monitoring';
      if (code === 'lw_start()') return 'monitoring';
      if (code === 'lw_stop()') return '1';
      if (code === 'lw_run(ns, True)') {
        const ns = locals?.ns as FakeProxy;
        runCount++;
        hits = 1;
        ns.payload.vars = {
          x: { group: 'scalar', type: 'int', repr: String(runCount), size: null },
        };
        const chunk = new TextEncoder().encode(`run ${runCount}: ${compiledSrc.trim()}\n`);
        stdoutWrite?.(chunk);
        return 'done';
      }
      if (code === 'lw_trace()') {
        return JSON.stringify([[1, 1, hits, { outer: true }]]);
      }
      if (code === 'lw_annotations(ns)') return '[]';
      if (code === 'lw_flow()') {
        return JSON.stringify({ hits, overflow: false, loops: [], branches: [] });
      }
      if (code === 'lw_frames()') return '[]';
      if (code === 'lw_snapshot(ns)') {
        const ns = locals?.ns as FakeProxy | undefined;
        return JSON.stringify(ns?.payload.vars ?? {});
      }
      // Initial TOOLKIT_SOURCE install
      return undefined;
    },
  } as unknown as PyodideInterface;

  return { py, namespaces, compiledHistory };
}

function consoleText(panels: Panel[]): string {
  const con = panels.find((p): p is Extract<Panel, { kind: 'console' }> => p.id === 'py-console');
  return con?.text ?? '';
}

function varsFields(panels: Panel[]) {
  const panel = panels.find((p): p is Extract<Panel, { kind: 'fields' }> => p.id === 'py-vars');
  return panel?.fields ?? [];
}

describe('pythonKernel & createPythonKernel', () => {
  it('declares explicit features and creates a Python kernel', () => {
    expect(pythonKernel.id).toBe('python');
    expect(pythonKernel.label).toBe('Python · Pyodide');
    expect(pythonKernel.editorSyntax).toBe('python');
    expect(pythonKernel.features).toEqual({ stepping: false, breakpoints: false });

    const custom = createPythonKernel();
    expect(custom.id).toBe('python');
    expect(custom.features).toEqual({ stepping: false, breakpoints: false });
  });
});

describe('PythonSession lifecycle', () => {
  it('omits line on engine-boot failure LoadResult', async () => {
    const session = new PythonSession(() => Promise.reject(new Error('pyodide.js 404')));
    const result = await session.load('print(1)\n');
    expect(result).toEqual({
      ok: false,
      message: 'failed to load the Python engine: pyodide.js 404',
    });
    expect('line' in result).toBe(false);
  });

  it('reset() clears runtime state and preserves source so reset(); run() re-runs in a fresh namespace', async () => {
    const { py, namespaces, compiledHistory } = makeFakePyodide();
    const session = new PythonSession(() => Promise.resolve(py));

    const load = await session.load('x = 1\n');
    expect(load.ok).toBe(true);
    expect(namespaces).toHaveLength(1);

    const first = await session.run();
    expect(first).toEqual({ finished: true, steps: 0 });
    expect(consoleText(session.state())).toBe('run 1: x = 1\n');
    expect(varsFields(session.state()).some((f) => f.key === 'x' && f.value === '1')).toBe(true);

    // reset() destroys the previous namespace and clears console/variables.
    session.reset();
    expect(namespaces[0]!.destroyed).toBe(true);
    expect(consoleText(session.state())).toBe('');
    expect(varsFields(session.state())).toHaveLength(0);

    // A subsequent run() creates a brand-new namespace and re-runs the loaded source.
    const second = await session.run();
    expect(second).toEqual({ finished: true, steps: 0 });
    expect(namespaces).toHaveLength(2);
    expect(namespaces[1]!.id).not.toBe(namespaces[0]!.id);
    expect(namespaces[1]!.destroyed).toBe(false);
    expect(compiledHistory).toEqual(['x = 1\n', 'x = 1\n', 'x = 1\n']);
    expect(consoleText(session.state())).toBe('run 2: x = 1\n');
    expect(varsFields(session.state()).some((f) => f.key === 'x' && f.value === '2')).toBe(true);

    // dispose() drops the loaded source as well.
    session.dispose();
    expect(namespaces[1]!.destroyed).toBe(true);
    expect(await session.run()).toEqual({
      finished: false,
      steps: 0,
      error: 'nothing is loaded — press Run first',
    });
  });
});
