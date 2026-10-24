import { describe, expect, it } from 'vitest';
import { parseOrg } from '../src/org';

describe('parseOrg: directives', () => {
  it('parses #+TITLE and #+SUBTITLE into title/subtitle nodes', () => {
    const doc = parseOrg('#+TITLE: Registers\n#+SUBTITLE: x86-64 basics\n');
    expect(doc).toEqual([
      { kind: 'title', text: 'Registers' },
      { kind: 'subtitle', text: 'x86-64 basics' },
    ]);
  });

  it('ignores unknown #+KEYWORD directives entirely', () => {
    const doc = parseOrg('#+FOO: bar\n#+SETUPFILE: whatever\nhello\n');
    expect(doc).toEqual([{ kind: 'para', text: 'hello' }]);
  });

  it('hides plain # comments', () => {
    const doc = parseOrg('# a hidden comment\nvisible\n');
    expect(doc).toEqual([{ kind: 'para', text: 'visible' }]);
  });
});

describe('parseOrg: headings and prose', () => {
  it('parses headings with their asterisk level', () => {
    const doc = parseOrg('* One\n** Two\n*** Three and more\n');
    expect(doc).toEqual([
      { kind: 'heading', level: 1, text: 'One' },
      { kind: 'heading', level: 2, text: 'Two' },
      { kind: 'heading', level: 3, text: 'Three and more' },
    ]);
  });

  it('joins consecutive lines into one paragraph, blank line splits two', () => {
    const doc = parseOrg('first line\nwrapped\n\nsecond para\n');
    expect(doc).toEqual([
      { kind: 'para', text: 'first line wrapped' },
      { kind: 'para', text: 'second para' },
    ]);
  });
});

describe('parseOrg: lists', () => {
  it('collects list items and folds indented continuation lines into the item', () => {
    const doc = parseOrg('- alpha\n- beta\n  continued text\n+ gamma\n');
    expect(doc).toEqual([
      { kind: 'list', items: ['alpha', 'beta continued text', 'gamma'] },
    ]);
  });
});

describe('parseOrg: tables', () => {
  it('parses first row as head, skips separator rows, trims cells', () => {
    const doc = parseOrg('| Register | Bits |\n|---+---|\n| rax | 64 |\n| eax | 32 |\n');
    expect(doc).toEqual([
      {
        kind: 'table',
        head: ['Register', 'Bits'],
        rows: [
          ['rax', '64'],
          ['eax', '32'],
        ],
      },
    ]);
  });
});

describe('parseOrg: src blocks', () => {
  it('pairs #+NAME with the following src block and preserves code verbatim including blank lines', () => {
    const src = [
      '#+NAME: add',
      '#+BEGIN_SRC asm -n',
      '  mov rax, 1',
      '',
      '  ret',
      '#+END_SRC',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'src',
        lang: 'asm',
        name: 'add',
        headers: '-n',
        code: '  mov rax, 1\n\n  ret',
      },
    ]);
  });

  it('lowercases the language and defaults name to null without #+NAME', () => {
    const src = '#+BEGIN_SRC ASM\nret\n#+END_SRC\n';
    expect(parseOrg(src)).toEqual([
      { kind: 'src', lang: 'asm', name: null, headers: '', code: 'ret' },
    ]);
  });
});

describe('parseOrg: #+RESULTS pairing', () => {
  it('pairs #+RESULTS: <name> to the named src block', () => {
    const src = [
      '#+NAME: a',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
      '#+NAME: b',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
      '#+RESULTS: b',
      ': 42',
      ': ok',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      { kind: 'src', lang: 'asm', name: 'a', headers: '', code: 'ret' },
      { kind: 'src', lang: 'asm', name: 'b', headers: '', code: 'ret' },
      { kind: 'results', name: 'b', canned: '42\nok' },
    ]);
  });

  it('an un-named #+RESULTS carries name null and strips the leading colon of each : line', () => {
    expect(parseOrg('#+RESULTS:\n: hello\n')).toEqual([
      { kind: 'results', name: null, canned: 'hello' },
    ]);
  });
});
