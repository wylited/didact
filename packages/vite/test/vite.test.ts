import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { diagramKey, mathKey } from '@didact/core/typst';
import {
  prerenderOrgPagesByPage,
  prerenderPageFiles,
  prerenderPageFilesByPage,
} from '../src/typst/prerender';
import { compileDiagram, compileMath, mathLayoutCss } from '../src/typst/engine';
import {
  didactTypst,
  TYPST_RESOLVED_ID,
  type DidactTypstOptions,
} from '../src/typst/vite';

// The engine is a wasm compiler; these tests exercise grouping, chunking and
// caching, so fixed deterministic stubs stand in for every compile.
vi.mock('../src/typst/engine', () => ({
  configureTypstEngine: vi.fn(),
  compileMath: vi.fn(async (src: string) => ({
    mathml: `<math><mi>${src}</mi></math>`,
    svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
  })),
  compileDiagram: vi.fn(
    async () => '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
  ),
  mathLayoutCss: vi.fn(async () => '.typst-math{display:inline}'),
}));

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function pagesDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'didact-typst-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  return dir;
}

function orgPage(title: string, body: string): string {
  return `#+TITLE: ${title}\n\n${body}\n`;
}

interface FakeContext {
  addWatchFile: (id: string) => void;
}

type LoadFn = (this: FakeContext, id: string) => Promise<string | null>;
type ResolveFn = (id: string) => string | null;
type ConfigResolvedFn = (config: { root: string; cacheDir: string }) => void;

function setup(
  dir: string,
  options: DidactTypstOptions = {},
): { plugin: Plugin; ctx: FakeContext } {
  const plugin = didactTypst({ pagesDir: dir, ...options });
  (plugin.configResolved as unknown as ConfigResolvedFn)({
    root: dir,
    cacheDir: 'node_modules/.vite',
  });
  return { plugin, ctx: { addWatchFile: vi.fn() } };
}

function loadOf(plugin: Plugin): LoadFn {
  return plugin.load as unknown as LoadFn;
}

function resolveOf(plugin: Plugin): ResolveFn {
  return plugin.resolveId as unknown as ResolveFn;
}

/** Parse the JSON payload of an `export default <json>;` virtual module. */
function parseModule(code: string | null): Record<string, unknown> {
  expect(code).not.toBeNull();
  const text = code!;
  expect(text.startsWith('export default ')).toBe(true);
  return JSON.parse(text.slice('export default '.length).trim().replace(/;$/, ''));
}

describe('prerenderOrgPagesByPage', () => {
  it('groups each page’s keys and compiles a shared formula once', async () => {
    vi.mocked(compileMath).mockClear();
    vi.mocked(compileDiagram).mockClear();
    vi.mocked(mathLayoutCss).mockClear();

    const shared = 'g1 + 1';
    const onlyA = 'g1 + 2';
    const diagram = '#let g1 = circle(radius: 1)';
    const pages = await prerenderOrgPagesByPage({
      'a.org': orgPage(
        'Alpha',
        `Shared $${shared}$ and own $${onlyA}$.\n\n`
          + `#+BEGIN_SRC typst :results svg\n${diagram}\n#+END_SRC`,
      ),
      'b.org': orgPage('Beta', `Shared $${shared}$ again.`),
    });

    expect(Object.keys(pages)).toEqual(['a.org', 'b.org']);
    const a = pages['a.org']!;
    const b = pages['b.org']!;
    expect(Object.keys(a.math).sort()).toEqual(
      [mathKey(shared, false), mathKey(onlyA, false)].sort(),
    );
    expect(Object.keys(b.math)).toEqual([mathKey(shared, false)]);
    expect(Object.keys(a.diagrams)).toEqual([diagramKey(diagram)]);
    expect(Object.keys(b.diagrams)).toEqual([]);
    // One shared stylesheet value for every page, even pages without math.
    expect(a.mathCss).toBe(b.mathCss);
    expect(a.mathCss).not.toBe('');
    expect(mathLayoutCss).toHaveBeenCalledTimes(1);
    // shared once + onlyA once.
    expect(compileMath).toHaveBeenCalledTimes(2);
    expect(compileDiagram).toHaveBeenCalledTimes(1);
  });

  it('skips the stylesheet and keeps per-page maps empty without math', async () => {
    vi.mocked(mathLayoutCss).mockClear();
    const pages = await prerenderOrgPagesByPage({
      'plain.org': orgPage('Plain', 'Just prose.'),
    });
    expect(pages['plain.org']).toEqual({ math: {}, diagrams: {}, mathCss: '' });
    expect(mathLayoutCss).not.toHaveBeenCalled();
  });

  it('prerenderPageFilesByPage keys artifacts by page file name', async () => {
    const dir = await pagesDir({
      'a.org': orgPage('Alpha', 'Only $h1$.'),
      'b.org': orgPage('Beta', 'Only $h2$.'),
      'notes.txt': 'ignored',
    });
    const pages = await prerenderPageFilesByPage(dir);
    expect(Object.keys(pages).sort()).toEqual(['a.org', 'b.org']);
    expect(Object.keys(pages['a.org']!.math)).toEqual([mathKey('h1', false)]);
    expect(Object.keys(pages['b.org']!.math)).toEqual([mathKey('h2', false)]);
  });
});

describe('didactTypst perPage chunking', () => {
  it('emits loader-backed pages and keeps per-page math/diagrams out of the main module', async () => {
    const dir = await pagesDir({
      'a.org': orgPage('Alpha', 'Own $k1$.\n\n#+BEGIN_SRC typst :results svg\n#let k1 = 1\n#+END_SRC'),
      'b.org': orgPage('Beta', 'Own $k2$.'),
    });
    const { plugin, ctx } = setup(dir, { perPage: true });
    const resolveId = resolveOf(plugin);
    const load = loadOf(plugin);

    const main = await load.call(ctx, TYPST_RESOLVED_ID);
    expect(main).toContain('math: {}');
    expect(main).toContain('diagrams: {}');
    // The loader must hand core the artifacts object, not the module
    // namespace: `import()` resolves `{ default: TypstArtifacts }`.
    expect(main).toContain(
      '"a.org": () => import("virtual:didact-typst/page/a").then((m) => m.default)',
    );
    expect(main).toContain(
      '"b.org": () => import("virtual:didact-typst/page/b").then((m) => m.default)',
    );
    expect(main).toContain('mathCss: ".typst-math{display:inline}"');
    expect(main).not.toContain('k1');
    expect(main).not.toContain(mathKey('k2', false));
    // Every page file is a build dependency of the main module.
    expect(ctx.addWatchFile).toHaveBeenCalledWith(join(dir, 'a.org'));
    expect(ctx.addWatchFile).toHaveBeenCalledWith(join(dir, 'b.org'));

    const aId = resolveId('virtual:didact-typst/page/a');
    expect(aId).not.toBeNull();
    const a = parseModule(await load.call(ctx, aId!)) as {
      math: Record<string, unknown>;
      diagrams: Record<string, unknown>;
      mathCss: string;
    };
    expect(Object.keys(a.math)).toEqual([mathKey('k1', false)]);
    expect(Object.keys(a.diagrams)).toEqual([diagramKey('#let k1 = 1')]);
    expect(a.mathCss).toBe('.typst-math{display:inline}');
    // Page A's module does not carry page B's formula.
    expect(JSON.stringify(a)).not.toContain(mathKey('k2', false));

    const bId = resolveId('virtual:didact-typst/page/b');
    const b = parseModule(await load.call(ctx, bId!)) as {
      math: Record<string, unknown>;
      diagrams: Record<string, unknown>;
    };
    expect(Object.keys(b.math)).toEqual([mathKey('k2', false)]);
    expect(Object.keys(b.diagrams)).toEqual([]);
    expect(JSON.stringify(b)).not.toContain(mathKey('k1', false));
  });

  it('names the unknown page module id in the error', async () => {
    const dir = await pagesDir({ 'a.org': orgPage('Alpha', 'Hi.') });
    const { plugin, ctx } = setup(dir, { perPage: true });
    const id = resolveOf(plugin)('virtual:didact-typst/page/ghost');
    await expect(loadOf(plugin).call(ctx, id!)).rejects.toThrow(
      'didact-typst: unknown page module id "virtual:didact-typst/page/ghost" — no ghost.org in',
    );
  });

  it('rejects page module loads without perPage', async () => {
    const dir = await pagesDir({ 'a.org': orgPage('Alpha', 'Hi.') });
    const { plugin, ctx } = setup(dir);
    const id = resolveOf(plugin)('virtual:didact-typst/page/a');
    await expect(loadOf(plugin).call(ctx, id!)).rejects.toThrow(
      'requires the didactTypst({ perPage: true }) option',
    );
  });

  it('keeps the eager module byte-compatible when perPage is false', async () => {
    const dir = await pagesDir({
      'a.org': orgPage('Alpha', 'Own $e1$.'),
      'b.org': orgPage('Beta', 'Own $e2$.'),
    });
    const { plugin, ctx } = setup(dir);
    const code = await loadOf(plugin).call(ctx, TYPST_RESOLVED_ID);
    const artifacts = await prerenderPageFiles(dir);
    expect(code).toBe(`export default ${JSON.stringify(artifacts)};\n`);
    expect(Object.keys(parseModule(code))).toEqual(['math', 'diagrams', 'mathCss']);
    // Eager mode inlines every page's formulas, exactly like the API it calls.
    expect(JSON.stringify(artifacts)).toContain(mathKey('e1', false));
    expect(JSON.stringify(artifacts)).toContain(mathKey('e2', false));
  });
});
