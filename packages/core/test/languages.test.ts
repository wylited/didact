// @vitest-environment happy-dom
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StreamParser } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { createBlockEditor } from '../src/block-editor';
import { loadEditorLanguage } from '../src/languages';
import type { Kernel } from '../src/kernel';
import { prologSpec, regexpSpec, sqlSpec, typstSpec, watSpec } from '../src/modes';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(HERE, '../..');

type Syntax = NonNullable<Kernel['editorSyntax']>;

/** A skipped whitespace run, as `highlight` reports it. */
const SP = ' :null';

/** Every member of the `Kernel['editorSyntax']` union, in source order. */
function unionMembers(): Syntax[] {
  const src = readFileSync(resolve(HERE, '../src/kernel.ts'), 'utf8');
  const contract = src.slice(src.indexOf('readonly editorSyntax?'));
  const block = contract.slice(0, contract.indexOf('createSession'));
  // the union has two legal sorry styles: `| 'a'` lines and PURE lines;
  // a comma-joined run (`| 'a' | 'b'`) declares several members on one line
  return [...block.matchAll(/'([^']+)'/g)]
    .map((m) => m[1]! as Syntax)
    // skip words that appear inside a comment in the declaration
    .filter((w) => /^[a-z][a-z0-9-]*$/.test(w));
}

/** The kernel ids apps/site registers (mountSite's `kernels` array). */
const REGISTERED = [
  'asm', 'riscv', 'mips', 'c', 'cpp', 'wasm', 'python', 'sql', 'matlab',
  'lua', 'javascript', 'regex', 'lisp', 'elisp', 'prolog', 'typst', 'fortran',
];

/** id → editorSyntax for every kernel package's src/kernel.ts declaration. */
function declaredSyntax(): Map<string, Syntax> {
  const found = new Map<string, Syntax>();
  for (const dir of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith('kernel-')) continue;
    const src = readFileSync(join(PACKAGES, dir.name, 'src/kernel.ts'), 'utf8');
    const id = /^\s*id: '([^']+)'/m.exec(src)?.[1];
    const syntax = /^\s*editorSyntax: '([^']+)'/m.exec(src)?.[1];
    if (id === undefined || syntax === undefined) {
      throw new Error(`${dir.name}/src/kernel.ts declares no id/editorSyntax`);
    }
    found.set(id, syntax as Syntax);
  }
  return found;
}

/** The token function a mode is built from — what `StreamLanguage.define`
 *  wraps, and what these tests exercise directly. */
type Tokenizer = Pick<StreamParser<unknown>, 'startState' | 'token'>;

/**
 * Drives a mode's token function over one line with the subset of
 * CodeMirror's StringStream the modes use. Returns `text:tokenClass` per
 * consumed run — whitespace included, so a skipped whitespace run is SP.
 */
function highlight(mode: Tokenizer, line: string, shared?: unknown): string[] {
  const indent = /^\s*/.exec(line)?.[0].length ?? 0;
  const stream = {
    pos: indent,
    start: 0,
    sol: () => stream.pos === indent,
    eol: () => stream.pos >= line.length,
    peek: () => line[stream.pos],
    next: () => line[stream.pos++],
    eatSpace: () => {
      const run = /^\s*/.exec(line.slice(stream.pos))![0];
      stream.pos += run.length;
      return run.length > 0;
    },
    skipToEnd: () => { stream.pos = line.length; },
    match(pattern: string | RegExp): RegExpMatchArray | null {
      const rest = line.slice(stream.pos);
      const m = typeof pattern === 'string'
        ? (rest.startsWith(pattern) ? ([pattern] as unknown as RegExpMatchArray) : null)
        : rest.match(pattern);
      const found = m !== null && (typeof pattern === 'string' || m[0].length > 0) ? m : null;
      if (found !== null) stream.pos += found[0].length;
      return found;
    },
  } as never as {
    pos: number; start: number; sol(): boolean; eol(): boolean; peek(): string | undefined;
    next(): string | undefined; eatSpace(): boolean; skipToEnd(): void;
    match(p: string | RegExp): RegExpMatchArray | null;
  };
  const state = shared ?? mode.startState?.(0) ?? {};
  const out: string[] = [];
  for (let guard = 0; !stream.eol(); guard++) {
    if (guard > 200) throw new Error(`tokenizer did not advance on: ${line}`);
    const before = stream.pos;
    const text = mode.token(stream as never, state);
    if (stream.pos === before) throw new Error(`tokenizer consumed nothing at ${before} of: ${line}`);
    out.push(`${line.slice(before, stream.pos)}:${String(text)}`);
  }
  return out;
}

describe('loadEditorLanguage: syntax → CM6 extension mapping', () => {
  it('reads the union members the contract declares', () => {
    // Guards unionMembers(): an empty parse would make later tests vacuous.
    const members = unionMembers();
    expect(members).toContain('plain');
    expect(members).toContain('wat');
    expect(members).toContain('asm-intel');
    expect(members).toContain('sql');
    expect(new Set(members).size).toBe(members.length); // no duplicates
    expect(members.length).toBe(17);
  });

  it('resolves every union member except plain, and never null for a declared mode', async () => {
    const nulls: Syntax[] = [];
    for (const syntax of unionMembers()) {
      if ((await loadEditorLanguage(syntax)) === null) nulls.push(syntax);
    }
    expect(nulls).toEqual(['plain']);
  });

  it('returns null for undefined (kernel default), explicit plain, and unknown ids', async () => {
    expect(await loadEditorLanguage(undefined)).toBeNull();
    expect(await loadEditorLanguage('plain')).toBeNull();
    expect(await loadEditorLanguage('asm-pdp11' as Syntax)).toBeNull();
    // 'asm' is a kernel *id*, never a syntax id — it must not borrow intel.
    expect(await loadEditorLanguage('asm' as Syntax)).toBeNull();
  });

  it('memoizes per syntax: repeated calls share one extension instance', async () => {
    expect(await loadEditorLanguage('python')).toBe(await loadEditorLanguage('python'));
    expect(await loadEditorLanguage('asm-intel')).toBe(await loadEditorLanguage('asm-intel'));
    expect(await loadEditorLanguage('sql')).toBe(await loadEditorLanguage('sql'));
  });

  it('gives each assembly dialect its own distinct extension instance', async () => {
    const intel = await loadEditorLanguage('asm-intel');
    const riscv = await loadEditorLanguage('asm-riscv');
    const mips = await loadEditorLanguage('asm-mips');
    expect(intel).not.toBe(riscv);
    expect(riscv).not.toBe(mips);
    expect(intel).not.toBe(mips);
  });

  it('gives each written mode its own distinct extension instance', async () => {
    const modes = await Promise.all([
      loadEditorLanguage('sql'), loadEditorLanguage('regexp'),
      loadEditorLanguage('wat'), loadEditorLanguage('typst'), loadEditorLanguage('prolog'),
    ]);
    expect(modes).not.toContain(null);
    expect(new Set(modes).size).toBe(5);
  });

  it('languages.ts imports no mode package at module top level', () => {
    const src = readFileSync(resolve(HERE, '../src/languages.ts'), 'utf8');
    expect(src).not.toMatch(/^import .* from '@codemirror\/(lang-|legacy-modes)/m);
    expect(src).not.toMatch(/^import .* from '\.\/(asm|modes)'/m);
  });
});

describe('every registered kernel declares a syntax that resolves', () => {
  const declared = declaredSyntax();

  it('scanned exactly the registered kernels', () => {
    expect([...declared.keys()].sort()).toEqual([...REGISTERED].sort());
  });

  it('no registered kernel declares plain text', () => {
    // Every kernel now has a real mode: a package that silently drops its
    // editorSyntax back to 'plain' must fail here, not just render dully.
    expect([...declared.values()]).not.toContain('plain');
  });

  it.each([...declared.entries()])('%s → %s', async (id, syntax) => {
    expect(unionMembers(), `${id} declares a syntax outside the union`).toContain(syntax);
    expect(await loadEditorLanguage(syntax), `${id} declares ${syntax}`).not.toBeNull();
  });

  it('no kernel reuses a syntax meant for another language', () => {
    // wasm once declared 'scheme' (highlighted as Lisp); matlab uses the
    // octave legacy mode on purpose — the M-file grammar is the same.
    expect(declared.get('wasm')).toBe('wat');
    expect(declared.get('regex')).toBe('regexp');
    expect(declared.get('typst')).toBe('typst');
    expect(declared.get('prolog')).toBe('prolog');
    expect(declared.get('lisp')).toBe('scheme');
    expect(declared.get('elisp')).toBe('scheme');
    expect(declared.get('matlab')).toBe('octave');
  });
});

describe('modes.ts: each tokenizer marks its language, not a neighbour', () => {
  it('SQL: keywords, identifiers, operators, numbers, comments', () => {
    expect(highlight(sqlSpec, 'SELECT name FROM t WHERE a >= 30; -- hi')).toEqual([
      'SELECT:keyword', SP, 'name:null', SP, 'FROM:keyword', SP,
      't:null', SP, 'WHERE:keyword', SP, 'a:null', SP,
      '>=:operator', SP, '30:number', ';:operator', SP, '-- hi:comment',
    ]);
  });

  it('SQL: case folds, doubled quotes escape, NULL is an atom', () => {
    expect(highlight(sqlSpec, `insert into u values (1, 'it''s', NULL)`)).toEqual([
      'insert:keyword', SP, 'into:keyword', SP, 'u:null', SP,
      'values:keyword', SP, '(:operator', '1:number', ',:operator', SP,
      "'it''s':string", ',:operator', SP, 'NULL:atom', '):operator',
    ]);
  });

  it('SQL: column types are typeName, a block comment is one run', () => {
    expect(highlight(sqlSpec, 'CREATE TABLE users (id INTEGER); /* c */')).toEqual([
      'CREATE:keyword', SP, 'TABLE:keyword', SP, 'users:null', SP,
      '(:operator', 'id:null', SP, 'INTEGER:typeName', '):operator',
      ';:operator', SP, '/* c */:comment',
    ]);
  });

  it('regexp: metacharacters are operators, literals stay plain', () => {
    expect(highlight(regexpSpec, '/^b.*d$/')).toEqual([
      '/:operator', '^:operator', 'b:null', '.:operator', '*:operator', 'd:null',
      '$:operator', '/:operator',
    ]);
  });

  it('regexp: classes and {n,m} are single units, escapes are operators', () => {
    expect(highlight(regexpSpec, '/a[^x]]{2,3}\\d/')).toEqual([
      '/:operator', 'a:null', '[^x]:atom', ']:operator', '{2,3}:operator', '\\d:operator',
      '/:operator',
    ]);
    expect(highlight(regexpSpec, '/[abc]+/')).toEqual([
      '/:operator', '[abc]:string', '+:operator', '/:operator',
    ]);
  });

  it('regexp: test-input lines and # comments never open a pattern', () => {
    expect(highlight(regexpSpec, 'zzabcaz')).toEqual(['zzabcaz:null']);
    expect(highlight(regexpSpec, '# inputs below')).toEqual(['# inputs below:comment']);
  });

  it('wat: nodes, instructions, identifiers, types, numbers', () => {
    // the paren is punctuation; the node/instruction that follows it is
    // the keyword (`func`, `param`, `i32.mul`, `local.get`)
    expect(highlight(watSpec, '(func $fact (param $n i32) (i32.mul (local.get $n) (i32.const 1)))')).toEqual([
      '(:punctuation', 'func:keyword', SP, '$fact:labelName', SP,
      '(:punctuation', 'param:keyword', SP,
      '$n:labelName', SP, 'i32:typeName', '):punctuation', SP,
      '(:punctuation', 'i32.mul:keyword', SP, '(:punctuation', 'local.get:keyword',
      SP, '$n:labelName', '):punctuation', SP, '(:punctuation',
      'i32.const:keyword', SP, '1:number', '):punctuation', '):punctuation',
      '):punctuation',
    ]);
  });

  it('wat: negative constants, strings, line and block comments', () => {
    expect(highlight(watSpec, '(i32.div_s (i32.const -7) (i32.const 2)) ;; done')).toContain('-7:number');
    expect(highlight(watSpec, '(i32.div_s (i32.const -7) (i32.const 2)) ;; done').at(-1)).toBe(';; done:comment');
    expect(highlight(watSpec, '(data (i32.const 0) "hi")')).toContain('"hi":string');
    expect(highlight(watSpec, '(; note ;) (nop)')).toEqual([
      '(; note ;):comment', ' :null', '(:punctuation', 'nop:keyword', '):punctuation',
    ]);
  });

  it('typst: headings, markup, inline code and math', () => {
    expect(highlight(typstSpec, '= The Infinitude of Primes')).toEqual([
      '= :keyword', 'The Infinitude of Primes:null',
    ]);
    expect(highlight(typstSpec, '*Theorem.* There are infinitely many prime numbers.')).toEqual([
      '*Theorem.*:strong', SP, 'There are infinitely many prime numbers.:null',
    ]);
    expect(highlight(typstSpec, 'In the plane, the distance to $(x, y)$ is')).toEqual([
      'In the plane, the distance to :null', '$(x, y)$:string', SP, 'is:null',
    ]);
  });

  it('typst: #set is a keyword, other #calls are variableName, list items are markers', () => {
    expect(highlight(typstSpec, '#set page(width: auto, margin: 1em)')).toEqual([
      '#set:keyword', SP, 'page(width: auto, margin: 1em):null',
    ]);
    expect(highlight(typstSpec, '#emph[bold]')).toEqual(['#emph:variableName', '[bold]:null']);
    // indentation is not a token: highlighting starts at the first
    // non-space character
    expect(highlight(typstSpec, '  - nested')).toEqual(['- :punctuation', 'nested:null']);
  });

  it('prolog: facts, rules and queries split atom, variable and clause neck', () => {
    expect(highlight(prologSpec, 'parent(tom, bob).')).toEqual([
      'parent:null', '(:punctuation', 'tom:null', ',:operator', SP,
      'bob:null', '):punctuation', '.:punctuation',
    ]);
    expect(highlight(prologSpec, 'grandparent(X, Z) :- parent(X, Y), parent(Y, Z).')).toEqual([
      'grandparent:null', '(:punctuation', 'X:variableName', ',:operator', SP,
      'Z:variableName', '):punctuation', SP, ':-:keyword', SP,
      'parent:null', '(:punctuation', 'X:variableName', ',:operator', SP,
      'Y:variableName', '):punctuation', ',:operator', SP,
      'parent:null', '(:punctuation', 'Y:variableName', ',:operator', SP,
      'Z:variableName', '):punctuation', '.:punctuation',
    ]);
    expect(highlight(prologSpec, '?- member(X, [a, b]).')).toEqual([
      '?-:keyword', SP, 'member:null', '(:punctuation', 'X:variableName',
      ',:operator', SP, '[:punctuation', 'a:null', ',:operator', SP,
      'b:null', ']:punctuation', '):punctuation', '.:punctuation',
    ]);
    expect(highlight(prologSpec, 'sentence --> noun_phrase.')).toEqual([
      'sentence:null', SP, '-->:keyword', SP, 'noun_phrase:null', '.:punctuation',
    ]);
  });

  it('prolog: % and /* */ comments, quoted atoms and both string quotes', () => {
    expect(highlight(prologSpec, '% a fact: parent(tom, bob).')).toEqual([
      '% a fact: parent(tom, bob).:comment',
    ]);
    expect(highlight(prologSpec, '/* rule */ parent(tom, bob).')).toEqual([
      '/* rule */:comment', SP, 'parent:null', '(:punctuation', 'tom:null',
      ',:operator', SP, 'bob:null', '):punctuation', '.:punctuation',
    ]);
    expect(highlight(prologSpec, `write('hello'), write("hi"), write(\`bt\`).`)).toEqual([
      'write:atom', '(:punctuation', "'hello':string", '):punctuation',
      ',:operator', SP, 'write:atom', '(:punctuation', '"hi":string',
      '):punctuation', ',:operator', SP, 'write:atom', '(:punctuation',
      '`bt`:string', '):punctuation', '.:punctuation',
    ]);
  });

  it('prolog: numbers, variables, cut/negation and builtin atoms', () => {
    expect(highlight(prologSpec, 'N is 2 + 3, _ = X.')).toEqual([
      'N:variableName', SP, 'is:keyword', SP, '2:number', SP, '+:operator',
      SP, '3:number', ',:operator', SP, '_:variableName', SP, '=:operator',
      SP, 'X:variableName', '.:punctuation',
    ]);
    expect(highlight(prologSpec, "X is 0'a.")).toEqual([
      'X:variableName', SP, 'is:keyword', SP, "0'a:number", '.:punctuation',
    ]);
    expect(highlight(prologSpec, 'safe(X) :- \\+ unsafe(X), !.')).toEqual([
      'safe:null', '(:punctuation', 'X:variableName', '):punctuation', SP,
      ':-:keyword', SP, '\\+:operator', SP, 'unsafe:null', '(:punctuation',
      'X:variableName', '):punctuation', ',:operator', SP, '!:operator',
      '.:punctuation',
    ]);
    expect(highlight(prologSpec, 'findall(X, p(X), L), retract(f(a)), nl.')).toEqual([
      'findall:atom', '(:punctuation', 'X:variableName', ',:operator', SP,
      'p:null', '(:punctuation', 'X:variableName', '):punctuation',
      ',:operator', SP, 'L:variableName', '):punctuation', ',:operator', SP,
      'retract:atom', '(:punctuation', 'f:null', '(:punctuation', 'a:null',
      '):punctuation', '):punctuation', ',:operator', SP, 'nl:atom',
      '.:punctuation',
    ]);
  });

  it('prolog: block comment state carries across separate lines', () => {
    const state = prologSpec.startState?.(0);
    expect(highlight(prologSpec, '/* opens a comment', state)).toEqual([
      '/* opens a comment:comment',
    ]);
    // one shared state: the second line starts inside the block
    expect(highlight(prologSpec, 'still inside */ p(a).', state)).toEqual([
      'still inside */:comment', SP, 'p:null', '(:punctuation', 'a:null',
      '):punctuation', '.:punctuation',
    ]);
  });

  it('prolog: own-property lookup leaves Object.prototype names as atoms', () => {
    expect(highlight(prologSpec, 'p(constructor).')).toEqual([
      'p:null', '(:punctuation', 'constructor:null', '):punctuation',
      '.:punctuation',
    ]);
    expect(highlight(prologSpec, 'p(toString), p(hasOwnProperty).')).toEqual([
      'p:null', '(:punctuation', 'toString:null', '):punctuation', ',:operator',
      SP, 'p:null', '(:punctuation', 'hasOwnProperty:null', '):punctuation',
      '.:punctuation',
    ]);
  });

  it('prolog: multi-character operators match whole, longest first', () => {
    expect(highlight(prologSpec, 'X =:= 1')).toEqual([
      'X:variableName', SP, '=:=:operator', SP, '1:number',
    ]);
    expect(highlight(prologSpec, 'X =.. L, Y =\\= 2, Z @=< W, U @>= V.')).toEqual([
      'X:variableName', SP, '=..:operator', SP, 'L:variableName', ',:operator',
      SP, 'Y:variableName', SP, '=\\=:operator', SP, '2:number', ',:operator',
      SP, 'Z:variableName', SP, '@=<:operator', SP, 'W:variableName',
      ',:operator', SP, 'U:variableName', SP, '@>=:operator', SP,
      'V:variableName', '.:punctuation',
    ]);
    expect(highlight(prologSpec, 'M:plus(X) :: int, A == B, A \\== B, A =< B, A >= B.')).toEqual([
      'M:variableName', '::operator', 'plus:null', '(:punctuation',
      'X:variableName', '):punctuation', SP, ':::operator', SP, 'int:null',
      ',:operator', SP, 'A:variableName', SP, '==:operator', SP,
      'B:variableName', ',:operator', SP, 'A:variableName', SP,
      '\\==:operator', SP, 'B:variableName', ',:operator', SP,
      'A:variableName', SP, '=<:operator', SP, 'B:variableName', ',:operator',
      SP, 'A:variableName', SP, '>=:operator', SP, 'B:variableName',
      '.:punctuation',
    ]);
  });
});

describe('block editor language loading', () => {
  /** A mount host attached to the happy-dom document. */
  function host(): HTMLElement {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    return parent;
  }

  const base = {
    initialCode: 'x = 1\n',
    canBreak: false,
    canStep: false,
    onRun: () => {},
    onStep: () => {},
    onDocChanged: () => {},
  } as const;

  it('upgrades a syntax-only editor in place and marks the syntax', async () => {
    // Warm the loader so the upgrade lands within the awaited ticks.
    await loadEditorLanguage('python');
    const parent = host();
    const view = createBlockEditor({ ...base, parent, language: null, syntax: 'python' });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(view.dom.dataset.language).toBe('python');
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it('applies a host language override synchronously with no lazy marker', async () => {
    const override = EditorView.contentAttributes.of({ 'data-language': 'override' });
    const parent = host();
    const view = createBlockEditor({
      ...base,
      parent,
      language: override,
      syntax: 'python',
    });
    try {
      expect(view.contentDOM.getAttribute('data-language')).toBe('override');
      await Promise.resolve();
      await Promise.resolve();
      expect(view.dom.dataset.language).toBeUndefined();
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
