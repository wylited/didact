"""didact python kernel — engine-side helper, installed once per engine.

`src/toolkit.ts` embeds this file verbatim; the session installs it into the
interpreter's main namespace and calls exactly the `lw_*` functions in the
API section at the bottom. `test/toolkit.test.ts` executes this file against
a host CPython when one is available, so the executed-line counts, loop and
branch flow, snapshots, annotations and the failure story are asserted by
running real programs.

The x-ray, precisely
--------------------
The block is compiled ONCE, whole (`lw_compile`), and that compiled code
object is what runs: CPython's number for a line is the only opinion that
counts, so the trace table and the program can never disagree.

The trace table has one row per line the module frame can execute. A row
knows which top-level statement it belongs to, and its flow role when it is
a loop header, a loop body's last line, an `if` test or an `if` arm head.

A LINE hook (`sys.monitoring` where CPython has it — Pyodide's interpreter
does — else `sys.settrace`) counts rows. It counts only FILENAME's lines, so
function bodies and imports never perturb the counts, and it is removed at
every run end (`lw_stop`), failure included. Past TRACE_LIMIT it removes
itself and `lw_flow` reports `overflow`, so no count shown is ever a guess.

`run(watch=True)` is the whole run with the hook on; `run(watch=False)` runs
after the flow has been measured, so a long hot loop is not slowed. The
session calls the fallback only when the first pass left the block's last
statement unexecuted (a budgeted infinite loop): the second pass is the one
that must finish, and it is not watched.

Stepping: with `sys.monitoring` present the session's own `sys.settrace`
function receives a `call` event for every module code object, and the
runner pauses before top-level statements. Without it, statements still run
one at a time (`run_one`), just never *between* statements inside one —
CPython has no such point, and this kernel does not pretend otherwise.

Every entry point returns a JSON string or a plain scalar, so nothing but
strings and numbers cross the WASM boundary.
"""

import ast, json, sys

FILENAME = 'lesson.py'
TRACE_LIMIT = 200000
# Per-run copy: set by lw_compile so a caller (or a test) can tune the budget
# without the hot path reading a name it might not see.
TRACE_LIMIT_FOR_RUN = TRACE_LIMIT


# ════════════════════════════════════════════════════════════════════════════
# run state
# ════════════════════════════════════════════════════════════════════════════

class _LWRow:
    """One line the block's module frame can execute."""

    __slots__ = ('index', 'line', 'stmt', 'hits', 'outer', 'end', 'loop',
                 'head', 'gate', 'tail', 'branch', 'then', 'else_', 'name')

    def __init__(self, line):
        self.index = 0
        self.line = line
        self.stmt = 0          # 1-based top-level statement number
        self.hits = 0
        self.outer = False     # first line of a top-level statement
        self.end = line        # that statement's last line
        self.loop = None       # the loop statement's first line
        self.head = False      # a loop header (one event per test)
        self.gate = False      # a `while` test line (re-read per iteration)
        self.tail = False      # a loop body's last line (re-read per pass)
        self.branch = None     # the `if` statement's first line
        self.then = False      # first line of the taken arm
        self.else_ = False     # first line of the other arm
        self.name = ''         # a def/class name

    def meta(self):
        out = {}
        if self.outer:
            out['outer'] = True
            out['end'] = self.end
        if self.loop is not None:
            out['loop'] = self.loop
            if self.head:
                out['head'] = True
            if self.gate:
                out['gate'] = True
            if self.tail:
                out['tail'] = True
        if self.branch is not None:
            out['branch'] = self.branch
            if self.then:
                out['then'] = True
            if self.else_:
                out['else'] = True
        if self.name:
            out['name'] = self.name
        return out


class _LWState:
    def __init__(self):
        self.src = ''
        self.code = None
        self.tree = None
        self.rows = []
        self.watch = {}
        self.hits = 0
        self.overflow = False
        self.installed = False
        self.tool = None
        self.traceback = []
        self.traceback_text = ''
        self.error = None
        self.locals_data = {}
        self.calls = {}


_S = _LWState()
_MON = getattr(sys, 'monitoring', None)


def _lw_reset():
    global _S
    calls = _S.calls
    _S = _LWState()
    _S.calls = calls
    return _S


# ════════════════════════════════════════════════════════════════════════════
# the splitter (kept for the session's per-statement stepping) and the table
# ════════════════════════════════════════════════════════════════════════════

def _lw_split(tree, lines):
    """[[text, first, last, node first line], …] per top-level statement.

    `text` is layout-stable: the first line's indent removed, the rest
    verbatim, so `textwrap.dedent(text)` compiles back to the same statement.
    """
    out = []
    for node in tree.body:
        first = node.lineno
        for deco in getattr(node, 'decorator_list', ()) or ():
            first = min(first, deco.lineno)
        last = node.end_lineno or first
        block = lines[first - 1:last]
        text = '\n'.join([block[0].lstrip()] + block[1:])
        out.append([text, first, last, node.lineno])
    return out


def _lw_head(node):
    body = getattr(node, 'body', None)
    if isinstance(body, list) and body and isinstance(body[0], ast.stmt):
        return body[0].lineno
    return (node.end_lineno or node.lineno) + 1


def _lw_loop_tail(loop, rows):
    """Mark the loop body's last line: re-read once per iteration."""
    if not loop.body:
        return
    tail = rows.get(loop.body[-1].lineno)
    if tail is None:
        return
    tail.loop = loop.lineno
    tail.tail = True
    if isinstance(loop, ast.While):
        tail.gate = True


def _lw_roles(node, row):
    """Flow role of a line, from the statement or clause that sits on it."""
    kind = type(node).__name__
    if kind in ('For', 'AsyncFor', 'While'):
        row.loop = node.lineno
        head_end = node.lineno if kind == 'While' else node.iter.end_lineno
        if node.lineno <= row.line <= head_end:
            row.head = True
            row.gate = kind == 'While'
        if node.body:
            tail = node.body[-1].lineno
            if row.line == tail:
                row.tail = True
                row.loop = node.lineno
                if kind == 'While':
                    row.gate = True
    elif kind == 'If':
        head_end = _lw_head(node)
        if node.lineno < head_end and node.body and node.body[0].lineno != row.line:
            row.branch = node.lineno
        if node.body and node.body[0].lineno == row.line:
            row.branch = node.lineno
            row.then = True
        if node.orelse and node.orelse[0].lineno == row.line:
            row.branch = node.lineno
            row.else_ = True


def _lw_table(code, tree):
    """One row per line the module frame can execute, with flow roles."""
    rows = {}
    for _start, _end, line in code.co_lines():
        if line and line not in rows:
            rows[line] = _LWRow(line)
    for i, node in enumerate(tree.body):
        first = node.lineno
        for deco in getattr(node, 'decorator_list', ()) or ():
            first = min(first, deco.lineno)
        last = node.end_lineno or first
        for row in rows.values():
            if first <= row.line <= last:
                row.stmt = i + 1
        start = rows.get(first)
        if start is not None:
            start.outer = True
            start.end = last
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for ln in range(first, _lw_head(node)):
                if ln in rows:
                    rows[ln].name = node.name
            continue
        # headers/arms of every compound statement in this top-level one;
        # each node is processed exactly once, at its own line
        stack = [node]
        while stack:
            cur = stack.pop()
            ln = getattr(cur, 'lineno', None)
            if ln in rows:
                _lw_roles(cur, rows[ln])
            if isinstance(cur, (ast.For, ast.AsyncFor, ast.While)):
                _lw_loop_tail(cur, rows)
            for child in ast.iter_child_nodes(cur):
                stack.append(child)
        # branch roles, derived from each `if` node directly: the arm head is
        # the first line either arm executes
        for cur in ast.walk(node):
            if not isinstance(cur, ast.If):
                continue
            bid = cur.lineno
            if bid in rows:
                rows[bid].branch = bid
            if cur.body and cur.body[0].lineno in rows:
                rows[cur.body[0].lineno].branch = bid
                rows[cur.body[0].lineno].then = True
            if cur.orelse and cur.orelse[0].lineno in rows:
                rows[cur.orelse[0].lineno].branch = bid
                rows[cur.orelse[0].lineno].else_ = True
    return [rows[ln] for ln in sorted(rows)]


# ════════════════════════════════════════════════════════════════════════════
# the hook
# ════════════════════════════════════════════════════════════════════════════

def _lw_count(line):
    """The hot path: a table lookup, an increment, a budget check."""
    state = _S
    row = state.watch.get(line)
    if row is None:
        return
    row.hits += 1
    state.hits += 1
    if state.hits >= TRACE_LIMIT_FOR_RUN:
        state.overflow = True
        lw_stop()


def _lw_monitor(code, line):
    if code.co_filename == FILENAME:
        _lw_count(line)


def _lw_settrace(frame, event, arg):
    if event == 'line' and frame.f_code.co_filename == FILENAME:
        _lw_count(frame.f_lineno)
    return _lw_settrace


def _lw_tool():
    state = _S
    if state.tool is not None:
        return state.tool
    if _MON is None:
        return None
    for tool in (_MON.PROFILER_ID, _MON.COVERAGE_ID, _MON.OPTIMIZER_ID):
        try:
            _MON.use_tool_id(tool, 'didact')
            state.tool = tool
            return tool
        except ValueError:
            continue
    return None


# ════════════════════════════════════════════════════════════════════════════
# values: grouping data for the variables panel
# ════════════════════════════════════════════════════════════════════════════

REPR_LIMIT = 200


def _lw_repr(value):
    try:
        text = repr(value)
    except Exception:
        return '<unrepresentable>'
    return text if len(text) <= REPR_LIMIT else text[:REPR_LIMIT - 1] + '…'


def _lw_len(value):
    for kind in (str, bytes, bytearray, list, tuple, set, frozenset, dict, range):
        if isinstance(value, kind):
            try:
                return len(value)
            except Exception:
                return None
    return None


def _lw_group(value):
    import inspect, types
    if inspect.isclass(value):
        return 'class'
    if inspect.isroutine(value) or isinstance(value, (types.BuiltinFunctionType, types.MethodType)):
        return 'function'
    if isinstance(value, types.ModuleType):
        return 'module'
    if _lw_len(value) is not None:
        return 'collection'
    return 'scalar'


def _lw_type(value):
    return 'NoneType' if value is None else type(value).__name__


def _lw_describe(namespace, names=None):
    """{name: {group, type, repr, size}} — the variables panel's input."""
    out = {}
    for name, value in list(namespace.items()):
        if not isinstance(name, str) or name.startswith('_'):
            continue
        if names is not None and name not in names:
            continue
        out[name] = {
            'group': _lw_group(value),
            'type': _lw_type(value),
            'repr': _lw_repr(value),
            'size': _lw_len(value),
        }
    return out


# ════════════════════════════════════════════════════════════════════════════
# annotations: declared vs observed
# ════════════════════════════════════════════════════════════════════════════

def _lw_ann_name(node):
    """The source-level name of an annotation expression."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return '%s | %s' % (_lw_ann_name(node.left), _lw_ann_name(node.right))
    if isinstance(node, ast.Subscript):
        inner = node.slice
        if isinstance(inner, ast.Tuple):
            text = ', '.join(_lw_ann_name(e) for e in inner.elts)
        else:
            text = _lw_ann_name(inner)
        return '%s[%s]' % (_lw_ann_name(node.value), text)
    return ast.unparse(node)


def _lw_hint(node, namespace):
    """Resolve an annotation expression to an object, or None."""
    try:
        return eval(compile(ast.Expression(node), FILENAME, 'eval'), namespace)
    except Exception:
        return None


def _lw_checked(value, hint):
    """isinstance, loosened: Any/object accept anything, unions any arm."""
    import typing
    if hint is None or hint is typing.Any or hint is object:
        return True
    origin = typing.get_origin(hint)
    if origin is typing.Union:
        return any(_lw_checked(value, arm) for arm in typing.get_args(hint))
    if origin is not None:
        hint = origin
    try:
        return isinstance(value, hint)
    except TypeError:
        return True


def _lw_checked_named(type_name, hint):
    """Compare an observed runtime type name with a resolved annotation."""
    import typing
    if hint is None or hint is typing.Any or hint is object:
        return True
    if type_name == 'NoneType':
        return hint is type(None)
    if isinstance(hint, type):
        return hint.__name__ == type_name
    return True


# ════════════════════════════════════════════════════════════════════════════
# API — everything the session calls lives below; all of it returns data
# ════════════════════════════════════════════════════════════════════════════

def _lw_register_source(src):
    """Put the block's source in linecache under FILENAME.

    CPython prints a frame's source line only when the file is findable;
    the block is compiled from a string, so without this every traceback
    would show the frame and no code. Registering it also makes
    `inspect.getsource` and `traceback.print_exc()` work inside the block.
    """
    import linecache
    linecache.cache[FILENAME] = (len(src), None, src.splitlines(True), FILENAME)


def lw_compile(src):
    """Parse, table and compile the block once. Returns '1'."""
    state = _lw_reset()
    state.src = src
    _lw_register_source(src)
    state.code = compile(src, FILENAME, 'exec')
    state.tree = ast.parse(src, FILENAME)
    state.rows = _lw_table(state.code, state.tree)
    state.watch = {row.line: row for row in state.rows}
    global TRACE_LIMIT_FOR_RUN
    TRACE_LIMIT_FOR_RUN = TRACE_LIMIT
    return '1'


def lw_check(src):
    """CPython's syntax verdict, line number included: JSON or None."""
    try:
        compile(src, FILENAME, 'exec')
    except SyntaxError as e:
        return json.dumps([e.lineno or 1, '%s: %s' % (type(e).__name__, e.msg)])
    except ValueError as e:
        return json.dumps([0, 'ValueError: %s' % e])
    return None


def lw_split_json(src):
    """The same split for the session: [text, first, last, node].

    The session JSON-parses each row, so a statement's text round-trips
    through JSON exactly as Python wrote it."""
    out = [[s, first, last, node]
           for s, first, last, node in _lw_split(ast.parse(src, FILENAME), src.split('\n'))]
    return json.dumps(out, sort_keys=True)


def lw_split(src):
    """Top-level statements: [[text, first, last, node], …]."""
    return json.dumps(_lw_split(ast.parse(src, FILENAME), src.split('\n')), sort_keys=True)


def lw_start():
    """Install the LINE hook for one run: 'monitoring' or 'settrace'."""
    state = _S
    state.installed = True
    tool = _lw_tool()
    if tool is not None:
        _MON.register_callback(tool, _MON.events.LINE, _lw_monitor)
        _MON.set_events(tool, _MON.events.LINE)
        return 'monitoring'
    sys.settrace(_lw_settrace)
    return 'settrace'


def lw_stop():
    """Remove the hook. Called at every run end, failure, budget and reset."""
    state = _S
    state.installed = False
    if _MON is not None and state.tool is not None:
        _MON.register_callback(state.tool, _MON.events.LINE, None)
        _MON.set_events(state.tool, 0)
    try:
        sys.settrace(None)
    except Exception:
        pass
    return '1'


def lw_has_monitor():
    """'1' when a step point between statements exists (sys.monitoring)."""
    return '1' if _lw_tool() is not None else '0'


def lw_mode():
    """The hook mechanism this interpreter offers: 'monitoring' or 'settrace'."""
    return 'monitoring' if _lw_tool() is not None else 'settrace'


def lw_run(ns, watch=True):
    """Execute the compiled block in `ns`. Returns 'done'.

    `watch=False` runs without installing the hook: the block is already
    measured and a long loop must not pay Python per line.
    """
    state = _S
    state.done = 0
    if watch:
        lw_start()
    try:
        exec(state.code, ns)
    except SystemExit as exc:
        lw_stop()
        state.error = 'SystemExit: %s' % (exc.code if exc.code is not None else 0)
        state.traceback = []
        raise
    except BaseException as exc:
        lw_stop()
        lw_fail(exc)
        raise
    finally:
        state.done = 1
        if watch:
            lw_stop()
    return 'done'


def lw_run_one(ns, index):
    """Execute top-level statement `index` (0-based) alone in `ns`."""
    state = _S
    tree = state.tree
    if index < 0 or index >= len(tree.body):
        return '0'
    node = tree.body[index]
    piece = ast.Module(body=[node], type_ignores=[])
    ast.fix_missing_locations(piece)
    code = compile(piece, FILENAME, 'exec')
    exec(code, ns)
    return '1'


def lw_trace():
    """The trace table: [[line, stmt, hits, meta], …]."""
    return json.dumps([[r.line, r.stmt, r.hits, r.meta()] for r in _S.rows], sort_keys=True)


def lw_flow():
    """Loop trip counts and branch tallies: {hits, overflow, loops, branches}.

    A `for` body's last line is re-read once per iteration (to call
    next()); a `while` body's last line is re-read to re-test the guard. Both
    are observed directly, so the trip count is that line's hit count — no
    off-by-one guessing from the header.
    """
    state = _S
    loops = {}
    branches = {}
    for row in state.rows:
        if row.loop is not None:
            loops.setdefault(row.loop, 0)
            if row.tail:
                loops[row.loop] += row.hits
        if row.branch is not None and (row.then or row.else_):
            entry = branches.setdefault(row.branch, [0, 0])
            if row.then:
                entry[0] += row.hits
            if row.else_:
                entry[1] += row.hits
    out_loops = [[line, loops[line]] for line in sorted(loops)]
    out_branches = [[line, branches[line]] for line in sorted(branches)]
    return json.dumps({'hits': state.hits, 'overflow': state.overflow,
                       'loops': out_loops, 'branches': out_branches}, sort_keys=True)


def lw_snapshot(ns):
    """Grouped variable data for the block namespace."""
    return json.dumps(_lw_describe(ns), sort_keys=True)


def lw_frames():
    """The block's live module frames, outermost first: [[fn, line], …]."""
    out = []
    frame = sys._getframe(1)
    while frame is not None and len(out) < 64:
        if frame.f_code.co_filename == FILENAME:
            out.append([frame.f_code.co_name, frame.f_lineno])
        frame = frame.f_back
    out.reverse()
    return json.dumps(out)


def lw_fail(exc):
    """Record a failure: the traceback frames and the innermost locals."""
    state = _S
    state.error = '%s: %s' % (type(exc).__name__, exc)
    state.traceback = []
    deepest = None
    tb = exc.__traceback__
    while tb is not None:
        frame = tb.tb_frame
        if frame.f_code.co_filename == FILENAME:
            state.traceback.append([frame.f_code.co_name, tb.tb_lineno])
            deepest = frame
        tb = tb.tb_next
    import traceback
    # The console shows the lesson's own frames only: the engine's frames
    # (pyodide's exec wrapper, this helper) are noise. StackSummary adds
    # the source line through linecache.
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename == FILENAME]
    text = ''.join(['Traceback (most recent call last):\n',
                    *traceback.StackSummary.from_list(frames).format(),
                    *traceback.format_exception_only(type(exc), exc)])
    state.traceback_text = text
    if deepest is not None:
        state.locals_data = _lw_describe(deepest.f_locals)
    return json.dumps({'error': state.error, 'traceback': state.traceback}, sort_keys=True)


def lw_fail_exc():
    """The failure recorded by the last lw_run: {error, traceback} as JSON."""
    return lw_traceback()


def lw_traceback():
    """The recorded failure: {error, traceback: [[fn, line], …], text}."""
    return json.dumps({'error': _S.error, 'traceback': _S.traceback,
                       'text': _S.traceback_text}, sort_keys=True)


def lw_locals():
    """The failing frame's locals, as grouped variable data."""
    return json.dumps(_S.locals_data, sort_keys=True)


def lw_annotations(ns):
    """Declared vs observed types: [[label, declared, observed, ok], …]."""
    state = _S
    out = []
    if state.tree is None:
        return json.dumps(out)
    for node in state.tree.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            name = node.target.id
            if name not in ns:
                continue
            out.append([name, _lw_ann_name(node.annotation), _lw_type(ns[name]),
                        _lw_checked(ns[name], _lw_hint(node.annotation, ns))])
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = node.args
            params = args.posonlyargs + args.args + args.kwonlyargs
            hints = [(a.arg, a.annotation) for a in params if a.annotation is not None]
            if args.vararg is not None and args.vararg.annotation is not None:
                hints.append((args.vararg.arg, args.vararg.annotation))
            if args.kwarg is not None and args.kwarg.annotation is not None:
                hints.append((args.kwarg.arg, args.kwarg.annotation))
            seen = state.calls.get(node.name, {})
            params = [a.arg for a in args.posonlyargs + args.args]
            for index_, (param, ann) in enumerate(hints):
                # the first observed call is keyed by position (arg0, …); by
                # keyword too, because a call may name its argument
                key = param if param in seen else 'arg%d' % index_
                observed = seen.get(key, 'not called')
                ok = True if key not in seen else _lw_checked_named(seen[key], _lw_hint(ann, ns))
                out.append(['%s(%s)' % (node.name, param), _lw_ann_name(ann), observed, ok])
            if node.returns is not None:
                observed = seen.get('->', 'not returned')
                ok = True if '->' not in seen else _lw_checked_named(seen['->'], _lw_hint(node.returns, ns))
                out.append(['%s →' % node.name, _lw_ann_name(node.returns), observed, ok])
    return json.dumps(out, sort_keys=True)


def lw_record_call(name, args, kwargs):
    """Record the first call's argument types for one block function."""
    seen = _S.calls.setdefault(name, {})
    for i, value in enumerate(args):
        seen.setdefault('arg%d' % i, _lw_type(value))
    for key, value in kwargs.items():
        seen.setdefault(key, _lw_type(value))
    return '1'


def lw_record_return(name, value):
    """Record the first return type of one block function."""
    _S.calls.setdefault(name, {}).setdefault('->', _lw_type(value))
    return '1'


def lw_calls():
    """The first-call record per function: {name: {param: type name}}."""
    return json.dumps(_S.calls, sort_keys=True)
