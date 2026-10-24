import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TypstDiagnostic, TypstSvgPage } from '../src/vendor';

// The engine loader is the only seam that touches the network/wasm; mock it
// with a deterministic fake typst compiler so session semantics (load/validate,
// run/render, reset, line mapping, panels) are asserted hermetically. The real
// engine is exercised by the bun smoke run documented in THIRD-PARTY.md.
const loadEngineMock = vi.hoisted(() => vi.fn());
vi.mock('../src/vendor', () => ({ loadEngine: loadEngineMock }));

import { TypstSession } from '../src/session';
import type { Panel } from '../src/types';

interface FakeEngineOpts {
  pages?: string[];
  warnings?: TypstDiagnostic[];
  errors?: TypstDiagnostic[];
  boom?: Error;
}

/** Deterministic stand-in for the typst-wasm compiler. */
function fakeEngine(opts: FakeEngineOpts = {}) {
  const sources = new Map<string, string>();
  const compileCalls: string[] = [];
  loadEngineMock.mockImplementation(async () => ({
    async addSource(path: string, text: string) {
      sources.set(path, text);
    },
    async compile(request: { main: string; format: 'svg' }) {
      compileCalls.push(`${request.main}:${sources.get(request.main) ?? ''}`);
      if (opts.boom) throw opts.boom;
      if (opts.errors) {
        throw Object.assign(new Error('typst: failed'), { diagnostics: opts.errors });
      }
      const pages: TypstSvgPage[] = (opts.pages ?? [narrowSvg()]).map((output, i) => ({
        page: i + 1,
        output,
      }));
      return { pages, diagnostics: opts.warnings ?? [] };
    },
  }));
  return { compileCalls };
}

function narrowSvg(): string {
  return '<svg viewBox="0 0 100 50" width="100pt" height="50pt"></svg>';
}

function wideSvg(): string {
  return '<svg viewBox="0 0 900 50" width="900pt" height="50pt"></svg>';
}

const ERR_LINE_3: TypstDiagnostic = {
  message: 'unclosed delimiter',
  severity: 'error',
  file: 'block-1.typ',
  line: 3,
  column: 7,
  hints: ['close the dollar sign'],
};

function htmlPanel(panels: Panel[]): Extract<Panel, { kind: 'html' }> | undefined {
  return panels.find((p): p is Extract<Panel, { kind: 'html' }> => p.kind === 'html');
}

function consolePanel(panels: Panel[]): Extract<Panel, { kind: 'console' }> | undefined {
  return panels.find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
}

beforeEach(() => {
  loadEngineMock.mockReset();
});

describe('TypstSession.load', () => {
  it('compiles and reports a page/ms summary', async () => {
    fakeEngine({ pages: [narrowSvg()] });
    const session = new TypstSession();
    const result = await session.load('= Hello\n$x^2$');
    expect(result).toEqual({ ok: true, summary: expect.stringMatching(/^compiled · 1 page · \d+ ms$/) });
  });

  it('maps the engine diagnostic to its 1-based line', async () => {
    fakeEngine({ errors: [ERR_LINE_3] });
    const session = new TypstSession();
    const result = await session.load('= Hello\n\n$oops');
    expect(result).toEqual({
      ok: false,
      line: 3,
      message: 'unclosed delimiter (close the dollar sign)',
    });
  });

  it('reports engine-availability failures without a source line', async () => {
    loadEngineMock.mockRejectedValue(new Error('no WebAssembly JSPI in this browser'));
    const session = new TypstSession();
    expect(await session.load('Hello')).toEqual({
      ok: false,
      line: 0,
      message: 'engine unavailable: no WebAssembly JSPI in this browser',
    });
  });

  it('reports non-diagnostic engine throws as failures', async () => {
    fakeEngine({ boom: new Error('wasm trap') });
    const session = new TypstSession();
    expect(await session.load('Hello')).toEqual({
      ok: false,
      line: 0,
      message: 'engine failure: wasm trap',
    });
  });
});

describe('TypstSession.run', () => {
  it('renders the engine svg in a page panel, with document fields', async () => {
    fakeEngine({ pages: [narrowSvg()] });
    const session = new TypstSession();
    await session.load('= Hello');
    expect(await session.run()).toEqual({ finished: true, steps: 0, exit: 'exit(0)' });

    const panels = session.state();
    const page = htmlPanel(panels);
    expect(page?.title).toBe('page');
    expect(page?.html).toContain('<svg');
    expect(page?.html).toContain('flex-direction:column');
    expect(consolePanel(panels)).toBeUndefined();
    const fields = panels.find((p) => p.kind === 'fields');
    expect(fields && fields.kind === 'fields' && fields.fields.map((f) => f.key)).toEqual([
      'pages',
      'compile',
    ]);
  });

  it('switches oversized pages to width 100%', async () => {
    fakeEngine({ pages: [wideSvg()] });
    const session = new TypstSession();
    await session.load('WIDE');
    await session.run();
    const page = htmlPanel(session.state());
    expect(page?.html).toContain('width="100%"');
    expect(page?.html).not.toContain('height="900pt"');
    expect(page?.html).toContain('height:auto');
  });

  it('shows warnings in a console panel and counts them', async () => {
    fakeEngine({
      warnings: [
        { message: 'layout did not converge', severity: 'warning', file: 'block-1.typ', line: 2, column: 1, hints: [] },
      ],
    });
    const session = new TypstSession();
    await session.load('= H');
    await session.run();
    const panels = session.state();
    expect(consolePanel(panels)?.text).toContain('block-1.typ:2:1: warning: layout did not converge');
    const fields = panels.find((p) => p.kind === 'fields');
    expect(fields && fields.kind === 'fields' && fields.fields.map((f) => f.key)).toEqual([
      'pages',
      'compile',
      'warnings',
    ]);
  });

  it('fails with the diagnostic line when the load compile errored', async () => {
    fakeEngine({ errors: [ERR_LINE_3] });
    const session = new TypstSession();
    await session.load('= H');
    const result = await session.run();
    expect(result.finished).toBe(false);
    expect(result.error).toContain('line 3');
    expect(result.error).toContain('unclosed delimiter');
  });

  it('recompiles after reset cleared the compiled output', async () => {
    const engine = fakeEngine({ pages: [narrowSvg()] });
    const session = new TypstSession();
    await session.load('= H');
    await session.run();
    session.reset();
    expect(htmlPanel(session.state())).toBeUndefined();

    expect(await session.run()).toEqual({ finished: true, steps: 0, exit: 'exit(0)' });
    expect(htmlPanel(session.state())?.html).toContain('<svg');
    expect(engine.compileCalls).toHaveLength(2);
  });
});

describe('TypstSession stepping', () => {
  it('never steps', async () => {
    fakeEngine();
    const session = new TypstSession();
    await session.load('= H');
    expect(await session.step()).toEqual({ ran: false });
    session.dispose();
    expect(session.state()).toEqual([]);
  });
});
