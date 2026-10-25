import { describe, expect, it } from 'vitest';
import { lispKernel, Machine, makeBuiltins, readProgram, renderWrite, Ref, withHeap, type Panel, type RunResult } from '../src/index';

/** Run `src` to completion on a fresh machine; throws if it errors. */
function evalSrc(src: string): Machine {
  let m!: Machine;
  const b = makeBuiltins((fv, env) => m.macroExpandOnce(fv, env));
  m = new Machine(readProgram(src), b);
  while (!m.finished && m.error === null) m.step();
  if (m.error !== null) throw new Error(`engine error: ${m.error}`);
  return m;
}

/** Evaluate one expression and render its value, machine-style. */
function evalStr(src: string): string {
  const m = evalSrc(src);
  return withHeap(m.heap, () => renderWrite(m.lastValue));
}

/** Session-level run: returns [console text, RunResult]. */
async function runSession(src: string): Promise<{ text: string; result: RunResult; panels: Panel[] }> {
  const s = lispKernel.createSession();
  const load = await s.load(src);
  if (!load.ok) throw new Error(`load failed: line ${load.line}: ${load.message}`);
  const result = await s.run();
  const panels = s.state();
  const con = panels.find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
  return { text: con?.text ?? '', result, panels };
}

describe('reader + arithmetic', () => {
  it('evaluates nested arithmetic left-to-right', () => {
    expect(evalStr('(+ 1 (* 2 3) (- 10 4))')).toBe('13');
    expect(evalStr('(* 2 (+ 3 4) (- 10 7))')).toBe('42');
    expect(evalStr('(/ 7 2)')).toBe('3.5');
    expect(evalStr('(- 10 1 2)')).toBe('7');
  });

  it('compares chains and does modulo/remainder with the right signs', () => {
    expect(evalStr('(< 1 2 3)')).toBe('#t');
    expect(evalStr('(< 1 3 2)')).toBe('#f');
    expect(evalStr('(modulo -7 3)')).toBe('2');
    expect(evalStr('(remainder -7 3)')).toBe('-1');
  });

  it('maps reader errors to 1-based lines', async () => {
    const s = lispKernel.createSession();
    const bad = await s.load('(define x 1)\n(display (+ 1 2)\n(display 4)');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.line).toBe(2); // the ( opened on line 2 is never closed
    const paren = await s.load('(a (b))\n)');
    expect(paren.ok).toBe(false);
    if (!paren.ok) expect(paren.line).toBe(2); // the stray ) on line 2
  });

  it('a trailing quote or dot at end of input is a clean reader error', async () => {
    const s = lispKernel.createSession();
    const quote = await s.load("(define x 1)\n(display x)\n'");
    expect(quote.ok).toBe(false);
    if (!quote.ok) {
      expect(quote.line).toBe(3); // the ' on line 3 has no operand after it
      expect(quote.message).toBe('unexpected end of input');
    }
    const dot = await s.load('(a . ');
    expect(dot.ok).toBe(false);
    if (!dot.ok) {
      expect(dot.line).toBe(1); // the . on line 1 has no tail after it
      expect(dot.message).toBe('unexpected end of input');
    }
  });
});

describe('quote, quasiquote, unquote-splicing', () => {
  it('quote builds heap data; quasiquote splices into it', () => {
    expect(evalStr(`'(1 2 (3 . 4))`)).toBe('(1 2 (3 . 4))');
    expect(evalStr('`(1 ,(+ 1 1) ,@(list 3 4) 5)')).toBe('(1 2 3 4 5)');
    expect(evalStr('`(a ,@(list) b)')).toBe('(a b)'); // splicing () contributes nothing
  });

  it('nested quasiquote keeps depth accounting', () => {
    expect(evalStr('`(1 `(2 ,(+ 1 2)))')).toBe('(1 (quasiquote (2 (unquote …))))'); // depth-limited render, honest ellipsis
  });
});

describe('closures and environments', () => {
  it('make-counter counts independently per closure', () => {
    const m = evalSrc(`
(define (make-counter)
  (let ((n 0))
    (lambda () (set! n (+ n 1)) n)))
(define c1 (make-counter))
(define c2 (make-counter))
(c1) (c1)
(list (c1) (c2))`);
    expect(withHeap(m.heap, () => renderWrite(m.lastValue))).toBe('(3 1)');
  });

  it('let* sees earlier bindings; letrec supports mutual recursion', () => {
    expect(evalStr('(let* ((x 1) (y (+ x 1))) (* x y))')).toBe('2');
    expect(evalStr(`(letrec ((e? (lambda (n) (if (= n 0) #t (o? (- n 1)))))
                        (o? (lambda (n) (if (= n 0) #f (e? (- n 1))))))
                   (list (e? 10) (o? 10)))`)).toBe('(#t #f)');
  });

  it('set! errors on unbound variables with the line', async () => {
    const { result } = await runSession('(define x 1)\n(set! nope 2)');
    expect(result.finished).toBe(false);
    expect(result.error).toBe('set!: unbound variable: nope (line 2)');
  });
});

describe('proper tail calls', () => {
  it('a 100 000-deep tail loop completes within the budget', async () => {
    const { result } = await runSession(`
(define (loop n)
  (if (= n 0)
      'done
      (loop (- n 1))))
(loop 100000)`);
    expect(result.finished).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('the 100 000 tail loop runs in constant control-stack space', () => {
    let m!: Machine;
    const b = makeBuiltins((fv, env) => m.macroExpandOnce(fv, env));
    m = new Machine(readProgram(`
(define (loop n)
  (if (= n 0)
      'done
      (loop (- n 1))))
(loop 100000)`), b);
    let maxStack = 0;
    while (!m.finished && m.error === null) {
      m.step();
      maxStack = Math.max(maxStack, m.stack.length);
    }
    // Broken tail calls would push one frame per call and grow the stack
    // past 100 000; the real bound is the operand/args frames in flight.
    expect(m.error).toBeNull();
    expect(m.finished).toBe(true);
    expect(maxStack).toBeLessThanOrEqual(4);
  });

  it('a runaway loop stops at the budget with a clean error', async () => {
    const { result } = await runSession('(define (spin n) (spin (+ n 1)))\n(spin 0)');
    expect(result.finished).toBe(false);
    expect(result.error).toMatch(/run budget exceeded \(1000000 reductions\) \(line 1\)/);
  });
});

describe('define-macro', () => {
  it('my-if expands to cond and applies without evaluating both arms', async () => {
    const { text } = await runSession(`
(define-macro (my-if c t e) \`(cond (,c ,t) (else ,e)))
(display (macroexpand-1 '(my-if #t 1 2)))
(newline)
(display (my-if #f 42 99))
(newline)`);
    expect(text).toBe('(cond (#t 1) (else 2))\n99\n');
  });

  it('swap! expands to a let with set! and swaps properly', async () => {
    const { text } = await runSession(`
(define-macro (swap! a b) \`(let ((tmp ,a)) (set! ,a ,b) (set! ,b tmp)))
(define x 1)
(define y 2)
(display (macroexpand-1 '(swap! x y)))
(newline)
(swap! x y)
(display (list x y))
(newline)`);
    expect(text).toBe('(let ((tmp x)) (set! x y) (set! y tmp))\n(2 1)\n');
  });

  it('macros receive unevaluated forms (that is the whole trick)', () => {
    expect(evalStr(`
(define-macro (twice e) \`(begin ,e ,e))
(define n 0)
(twice (set! n (+ n 1)))
n`)).toBe('2');
  });

  it('errors inside a macro expansion map to the macro call site', async () => {
    const { result } = await runSession("; comment\n(define-macro (m) (list 'begin (list 'undefined-thing)))\n(m)");
    expect(result.finished).toBe(false);
    expect(result.error).toBe('unbound variable: undefined-thing (line 3)');
  });

  it('macroexpand-1 refuses a transformer that never finishes', async () => {
    const { result } = await runSession("(define (spin n) (spin (+ n 1)))\n(define-macro (m) (spin 0))\n(macroexpand-1 '(m))");
    expect(result.finished).toBe(false);
    expect(result.error).toBe('macro transformer too long (over 10 000 reductions) (line 3)');
  });
});

describe('eq?, eqv?, equal?, and the heap', () => {
  it('eq? is address identity; equal? walks the heap', () => {
    expect(evalStr('(define xs (list 1 2)) (eq? xs xs)')).toBe('#t');
    expect(evalStr('(eq? (list 1 2) (list 1 2))')).toBe('#f');
    expect(evalStr('(equal? (list 1 2) (list 1 2))')).toBe('#t');
    expect(evalStr('(equal? (list 1 (list 2 3)) (list 1 (list 2 3)))')).toBe('#t');
    expect(evalStr("(eq? 'a 'a)")).toBe('#t');
    expect(evalStr('(eqv? 2 2)')).toBe('#t');
  });

  it('append shares its last list — visible through eq?', () => {
    expect(evalStr(`(define a (list 1 2))
(define b (list 3 4))
(define c (append a b))
(list (eq? (cdr (cdr c)) b) (eq? c a))`)).toBe('(#t #f)');
  });

  it('append refuses a dotted non-final argument instead of dropping the tail', async () => {
    const { result } = await runSession('(define x 1)\n(append (cons 1 2) (list 3))');
    expect(result.finished).toBe(false);
    expect(result.error).toBe('append: expected a proper list (line 2)');
  });

  it('renders dotted pairs honestly', async () => {
    const { text } = await runSession("(display (cons 1 2)) (newline) (display '(1 2 . 3)) (newline)");
    expect(text).toBe('(1 . 2)\n(1 2 . 3)\n');
  });
});

describe('cond', () => {
  it('falls through to else', () => {
    expect(evalStr(`(cond ((= 1 2) 'a) ((= 1 3) 'b) (else 'fallback))`)).toBe('fallback');
    expect(evalStr(`(cond ((= 1 1) 'first) (else 'fallback))`)).toBe('first');
    expect(evalStr(`(cond (#t) (else 'fallback))`)).toBe('#t'); // valueless clause returns the test
  });
});

describe('panels and stepping (the under-the-hood story)', () => {
  it('heap addresses are stable across steps', async () => {
    const s = lispKernel.createSession();
    await s.load('(define a (list 1 2 3))\n(display (length a))');
    // Step until the list exists, then keep going — cell 0x0020 must not move.
    for (let i = 0; i < 6; i++) await s.step();
    const heap = () => s.state().find((p): p is Extract<Panel, { kind: 'listing' }> => p.id === 'heap')!;
    const before = heap().rows.map((r) => `${r.addr}:${r.text}`).join('|');
    const rowsAfter: string[] = [];
    for (let i = 0; i < 10; i++) {
      await s.step();
      rowsAfter.push(heap().rows.map((r) => `${r.addr}:${r.text}`).join('|'));
    }
    // Every row that existed before still exists, unchanged, afterwards.
    for (const after of rowsAfter) {
      for (const row of before.split('|')) expect(after).toContain(row);
    }
    await s.run();
    const done = heap().rows;
    expect(done.map((r) => r.text)).toEqual([
      'car 3 · cdr ()',
      'car 2 · cdr (3)',
      'car 1 · cdr (2 3)',
    ]);
  });
  it('cells allocated by a step are marked current in the Heap panel', async () => {
    const s = lispKernel.createSession();
    await s.load('(define x (cons 1 2))\n(define y (cons 3 4))');
    // Step until the first cons has actually allocated: the define
    // dispatches, the operand chain runs, then the apply allocates.
    for (let i = 0; i < 20 && heapOf(s).rows.length === 0; i++) await s.step();
    const heap = heapOf(s);
    expect(heap.rows.length).toBe(1);
    expect(heap.rows[0]!.current).toBe(true);
    await s.run();
    expect(heapOf(s).rows.length).toBe(2);
  });

  it('environment panels show frame chains; set! marks the binding changed', async () => {
    const s = lispKernel.createSession();
    await s.load(`(define x 1)
(define (bump!)
  (set! x 99)
  x)
(bump!)`);
    await s.run();
    const envPanels = s.state().filter((p): p is Extract<Panel, { kind: 'fields' }> => p.kind === 'fields');
    expect(envPanels.length).toBeGreaterThanOrEqual(1);
    const global = envPanels.find((p) => p.title === 'global');
    expect(global).toBeDefined();
    expect(global!.fields.map((f) => `${f.key}=${f.value}`)).toEqual(['x=99', 'bump!=#<procedure bump!>']);
  });

  it('the control stack names what each frame waits for', async () => {
    const s = lispKernel.createSession();
    await s.load('(* 2 (+ 3 4))');
    await s.step(); // dispatch the application
    await s.step(); // focus the operator
    const stack = s.state().find((p): p is Extract<Panel, { kind: 'listing' }> => p.id === 'control')!;
    const texts = stack.rows.map((r) => r.text);
    expect(texts.some((t) => t.includes('waiting for'))).toBe(true);
    expect(stack.rows[stack.rows.length - 1]!.current).toBe(true);
  });

  it('breakpoints pause before a form on that line; step then resume', async () => {
    const s = lispKernel.createSession();
    await s.load(`(define (twice x) (* 2 x))\n(display (twice 21))`);
    const paused = await s.run([2]);
    expect(paused.finished).toBe(false);
    expect(paused.pausedAt).toBe(2);
    await s.step(); // step past the breakpointed form's first reduction
    const done = await s.run();
    expect(done.finished).toBe(true);
    const con = s.state().find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console');
    expect(con!.text).toBe('42');
  });

  it('reset rebuilds the machine from scratch', async () => {
    const s = lispKernel.createSession();
    await s.load('(display 1)(newline)');
    const first = await s.run();
    s.reset();
    const second = await s.run();
    expect(second.finished).toBe(true);
    expect(second.steps).toBe(first.steps);
  });
});

describe('error mapping and honesty', () => {
  it('error builtin reports the call site line', async () => {
    const { result } = await runSession('(define x 1)\n(display x)\n(error "boom:" 42)');
    expect(result.finished).toBe(false);
    expect(result.error).toBe('boom: 42 (line 3)');
  });

  it('car of a non-pair names the line', async () => {
    const { result } = await runSession('(car 5)');
    expect(result.error).toMatch(/car: expected a pair, got 5 \(line 1\)/);
  });

  it('unbound variable references report their line', async () => {
    const { result } = await runSession('(define a 1)\n(+ a nope)');
    expect(result.error).toBe('unbound variable: nope (line 2)');
  });

  it('the heap is bounded and overflows with a line', async () => {
    const { result } = await runSession('(define (grow l)\n  (grow (cons 0 l)))\n(grow (list))');
    expect(result.finished).toBe(false);
    expect(result.error).toMatch(/heap overflow: 4096 cells \(line 2\)/);
  });

  it('and/or attribute atom-operand errors to the enclosing form line', async () => {
    const andErr = await runSession('(define x 1)\n(and #t nope)');
    expect(andErr.result.error).toBe('unbound variable: nope (line 2)');
    const orErr = await runSession('(define x 1)\n(or #f nope)');
    expect(orErr.result.error).toBe('unbound variable: nope (line 2)');
  });

  it('modulo and remainder by zero raise line-mapped errors like /', async () => {
    const mod = await runSession('(define x 1)\n(modulo 5 0)');
    expect(mod.result.finished).toBe(false);
    expect(mod.result.error).toBe('modulo: division by zero (line 2)');
    const rem = await runSession('(define x 1)\n(remainder 5 0)');
    expect(rem.result.finished).toBe(false);
    expect(rem.result.error).toBe('remainder: division by zero (line 2)');
  });
});

describe('kernel registration surface', () => {
  it('declares the org id, label, syntax, and features', () => {
    expect(lispKernel.id).toBe('lisp');
    expect(lispKernel.label).toBe('Lisp · interpreter');
    expect(lispKernel.editorSyntax).toBe('scheme');
    expect(lispKernel.features).toEqual({ breakpoints: true, stepping: true });
  });

  it('load summarizes the form count', async () => {
    const s = lispKernel.createSession();
    const load = await s.load('(define x 1)\n(display x)');
    expect(load).toEqual({ ok: true, summary: 'loaded · 2 forms' });
    s.dispose();
    expect(await s.run()).toEqual({ finished: false, steps: 0, error: 'nothing is loaded' });
  });

  it('Ref addresses are the cells they name', () => {
    const m = evalSrc('(list 1 2)');
    const lst = m.lastValue;
    expect(lst).toBeInstanceOf(Ref);
    if (lst instanceof Ref) {
      expect(m.heap.get(lst.addr).car).toBe(1);
      expect(m.heap.cdr(lst)).toBeInstanceOf(Ref);
    }
  });
});

function heapOf(s: { state(): Panel[] }): Extract<Panel, { kind: 'listing' }> {
  const p = s.state().find((q): q is Extract<Panel, { kind: 'listing' }> => q.id === 'heap');
  if (p === undefined) throw new Error('missing heap panel');
  return p;
}
