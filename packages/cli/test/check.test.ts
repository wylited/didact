import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkPages, pythonRunner } from '../src/check';
import { parseCliArgs } from '../src/cli';

const dirs: string[] = [];

function pages(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'didact-check-test-'));
  dirs.push(dir);
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('checkPages: syntax', () => {
  it('reports no diagnostics for a clean page and scans its blocks', async () => {
    const dir = pages({
      'clean.org': [
        '#+TITLE: Clean',
        '',
        '#+NAME: hello',
        '#+BEGIN_SRC python',
        'print("hi")',
        '#+END_SRC',
        '',
        '#+RESULTS:',
        ': hi',
        '',
      ].join('\n'),
    });

    const report = await checkPages({ pagesDir: dir });

    expect(report.pages).toBe(1);
    expect(report.diagnostics).toEqual([]);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]).toMatchObject({
      file: 'clean.org',
      page: 'clean',
      line: 5,
      lang: 'python',
      name: 'hello',
      status: 'skipped',
    });
  });

  it('defaults a language-less block to text', async () => {
    const dir = pages({
      'plain.org': '#+TITLE: Plain\n#+BEGIN_SRC\nplain text\n#+END_SRC\n',
    });

    const report = await checkPages({ pagesDir: dir });

    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]).toMatchObject({
      line: 3,
      lang: 'text',
      name: null,
      status: 'skipped',
    });
  });

  it('maps an unknown directive to an exact file/line diagnostic', async () => {
    const dir = pages({ 'bad.org': '#+TITLE: Bad\n#+FOO: bar\n' });

    const report = await checkPages({ pagesDir: dir });

    expect(report.diagnostics).toEqual([
      {
        file: 'bad.org',
        page: 'bad',
        line: 2,
        severity: 'warning',
        message: 'unsupported directive #+FOO — dropped by the renderer',
      },
    ]);
  });
});

describe('checkPages: --run', () => {
  it('flags a stale RESULTS block as a mismatch', async () => {
    const dir = pages({
      'stale.org': [
        '#+TITLE: Stale',
        '#+BEGIN_SRC python',
        'print("new")',
        '#+END_SRC',
        '#+RESULTS:',
        ': old',
      ].join('\n'),
    });

    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async () => ({ code: 0, stdout: 'new\n', stderr: '' }),
    });

    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]!.status).toBe('mismatch');
    expect(report.blocks[0]!.detail).toContain('canned #+RESULTS');
    expect(report.blocks[0]!.detail).toContain('-old');
    expect(report.blocks[0]!.detail).toContain('+new');
  });

  it('reports a runner failure as an error with its stderr', async () => {
    const dir = pages({
      'broken.org': '#+TITLE: Broken\n#+BEGIN_SRC python\nraise SystemExit(2)\n#+END_SRC\n',
    });

    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async () => ({ code: 2, stdout: '', stderr: 'boom\n' }),
    });

    expect(report.blocks[0]!.status).toBe('error');
    expect(report.blocks[0]!.detail).toContain('exit 2');
    expect(report.blocks[0]!.detail).toContain('boom');
  });

  it('marks blocks skipped when the runner declines to execute them', async () => {
    const dir = pages({
      'c.org': '#+TITLE: C\n#+BEGIN_SRC c\nint main(void) { return 0; }\n#+END_SRC\n',
    });

    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async () => null,
    });

    expect(report.blocks[0]!.status).toBe('skipped');
  });

  it('skips :session blocks and still runs independent ones', async () => {
    const dir = pages({
      'shared.org': [
        '#+TITLE: Shared',
        '#+BEGIN_SRC python :session demo',
        'print("shared")',
        '#+END_SRC',
        '',
        '#+BEGIN_SRC python',
        'print("solo")',
        '#+END_SRC',
      ].join('\n'),
    });

    const ran: string[] = [];
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => {
        ran.push(block.code);
        return { code: 0, stdout: 'solo\n', stderr: '' };
      },
    });

    expect(report.blocks).toHaveLength(2);
    expect(report.blocks[0]!.status).toBe('skipped');
    expect(report.blocks[0]!.detail).toContain(':session demo');
    expect(report.blocks[1]!.status).toBe('ok');
    expect(ran).toEqual(['print("solo")']);
  });

  it('compares a colon-less RESULTS block', async () => {
    const dir = pages({
      'nocolon.org': [
        '#+TITLE: No colon',
        '#+BEGIN_SRC python',
        'print("new")',
        '#+END_SRC',
        '#+RESULTS',
        ': old',
      ].join('\n'),
    });

    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async () => ({ code: 0, stdout: 'new\n', stderr: '' }),
    });

    expect(report.blocks[0]!.status).toBe('mismatch');
    expect(report.blocks[0]!.detail).toContain('-old');
    expect(report.blocks[0]!.detail).toContain('+new');
  });

  it('attaches a named RESULTS block to the named block across comments', async () => {
    const dir = pages({
      'named.org': [
        '#+TITLE: Named',
        '#+NAME: first',
        '#+BEGIN_SRC python',
        'print("one")',
        '#+END_SRC',
        '',
        '#+BEGIN_SRC python',
        'print("two")',
        '#+END_SRC',
        '',
        '# an intervening comment',
        '#+RESULTS: first',
        ': one',
      ].join('\n'),
    });

    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => ({
        code: 0,
        stdout: block.code.includes('one') ? 'wrong\n' : 'two\n',
        stderr: '',
      }),
    });

    expect(report.blocks).toHaveLength(2);
    expect(report.blocks[0]!.status).toBe('mismatch');
    expect(report.blocks[0]!.detail).toContain('-one');
    expect(report.blocks[0]!.detail).toContain('+wrong');
    expect(report.blocks[1]!.status).toBe('ok');
  });

  it('accepts a matching RESULTS block', async () => {
    const dir = pages({
      'match.org': '#+TITLE: Match\n#+BEGIN_SRC python\nprint(1)\n#+END_SRC\n#+RESULTS:\n: 1\n',
    });

    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async () => ({ code: 0, stdout: '1\n', stderr: '' }),
    });

    expect(report.blocks[0]!.status).toBe('ok');
  });
});

describe('checkPages: page selection', () => {
  it('throws when no pages match', async () => {
    const empty = pages({});
    await expect(checkPages({ pagesDir: empty })).rejects.toThrow('no pages matched');

    const dir = pages({ 'one.org': '#+TITLE: One\n' });
    await expect(checkPages({ pagesDir: dir, pages: ['two'] })).rejects.toThrow(
      'no pages matched',
    );
  });

  it('filters by file stem', async () => {
    const dir = pages({
      'one.org': '#+TITLE: One\n',
      'two.org': '#+TITLE: Two\n',
    });

    const report = await checkPages({ pagesDir: dir, pages: ['two'] });

    expect(report.pages).toBe(1);
    expect(report.diagnostics).toEqual([]);
  });
});

describe('pythonRunner', () => {
  it('returns null for non-Python blocks without spawning an interpreter', async () => {
    const runner = pythonRunner('/definitely/not/a/python');

    await expect(
      runner({
        file: 'x.org',
        page: 'x',
        line: 1,
        lang: 'c',
        session: null,
        code: 'input("this must not run")',
      }),
    ).resolves.toBeNull();
  });
});

describe('parseCliArgs', () => {
  it('consumes the required check subcommand', () => {
    expect(parseCliArgs(['check', '--run', 'python'])).toEqual({
      pagesDir: null,
      run: true,
      python: null,
      stems: ['python'],
      help: false,
    });
    expect(parseCliArgs(['check']).stems).toEqual([]);
  });

  it('parses the remaining options and page stems', () => {
    expect(parseCliArgs(['check', '--pages', 'pages', '--python', 'py3', 'a', 'b'])).toEqual({
      pagesDir: 'pages',
      run: false,
      python: 'py3',
      stems: ['a', 'b'],
      help: false,
    });
  });

  it('accepts help forms', () => {
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs(['help']).help).toBe(true);
    expect(parseCliArgs(['check', '--help']).help).toBe(true);
  });

  it('rejects a missing or unknown subcommand', () => {
    expect(() => parseCliArgs([])).toThrow('missing command');
    expect(() => parseCliArgs(['lint'])).toThrow('unknown command: lint');
    expect(() => parseCliArgs(['--run'])).toThrow('unknown command: --run');
  });
});
