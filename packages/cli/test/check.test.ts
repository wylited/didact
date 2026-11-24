import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('keeps a NAME across prose and captions until the next src block', async () => {
    const dir = pages({
      'promised.org': [
        '#+TITLE: Promised',
        '#+NAME: first',
        'Prose between the promise and its block.',
        '',
        '#+CAPTION: A figure',
        '#+BEGIN_SRC python',
        'print("one")',
        '#+END_SRC',
        '',
        '#+BEGIN_SRC python',
        'print("two")',
        '#+END_SRC',
        '',
        '#+RESULTS: first',
        ': one',
      ].join('\n'),
    });

    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => ({
        code: 0,
        stdout: block.code.includes('one') ? 'one\n' : 'two\n',
        stderr: '',
      }),
    });

    expect(report.blocks).toHaveLength(2);
    expect(report.blocks[0]!.name).toBe('first');
    expect(report.blocks[0]!.status).toBe('ok');
    expect(report.blocks[1]!.status).toBe('ok');
  });

  it('accepts a colon-less NAME directive', async () => {
    const dir = pages({
      'nocolonname.org': [
        '#+TITLE: No colon name',
        '#+NAME first',
        '#+BEGIN_SRC python',
        'print("one")',
        '#+END_SRC',
      ].join('\n'),
    });

    const report = await checkPages({ pagesDir: dir });
    expect(report.blocks[0]!.name).toBe('first');
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

  it('never runs or reports code hidden in a comment block', async () => {
    const dir = pages({
      'hidden.org': [
        '#+TITLE: Hidden',
        '#+BEGIN_COMMENT',
        '#+BEGIN_SRC python',
        'print("hidden")',
        '#+END_SRC',
        '#+RESULTS:',
        ': stale',
        '#+END_COMMENT',
        '#+BEGIN_SRC python',
        'print("live")',
        '#+END_SRC',
        '#+RESULTS:',
        ': live',
      ].join('\n'),
    });

    const ran: string[] = [];
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => {
        ran.push(block.code);
        return { code: 0, stdout: 'live\n', stderr: '' };
      },
    });

    expect(ran).toEqual(['print("live")']);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]!.status).toBe('ok');
  });

  it('accepts a matching EXERCISE/CHECK block without RESULTS', async () => {
    const dir = pages({
      'drill.org': [
        '#+TITLE: Drill',
        '#+EXERCISE: Sum the squares',
        '#+CHECK: 30',
        '#+BEGIN_SRC python',
        'print(30)',
        '#+END_SRC',
      ].join('\n'),
    });

    const ran: string[] = [];
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => {
        ran.push(block.code);
        return { code: 0, stdout: '30\n', stderr: '' };
      },
    });

    expect(ran).toEqual(['print(30)']);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]).toMatchObject({ line: 5, lang: 'python', status: 'ok' });
  });

  it('normalizes line endings and trailing whitespace for CHECK', async () => {
    const dir = pages({
      'crlf.org': [
        '#+TITLE: CRLF',
        '#+CHECK: 30',
        '#+BEGIN_SRC python',
        'print(30)',
        '#+END_SRC',
      ].join('\n'),
    });

    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async () => ({ code: 0, stdout: '30  \r\n\r\n', stderr: '' }),
    });

    expect(report.blocks[0]!.status).toBe('ok');
  });

  it('flags a stale CHECK as a mismatch with its line and diff', async () => {
    const dir = pages({
      'stale-check.org': [
        '#+TITLE: Stale check',
        '#+EXERCISE: Double',
        '#+CHECK: 7',
        '#+BEGIN_SRC python',
        'print(6)',
        '#+END_SRC',
      ].join('\n'),
    });

    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async () => ({ code: 0, stdout: '6\n', stderr: '' }),
    });

    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]!.line).toBe(5);
    expect(report.blocks[0]!.status).toBe('mismatch');
    expect(report.blocks[0]!.detail).toContain('#+CHECK');
    expect(report.blocks[0]!.detail).toContain('-7');
    expect(report.blocks[0]!.detail).toContain('+6');
  });

  it('verifies both RESULTS and CHECK and names the failing checks', async () => {
    const dir = pages({
      'both.org': [
        '#+TITLE: Both',
        '#+CHECK: 99',
        '#+BEGIN_SRC python',
        'print(6)',
        '#+END_SRC',
        '#+RESULTS:',
        ': 7',
      ].join('\n'),
    });

    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async () => ({ code: 0, stdout: '6\n', stderr: '' }),
    });

    expect(report.blocks[0]!.status).toBe('mismatch');
    expect(report.blocks[0]!.detail).toContain('failed: canned #+RESULTS, #+CHECK');
    expect(report.blocks[0]!.detail).toContain('-7');
    expect(report.blocks[0]!.detail).toContain('-99');
    expect(report.blocks[0]!.detail).toContain('+6');
  });

  it('passes when both RESULTS and CHECK match', async () => {
    const dir = pages({
      'both-ok.org': [
        '#+TITLE: Both ok',
        '#+CHECK: 6',
        '#+BEGIN_SRC python',
        'print(6)',
        '#+END_SRC',
        '#+RESULTS:',
        ': 6',
      ].join('\n'),
    });

    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async () => ({ code: 0, stdout: '6\n', stderr: '' }),
    });

    expect(report.blocks[0]!.status).toBe('ok');
  });

  it('does not run an EXERCISE that has no CHECK and no RESULTS', async () => {
    const dir = pages({
      'unchecked.org': [
        '#+TITLE: Unchecked',
        '#+EXERCISE: Drill only',
        '#+BEGIN_SRC python',
        'print("anything")',
        '#+END_SRC',
      ].join('\n'),
    });

    let calls = 0;
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async () => {
        calls++;
        return { code: 0, stdout: 'anything\n', stderr: '' };
      },
    });

    expect(calls).toBe(0);
    expect(report.blocks[0]!.status).toBe('skipped');
  });

  it('ignores an EXERCISE hidden in a comment region', async () => {
    const dir = pages({
      'hidden-drill.org': [
        '#+TITLE: Hidden drill',
        '#+BEGIN_COMMENT',
        '#+EXERCISE: Hidden',
        '#+CHECK: nope',
        '#+BEGIN_SRC python',
        'print("hidden")',
        '#+END_SRC',
        '#+END_COMMENT',
        '#+BEGIN_SRC python',
        'print("live")',
        '#+END_SRC',
      ].join('\n'),
    });

    const ran: string[] = [];
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => {
        ran.push(block.code);
        return { code: 0, stdout: 'live\n', stderr: '' };
      },
    });

    expect(ran).toEqual(['print("live")']);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]!.status).toBe('ok');
  });

  it('verifies an EXERCISE on the source block inside a hint', async () => {
    const dir = pages({
      'hint.org': [
        '#+TITLE: Hint',
        '#+BEGIN_HINT',
        '#+EXERCISE: Sum',
        '#+CHECK: 30',
        '#+BEGIN_SRC python',
        'print(31)',
        '#+END_SRC',
        '#+END_HINT',
      ].join('\n'),
    });

    const ran: string[] = [];
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => {
        ran.push(block.code);
        return { code: 0, stdout: '31\n', stderr: '' };
      },
    });

    expect(ran).toEqual(['print(31)']);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]).toMatchObject({ line: 6, name: null, status: 'mismatch' });
    expect(report.blocks[0]!.detail).toContain('#+CHECK');
    expect(report.blocks[0]!.detail).toContain('-30');
    expect(report.blocks[0]!.detail).toContain('+31');
  });

  it('does not leak a NAME or EXERCISE created inside a hint to a later block', async () => {
    const dir = pages({
      'leak.org': [
        '#+TITLE: No leak',
        '#+BEGIN_HINT',
        '#+NAME: inner',
        '#+EXERCISE: Leaked',
        '#+CHECK: leaked',
        '#+END_HINT',
        '#+BEGIN_SRC python',
        'print("live")',
        '#+END_SRC',
      ].join('\n'),
    });

    const ran: string[] = [];
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => {
        ran.push(block.code);
        return { code: 0, stdout: 'live\n', stderr: '' };
      },
    });

    expect(ran).toEqual(['print("live")']);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]).toMatchObject({ name: null, status: 'ok' });
  });

  it('keeps an outer promise across a comment region', async () => {
    const dir = pages({
      'comment-scope.org': [
        '#+TITLE: Comment scope',
        '#+EXERCISE: Before',
        '#+CHECK: 30',
        '#+BEGIN_COMMENT',
        '#+EXERCISE: Hidden',
        '#+CHECK: nope',
        '#+BEGIN_SRC python',
        'print("hidden")',
        '#+END_SRC',
        '#+END_COMMENT',
        '#+BEGIN_SRC python',
        'print(30)',
        '#+END_SRC',
      ].join('\n'),
    });

    const ran: string[] = [];
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => {
        ran.push(block.code);
        return { code: 0, stdout: '30\n', stderr: '' };
      },
    });

    expect(ran).toEqual(['print(30)']);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]!.status).toBe('ok');
  });

  it('leaves an outer promise consumed inside a fold consumed', async () => {
    const dir = pages({
      'consume.org': [
        '#+TITLE: Consume',
        '#+EXERCISE: Outer',
        '#+CHECK: 30',
        '#+BEGIN_HINT',
        '#+BEGIN_SRC python',
        'print(30)',
        '#+END_SRC',
        '#+END_HINT',
        '#+BEGIN_SRC python',
        'print("other")',
        '#+END_SRC',
      ].join('\n'),
    });

    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => ({
        code: 0,
        stdout: block.code.includes('30') ? '30\n' : 'wrong\n',
        stderr: '',
      }),
    });

    expect(report.blocks).toHaveLength(2);
    expect(report.blocks[0]).toMatchObject({ line: 6, status: 'ok' });
    expect(report.blocks[1]).toMatchObject({ line: 10, status: 'ok' });
  });

  it('skips an EXERCISE/CHECK block the runner declines', async () => {
    const dir = pages({
      'drill.c.org': [
        '#+TITLE: C drill',
        '#+EXERCISE: Compile',
        '#+CHECK: ok',
        '#+BEGIN_SRC c',
        'int main(void) { return 0; }',
        '#+END_SRC',
      ].join('\n'),
    });

    const report = await checkPages({ pagesDir: dir, run: true, runner: async () => null });

    expect(report.blocks[0]!.status).toBe('skipped');
  });

  it('treats an unterminated, lower-case comment block as running to EOF', async () => {
    const dir = pages({
      'tail.org': [
        '#+TITLE: Tail',
        '#+begin_comment',
        '#+BEGIN_SRC python',
        'print("hidden")',
        '#+END_SRC',
      ].join('\n'),
    });

    let calls = 0;
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async () => {
        calls++;
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    expect(calls).toBe(0);
    expect(report.blocks).toEqual([]);
  });

  it('does not attach a named RESULTS block when no block has that name', async () => {
    const dir = pages({
      'orphan.org': [
        '#+TITLE: Orphan',
        '#+NAME: first',
        '#+BEGIN_SRC python',
        'print("one")',
        '#+END_SRC',
        '',
        '#+RESULTS: ghost',
        ': wrong',
      ].join('\n'),
    });

    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async () => ({ code: 0, stdout: 'one\n', stderr: '' }),
    });

    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]!.status).toBe('ok');
    expect(report.blocks[0]!.detail).toBeUndefined();
  });

  it('treats #+BEGIN_SRC:text as an inert text block covering the inner src', async () => {
    const dir = pages({
      'textlang.org': [
        '#+TITLE: Text lang',
        '#+BEGIN_SRC:text',
        '#+BEGIN_SRC python',
        'print("inner")',
        '#+END_SRC',
        '#+END_SRC',
      ].join('\n'),
    });

    const ran: { lang: string; code: string }[] = [];
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => {
        ran.push({ lang: block.lang, code: block.code });
        return null;
      },
    });

    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]!.lang).toBe('text');
    expect(ran).toEqual([{ lang: 'text', code: '#+BEGIN_SRC python\nprint("inner")' }]);
  });

  it('parses #+BEGIN_SRC:python as a Python block', async () => {
    const dir = pages({
      'colonlang.org': [
        '#+TITLE: Colon lang',
        '#+BEGIN_SRC:python',
        'print("hi")',
        '#+END_SRC',
        '#+RESULTS:',
        ': hi',
      ].join('\n'),
    });

    const ran: string[] = [];
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => {
        ran.push(block.code);
        return { code: 0, stdout: 'hi\n', stderr: '' };
      },
    });

    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]!.lang).toBe('python');
    expect(ran).toEqual(['print("hi")']);
    expect(report.blocks[0]!.status).toBe('ok');
  });

  it('does not close a comment on #+END_COMMENT: note', async () => {
    const dir = pages({
      'sticky.org': [
        '#+TITLE: Sticky',
        '#+BEGIN_COMMENT',
        '#+END_COMMENT: note',
        '#+BEGIN_SRC python',
        'print("hidden")',
        '#+END_SRC',
        '#+END_COMMENT',
        '#+BEGIN_SRC python',
        'print("live")',
        '#+END_SRC',
      ].join('\n'),
    });

    const ran: string[] = [];
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => {
        ran.push(block.code);
        return null;
      },
    });

    expect(ran).toEqual(['print("live")']);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]!.line).toBe(9);
  });

  it('treats #+BEGIN_COMMENT2 as a comment region', async () => {
    const dir = pages({
      'suffixed.org': [
        '#+TITLE: Suffixed',
        '#+BEGIN_COMMENT2',
        '#+BEGIN_SRC python',
        'print("hidden")',
        '#+END_SRC',
        '#+END_COMMENT',
        '#+BEGIN_SRC python',
        'print("live")',
        '#+END_SRC',
      ].join('\n'),
    });

    const ran: string[] = [];
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => {
        ran.push(block.code);
        return null;
      },
    });

    expect(ran).toEqual(['print("live")']);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]!.line).toBe(8);
  });

  it('sends a block that only mentions input() to the custom runner', async () => {
    const dir = pages({
      'inputish.org': [
        '#+TITLE: Inputish',
        '#+BEGIN_SRC python',
        '# input() would block, but this is a comment',
        'msg = "call input() in the browser"',
        'print(msg)',
        '#+END_SRC',
      ].join('\n'),
    });

    const ran: string[] = [];
    const report = await checkPages({
      pagesDir: dir,
      run: true,
      runner: async (block) => {
        ran.push(block.code);
        return { code: 0, stdout: 'call input() in the browser\n', stderr: '' };
      },
    });

    expect(ran).toHaveLength(1);
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
        code: 'input("this must not run")',
      }),
    ).resolves.toBeNull();
  });

  it('runs a block that only mentions input() in a comment or string', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'didact-check-shim-'));
    dirs.push(dir);
    const shim = join(dir, 'python-shim.sh');
    writeFileSync(shim, '#!/bin/sh\necho ok\n');
    chmodSync(shim, 0o755);
    const runner = pythonRunner(shim);

    await expect(
      runner({
        file: 'x.org',
        page: 'x',
        line: 1,
        lang: 'python',
        code: '# input() is only mentioned here\nprint("input()")',
      }),
    ).resolves.toEqual({ code: 0, stdout: 'ok\n', stderr: '' });
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
