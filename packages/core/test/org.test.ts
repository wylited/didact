import { describe, expect, it } from 'vitest';
import { normalizeOrgKeyword, parseOrg, parseOrgChecked } from '../src/org';

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

  it('drops a #+BEGIN_COMMENT block between two paragraphs', () => {
    const src = 'before\n#+BEGIN_COMMENT\nhidden words\nmore hidden\n#+END_COMMENT\nafter\n';
    expect(parseOrg(src)).toEqual([
      { kind: 'para', text: 'before' },
      { kind: 'para', text: 'after' },
    ]);
  });

  it('accepts lowercase comment markers', () => {
    const src = 'before\n#+begin_comment\nhidden\n#+end_comment\nafter\n';
    expect(parseOrg(src)).toEqual([
      { kind: 'para', text: 'before' },
      { kind: 'para', text: 'after' },
    ]);
  });

  it('skips src-block text inside a comment block as plain hidden lines', () => {
    const src = [
      'before',
      '#+BEGIN_COMMENT',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
      '#+END_COMMENT',
      'after',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      { kind: 'para', text: 'before' },
      { kind: 'para', text: 'after' },
    ]);
  });

  it('an unterminated comment block swallows the rest of the document', () => {
    const src = 'before\n#+BEGIN_COMMENT\nhidden\n\n* not a heading\nmore\n';
    expect(parseOrg(src)).toEqual([{ kind: 'para', text: 'before' }]);
  });

  it('parses text after #+END_COMMENT', () => {
    const src = '#+BEGIN_COMMENT\nhidden\n#+END_COMMENT\nafter\n\n* Heading\n';
    expect(parseOrg(src)).toEqual([
      { kind: 'para', text: 'after' },
      { kind: 'heading', level: 1, text: 'Heading' },
    ]);
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
        caption: null,
        headers: '-n',
        code: '  mov rax, 1\n\n  ret',
        exercise: null,
      },
    ]);
  });

  it('lowercases the language and defaults name to null without #+NAME', () => {
    const src = '#+BEGIN_SRC ASM\nret\n#+END_SRC\n';
    expect(parseOrg(src)).toEqual([
      {
        kind: 'src',
        lang: 'asm',
        name: null,
        caption: null,
        headers: '',
        code: 'ret',
        exercise: null,
      },
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
      { kind: 'src', lang: 'asm', name: 'a', caption: null, headers: '', code: 'ret', exercise: null },
      { kind: 'src', lang: 'asm', name: 'b', caption: null, headers: '', code: 'ret', exercise: null },
      { kind: 'results', name: 'b', canned: '42\nok' },
    ]);
  });

  it('an un-named #+RESULTS carries name null and strips the leading colon of each : line', () => {
    expect(parseOrg('#+RESULTS:\n: hello\n')).toEqual([
      { kind: 'results', name: null, canned: 'hello' },
    ]);
  });
});

// spec note: org.ts strips `/^\s*:\s?/` from each results line — exactly one
// leading colon plus at most one space. Emacs org-babel would treat `::` as
// a deeper nesting level and `:` alone as an empty line; this parser keeps
// the remainder verbatim. Pinned as-is; change deliberately if the org
// grammar is ever widened.
describe('parseOrg: #+RESULTS colon stripping', () => {
  it('strips one colon and at most one space, whatever precedes or follows', () => {
    const src = [
      '#+RESULTS:',
      ': plain', // colon + space
      '  : indented', // leading whitespace before the colon
      ':no-space', // tight colon, no space
      ':  two spaces', // two spaces: only the first goes
      ':: double', // second colon survives
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'results',
        name: null,
        canned: 'plain\nindented\nno-space\n two spaces\n: double',
      },
    ]);
  });

  it('ends the block at the first line without a leading colon', () => {
    const src = ['#+RESULTS:', ': 42', 'not a results line', ': orphan'].join('\n');
    expect(parseOrg(src)).toEqual([
      { kind: 'results', name: null, canned: '42' },
      { kind: 'para', text: 'not a results line : orphan' }, // later : lines are prose
    ]);
  });
});

describe('parseOrg: folds', () => {
  it('parses hint and solution folds as nested documents', () => {
    const src = [
      'before',
      '#+BEGIN_HINT',
      'a hint',
      '#+BEGIN_SOLUTION',
      'the answer',
      '#+END_SOLUTION',
      '#+END_HINT',
      'after',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      { kind: 'para', text: 'before' },
      {
        kind: 'fold',
        variant: 'hint',
        doc: [
          { kind: 'para', text: 'a hint' },
          { kind: 'fold', variant: 'solution', doc: [{ kind: 'para', text: 'the answer' }] },
        ],
      },
      { kind: 'para', text: 'after' },
    ]);
  });

  it('accepts lowercase markers and closes an unterminated fold at EOF', () => {
    const src = [
      '#+begin_solution',
      'answer',
      '#+begin_hint',
      'nested hint',
      '#+end_hint',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'fold',
        variant: 'solution',
        doc: [
          { kind: 'para', text: 'answer' },
          { kind: 'fold', variant: 'hint', doc: [{ kind: 'para', text: 'nested hint' }] },
        ],
      },
    ]);
  });

  it('keeps a src block inside a fold executable', () => {
    const src = [
      '#+BEGIN_HINT',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
      '#+END_HINT',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'fold',
        variant: 'hint',
        doc: [{
          kind: 'src',
          lang: 'asm',
          name: null,
          caption: null,
          headers: '',
          code: 'ret',
          exercise: null,
        }],
      },
    ]);
  });

  it('does not treat markers inside a src block as fold delimiters', () => {
    const src = [
      '#+BEGIN_HINT',
      '#+BEGIN_SRC text',
      '#+END_HINT',
      '#+END_SRC',
      '#+END_HINT',
      'after',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'fold',
        variant: 'hint',
        doc: [{
          kind: 'src',
          lang: 'text',
          name: null,
          caption: null,
          headers: '',
          code: '#+END_HINT',
          exercise: null,
        }],
      },
      { kind: 'para', text: 'after' },
    ]);
  });

  it('nests folds of the same variant instead of closing at the inner END marker', () => {
    const src = [
      '#+BEGIN_HINT',
      'outer',
      '#+BEGIN_HINT',
      'inner',
      '#+END_HINT',
      'still outer',
      '#+END_HINT',
      'after',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'fold',
        variant: 'hint',
        doc: [
          { kind: 'para', text: 'outer' },
          { kind: 'fold', variant: 'hint', doc: [{ kind: 'para', text: 'inner' }] },
          { kind: 'para', text: 'still outer' },
        ],
      },
      { kind: 'para', text: 'after' },
    ]);
  });

  it('hides a fold opened inside a #+BEGIN_COMMENT body', () => {
    const src = [
      'before',
      '#+BEGIN_COMMENT',
      '#+BEGIN_HINT',
      'hidden hint',
      '#+END_HINT',
      '#+END_COMMENT',
      'after',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      { kind: 'para', text: 'before' },
      { kind: 'para', text: 'after' },
    ]);
  });

  it('keeps promises made inside a fold from escaping to a later block', () => {
    const src = [
      '#+BEGIN_HINT',
      '#+NAME: hidden',
      '#+CAPTION: Hidden caption',
      '#+EXERCISE: Hidden exercise',
      '#+CHECK: 0',
      'no source block here',
      '#+END_HINT',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'fold',
        variant: 'hint',
        doc: [{ kind: 'para', text: 'no source block here' }],
      },
      {
        kind: 'src',
        lang: 'asm',
        name: null,
        caption: null,
        headers: '',
        code: 'ret',
        exercise: null,
      },
    ]);
  });

  it('discards promises created in a nested fold instead of leaking them outward', () => {
    const src = [
      '#+BEGIN_HINT',
      'outer',
      '#+BEGIN_HINT',
      '#+NAME: deep',
      '#+EXERCISE: Deep',
      'inner text',
      '#+END_HINT',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
      '#+END_HINT',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'fold',
        variant: 'hint',
        doc: [
          { kind: 'para', text: 'outer' },
          { kind: 'fold', variant: 'hint', doc: [{ kind: 'para', text: 'inner text' }] },
          {
            kind: 'src',
            lang: 'asm',
            name: null,
            caption: null,
            headers: '',
            code: 'ret',
            exercise: null,
          },
        ],
      },
    ]);
  });

  it('keeps an outer promise consumed inside the fold from reaching a later block', () => {
    const src = [
      '#+NAME: inner',
      '#+EXERCISE: Inside',
      '#+BEGIN_HINT',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
      '#+END_HINT',
      '#+BEGIN_SRC asm',
      'hlt',
      '#+END_SRC',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'fold',
        variant: 'hint',
        doc: [{
          kind: 'src',
          lang: 'asm',
          name: 'inner',
          caption: null,
          headers: '',
          code: 'ret',
          exercise: { title: 'Inside', expected: null },
        }],
      },
      {
        kind: 'src',
        lang: 'asm',
        name: null,
        caption: null,
        headers: '',
        code: 'hlt',
        exercise: null,
      },
    ]);
  });
});

describe('parseOrg: #+RESULTS after folds', () => {
  it('keeps a #+RESULTS: after a fold in document order for the block inside it', () => {
    const src = [
      '#+BEGIN_HINT',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
      '#+END_HINT',
      '#+RESULTS:',
      ': 42',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'fold',
        variant: 'hint',
        doc: [{
          kind: 'src',
          lang: 'asm',
          name: null,
          caption: null,
          headers: '',
          code: 'ret',
          exercise: null,
        }],
      },
      { kind: 'results', name: null, canned: '42' },
    ]);
  });
});

describe('parseOrg: exercises', () => {
  it('promises #+EXERCISE and #+CHECK to the next src block, then clears both', () => {
    const src = [
      '#+EXERCISE: Add two registers',
      '#+CHECK: 3',
      '#+BEGIN_SRC asm :session demo',
      'add rax, 1',
      '#+END_SRC',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'src',
        lang: 'asm',
        name: null,
        caption: null,
        headers: ':session demo',
        code: 'add rax, 1',
        exercise: { title: 'Add two registers', expected: '3' },
      },
      {
        kind: 'src',
        lang: 'asm',
        name: null,
        caption: null,
        headers: '',
        code: 'ret',
        exercise: null,
      },
    ]);
  });

  it('defaults the title to "Exercise" when only #+CHECK is present', () => {
    expect(parseOrg('#+CHECK: 42\n#+BEGIN_SRC asm\nret\n#+END_SRC\n')).toEqual([
      {
        kind: 'src',
        lang: 'asm',
        name: null,
        caption: null,
        headers: '',
        code: 'ret',
        exercise: { title: 'Exercise', expected: '42' },
      },
    ]);
  });

  it('keeps NAME/CAPTION and leaves expected null without #+CHECK', () => {
    const src = [
      '#+NAME: add',
      '#+CAPTION: Sum',
      '#+EXERCISE: Add',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'src',
        lang: 'asm',
        name: 'add',
        caption: 'Sum',
        headers: '',
        code: 'ret',
        exercise: { title: 'Add', expected: null },
      },
    ]);
  });

  it('attaches a promise to the first src block inside a fold in document order', () => {
    const src = [
      '#+EXERCISE: Nested',
      '#+BEGIN_HINT',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
      '#+END_HINT',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'fold',
        variant: 'hint',
        doc: [{
          kind: 'src',
          lang: 'asm',
          name: null,
          caption: null,
          headers: '',
          code: 'ret',
          exercise: { title: 'Nested', expected: null },
        }],
      },
    ]);
  });

  it('fulfils exercise promises made inside a fold without leaking them to later blocks', () => {
    const src = [
      '#+BEGIN_HINT',
      '#+EXERCISE: Nested',
      '#+CHECK: 3',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
      '#+END_HINT',
      '#+BEGIN_SRC asm',
      'hlt',
      '#+END_SRC',
    ].join('\n');
    expect(parseOrg(src)).toEqual([
      {
        kind: 'fold',
        variant: 'hint',
        doc: [{
          kind: 'src',
          lang: 'asm',
          name: null,
          caption: null,
          headers: '',
          code: 'ret',
          exercise: { title: 'Nested', expected: '3' },
        }],
      },
      {
        kind: 'src',
        lang: 'asm',
        name: null,
        caption: null,
        headers: '',
        code: 'hlt',
        exercise: null,
      },
    ]);
  });
});

describe('parseOrgChecked: folds', () => {
  it('reports unsupported syntax inside folds at absolute line numbers', () => {
    const src = [
      '#+TITLE: T',
      '#+BEGIN_HINT',
      'hint body',
      '#+FOO: nope',
      '1. numbered',
      '#+END_HINT',
      '#+BEGIN_SOLUTION',
      '#+BEGIN_HINT',
      'deep',
      '> quote',
      '#+END_HINT',
      '#+END_SOLUTION',
    ].join('\n');
    expect(parseOrgChecked(src).diagnostics).toEqual([
      { line: 4, severity: 'warning', message: 'unsupported directive #+FOO — dropped by the renderer' },
      { line: 5, severity: 'warning', message: 'numbered lists are not rendered; use "- "' },
      { line: 10, severity: 'warning', message: 'blockquotes are not rendered' },
    ]);
  });

  it('reports an unclosed src block inside a fold at its absolute line', () => {
    const src = [
      '#+TITLE: T',
      '#+BEGIN_HINT',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_HINT',
    ].join('\n');
    expect(parseOrgChecked(src).diagnostics).toEqual([
      { line: 3, severity: 'error', message: 'unclosed #+BEGIN_SRC (asm)' },
    ]);
  });

  it('treats HINT, SOLUTION, EXERCISE, and CHECK as supported directives', () => {
    const src = [
      '#+TITLE: T',
      '#+EXERCISE: E',
      '#+CHECK: ok',
      '#+BEGIN_HINT',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
      '#+END_HINT',
      '#+BEGIN_SOLUTION',
      'answer',
      '#+END_SOLUTION',
    ].join('\n');
    expect(parseOrgChecked(src).diagnostics).toEqual([]);
  });
});

describe('parseOrgChecked: diagnostics', () => {
  it('warns about unsupported directives using the keyword as written', () => {
    const { diagnostics } = parseOrgChecked('#+TITLE: T\n#+FOO: bar\n#+SETUPFILE: whatever\nhello\n');
    expect(diagnostics).toEqual([
      { line: 2, severity: 'warning', message: 'unsupported directive #+FOO — dropped by the renderer' },
      { line: 3, severity: 'warning', message: 'unsupported directive #+SETUPFILE — dropped by the renderer' },
    ]);
  });

  it('errors on #+END_SRC outside a source block', () => {
    const { diagnostics } = parseOrgChecked('#+TITLE: T\n#+END_SRC\n');
    expect(diagnostics).toEqual([
      { line: 2, severity: 'error', message: '#+END_SRC without #+BEGIN_SRC' },
    ]);
  });

  it('errors on an unterminated source block at its #+BEGIN_SRC line', () => {
    const { diagnostics } = parseOrgChecked('#+TITLE: T\n#+BEGIN_SRC asm -n\nret\n');
    expect(diagnostics).toEqual([
      { line: 2, severity: 'error', message: 'unclosed #+BEGIN_SRC (asm)' },
    ]);
  });

  it('warns when a #+NAME: promise is lost to another #+NAME: or EOF', () => {
    const src = [
      '#+TITLE: T',
      '#+NAME: doomed',
      'A paragraph intervenes.',
      '#+NAME: last',
    ].join('\n');
    const { diagnostics } = parseOrgChecked(src);
    expect(diagnostics).toEqual([
      { line: 2, severity: 'warning', message: '#+NAME: doomed is not followed by a source block' },
      { line: 4, severity: 'warning', message: '#+NAME: last is not followed by a source block' },
    ]);
  });

  it('keeps a #+NAME: promise across blank lines, comments, and directives until the src block', () => {
    const src = [
      '#+TITLE: T',
      '#+NAME: kept',
      '',
      '# # comment',
      '#+UNKNOWN: x',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
    ].join('\n');
    expect(parseOrgChecked(src).diagnostics).toEqual([
      { line: 5, severity: 'warning', message: 'unsupported directive #+UNKNOWN — dropped by the renderer' },
    ]);
  });

  it('warns about the overwritten #+NAME: when two NAME directives are consecutive', () => {
    const src = [
      '#+TITLE: T',
      '#+NAME: first',
      '#+NAME: second',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
    ].join('\n');
    expect(parseOrgChecked(src).diagnostics).toEqual([
      { line: 2, severity: 'warning', message: '#+NAME: first is not followed by a source block' },
    ]);
  });

  it('warns when #+EXERCISE: and #+CHECK: promises are lost at EOF', () => {
    const src = [
      '#+TITLE: T',
      '#+EXERCISE: Add two registers',
      '#+CHECK: 3',
      'A paragraph instead of a block.',
    ].join('\n');
    expect(parseOrgChecked(src).diagnostics).toEqual([
      { line: 2, severity: 'warning', message: '#+EXERCISE: Add two registers is not followed by a source block' },
      { line: 3, severity: 'warning', message: '#+CHECK: 3 is not followed by a source block' },
    ]);
  });

  it('warns when #+EXERCISE: or #+CHECK: is overwritten by the same directive', () => {
    const src = [
      '#+TITLE: T',
      '#+EXERCISE: first',
      '#+EXERCISE: second',
      '#+CHECK: 1',
      '#+CHECK: 2',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
    ].join('\n');
    expect(parseOrgChecked(src).diagnostics).toEqual([
      { line: 2, severity: 'warning', message: '#+EXERCISE: first is not followed by a source block' },
      { line: 4, severity: 'warning', message: '#+CHECK: 1 is not followed by a source block' },
    ]);
  });

  it('warns about promises lost inside a fold even when a block follows the fold', () => {
    const src = [
      '#+TITLE: T',
      '#+BEGIN_HINT',
      '#+EXERCISE: Nested',
      '#+CHECK: 3',
      'no source block',
      '#+END_HINT',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
    ].join('\n');
    const checked = parseOrgChecked(src);
    expect(checked.diagnostics).toEqual([
      { line: 3, severity: 'warning', message: '#+EXERCISE: Nested is not followed by a source block' },
      { line: 4, severity: 'warning', message: '#+CHECK: 3 is not followed by a source block' },
    ]);
    // The promise never reaches the block after the fold, so diagnostics and
    // parseDoc agree about where the exercise lives.
    expect(checked.doc).toEqual([
      { kind: 'title', text: 'T' },
      { kind: 'fold', variant: 'hint', doc: [{ kind: 'para', text: 'no source block' }] },
      {
        kind: 'src',
        lang: 'asm',
        name: null,
        caption: null,
        headers: '',
        code: 'ret',
        exercise: null,
      },
    ]);
  });

  it('stays quiet when promises are fulfilled inside a fold', () => {
    const src = [
      '#+TITLE: T',
      '#+BEGIN_HINT',
      '#+EXERCISE: Nested',
      '#+CHECK: 3',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
      '#+END_HINT',
    ].join('\n');
    expect(parseOrgChecked(src).diagnostics).toEqual([]);
  });

  it('keeps an outer promise pending across a fold body that leaves it alone', () => {
    const src = [
      '#+TITLE: T',
      '#+NAME: outer',
      '#+EXERCISE: Outer',
      '#+BEGIN_HINT',
      'hint text',
      '#+END_HINT',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
    ].join('\n');
    const checked = parseOrgChecked(src);
    expect(checked.diagnostics).toEqual([]);
    expect(checked.doc).toEqual([
      { kind: 'title', text: 'T' },
      { kind: 'fold', variant: 'hint', doc: [{ kind: 'para', text: 'hint text' }] },
      {
        kind: 'src',
        lang: 'asm',
        name: 'outer',
        caption: null,
        headers: '',
        code: 'ret',
        exercise: { title: 'Outer', expected: null },
      },
    ]);
  });

  it('stays quiet when only #+CHECK: promises an exercise', () => {
    const src = [
      '#+TITLE: T',
      '#+CHECK: 42',
      '#+BEGIN_SRC asm',
      'ret',
      '#+END_SRC',
    ].join('\n');
    const checked = parseOrgChecked(src);
    expect(checked.diagnostics).toEqual([]);
    expect(checked.doc).toEqual([
      { kind: 'title', text: 'T' },
      {
        kind: 'src',
        lang: 'asm',
        name: null,
        caption: null,
        headers: '',
        code: 'ret',
        exercise: { title: 'Exercise', expected: '42' },
      },
    ]);
  });

  it('warns once at line 1 when #+TITLE: is missing', () => {
    const { diagnostics } = parseOrgChecked('just prose\n');
    expect(diagnostics).toEqual([
      { line: 1, severity: 'warning', message: 'missing #+TITLE: line' },
    ]);
  });

  it('warns about numbered list markers', () => {
    const { diagnostics } = parseOrgChecked('#+TITLE: T\n1. first\n2) second\n');
    expect(diagnostics).toEqual([
      { line: 2, severity: 'warning', message: 'numbered lists are not rendered; use "- "' },
      { line: 3, severity: 'warning', message: 'numbered lists are not rendered; use "- "' },
    ]);
  });

  it('warns about blockquotes', () => {
    const { diagnostics } = parseOrgChecked('#+TITLE: T\n> quote\n');
    expect(diagnostics).toEqual([
      { line: 2, severity: 'warning', message: 'blockquotes are not rendered' },
    ]);
  });

  it('warns about Markdown links', () => {
    const { diagnostics } = parseOrgChecked('#+TITLE: T\nSee [docs](https://example.com).\n');
    expect(diagnostics).toEqual([
      { line: 2, severity: 'warning', message: 'Markdown links are not supported; use [[url][label]]' },
    ]);
  });

  it('warns about ":" output lines outside #+RESULTS', () => {
    const { diagnostics } = parseOrgChecked('#+TITLE: T\n: stray output\n');
    expect(diagnostics).toEqual([
      { line: 2, severity: 'warning', message: '":" output line outside a #+RESULTS block is rendered as prose' },
    ]);
  });

  it('stays quiet for hidden comments, org links, headings, lists, and tables', () => {
    const src = [
      '#+TITLE: T',
      '# a hidden comment',
      '* Heading',
      '- bullet one',
      '| a | b |',
      'A [[https://example.com][link]] and [[file:page.org][page]].',
      '#+CAPTION: A $x$ caption',
      '#+BEGIN_COMMENT',
      '#+FOO: hidden directives do not warn',
      '1. hidden numbered list',
      '#+END_COMMENT',
      '#+BEGIN_SRC typst',
      'x',
      '#+END_SRC',
    ].join('\n');
    expect(parseOrgChecked(src).diagnostics).toEqual([]);
  });

  it('produces no diagnostics for constructs inside source blocks', () => {
    const src = [
      '#+TITLE: T',
      '#+NAME: block',
      '#+BEGIN_SRC text',
      '1. numbered',
      '> quoted',
      '[link](https://example.com)',
      '#+FOO: nope',
      ': output',
      '#+END_SRC',
    ].join('\n');
    expect(parseOrgChecked(src).diagnostics).toEqual([]);
  });

  it('collects diagnostics in document order across rules', () => {
    const src = [
      '#+TITLE: T',
      '1. first',
      '> quote',
      '[x](y)',
      ': stray',
    ].join('\n');
    const { diagnostics } = parseOrgChecked(src);
    expect(diagnostics.map((d) => d.line)).toEqual([2, 3, 4, 5]);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'numbered lists are not rendered; use "- "',
      'blockquotes are not rendered',
      'Markdown links are not supported; use [[url][label]]',
      '":" output line outside a #+RESULTS block is rendered as prose',
    ]);
  });

  it('leaves the produced doc identical to parseOrg for a mixed document', () => {
    const src = [
      '#+TITLE: Registers',
      '#+SUBTITLE: x86-64 basics',
      '',
      '# a hidden comment',
      '* Registers',
      'Plain [[https://example.com][link]] text.',
      '',
      '#+NAME: add',
      '#+BEGIN_SRC asm -n',
      '  mov rax, 1',
      '#+END_SRC',
      '#+RESULTS: add',
      ': 42',
    ].join('\n');
    const checked = parseOrgChecked(src);
    expect(checked.doc).toEqual(parseOrg(src));
    expect(checked.diagnostics).toEqual([]);
  });

  it('does not alter the doc when diagnostics are present', () => {
    const src = '#+NAME: orphan\n1. numbered\n> quote\n[x](y)\n: stray\n';
    expect(parseOrgChecked(src).doc).toEqual(parseOrg(src));
  });

  it('normalizeOrgKeyword handles leading, trailing, and repeated underscores without throwing', () => {
    expect(normalizeOrgKeyword('_FOO')).toBe('Foo');
    expect(normalizeOrgKeyword('A__B')).toBe('AB');
    expect(normalizeOrgKeyword('___')).toBe('');
    expect(normalizeOrgKeyword('BEGIN_SRC')).toBe('BeginSrc');
    // Parsing a document containing such directives never throws.
    expect(() => parseOrgChecked('#+TITLE: T\n#+_FOO: x\n#+A__B: y\n')).not.toThrow();
  });

  it('treats bare #+NAME: as null rather than an empty string', () => {
    const src = '#+TITLE: T\n#+NAME:\n#+BEGIN_SRC asm\nret\n#+END_SRC\n';
    const checked = parseOrgChecked(src);
    expect(checked.diagnostics).toEqual([]);
    expect(checked.doc).toEqual([
      { kind: 'title', text: 'T' },
      {
        kind: 'src',
        lang: 'asm',
        name: null,
        caption: null,
        headers: '',
        code: 'ret',
        exercise: null,
      },
    ]);
  });
});
