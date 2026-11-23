import { describe, expect, it } from 'vitest';
import { readProgram } from '../src/reader';
import { Float, type Form, type FormArray, FormVector, LispError, Sym, renderForm } from '../src/value';

/** Read one form, failing loudly when the source produced none. */
function one(src: string): Form {
  const forms = readProgram(src);
  expect(forms).toHaveLength(1);
  return forms[0]!;
}

function readError(src: string): LispError {
  try {
    readProgram(src);
  } catch (e) {
    if (e instanceof LispError) return e;
    throw e;
  }
  throw new Error(`expected a LispError for ${JSON.stringify(src)}`);
}

describe('atoms and symbols', () => {
  it('reads signed integers and floats, including exponents', () => {
    expect(readProgram('12 -3 3.5 -0.5 1e3')).toEqual([12, -3, new Float(3.5), new Float(-0.5), new Float(1000)]);
    expect(one('+')).toBe(Sym.intern('+'));
    expect(one('-')).toBe(Sym.intern('-'));
  });

  it('interns symbols, including nil, t, and keywords', () => {
    const [foo, bar, nilSym, tSym, kw] = readProgram('foo foo nil t :bar');
    expect(foo).toBe(Sym.intern('foo'));
    expect(bar).toBe(foo);
    expect(nilSym).toBe(Sym.intern('nil'));
    expect(tSym).toBe(Sym.intern('t'));
    expect(kw).toBe(Sym.intern(':bar'));
  });

  it('treats non-delimiter punctuation as part of symbols', () => {
    expect(one('foo?')).toBe(Sym.intern('foo?'));
    expect(one('a.b')).toBe(Sym.intern('a.b'));
    expect(one('1+')).toBe(Sym.intern('1+'));
  });

  it('reads every top-level form without evaluating it', () => {
    const forms = readProgram('(+ 1 2) x');
    expect(forms).toHaveLength(2);
    const call = forms[0] as FormArray;
    expect(Array.isArray(call)).toBe(true);
    expect(call[0]).toBe(Sym.intern('+'));
    expect(call[1]).toBe(1);
    expect(call[2]).toBe(2);
    expect(forms[1]).toBe(Sym.intern('x'));
  });

  it('returns an empty program for empty and comment-only input', () => {
    expect(readProgram('')).toEqual([]);
    expect(readProgram('  \n ; just a comment\n')).toEqual([]);
  });

  it('skips comments to end of line but not semicolons in strings', () => {
    expect(readProgram('1 ; ( [ " \n2')).toEqual([1, 2]);
    expect(one('"a;b"')).toBe('a;b');
  });
});

describe('lists, vectors, and lines', () => {
  it('stamps the opening line on nested lists and top-level forms', () => {
    const forms = readProgram('  (a\n    (b c)\n d)\n\n(e)');
    const outer = forms[0] as FormArray;
    expect(outer.line).toBe(1);
    expect(outer).toHaveLength(3);
    expect(outer[0]).toBe(Sym.intern('a'));
    expect(outer[2]).toBe(Sym.intern('d'));
    const inner = outer[1] as FormArray;
    expect(inner.line).toBe(2);
    expect(inner[0]).toBe(Sym.intern('b'));
    expect(inner[1]).toBe(Sym.intern('c'));
    const second = forms[1] as FormArray;
    expect(second.line).toBe(5);
  });

  it('reads an empty list with its line', () => {
    const form = one('\n ()') as FormArray;
    expect(form).toHaveLength(0);
    expect(form.line).toBe(2);
  });

  it('reads dotted pairs into FormArray.dot', () => {
    const form = one('(a b . c)') as FormArray;
    expect(form).toHaveLength(2);
    expect(form.line).toBe(1);
    expect(form[0]).toBe(Sym.intern('a'));
    expect(form[1]).toBe(Sym.intern('b'));
    expect(form.dot).toBe(Sym.intern('c'));
    expect('dot' in form).toBe(true);
  });

  it('allows a compound form after the dot', () => {
    const form = one('(a . (b c))') as FormArray;
    const tail = form.dot as FormArray;
    expect(tail.line).toBe(1);
    expect(tail[0]).toBe(Sym.intern('b'));
    expect(tail[1]).toBe(Sym.intern('c'));
  });

  it('renders list and vector forms through renderForm', () => {
    expect(renderForm(one('(1 (2) 3)'))).toBe('(1 (2) 3)');
    expect(renderForm(one('(1 2 . 3)'))).toBe('(1 2 . 3)');
    expect(renderForm(one('(1 . (2 3))'))).toBe('(1 . (2 3))');
    expect(renderForm(one('[1 [2]]'))).toBe('[1 [2]]');
  });

  it('reads vectors with element and bracket lines', () => {
    const v = one('[\n 1\n [2]]') as FormVector;
    expect(v).toBeInstanceOf(FormVector);
    expect(v.line).toBe(1);
    expect(v.items[0]).toBe(1);
    const inner = v.items[1] as FormVector;
    expect(inner).toBeInstanceOf(FormVector);
    expect(inner.items).toEqual([2]);
    expect(inner.line).toBe(3);
  });

  it('allows an empty vector', () => {
    const v = one('[]') as FormVector;
    expect(v).toBeInstanceOf(FormVector);
    expect(v.items).toEqual([]);
    expect(v.line).toBe(1);
  });

  it('keeps vector contents unevaluated', () => {
    const v = one('[+ 1]') as FormVector;
    expect(v.items[0]).toBe(Sym.intern('+'));
    expect(v.items[1]).toBe(1);
  });
});

describe('quote syntax', () => {
  it('expands every prefix into an ordinary list form', () => {
    const cases = [
      ["'x", 'quote'],
      ['`x', 'quasiquote'],
      [',x', 'unquote'],
      [',@x', 'unquote-splicing'],
      ["#'x", 'function'],
    ] as const;
    for (const [src, name] of cases) {
      const form = one(src) as FormArray;
      expect(form.line).toBe(1);
      expect(form[0]).toBe(Sym.intern(name));
      expect(form[1]).toBe(Sym.intern('x'));
    }
  });

  it('stamps the prefix line on the generated form', () => {
    const forms = readProgram('x\n  \'y');
    const quoted = forms[1] as FormArray;
    expect(quoted.line).toBe(2);
    expect(quoted[0]).toBe(Sym.intern('quote'));
    expect(quoted[1]).toBe(Sym.intern('y'));
  });

  it('nests prefixes and does not evaluate the quoted body', () => {
    const quoted = one("'(+ 1 2)") as FormArray;
    expect(quoted[0]).toBe(Sym.intern('quote'));
    const call = quoted[1] as FormArray;
    expect(call[0]).toBe(Sym.intern('+'));
    expect(call[1]).toBe(1);
    expect(call[2]).toBe(2);

    const qq = one('`(a ,b ,@c)') as FormArray;
    expect(qq[0]).toBe(Sym.intern('quasiquote'));
    const body = qq[1] as FormArray;
    expect(body[0]).toBe(Sym.intern('a'));
    expect((body[1] as FormArray)[0]).toBe(Sym.intern('unquote'));
    expect((body[2] as FormArray)[0]).toBe(Sym.intern('unquote-splicing'));

    const head = one("''x") as FormArray;
    expect(head[0]).toBe(Sym.intern('quote'));
    expect((head[1] as FormArray)[0]).toBe(Sym.intern('quote'));
    expect((head[1] as FormArray)[1]).toBe(Sym.intern('x'));
    expect((head[1] as FormArray).line).toBe(1);
  });
});

describe('strings', () => {
  it('decodes the documented escapes', () => {
    expect(readProgram(String.raw`"a\nb\tc"`)).toEqual(['a\nb\tc']);
    expect(readProgram(String.raw`"\r"`)).toEqual(['\r']);
    expect(readProgram(String.raw`"\\"`)).toEqual(['\\']);
    expect(readProgram(String.raw`"\""`)).toEqual(['"']);
  });

  it('treats an unknown escape as the character itself', () => {
    expect(readProgram(String.raw`"\q"`)).toEqual(['q']);
    expect(readProgram(String.raw`"\ "`)).toEqual([' ']);
  });

  it('allows literal newlines and tracks lines after the string', () => {
    expect(readProgram('"a\nb"')).toEqual(['a\nb']);
    const forms = readProgram('"a\nb" 42');
    expect(forms[1]).toBe(42);
  });

  it('reports an unterminated string at its opening line', () => {
    const e = readError('1\n  "abc');
    expect(e.message).toBe('unterminated string');
    expect(e.line).toBe(2);
  });
});

describe('character literals', () => {
  it('reads plain, escaped, and delimiter characters', () => {
    expect(readProgram('?a')).toEqual([97]);
    expect(readProgram('?A')).toEqual([65]);
    expect(readProgram(String.raw`?\n`)).toEqual([10]);
    expect(readProgram(String.raw`?\t`)).toEqual([9]);
    expect(readProgram(String.raw`?\r`)).toEqual([13]);
    expect(readProgram(String.raw`?\s`)).toEqual([32]);
    expect(readProgram(String.raw`?\(`)).toEqual([40]);
    expect(readProgram(String.raw`?\;`)).toEqual([59]);
    expect(readProgram(String.raw`?\\`)).toEqual([92]);
  });

  it('treats ? as a symbol character inside a token', () => {
    expect(one('foo?')).toBe(Sym.intern('foo?'));
  });

  it('rejects a bare question mark at the end of input', () => {
    const e = readError('?');
    expect(e.message).toBe('invalid character literal');
    expect(e.line).toBe(1);
    expect(readError('(a\n ?').line).toBe(2);
  });
});

describe('reader rejections', () => {
  it('rejects stray closing parentheses and brackets', () => {
    const paren = readError('(a)\n )');
    expect(paren.message).toBe('unexpected )');
    expect(paren.line).toBe(2);
    const bracket = readError('[1]\n ]');
    expect(bracket.message).toBe('unexpected ]');
    expect(bracket.line).toBe(2);
  });

  it('reports the opening line of an unterminated list', () => {
    const e = readError('(a\n (b c)');
    expect(e.message).toBe('unterminated list');
    expect(e.line).toBe(1);
    expect(readError('(a\n (b\n').line).toBe(2);
  });

  it('reports the opening line of an unterminated vector', () => {
    const e = readError('[1\n 2');
    expect(e.message).toBe('unterminated vector');
    expect(e.line).toBe(1);
  });

  it('rejects every prefix dangling at end of input', () => {
    for (const [src, text] of [["1\n'", "'"], ['1\n`', '`'], ['1\n,', ','], ['1\n,@', ',@'], ["1\n#'", "#'"]] as const) {
      const e = readError(src);
      expect(e.message).toBe(`unexpected end of input after ${text}`);
      expect(e.line).toBe(2);
    }
  });

  it('rejects a dot outside a list', () => {
    const e = readError('(a)\n  .');
    expect(e.message).toBe('unexpected .');
    expect(e.line).toBe(2);
    expect(readError('[a . b]').message).toBe('unexpected .');
  });

  it('rejects a dotted pair with no element before the dot', () => {
    const e = readError('(. b)');
    expect(e.message).toBe('malformed dotted pair');
    expect(e.line).toBe(1);
  });

  it('rejects a dotted pair with no element after the dot', () => {
    const e = readError('(a . )');
    expect(e.message).toBe('malformed dotted pair');
    expect(e.line).toBe(1);
  });

  it('rejects more than one element after the dot at the dot line', () => {
    const e = readError('(a\n . b c)');
    expect(e.message).toBe('malformed dotted pair');
    expect(e.line).toBe(2);
    expect(readError('(a . b . c)').message).toBe('malformed dotted pair');
  });
});
