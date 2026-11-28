import { describe, expect, it } from 'vitest';
import {
  ElispMachine, ElispSession, Runtime, readProgram, renderWrite,
  type Panel, type RunResult,
} from '../src/index';

/** Build a machine over `src`; `lexical` overrides header detection. */
function machineFor(src: string, lexical?: boolean): ElispMachine {
  const header = /-\*-.*lexical-binding:\s*t\s*;?.*-\*-/.test(src);
  return new ElispMachine(
    { forms: readProgram(src), lexicalBinding: lexical ?? header },
    new Runtime(),
  );
}

/** Run to completion and render the last value; throws on a kernel error. */
function evalStr(src: string, lexical?: boolean): string {
  const m = machineFor(src, lexical);
  m.run();
  if (m.error !== null) throw new Error(m.error);
  return renderWrite(m.lastValue);
}

async function runSession(src: string): Promise<{ result: RunResult; panels: Panel[]; output: string }> {
  const s = new ElispSession();
  const load = await s.load(src);
  if (!load.ok) throw new Error(`load failed: ${load.line}: ${load.message}`);
  const result = await s.run();
  const panels = s.state();
  const out = panels.find((p): p is Extract<Panel, { kind: 'console' }> => p.kind === 'console' && p.id === 'output');
  return { result, panels, output: out?.text ?? '' };
}

function panel(panels: Panel[], id: string): Panel | undefined {
  return panels.find((p) => p.id === id);
}

describe('core evaluation', () => {
  it('evaluates arithmetic, strings, and nested calls', () => {
    expect(evalStr('(+ 1 (* 2 3))')).toBe('7');
    expect(evalStr('(concat "a" "b" (number-to-string 3))')).toBe('"ab3"');
    expect(evalStr('(if (> 2 1) 10 20)')).toBe('10');
    expect(evalStr('(if nil 10 20)')).toBe('20');
    expect(evalStr('(when t 1 2 3)')).toBe('3');
    expect(evalStr('(unless nil 4)')).toBe('4');
    expect(evalStr('(cond ((= 1 2) 1) ((= 2 2) 2) (t 3))')).toBe('2');
    expect(evalStr('(and 1 2 3)')).toBe('3');
    expect(evalStr('(and 1 nil 3)')).toBe('nil');
    expect(evalStr('(or nil nil 9)')).toBe('9');
  });

  it('treats nil as false and every other value as true', () => {
    expect(evalStr('(if 0 1 2)')).toBe('1');
    expect(evalStr('(if "" 1 2)')).toBe('1');
    expect(evalStr('(if (list) 1 2)')).toBe('2');
    expect(evalStr('(not nil)')).toBe('t');
    expect(evalStr('(null ())')).toBe('t');
  });

  it('quotes data into cons cells and vectors', () => {
    expect(evalStr("(car '(1 2 3))")).toBe('1');
    expect(evalStr("(cdr '(1 . 2))")).toBe('2');
    expect(evalStr("'(a b . c)")).toBe('(a b . c)');
    expect(evalStr('[1 2 (+ 1 2)]')).toBe('[1 2 (+ 1 2)]');
    expect(evalStr("(aref [a b] 1)")).toBe('b');
  });

  it('setq returns the value and updates the nearest binding', () => {
    expect(evalStr('(setq x 4) x')).toBe('4');
    expect(evalStr('(setq x 1 y 2) (list x y)')).toBe('(1 2)');
    expect(evalStr('(let ((x 1)) (setq x 9) x)')).toBe('9');
  });

  it('multiple ELSE forms in if, and zero-argument setq', () => {
    expect(evalStr('(if nil 1 2 3)')).toBe('3');
    expect(evalStr('(if t 1 2 3)')).toBe('1');
    expect(evalStr('(setq)')).toBe('nil');
  });

  it('refuses to set constants', () => {
    const err = (() => { try { evalStr('(setq t 1)'); return null; } catch (e) { return String(e); } })();
    expect(err).toContain('constant symbol: t');
  });

  it('let is parallel, let* is sequential', () => {
    expect(evalStr('(let ((x 1) (y 2)) (+ x y))')).toBe('3');
    expect(evalStr('(let* ((x 1) (y (+ x 1))) y)')).toBe('2');
    const err = (() => { try { evalStr('(let ((x 1) (y x)) y)'); return null; } catch (e) { return String(e); } })();
    expect(err).toContain('void-variable x');
  });
});

describe('Lisp-2: value cell vs function cell', () => {
  it('defun fills the function cell without touching the value cell', () => {
    expect(evalStr('(defun double (x) (* 2 x)) (double 4)')).toBe('8');
    expect(evalStr('(defun double (x) (* 2 x)) (setq double 99) (double 4)')).toBe('8');
    expect(evalStr('(defun double (x) (* 2 x)) (setq double 99) double')).toBe('99');
  });

  it('a lambda in a value cell is callable only through funcall', () => {
    expect(evalStr('(setq f (lambda (x) (+ x 1))) (funcall f 1)')).toBe('2');
    const err = (() => { try { evalStr('(setq f (lambda (x) x)) (f 1)'); return null; } catch (e) { return String(e); } })();
    expect(err).toContain('void-function f');
  });

  it('fset/defalias define the function cell, and symbols alias', () => {
    expect(evalStr("(fset 'triple (lambda (x) (* 3 x))) (triple 2)")).toBe('6');
    expect(evalStr("(defun a (x) (+ x 1)) (defalias 'b 'a) (b 4)")).toBe('5');
    expect(evalStr("(fset 'triple (lambda (x) x)) (fboundp 'triple)")).toBe('t');
  });

  it('apply and funcall flatten their last argument', () => {
    expect(evalStr("(apply '+ '(1 2 3))")).toBe('6');
    expect(evalStr("(apply '+ 1 2 '(3 4))")).toBe('10');
    expect(evalStr("(mapcar (lambda (x) (* x x)) '(1 2 3))")).toBe('(1 4 9)');
  });
});

describe('dynamic vs lexical binding', () => {
  const body = '(setq x 1) (defun get-x () x) (let ((x 2)) (get-x))';

  it('binds let and arguments dynamically by default', () => {
    expect(evalStr(body, false)).toBe('2');
  });

  it('captures let bindings lexically with the file-local header', () => {
    expect(evalStr(';; -*- lexical-binding: t; -*-\n' + body)).toBe('1');
  });

  it('lets a closure keep its lexical argument (or lose it dynamically)', () => {
    const src = '(defun make-adder (n) (lambda (x) (+ x n))) (funcall (make-adder 5) 3)';
    expect(evalStr(src, true)).toBe('8');
    const err = (() => { try { evalStr(src, false); return null; } catch (e) { return String(e); } })();
    expect(err).toContain('void-variable n');
  });

  it('defvar marks a name special: still dynamically bound under lexical-binding', () => {
    const src = ';; -*- lexical-binding: t; -*-\n(defvar v 1) (defun get-v () v) (let ((v 2)) (get-v))';
    expect(evalStr(src)).toBe('2');
  });

  it('setq lexical-binding switches the mode at runtime', () => {
    const src = '(setq lexical-binding t) (defun make (n) (lambda () n)) (funcall (make 7))';
    expect(evalStr(src)).toBe('7');
  });
});

describe('functions and macros', () => {
  it('binds &optional and &rest', () => {
    expect(evalStr('(defun f (a &optional b &rest c) (list a b c)) (f 1)')).toBe('(1 nil nil)');
    expect(evalStr('(defun f (a &optional b &rest c) (list a b c)) (f 1 2 3 4)')).toBe('(1 2 (3 4))');
    expect(evalStr('(defun f (a &optional b) (list a b)) (f 1 2)')).toBe('(1 2)');
  });

  it('signals arity errors with the function name', () => {
    const err = (() => { try { evalStr('(defun f (a b) a) (f 1)'); return null; } catch (e) { return String(e); } })();
    expect(err).toContain('f: wrong number of arguments (1)');
  });

  it('expands defmacro transformers, including backquote/splice', () => {
    const src = [
      '(defmacro our-unless (c &rest body)',
      '  `(if ,c nil (progn ,@body)))',
      '(setq n 0)',
      '(our-unless nil (setq n 5) (setq n (+ n 1)))',
      'n',
    ].join('\n');
    expect(evalStr(src)).toBe('6');
  });

  it('macroexpand-1 returns the expansion without running it', () => {
    const src = [
      '(defmacro twice (x) `(progn ,x ,x))',
      "(macroexpand-1 '(twice (setq z 1)))",
    ].join('\n');
    expect(evalStr(src)).toBe('(progn (setq z 1) (setq z 1))');
    const m = machineFor(src + '\nz');
    m.run();
    expect(m.error).toContain('void-variable z');
  });

  it('shows the last value in the console when nothing was printed', async () => {
    const { result, panels } = await runSession('(+ 1 2)');
    expect(result.exit).toBe('=> 3');
    const out = panel(panels, 'output') as Extract<Panel, { kind: 'console' }>;
    expect(out.text).toBe('3');
    // the console stays first so the block's results slot shows it
    expect(panels.filter((p) => p.kind === 'console')[0]?.id).toBe('output');
  });

  it('keeps printed output verbatim and the value in the status', async () => {
    const { result, panels } = await runSession('(message "hi")\n(+ 1 2)');
    const out = panel(panels, 'output') as Extract<Panel, { kind: 'console' }>;
    expect(out.text).toBe('hi\n');
    expect(result.exit).toBe('=> 3');
  });

  it('runs macro arguments unevaluated', () => {
    expect(evalStr('(defmacro q (x) (list (quote quote) x)) (q (a b))')).toBe('(a b)');
  });
});

describe('non-local control and errors', () => {
  it('catch/throw return the thrown value', () => {
    expect(evalStr("(catch 'done (throw 'done 42) 0)")).toBe('42');
    expect(evalStr("(+ 1 (catch 'x (throw 'x 5)))")).toBe('6');
  });

  it('unwind-protect runs cleanup for normal and thrown exits', () => {
    expect(evalStr('(setq x 0) (unwind-protect (setq x 1) (setq x 2)) x')).toBe('2');
    expect(evalStr("(setq x 0) (catch 't (unwind-protect (throw 't 1) (setq x 3))) x")).toBe('3');
  });

  it('condition-case catches the matching condition and binds the error', () => {
    expect(evalStr("(condition-case nil (car 1) (error 'caught))")).toBe('caught');
    expect(evalStr('(condition-case e (error "boom") (error (cadr e)))')).toBe('"boom"');
  });

  it('ignore-errors returns nil on an error', () => {
    expect(evalStr('(ignore-errors (car 1))')).toBe('nil');
    expect(evalStr('(ignore-errors (+ 1 2))')).toBe('3');
  });

  it('maps errors to source lines', () => {
    const m = machineFor('(defun f (x)\n  (car x))\n(f 1)');
    m.run();
    expect(m.error).toContain('(line 2)');
  });
});

describe('simulated Emacs runtime', () => {
  it('inserts, moves point, deletes, and reads buffer text', () => {
    expect(evalStr('(insert "hello") (buffer-string)')).toBe('"hello"');
    expect(evalStr('(insert "hello") (goto-char 1) (insert ">") (buffer-string)')).toBe('">hello"');
    expect(evalStr('(insert "hello") (delete-region 2 4) (buffer-string)')).toBe('"hlo"');
    expect(evalStr('(insert "hello") (goto-char 1) (point)')).toBe('1');
    expect(evalStr('(insert "hello") (point-max)')).toBe('6');
  });

  it('save-excursion restores point as a marker', () => {
    expect(evalStr('(insert "hello") (goto-char 2) (save-excursion (goto-char 5) (insert "!")) (point)')).toBe('2');
    expect(evalStr('(insert "hello") (goto-char 5) (save-excursion (goto-char 2) (insert "X")) (point)')).toBe('6');
    expect(evalStr('(insert "hello") (goto-char 5) (save-excursion (insert "!")) (point)')).toBe('5');
  });

  it('with-current-buffer switches for the body and restores', () => {
    const src = '(with-current-buffer (get-buffer-create "notes") (insert "x") (buffer-string))';
    expect(evalStr(src)).toBe('"x"');
    expect(evalStr(src + ' (buffer-name)')).toBe('"*scratch*"');
  });

  it('bucket-local variables shadow only in their buffer', () => {
    expect(evalStr('(setq v 0) (setq-local v 1) v')).toBe('1');
    expect(evalStr('(setq v 0) (setq-local v 1) (with-current-buffer (get-buffer-create "b") v)'))
      .toBe('0');
  });

  it('runs hooks in order and dedupes add-hook', () => {
    const src = [
      '(defvar ran 0)',
      '(defun first () (setq ran (+ ran 1)))',
      '(add-hook \'after-init-hook \'first)',
      '(add-hook \'after-init-hook \'first)',
      '(run-hooks \'after-init-hook)',
      'ran',
    ].join('\n');
    expect(evalStr(src)).toBe('1');
  });

  it('orders prepended hooks most-recent-first', () => {
    const src = [
      '(defvar log "")',
      '(defun h1 () (setq log (concat log "1")))',
      '(defun h2 () (setq log (concat log "2")))',
      '(add-hook \'after-init-hook \'h1)',
      '(add-hook \'after-init-hook \'h2)',
      '(run-hooks \'after-init-hook)',
      'log',
    ].join('\n');
    expect(evalStr(src)).toBe('"21"');
  });

  it('symbol-value/boundp see dynamic bindings, never lexical ones', () => {
    expect(evalStr("(setq v 1) (let ((v 2)) (symbol-value 'v))")).toBe('2');
    expect(evalStr("(setq v 1) (let ((v 2)) (boundp 'v))")).toBe('t');
    expect(evalStr("(setq v 1) (let ((v 2)) (set 'v 3) v)")).toBe('3');
    expect(evalStr("(setq v 1) (let ((v 2)) (set 'v 3)) v")).toBe('1');
    expect(() => evalStr("(let ((v 2)) (symbol-value 'v))", true))
      .toThrow(/void-variable v/);
    expect(evalStr("(let ((v 2)) (boundp 'v))", true)).toBe('nil');
  });

  it('returns the symbol itself for #\'symbol, like Emacs', () => {
    expect(evalStr("(defun double (x) (* 2 x)) (eq 'double #'double)")).toBe('t');
    expect(evalStr("(defun double (x) (* 2 x)) (let ((f #'double)) (funcall f 3))")).toBe('6');
  });

  it('removes a hook added with #\' by its symbol', () => {
    const src = [
      '(defvar ran 0)',
      '(defun h () (setq ran 1))',
      "(add-hook 'after-init-hook #'h)",
      "(remove-hook 'after-init-hook 'h)",
      "(run-hooks 'after-init-hook)",
      'ran',
    ].join('\n');
    expect(evalStr(src)).toBe('0');
  });

  it('keeps defvar-named function parameters lexical under lexical-binding', () => {
    const src = [
      '(defvar v 1)',
      '(defun read-v () v)',
      '(defun shell (v) (read-v))',
      '(let ((v 2)) (shell 3))',
    ].join('\n');
    // Emacs keeps the parameter lexical, so read-v sees the dynamic let
    expect(evalStr(src, true)).toBe('2');
    // without defvar the parameter is lexical, so read-v has no v at all
    const plain = [
      '(defun read-v () v)',
      '(defun shell (v) (read-v))',
      '(let ((v 2)) (shell 3))',
    ].join('\n');
    expect(() => evalStr(plain, true)).toThrow(/void-variable v/);
  });

  it('allows an empty defun body', () => {
    expect(evalStr('(defun noop ()) (noop)')).toBe('nil');
  });

  it('rejects dotted code forms instead of treating them as calls', () => {
    expect(() => evalStr('(list . 1)')).toThrow(/invalid-function/);
  });

  it('reads a combined file-local cookie', () => {
    const src = ';; -*- mode: emacs-lisp; lexical-binding: t; -*-\n(let ((x 1)) (symbol-value \'x))';
    expect(() => evalStr(src)).toThrow(/void-variable x/);
    expect(evalStr(';; -*- mode: emacs-lisp; lexical-binding: t; -*-\n(defun make-adder (n) (lambda (x) (+ x n))) (funcall (make-adder 1) 2)'))
      .toBe('3');
  });

  it('binds lexical-binding even without a cookie, and reads only line 1', () => {
    expect(evalStr('(list lexical-binding (boundp \'lexical-binding))')).toBe('(nil t)');
    const secondLine = ';; a comment\n;; -*- lexical-binding: t; -*-\n(let ((x 1)) (symbol-value \'x))';
    expect(() => evalStr(secondLine)).toThrow(/void-variable x/);
  });

  it('leaves a defvar without an initializer void', () => {
    expect(evalStr("(defvar zz) (boundp 'zz)")).toBe('nil');
    expect(() => evalStr('(defvar zz) zz')).toThrow(/void-variable zz/);
    expect(() => evalStr('(defconst cc)')).toThrow(/defconst: expected a value/);
  });

  it('returns a sole string body and still records it as a docstring', () => {
    expect(evalStr('((lambda () "hi"))')).toBe('"hi"');
    expect(evalStr('(defun f () "hi") (f)')).toBe('"hi"');
  });

  it('expands unquote and splice inside backquoted vectors', () => {
    expect(evalStr('`[a ,(+ 1 1)]')).toBe('[a 2]');
    expect(evalStr('`[,@(list 1 2)]')).toBe('[1 2]');
  });

  it('keeps middle elements and dotted tails in backquoted lists', () => {
    expect(evalStr('`(1 2 . 3)')).toBe('(1 2 . 3)');
    expect(evalStr('(let ((x 4)) `(a b ,x . 9))')).toBe('(a b 4 . 9)');
    expect(evalStr('`(a ,@(list 1 2) b)')).toBe('(a 1 2 b)');
  });

  it('is eq to itself for the same float binding', () => {
    expect(evalStr('(let ((x 1.5)) (eq x x))')).toBe('t');
    expect(evalStr('(let ((x 1.0)) (eq x x))')).toBe('t');
    expect(evalStr('(eq 1.5 1.5)')).toBe('nil');
    expect(evalStr('(eql 1.5 1.5)')).toBe('t');
  });

  it('dedupes structurally equal lambdas on a hook', () => {
    expect(evalStr('(setq h nil) (add-hook \'h (lambda ())) (add-hook \'h (lambda ())) (length h)'))
      .toBe('1');
  });

  it('canonicalizes key vectors and matches kbd strings', () => {
    expect(evalStr("(define-key global-map [13] 'foo) (lookup-key global-map (kbd \"RET\"))")).toBe('foo');
    expect(evalStr("(define-key global-map [3 97] 'foo) (lookup-key global-map (kbd \"C-c a\"))")).toBe('foo');
    expect(evalStr("(define-key global-map [f5] 'foo) (lookup-key global-map (kbd \"<f5>\"))")).toBe('foo');
  });

  it('reads Emacs character escapes', () => {
    expect(evalStr('(list ?\\C-a ?\\M-x ?\\x41 ?\\101 ?\\b)')).toBe('(1 134217848 65 65 8)');
    expect(evalStr('?\\^A')).toBe('1');
  });

  it('dispatches intercepted builtins through funcall and apply', () => {
    expect(evalStr("(funcall #'mapcar #'1+ '(1 2))")).toBe('(2 3)');
    expect(evalStr("(funcall #'apply #'+ '(1 2))")).toBe('3');
  });

  it('mutates hooks in the nearest dynamic binding', () => {
    expect(evalStr("(defvar mh nil) (let ((mh nil)) (add-hook 'mh 'f) mh)")).toBe('(f)');
    expect(evalStr("(defvar rh '(a b)) (let ((rh '(a b))) (remove-hook 'rh 'a) rh)")).toBe('(b)');
    expect(evalStr("(setq h '(a)) (remove-hook 'h 'a t) h")).toBe('(a)');
  });

  it('keeps save-restriction from restoring point', () => {
    expect(evalStr('(insert "abcdef") (goto-char 2) (save-restriction (goto-char 5)) (point)'))
      .toBe('5');
  });

  it('splices vectors into backquoted vectors', () => {
    expect(evalStr('(let ((v [1 2])) `[,@v])')).toBe('[1 2]');
    expect(evalStr('(let ((v [1 2])) `[0 ,@v 3])')).toBe('[0 1 2 3]');
  });

  it('names builtin error conditions', () => {
    expect(evalStr("(condition-case e (aref [1] 5) (args-out-of-range 'range) (error 'other))"))
      .toBe('range');
    expect(evalStr("(condition-case e (progn (defun ft (t) t) (ft 1)) (setting-constant 'caught) (error 'other))")).toBe('caught');
    expect(evalStr("(condition-case e (setq x) (wrong-number-of-arguments 'caught) (error 'other))"))
      .toBe('caught');
    expect(evalStr('(list (goto-char 0) (goto-char 99))')).toBe('(0 99)');
    expect(evalStr("(alist-get \"b\" '((\"b\" . 2)))")).toBe('nil');
  });

  it('ignores a lexical-binding parameter when choosing closure binding', () => {
    const src = [
      '(defun g (lexical-binding) (lambda () lexical-binding))',
      '(funcall (g nil))',
    ].join('\n');
    expect(evalStr(src, true)).toBe('nil');
  });

  it('skips a shebang line', () => {
    const src = '#!/usr/bin/env emacs\n;; -*- lexical-binding: t; -*-\n(defun make (n) (lambda () n)) (funcall (make 8))';
    expect(evalStr(src)).toBe('8');
  });

  it('keeps floatness through arithmetic and division', () => {
    expect(evalStr('(/ 3.0 2)')).toBe('1.5');
    expect(evalStr('(/ 1.0 2)')).toBe('0.5');
    expect(evalStr('(+ 1.0)')).toBe('1.0');
    expect(evalStr('(* 1.5 2)')).toBe('3.0');
    expect(evalStr('(floatp (* 1.5 2))')).toBe('t');
    expect(evalStr('(max 1.0 2)')).toBe('2.0');
    expect(() => evalStr('(% 5.5 2)')).toThrow(/expected an integer/);
  });

  it('does not eq floats but does eq fixnums', () => {
    expect(evalStr('(eq 1 1)')).toBe('t');
    expect(evalStr('(eq 1.5 1.5)')).toBe('nil');
  });

  it('binds keywords to themselves', () => {
    expect(evalStr('(symbol-value :foo)')).toBe(':foo');
    expect(evalStr('(boundp :foo)')).toBe('t');
  });

  it('provides and requires features', () => {
    expect(evalStr("(require 'seq) (featurep 'seq)")).toBe('t');
    expect(evalStr("(provide 'mine) (featurep 'mine)")).toBe('t');
    expect(() => evalStr("(require 'nosuch)")).toThrow(/cannot open load file/);
  });

  it('filters, maps, and reduces sequences with pcase destructuring', () => {
    const src = [
      '(require \'seq)',
      '(defun parse-pair (entry)',
      '  (pcase entry',
      '    (`(,k . ,v) (format "%s=%s" k v))',
      '    (_ "invalid")))',
      '(let* ((scores \'((ada . 95) (bob . 62) (cy . 88)))',
      '       (passing (seq-filter (lambda (pair) (>= (cdr pair) 80)) scores))',
      '       (labels (seq-map #\'parse-pair passing))',
      '       (total (seq-reduce (lambda (acc pair) (+ acc (cdr pair))) passing 0)))',
      '  (list labels total))',
    ].join('\n');
    expect(evalStr(src)).toBe('(("ada=95" "cy=88") 183)');
  });

  it('treats car and cdr of nil as nil', () => {
    expect(evalStr('(list (car nil) (cdr nil) (cadr nil))')).toBe('(nil nil nil)');
  });

  it('signals wrong-type-argument so named handlers can catch it', () => {
    expect(evalStr("(condition-case e (car 1) (wrong-type-argument 'caught))")).toBe('caught');
    expect(evalStr("(condition-case e (+ 1 \"x\") (wrong-type-argument 'caught))")).toBe('caught');
  });

  it('accepts strings and vectors in sequence functions', () => {
    expect(evalStr('(reverse "abc")')).toBe('"cba"');
    expect(evalStr('(reverse [1 2 3])')).toBe('[3 2 1]');
    expect(evalStr('(mapcar #\'1+ [1 2])')).toBe('(2 3)');
    expect(evalStr('(mapcar #\'identity "ab")')).toBe('(97 98)');
    expect(evalStr('(concat [97 98])')).toBe('"ab"');
  });

  it('calls builtins indirectly with dynamic bindings visible', () => {
    expect(evalStr("(defvar v 1) (let ((v 2)) (list (funcall #'symbol-value 'v) (funcall #'boundp 'v)))"))
      .toBe('(2 t)');
    expect(evalStr("(defvar v 1) (let ((v 2)) (funcall #'set 'v 3) v)")).toBe('3');
  });

  it('supports prefix keymaps and rejects non-prefix conflicts', () => {
    expect(evalStr([
      '(setq m (make-sparse-keymap))',
      "(define-key m (kbd \"C-c a\") 'bar)",
      "(keymapp (lookup-key m (kbd \"C-c\")))",
    ].join('\n'))).toBe('t');
    expect(evalStr([
      '(setq m (make-sparse-keymap))',
      '(setq sub (make-sparse-keymap))',
      '(define-key sub (kbd "a") (quote cmd))',
      '(define-key m (kbd "C-c") sub)',
      '(lookup-key m (kbd "C-c a"))',
    ].join('\n'))).toBe('cmd');
    // a prefix map returned by lookup-key can be extended in place
    expect(evalStr([
      '(setq m (make-sparse-keymap))',
      "(define-key m (kbd \"C-c a\") 'bar)",
      "(define-key (lookup-key m (kbd \"C-c\")) (kbd \"b\") 'baz)",
      '(lookup-key m (kbd "C-c b"))',
    ].join('\n'))).toBe('baz');
    const conflict = [
      '(setq m (make-sparse-keymap))',
      "(define-key m (kbd \"C-c\") 'foo)",
      "(define-key m (kbd \"C-c a\") 'bar)",
    ].join('\n');
    expect(() => evalStr(conflict)).toThrow(/non-prefix key/);
  });

  it('matches common Emacs string and vector calls', () => {
    expect(evalStr('(substring "hello" 1 3)')).toBe('"el"');
    expect(evalStr('(substring "hello" -3)')).toBe('"llo"');
    expect(evalStr('(concat "a" nil "b")')).toBe('"ab"');
    expect(evalStr('(format "%s=%d" "a" 3)')).toBe('"a=3"');
    expect(evalStr('(format "%S" "a")')).toBe('"\\"a\\""');
    expect(evalStr('(number-to-string 3.5)')).toBe('"3.5"');
    expect(evalStr('(string-to-number "3.5")')).toBe('3.5');
    expect(evalStr('(aref "abc" 1)')).toBe('98');
    expect(evalStr("(make-vector 3 'x)")).toBe('[x x x]');
    expect(evalStr('(insert "hello") (buffer-substring 2 4)')).toBe('"el"');
  });

  it('uses Emacs argument order for nth, member, and assoc', () => {
    expect(evalStr("(nth 1 '(a b c))")).toBe('b');
    expect(evalStr("(nthcdr 1 '(a b c))")).toBe('(b c)');
    expect(evalStr("(member 2 '(1 2 3))")).toBe('(2 3)');
    expect(evalStr("(memq 'b '(a b c))")).toBe('(b c)');
    expect(evalStr("(assoc 'b '((a . 1) (b . 2)))")).toBe('(b . 2)');
    expect(evalStr("(assq 'b '((a . 1) (b . 2)))")).toBe('(b . 2)');
  });

  it('bounds empty-body loops and oversized vectors', () => {
    expect(() => evalStr('(dotimes (i 100000000000000000000))')).toThrow(/run budget exceeded/);
    expect(() => evalStr('(make-vector 2000000 nil)')).toThrow(/element limit/);
    expect(() => evalStr('(let ((s "x")) (dotimes (i 21) (setq s (concat s s))) s)'))
      .toThrow(/string limit exceeded/);
  });

  it('reports an interrupted run when reset happens mid-flight', async () => {
    const s = new ElispSession();
    await s.load('(dotimes (i 30000) (setq x i))');
    const p = s.run();
    s.reset();
    const r = await p;
    expect(r.error).toContain('run interrupted');
    expect(s.state().length).toBeGreaterThan(0);
  });

  it('clears the previous program when a load fails', async () => {
    const s = new ElispSession();
    await s.load('(setq x 41)\n(+ x 1)');
    expect((await s.run()).finished).toBe(true);
    const bad = await s.load('(defun f (');
    expect(bad.ok).toBe(false);
    expect(s.state()).toEqual([]);
    const after = await s.run();
    expect(after.finished).toBe(false);
    expect(after.error).toContain('nothing is loaded');
  });

  it('renders an improper hook value without throwing', async () => {
    const s = new ElispSession();
    await s.load("(setq my-hook (cons 'a 'b))");
    expect((await s.run()).finished).toBe(true);
    const hooks = s.state().find((p) => p.id === 'hooks') as
      Extract<Panel, { kind: 'listing' }> | undefined;
    expect(hooks?.rows[0]?.text).toContain('<invalid hook value>');
  });

  it('shows #\'-quoted hooks and bindings as commands, not aliases', async () => {
    const s = new ElispSession();
    await s.load([
      '(defun hello () (interactive))',
      "(add-hook 'after-init-hook #'hello)",
      '(define-key global-map (kbd "C-c h") #\'hello)',
    ].join('\n'));
    await s.run();
    const panels = s.state();
    const hooks = panels.find((p) => p.id === 'hooks') as Extract<Panel, { kind: 'listing' }>;
    expect(hooks.rows[0]?.text).toContain('hello');
    expect(hooks.rows[0]?.text).not.toContain('alias');
    const keys = panels.find((p) => p.id === 'keymaps') as Extract<Panel, { kind: 'listing' }>;
    expect(keys.rows[0]?.text).toContain('hello');
    expect(keys.rows[0]?.text).not.toContain('alias');
  });

  it('renders a cyclic hook list without throwing', async () => {
    const s = new ElispSession();
    await s.load("(setq after-init-hook (let ((x (list 1))) (setcdr x x) x))");
    expect((await s.run()).finished).toBe(true);
    const hooks = s.state().find((p) => p.id === 'hooks') as
      Extract<Panel, { kind: 'listing' }> | undefined;
    expect(hooks?.rows[0]?.text).toContain('<circular list>');
  });

  it('bounds infinite loops and runaway recursion', () => {
    const t0 = Date.now();
    expect(() => evalStr('(while t)')).toThrow(/run budget exceeded/);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(() => evalStr('(defun f (n) (1+ (f n))) (f 1)'))
      .toThrow(/max-lisp-eval-depth exceeded/);
  });

  it('does not restore the mark from save-excursion', () => {
    expect(evalStr('(insert "abcdef") (goto-char 3) (set-mark 5) (save-excursion (goto-char 1) (set-mark 6)) (mark)'))
      .toBe('6');
  });

  it('moves the mark with insertions and deletions', () => {
    expect(evalStr('(insert "abcdef") (set-mark 4) (erase-buffer) (list (point) (mark))'))
      .toBe('(1 1)');
    expect(evalStr('(insert "abcdef") (set-mark 6) (delete-region 5 7) (mark)')).toBe('5');
    expect(evalStr('(insert "abcdef") (goto-char 3) (set-mark 5) (insert "XY") (list (point) (mark))'))
      .toBe('(5 7)');
  });

  it('rejects selecting a killed buffer', () => {
    expect(() => evalStr('(let ((b (generate-new-buffer "tmp"))) (kill-buffer b) (set-buffer b))'))
      .toThrow(/Selecting deleted buffer/);
    expect(evalStr('(get-buffer-create "other") (save-excursion (kill-buffer (current-buffer))) (buffer-name)'))
      .toBe('"other"');
    expect(evalStr('(get-buffer-create "other") (save-excursion (kill-buffer (current-buffer))) (get-buffer "*scratch*")'))
      .toBe('nil');
  });

  it('writes princ/prin1/print/terpri to an optional buffer', () => {
    expect(evalStr('(princ "hi" (get-buffer-create "o")) (with-current-buffer "o" (buffer-string))'))
      .toBe('"hi"');
    expect(evalStr('(prin1 "hi" (get-buffer-create "o")) (with-current-buffer "o" (buffer-string))'))
      .toBe('"\\"hi\\""');
  });

  it('auto-localizes variables made buffer-local', () => {
    expect(evalStr([
      '(setq x 1)',
      "(make-variable-buffer-local 'x)",
      '(with-current-buffer (get-buffer-create "b") (setq x 2))',
      "(list x (buffer-local-value 'x (get-buffer \"b\")))",
    ].join('\n'))).toBe('(1 2)');
  });

  it('compares distinct cyclic lists without recursing forever', () => {
    expect(evalStr('(let ((x (list 1)) (y (list 1))) (setcdr x x) (setcdr y y) (equal x y))'))
      .toBe('t');
  });

  it('guards plists and aggregate allocations', () => {
    const cycle = "(setq l (list 'a 'b)) (setcdr (cdr l) l) ";
    expect(() => evalStr(cycle + "(plist-get l 'zz)")).toThrow(/circular list/);
    expect(() => evalStr(cycle + "(plist-put l 'zz 1)")).toThrow(/circular list/);
    expect(() => evalStr('(dotimes (i 3) (make-vector 1000000 nil))'))
      .toThrow(/vector allocation limit/);
    expect(() => evalStr(`(kbd "${'a'.repeat(600)}")`)).toThrow(/too long/);
  });

  it('compares long proper lists without exhausting the JS stack', () => {
    expect(evalStr('(let ((a nil) (b nil)) (dotimes (i 5000) (setq a (cons i a) b (cons i b))) (equal a b))'))
      .toBe('t');
  });

  it('reports circular lists instead of hanging', () => {
    const cycle = '(setq l (list 1 2)) (setcdr (cdr l) l) ';
    expect(() => evalStr(cycle + '(apply #\'+ l)')).toThrow(/circular list/);
    expect(() => evalStr(cycle + '(member 9 l)')).toThrow(/circular list/);
    expect(() => evalStr(cycle + '(length l)')).toThrow(/circular list/);
  });

  it('returns nil from an empty lambda body', () => {
    expect(evalStr('(funcall (lambda ()))')).toBe('nil');
  });

  it('supports mark, set-mark, char-after, and char-before', () => {
    expect(evalStr('(insert "abc") (set-mark 2) (mark)')).toBe('2');
    expect(evalStr('(insert "abc") (goto-char 2) (char-after)')).toBe('98');
    expect(evalStr('(insert "abc") (goto-char 2) (char-before)')).toBe('97');
    expect(evalStr('(insert "abc") (goto-char 4) (char-after)')).toBe('nil');
  });

  it('restores the current buffer in save-excursion', () => {
    expect(evalStr('(save-excursion (set-buffer (get-buffer-create "b"))) (buffer-name)')).toBe('"*scratch*"');
  });

  it('dolist RESULT runs outside the element binding', () => {
    expect(evalStr("(setq x 99) (dolist (x '(1 2) x) 0)")).toBe('99');
  });

  it('defines keys, looks them up, and calls the command interactively', () => {
    const src = [
      '(defun hello () (interactive) (insert "hi"))',
      '(define-key global-map (kbd "C-c h") #\'hello)',
      '(call-interactively (lookup-key global-map (kbd "C-c h")))',
      '(buffer-string)',
    ].join('\n');
    expect(evalStr(src)).toBe('"hi"');
    expect(evalStr('(defun hello () (interactive)) (keymapp global-map)')).toBe('t');
  });

  it('message/princ/prin1 write to the output panel', () => {
    return runSession([
      '(message "hello %s" "world")',
      '(princ "a")',
      '(prin1 "b")',
      '(terpri)',
      '(print 7)',
    ].join('\n')).then(({ output }) => {
      expect(output).toContain('hello world');
      expect(output).toContain('a"b"');
      expect(output).toContain('7');
    });
  });
});

describe('session: stepping, breakpoints, reset, panels', () => {
  it('opens on a control-stack listing whose current row maps to line 1', async () => {
    const s = new ElispSession();
    await s.load('(defun f (x)\n  (+ x 1))\n(f 2)');
    const panels = s.state();
    expect(panels[0]).toMatchObject({ kind: 'listing', id: 'control' });
    const control = panels[0] as Extract<Panel, { kind: 'listing' }>;
    const current = control.rows.find((r) => r.current);
    expect(current?.line).toBe(1);
  });

  it('steps one reduction at a time and finishes', async () => {
    const s = new ElispSession();
    await s.load('(+ 1 2)');
    const first = await s.step();
    expect(first.ran).toBe(true);
    expect(first.result?.finished).toBe(false);
    let guard = 0;
    let res = first.result!;
    while (!res.finished && guard++ < 200) res = (await s.step()).result!;
    expect(res.finished).toBe(true);
    expect(res.steps).toBeGreaterThan(1);
  });

  it('stops before a breakpoint line and resumes past it', async () => {
    const s = new ElispSession();
    await s.load('(defun f (x)\n  (+ x 1))\n(f 2)');
    const paused = await s.run([3]);
    expect(paused.pausedAt).toBe(3);
    expect(paused.finished).toBe(false);
    // Run again with the breakpoint still set: execute past this visit
    expect((await s.run([3])).finished).toBe(true);
  });

  it('does not inch through nested forms on one breakpointed line', async () => {
    const s = new ElispSession();
    await s.load('(setq a 1)\n(list (setq b 2) (setq c 3))');
    const paused = await s.run([2]);
    expect(paused.pausedAt).toBe(2);
    const resumed = await s.run([2]);
    expect(resumed.finished).toBe(true);
    expect(resumed.steps).toBeGreaterThan(paused.steps);
  });

  it('pauses again when a loop revisits the breakpointed line', async () => {
    const s = new ElispSession();
    await s.load('(setq i 0)\n(while (< i 2)\n  (setq i (1+ i)))');
    const first = await s.run([3]);
    expect(first.pausedAt).toBe(3);
    const second = await s.run([3]);
    expect(second.pausedAt).toBe(3);
    expect(second.steps).toBeGreaterThan(first.steps);
    const end = await s.run([3]);
    expect(end.finished).toBe(true);
  });

  it('reset rebuilds a clean machine; sessions do not leak definitions', async () => {
    const s = new ElispSession();
    await s.load('(setq x 1) (defun f () x)');
    expect((await s.run()).finished).toBe(true);
    s.reset();
    expect(s.state()[0]).toMatchObject({ id: 'control' });
    const again = await s.run();
    expect(again.finished).toBe(true);

    const fresh = new ElispSession();
    await fresh.load('(f)');
    const res = await fresh.run();
    expect(res.error).toContain('void-function f');
  });

  it('renders buffer, symbols, hooks, keymaps, and output panels', async () => {
    const { panels } = await runSession([
      '(defvar launched 0)',
      '(defun hello () (interactive) (insert "hi"))',
      '(defun mark () (setq launched 1))',
      '(add-hook \'after-init-hook \'mark)',
      '(run-hooks \'after-init-hook)',
      '(define-key global-map (kbd "C-c h") #\'hello)',
      '(call-interactively (lookup-key global-map (kbd "C-c h")))',
      '(message "ready")',
    ].join('\n'));
    const ids = panels.map((p) => p.id);
    expect(ids).toContain('buffer');
    expect(ids).toContain('buffer-text');
    expect(ids).toContain('symbols');
    expect(ids).toContain('hooks');
    expect(ids).toContain('keymaps');
    const symbols = panel(panels, 'symbols') as Extract<Panel, { kind: 'listing' }>;
    const hello = symbols.rows.find((r) => r.text.startsWith('hello'));
    expect(hello?.text).toContain('fn #<command hello>');
    const hooks = panel(panels, 'hooks') as Extract<Panel, { kind: 'listing' }>;
    expect(hooks.rows[0]?.text).toContain('after-init-hook');
    const keys = panel(panels, 'keymaps') as Extract<Panel, { kind: 'listing' }>;
    expect(keys.rows[0]?.text).toContain('C-c h');
    const bufferText = panel(panels, 'buffer-text') as Extract<Panel, { kind: 'listing' }>;
    expect(bufferText.rows.some((r) => r.text.includes('hi'))).toBe(true);
  });

  it('reports reader errors with their line and does not load', async () => {
    const s = new ElispSession();
    const bad = await s.load('(defun f ()\n  (insert "x")');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.line).toBe(1);
  });

  it('rejects an empty program', async () => {
    const s = new ElispSession();
    const empty = await s.load('; only a comment\n');
    expect(empty.ok).toBe(false);
  });
});

describe('source line mapping and breakpoint semantics', () => {
  it('maps runtime errors to the innermost form line', () => {
    const m = machineFor('(+ 1\n   (/ 1 0))');
    m.run();
    expect(m.error).toContain('(line 2)');
  });

  it('maps top-level atom forms to their own source line', async () => {
    const s = new ElispSession();
    await s.load('(setq alpha 1)\n(+ alpha 1)\nalpha');
    const paused = await s.run([3]);
    expect(paused.pausedAt).toBe(3);
    const bad = new ElispSession();
    await bad.load('(setq a 1)\n\nmissing-var');
    expect((await bad.run()).error).toContain('(line 3)');
  });

  it('does not move point from line position queries', () => {
    expect(evalStr('(insert "abc\ndef\nghi") (goto-char 2) (list (line-end-position 2) (point) (line-beginning-position 3) (point))'))
      .toBe('(8 2 9 2)');
  });

  it('keeps narrowing bounds in step with edits', () => {
    expect(evalStr('(insert "abcdef") (narrow-to-region 2 5) (goto-char 3) (insert "Z") (list (point-min) (point-max) (buffer-string) (point))'))
      .toBe('(2 6 "bZcd" 4)');
    expect(evalStr('(insert "abcdef") (narrow-to-region 2 5) (delete-region 2 5) (list (point-min) (point-max) (buffer-string) (point))'))
      .toBe('(2 2 "" 2)');
    expect(evalStr('(insert "abcdef") (narrow-to-region 2 5) (erase-buffer) (list (point-min) (point-max) (buffer-string) (point))'))
      .toBe('(1 1 "" 1)');
  });

  it('shows the effective buffer-local value in the Symbols panel', async () => {
    const s = new ElispSession();
    await s.load('(setq v 0) (setq-local v 1) v');
    expect((await s.run()).finished).toBe(true);
    const symbols = s.state().find((p) => p.id === 'symbols') as Extract<Panel, { kind: 'listing' }>;
    expect(symbols.rows[0]?.text).toContain('value 1');
  });

  it('reports a step without a breakpoint pausedAt', async () => {
    const s = new ElispSession();
    await s.load('(+ 1 2)');
    const first = await s.step();
    expect(first.result?.pausedAt).toBeUndefined();
  });

  it('pauses before the breakpointed line, not after it', async () => {
    const s = new ElispSession();
    await s.load('(setq a 1)\n(setq b 2)');
    const res = await s.run([2]);
    expect(res.pausedAt).toBe(2);
    expect(res.steps).toBeGreaterThan(0);
    const panels = s.state();
    const control = panels[0] as Extract<Panel, { kind: 'listing' }>;
    expect(control.rows.find((r) => r.current)?.line).toBe(2);
  });

  it(':session resume() preserves runtime state, special vars, and buffers, and reset() clears them', async () => {
    const s = new ElispSession();
    await s.load(`;; -*- lexical-binding: t; -*-
(defvar dyn-x 10)
(defun get-dyn () dyn-x)
(insert "hello")`);
    expect((await s.run()).finished).toBe(true);

    const r = await s.resume(`(insert " world")
(list (let ((dyn-x 99)) (get-dyn)) (buffer-string))`);
    expect(r).toEqual({ ok: true, summary: 'resumed · 2 forms' });
    const run2 = await s.run();
    expect(run2.finished).toBe(true);
    expect(run2.exit).toBe('=> (99 "hello world")');

    s.reset();
    const afterReset = await s.run();
    expect(afterReset.finished).toBe(false);
    expect(afterReset.error).toContain('void-function get-dyn');
    s.dispose();
  });
});
