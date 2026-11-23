import { describe, expect, it } from 'vitest';
import { Runtime, callBuiltin } from '../src/runtime';
import { makeBuiltins } from '../src/builtins';
import {
  Builtin,
  Buffer,
  Closure,
  Cons,
  Keymap,
  LispError,
  Sym,
  Vec,
  listOf,
  nil,
  renderWrite,
  t,
  type Value,
} from '../src/value';

const intern = Sym.intern;

/** A fresh session plus a tiny call harness that mimics the machine's ctx. */
function setup() {
  const rt = new Runtime();
  const table = makeBuiltins(rt);
  const call = (name: string, ...args: Value[]): Value => {
    const b = table.get(name);
    if (!(b instanceof Builtin)) throw new Error(`no builtin: ${name}`);
    return callBuiltin(b, args, { runtime: rt, out: (text) => rt.emit(text), line: 1 });
  };
  const failure = (name: string, ...args: Value[]): LispError => {
    try {
      call(name, ...args);
    } catch (e) {
      if (e instanceof LispError) return e;
      throw e;
    }
    throw new Error(`expected ${name} to signal`);
  };
  return { rt, table, call, failure };
}

describe('arithmetic', () => {
  it('integer / truncates toward zero', () => {
    const { call } = setup();
    expect(call('/', 7, 2)).toBe(3);
    expect(call('/', -7, 2)).toBe(-3);
    expect(call('/', 7, -2)).toBe(-3);
    expect(call('/', 4)).toBe(0);
  });

  it('float / appears as soon as one operand is a float', () => {
    const { call } = setup();
    expect(call('/', 7, 2.5)).toBe(2.8);
    expect(renderWrite(call('/', 0.5))).toBe('2.0');
    expect(renderWrite(call('/', 1.5, 0.5))).toBe('3.0');
  });

  it('+ - * fold, with the usual identities', () => {
    const { call } = setup();
    expect(call('+')).toBe(0);
    expect(call('*')).toBe(1);
    expect(call('+', 1, 2, 3)).toBe(6);
    expect(call('*', 2, 3, 4)).toBe(24);
    expect(call('-', 10, 1, 2)).toBe(7);
    expect(call('-', 5)).toBe(-5);
  });

  it('% is remainder and mod is floor-mod', () => {
    const { call } = setup();
    expect(call('%', -7, 3)).toBe(-1);
    expect(call('mod', -7, 3)).toBe(2);
    expect(call('%', 7, -3)).toBe(1);
    expect(call('mod', 7, -3)).toBe(-2);
  });

  it('1+, 1-, abs, min and max', () => {
    const { call } = setup();
    expect(call('1+', 41)).toBe(42);
    expect(call('1-', 43)).toBe(42);
    expect(call('abs', -9)).toBe(9);
    expect(call('min', 3, -2, 7)).toBe(-2);
    expect(call('max', 3, -2, 7)).toBe(7);
  });

  it('comparisons chain left to right', () => {
    const { call } = setup();
    expect(call('<', 1, 2, 3)).toBe(t);
    expect(call('<', 1, 3, 2)).toBe(nil);
    expect(call('=', 2, 2, 2)).toBe(t);
    expect(call('>=', 3, 3, 2)).toBe(t);
    expect(call('<=', 1, 2)).toBe(t);
    expect(call('>', 1, 2)).toBe(nil);
  });

  it('division by zero and non-numbers are signals', () => {
    const { failure } = setup();
    expect(failure('/', 1, 0).data).toBe('arith-error');
    const bad = failure('+', 1, 'two');
    expect(bad.message).toContain('+');
    expect(bad.message).toContain('expected a number');
  });
});

describe('predicates', () => {
  it('eq is identity while equal is structural', () => {
    const { call } = setup();
    const a = listOf([1, 2]);
    const b = listOf([1, 2]);
    expect(call('equal', a, b)).toBe(t);
    expect(call('eq', a, b)).toBe(nil);
    expect(call('eq', a, a)).toBe(t);
    expect(call('eq', intern('x'), intern('x'))).toBe(t);
  });

  it('null/not and the type predicates agree', () => {
    const { call, rt } = setup();
    expect(call('null', nil)).toBe(t);
    expect(call('not', 0)).toBe(nil);
    expect(call('consp', listOf([1]))).toBe(t);
    expect(call('consp', nil)).toBe(nil);
    expect(call('listp', nil)).toBe(t);
    expect(call('atom', 3)).toBe(t);
    expect(call('symbolp', nil)).toBe(t);
    expect(call('stringp', 's')).toBe(t);
    expect(call('numberp', 1.5)).toBe(t);
    expect(call('integerp', 1.5)).toBe(nil);
    expect(call('floatp', 1.5)).toBe(t);
    expect(call('bufferp', rt.current)).toBe(t);
    expect(call('keymapp', new Keymap('k'))).toBe(t);
  });

  it('functionp/commandp look through the function cell', () => {
    const { call, table } = setup();
    const car = table.get('car')!;
    expect(call('functionp', car)).toBe(t);
    call('fset', intern('my-car'), car);
    expect(call('functionp', intern('my-car'))).toBe(t);
    const command = new Closure({ required: [], optional: [], rest: null }, [], null, false, 1);
    command.command = true;
    call('fset', intern('my-command'), command);
    expect(call('commandp', intern('my-command'))).toBe(t);
    expect(call('commandp', intern('my-car'))).toBe(nil);
  });

  it('boundp/fboundp distinguish value and function cells', () => {
    const { call } = setup();
    call('set', intern('x'), 1);
    expect(call('boundp', intern('x'))).toBe(t);
    expect(call('fboundp', intern('x'))).toBe(nil);
    expect(call('fboundp', intern('car'))).toBe(t);
    expect(call('boundp', intern('never-set'))).toBe(nil);
  });
});

describe('lists', () => {
  it('cons/car/cdr and the c[ad]+r combinations', () => {
    const { call } = setup();
    const xs = call('list', 1, 2, 3, 4);
    expect(call('car', xs)).toBe(1);
    expect(renderWrite(call('cdr', xs))).toBe('(2 3 4)');
    expect(call('cadr', xs)).toBe(2);
    expect(call('caddr', xs)).toBe(3);
    expect(renderWrite(call('cddr', xs))).toBe('(3 4)');
    expect(renderWrite(call('cons', 0, xs))).toBe('(0 1 2 3 4)');
  });

  it('list, append and length', () => {
    const { call } = setup();
    expect(renderWrite(call('append', listOf([1, 2]), listOf([3])))).toBe('(1 2 3)');
    expect(call('append')).toBe(nil);
    expect(call('length', listOf([1, 2, 3]))).toBe(3);
    expect(call('length', 'hello')).toBe(5);
    expect(call('length', new Vec([1, 2]))).toBe(2);
  });

  it('append copies all but the last list, which is shared', () => {
    const { call } = setup();
    const last = listOf([3, 4]);
    const out = call('append', listOf([1, 2]), last) as Cons;
    const tail = call('nthcdr', 2, out);
    expect(tail).toBe(last);
    expect(out).not.toBe(last);
  });

  it('nth and nthcdr are zero-based', () => {
    const { call } = setup();
    const xs = listOf(['a', 'b', 'c']);
    expect(call('nth', 0, xs)).toBe('a');
    expect(call('nth', 2, xs)).toBe('c');
    expect(call('nth', 9, xs)).toBe(nil);
    expect(renderWrite(call('nthcdr', 1, xs))).toBe('("b" "c")');
    expect(call('nthcdr', 9, xs)).toBe(nil);
  });

  it('reverse copies and nreverse reverses in place', () => {
    const { call } = setup();
    const xs = listOf([1, 2, 3]);
    const rev = call('reverse', xs);
    expect(renderWrite(xs)).toBe('(1 2 3)');
    expect(renderWrite(rev)).toBe('(3 2 1)');
    const same = call('nreverse', xs);
    expect(renderWrite(same)).toBe('(3 2 1)');
    expect(call('nthcdr', 2, same)).toBe(xs); // the old head is now the tail
  });

  it('last returns the final cons (or the last N)', () => {
    const { call } = setup();
    expect(renderWrite(call('last', listOf([1, 2, 3])))).toBe('(3)');
    expect(renderWrite(call('last', listOf([1, 2, 3]), 2))).toBe('(2 3)');
    expect(call('last', nil)).toBe(nil);
  });

  it('member/memq return the tail and assoc/assq the pair', () => {
    const { call } = setup();
    const xs = listOf([1, 2, 3]);
    expect(call('member', 2, xs)).toBe(call('nthcdr', 1, xs));
    expect(call('memq', 4, xs)).toBe(nil);
    const alist = listOf([new Cons(intern('a'), 1), new Cons(intern('b'), 2)]);
    expect(call('assq', intern('b'), alist)).toBe(call('nth', 1, alist));
    expect(call('assoc', intern('z'), alist)).toBe(nil);
  });

  it('setcar/setcdr and rplaca/rplacd mutate the cell', () => {
    const { call } = setup();
    const cell = new Cons(1, 2);
    expect(call('setcar', cell, 3)).toBe(3);
    expect(call('setcdr', cell, 4)).toBe(4);
    expect(renderWrite(cell)).toBe('(3 . 4)');
    expect(call('rplaca', cell, 5)).toBe(cell);
    expect(cell.car).toBe(5);
  });
});

describe('strings, symbols and vectors', () => {
  it('concat and substring (including negative indexes)', () => {
    const { call } = setup();
    expect(call('concat', 'foo', nil, 'bar')).toBe('foobar');
    expect(call('concat', listOf([65, 66]))).toBe('AB');
    expect(call('substring', 'hello', 1, 4)).toBe('ell');
    expect(call('substring', 'hello', 2)).toBe('llo');
    expect(call('substring', 'hello', -3)).toBe('llo');
    expect(call('substring', 'hello', 9)).toBe('');
  });

  it('string-to-number parses the leading number and defaults to 0', () => {
    const { call } = setup();
    expect(call('string-to-number', '  -12.5rest')).toBe(-12.5);
    expect(call('string-to-number', '42')).toBe(42);
    expect(call('string-to-number', 'nope')).toBe(0);
    expect(call('number-to-string', 3.5)).toBe('3.5');
  });

  it('format handles %s, %S, %d and %%', () => {
    const { call } = setup();
    expect(call('format', '%s-%S-%d-%%', 'a', 'b', 3.9)).toBe('a-"b"-3-%');
    expect(call('format', 'plain')).toBe('plain');
  });

  it('format rejects missing arguments and unknown operations', () => {
    const { failure } = setup();
    expect(failure('format', '%s %s', 'one').message).toContain('not enough arguments');
    expect(failure('format', '%q', 1).message).toContain('invalid format operation');
    expect(failure('format', '%d', 'x').message).toContain('%d expected a number');
  });

  it('upcase/downcase/capitalize work on strings and symbols', () => {
    const { call } = setup();
    expect(call('upcase', 'aBc')).toBe('ABC');
    expect(call('downcase', 'aBc')).toBe('abc');
    expect(call('capitalize', 'hello  world')).toBe('Hello  World');
    const sym = call('upcase', intern('foo'));
    expect(sym).toBe(intern('FOO'));
  });

  it('string comparisons are lexicographic', () => {
    const { call } = setup();
    expect(call('string=', 'a', 'a')).toBe(t);
    expect(call('string=', 'a', 'b')).toBe(nil);
    expect(call('string<', 'abc', 'abd')).toBe(t);
    expect(call('string>', 'b', 'a')).toBe(t);
  });

  it('vectors: vector, make-vector, aref and length', () => {
    const { call } = setup();
    const v = call('vector', 1, 'two') as Vec;
    expect(v.items).toHaveLength(2);
    expect(call('aref', v, 1)).toBe('two');
    expect(call('aref', 'abc', 0)).toBe(97);
    const made = call('make-vector', 3, 0) as Vec;
    expect(made.items).toEqual([0, 0, 0]);
    expect(call('length', made)).toBe(3);
  });

  it('aref reports out-of-range and type errors', () => {
    const { failure } = setup();
    expect(failure('aref', new Vec([]), 0).message).toContain('out of range');
    expect(failure('aref', 3, 0).message).toContain('expected a string or vector');
  });
});

describe('output and errors', () => {
  it('princ/prin1/print/terpri write the expected text', () => {
    const { call, rt } = setup();
    expect(call('princ', 'hi')).toBe('hi');
    expect(call('prin1', 'hi')).toBe('hi');
    expect(call('print', 'hi')).toBe('hi');
    call('terpri');
    expect(rt.output).toBe('hi"hi""hi"\n\n');
  });

  it('message formats, emits a newline, and returns the string', () => {
    const { call, rt } = setup();
    expect(call('message', 'x %d', 2)).toBe('x 2');
    expect(call('message', 42)).toBe('42');
    expect(rt.output).toBe('x 2\n42\n');
  });

  it('error/user-error/signal carry formatted text and condition data', () => {
    const { failure } = setup();
    const err = failure('error', 'boom %d', 3);
    expect(err.message).toBe('boom 3');
    expect(err.data).toBe('error');
    expect(err.line).toBe(1);

    const user = failure('user-error', 'not now');
    expect(user.message).toBe('not now');
    expect(user.data).toBe('user-error');

    const sig = failure('signal', intern('wrong-type-argument'),
      listOf([intern('numberp'), 'x']));
    expect(sig.data).toBe('wrong-type-argument');
    expect(sig.message).toContain('wrong-type-argument');
  });

  it('leaf accessors signal with useful LispError data', () => {
    const { failure } = setup();
    expect(failure('car', 3).message).toContain('car: expected a list');
    expect(failure('cons', 1).message).toContain('wrong number of arguments');
    expect(failure('cons', 1).data).toBe('wrong-number-of-arguments');
  });
});

describe('symbol cells', () => {
  it('set/symbol-value and fset/symbol-function use per-session cells', () => {
    const { call, table } = setup();
    call('set', intern('x'), 5);
    expect(call('symbol-value', intern('x'))).toBe(5);
    const car = table.get('car')!;
    call('fset', intern('alias'), car);
    expect(call('symbol-function', intern('alias'))).toBe(car);
  });

  it('void cells signal void-variable / void-function', () => {
    const { failure } = setup();
    expect(failure('symbol-value', intern('nope')).data).toBe('void-variable');
    expect(failure('symbol-function', intern('nope')).data).toBe('void-function');
  });

  it('two runtimes never share global cells', () => {
    const a = setup();
    const b = setup();
    a.call('set', intern('x'), 1);
    expect(a.call('boundp', intern('x'))).toBe(t);
    expect(b.call('boundp', intern('x'))).toBe(nil);
  });

  it('make-symbol is uninterned; interned symbols are eq', () => {
    const { call } = setup();
    const a = call('make-symbol', 'tmp');
    const b = call('make-symbol', 'tmp');
    expect(a).not.toBe(b);
    expect(call('eq', a, intern('tmp'))).toBe(nil);
    expect(call('symbol-name', a)).toBe('tmp');
    expect(call('eq', call('intern', 'q'), intern('q'))).toBe(t);
  });
});

describe('buffers', () => {
  it('insert moves point and buffer-string reflects the text', () => {
    const { call, rt } = setup();
    call('insert', 'hello');
    expect(call('buffer-string')).toBe('hello');
    expect(call('point')).toBe(6);
    expect(call('point-min')).toBe(1);
    expect(call('point-max')).toBe(6);
    call('goto-char', 1);
    call('insert', 'X ', 65);
    expect(call('buffer-string')).toBe('X Ahello');
    expect(rt.current.text).toBe('X Ahello');
  });

  it('delete-region removes text and shifts point sensibly', () => {
    const { call } = setup();
    call('insert', 'abcdef');
    call('goto-char', 5);
    call('delete-region', 2, 4); // END is exclusive: removes "bc"
    expect(call('buffer-string')).toBe('adef');
    expect(call('point')).toBe(3);
  });

  it('erase-buffer clears text and point, marking the buffer modified', () => {
    const { call } = setup();
    call('insert', 'abc');
    call('set-buffer-modified-p', nil);
    expect(call('buffer-modified-p')).toBe(nil);
    call('erase-buffer');
    expect(call('buffer-string')).toBe('');
    expect(call('point')).toBe(1);
    expect(call('buffer-modified-p')).toBe(t);
  });

  it('buffer-substring is 1-based and clamps', () => {
    const { call } = setup();
    call('insert', 'abcd');
    expect(call('buffer-substring', 2, 4)).toBe('bc');
    expect(call('buffer-substring', 0, 99)).toBe('abcd');
    expect(call('buffer-substring', 3, 3)).toBe('');
  });

  it('line movement: bolp/eolp, beginning/end, forward-line/char', () => {
    const { call } = setup();
    call('insert', 'ab\ncd\nef');
    call('goto-char', 1);
    expect(call('bolp')).toBe(t);
    call('end-of-line');
    expect(call('point')).toBe(3);
    expect(call('eolp')).toBe(t);
    call('forward-line', 1);
    expect(call('point')).toBe(4);
    call('end-of-line');
    expect(call('point')).toBe(6);
    call('forward-char');
    expect(call('point')).toBe(7);
    expect(call('bolp')).toBe(t);
    call('beginning-of-line');
    expect(call('point')).toBe(7);
    call('forward-line', 5);
    expect(call('point')).toBe(9);
  });

  it('buffer-size/buffer-name and modified state', () => {
    const { call, rt } = setup();
    expect(call('buffer-name')).toBe('*scratch*');
    expect(call('buffer-size')).toBe(0);
    expect(call('buffer-modified-p')).toBe(nil);
    call('insert', 'abc');
    expect(call('buffer-size')).toBe(3);
    expect(call('buffer-modified-p')).toBe(t);
    call('set-buffer-modified-p', nil);
    expect(call('buffer-modified-p')).toBe(nil);
    expect(call('buffer-name', rt.current)).toBe('*scratch*');
  });

  it('get-buffer-create reuses a name; generate-new-buffer never does', () => {
    const { call, rt } = setup();
    const one = call('get-buffer-create', 'work');
    const two = call('get-buffer-create', 'work');
    expect(one).toBe(two);
    expect(call('get-buffer', 'work')).toBe(one);
    expect(call('get-buffer', 'missing')).toBe(nil);
    const a = call('generate-new-buffer', 'tmp');
    const b = call('generate-new-buffer', 'tmp');
    expect(a).not.toBe(b);
    expect((a as Buffer).name).toBe('tmp');
    expect((b as Buffer).name).toBe('tmp<2>');
    call('set-buffer', 'work');
    expect(call('current-buffer')).toBe(rt.getBuffer('work'));
  });

  it('kill-buffer switches away from the current buffer', () => {
    const { call, rt } = setup();
    call('get-buffer-create', 'other');
    call('set-buffer', 'other');
    call('kill-buffer');
    expect(rt.getBuffer('other')).toBeUndefined();
    expect(call('current-buffer')).toBe(rt.getBuffer('*scratch*'));
  });
});

describe('buffer-local variables', () => {
  it('setq-local shadows the global cell and buffer-local-value sees both', () => {
    const { call, rt } = setup();
    const other = rt.createBuffer('other');
    call('set', intern('x'), 10);
    call('setq-local', intern('x'), 1);
    expect(call('buffer-local-value', intern('x'), rt.current)).toBe(1);
    expect(call('buffer-local-value', intern('x'), other)).toBe(10);
    expect(call('symbol-value', intern('x'))).toBe(1);
    call('set-buffer', other);
    expect(call('symbol-value', intern('x'))).toBe(10);
  });

  it('make-local-variable seeds from the default; kill-local-variable removes it', () => {
    const { call, rt } = setup();
    call('set', intern('y'), 7);
    call('make-local-variable', intern('y'));
    expect(rt.localVariable(rt.current, 'y')).toBe(7);
    call('setq-local', intern('y'), 8);
    expect(call('symbol-value', intern('y'))).toBe(8);
    call('kill-local-variable', intern('y'));
    expect(call('symbol-value', intern('y'))).toBe(7);
  });

  it('make-variable-buffer-local is recorded on the runtime', () => {
    const { call, rt } = setup();
    call('make-variable-buffer-local', intern('z'));
    expect(rt.isBufferLocalVariable('z')).toBe(true);
  });

  it('buffer-local-value signals void-variable when neither cell is bound', () => {
    const { call, rt, failure } = setup();
    expect(failure('buffer-local-value', intern('none'), rt.current).data).toBe('void-variable');
    expect(call('buffer-local-value', intern('nil'), rt.current)).toBe(nil);
  });
});

describe('hooks', () => {
  it('add-hook is idempotent under eq and remove-hook removes', () => {
    const { call, rt, table } = setup();
    const f1 = table.get('car')!;
    const f2 = table.get('cdr')!;
    call('add-hook', intern('h'), f1);
    call('add-hook', intern('h'), f1);
    call('add-hook', intern('h'), f2);
    expect(rt.hookFunctions(intern('h'))).toHaveLength(2);
    call('remove-hook', intern('h'), f1);
    expect(rt.hookFunctions(intern('h'))).toEqual([f2]);
    call('remove-hook', intern('h'), f2);
    expect(rt.hookFunctions(intern('h'))).toEqual([]);
  });

  it('LOCAL hooks live on the buffer; the global hook is untouched', () => {
    const { call, rt, table } = setup();
    const f1 = table.get('car')!;
    const f2 = table.get('cdr')!;
    const a = rt.current;
    const b = rt.createBuffer('b');
    call('add-hook', intern('h'), f1);
    call('add-hook', intern('h'), f2, t);
    expect(rt.hookFunctions(intern('h'))).toEqual([f2, f1]);
    call('set-buffer', b);
    expect(rt.hookFunctions(intern('h'))).toEqual([f1]);
    call('set-buffer', a);
    expect(rt.localVariable(a, 'h')).not.toBeUndefined();
  });

  it('a legacy single-function hook value is normalized to a list', () => {
    const { call, rt, table } = setup();
    const f1 = table.get('car')!;
    const f2 = table.get('cdr')!;
    rt.globalValues.set('legacy-hook', f1);
    call('add-hook', intern('legacy-hook'), f2);
    expect(rt.hookFunctions(intern('legacy-hook'))).toHaveLength(2);
  });
});

describe('keymaps and kbd', () => {
  it('kbd canonicalizes whitespace, modifiers and named keys', () => {
    const { call } = setup();
    expect(call('kbd', 'C-x   C-f')).toBe('C-x C-f');
    expect(call('kbd', 'C-c a')).toBe('C-c a');
    expect(call('kbd', 'RET')).toBe('RET');
    expect(call('kbd', 'M-C-x')).toBe('C-M-x');
    expect(call('kbd', 'abc')).toBe('a b c');
  });

  it('define-key/lookup-key share the canonical key string; nil unbinds', () => {
    const { call } = setup();
    const map = call('make-sparse-keymap') as Keymap;
    call('define-key', map, call('kbd', 'C-c a'), intern('my-command'));
    expect(call('lookup-key', map, call('kbd', 'C-c a'))).toBe(intern('my-command'));
    expect(call('lookup-key', map, call('kbd', 'C-c b'))).toBe(nil);
    call('define-key', map, call('kbd', 'C-c a'), nil);
    expect(call('lookup-key', map, call('kbd', 'C-c a'))).toBe(nil);
  });

  it('lookup-key falls through to the parent keymap', () => {
    const { call } = setup();
    const parent = new Keymap('parent');
    const child = new Keymap('child', parent);
    call('define-key', parent, 'C-x C-s', intern('save'));
    expect(call('lookup-key', child, 'C-x C-s')).toBe(intern('save'));
  });

  it('current-local-map is a stable lazy per-buffer map', () => {
    const { call, rt } = setup();
    const first = call('current-local-map');
    expect(first).toBeInstanceOf(Keymap);
    expect(call('current-local-map')).toBe(first);
    const custom = call('make-sparse-keymap') as Keymap;
    call('use-local-map', custom);
    expect(call('current-local-map')).toBe(custom);
    call('use-local-map', nil);
    const after = call('current-local-map');
    expect(after).toBeInstanceOf(Keymap);
    expect(after).not.toBe(custom);
    expect(rt.current.locals.get('local-map')).toBeUndefined();
  });

  it('make-sparse-keymap registers each map', () => {
    const { call, rt } = setup();
    const before = rt.keymaps.length;
    const map = call('make-sparse-keymap');
    expect(rt.keymaps).toHaveLength(before + 1);
    expect(rt.keymaps[rt.keymaps.length - 1]).toBe(map);
    expect(call('keymapp', map)).toBe(t);
  });
});

describe('changed-binding tracking', () => {
  it('set/setq-local mark names and clearChanged empties the set', () => {
    const { call, rt } = setup();
    expect(rt.changed.size).toBe(0);
    call('set', intern('x'), 1);
    call('setq-local', intern('y'), 2);
    expect([...rt.changed].sort()).toEqual(['x', 'y']);
    rt.clearChanged();
    expect(rt.changed.size).toBe(0);
  });
});
