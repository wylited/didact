// terms.ts — the term ontology, unification with occurs check, trails,
// and rendering. Terms are immutable trees; variables are numbered cells
// in a single substitution array owned by the engine's Ctx (see engine.ts).
// A `trail` records every binding so backtracking is a pure undo.

export type Term =
  | { t: 'int'; n: number }
  | { t: 'atom'; name: string }
  | { t: 'var'; id: number; name: string }
  | { t: 'str'; name: string; args: Term[] };

/** 1-based-source-line error; every runtime failure carries one. */
export class PrologError extends Error {
  readonly line?: number;
  constructor(message: string, line?: number) {
    super(message);
    this.line = line;
  }
}

/** The empty list is the atom '[]'; non-empty lists are '.'/2 compounds. */
export const NIL: Term = { t: 'atom', name: '[]' };

export function listOf(terms: Term[]): Term {
  let out = NIL;
  for (let i = terms.length - 1; i >= 0; i--) out = { t: 'str', name: '.', args: [terms[i]!, out] };
  return out;
}

/** Substitution state shared by a query run (and nested findall searches). */
export interface Ctx {
  bindings: (Term | null)[];
  trail: { id: number; prev: Term | null }[];
  nextVar: number;
  steps: number;
  budget: number;
}

export function newCtx(budget: number): Ctx {
  return { bindings: [], trail: [], nextVar: 0, steps: 0, budget };
}

export function deref(t: Term, ctx: Ctx): Term {
  let cur = t;
  while (cur.t === 'var') {
    const b = ctx.bindings[cur.id];
    if (b === undefined || b === null) return cur;
    cur = b;
  }
  return cur;
}

export function bind(v: { t: 'var'; id: number; name: string }, to: Term, ctx: Ctx): void {
  ctx.trail.push({ id: v.id, prev: ctx.bindings[v.id] ?? null });
  ctx.bindings[v.id] = to;
}

export function undoTo(len: number, ctx: Ctx): void {
  while (ctx.trail.length > len) {
    const e = ctx.trail.pop()!;
    ctx.bindings[e.id] = e.prev;
  }
}

/** Does `t` mention variable `id`? (occurs check) */
export function occursIn(id: number, t: Term, ctx: Ctx): boolean {
  const d = deref(t, ctx);
  if (d.t === 'var') return d.id === id;
  if (d.t === 'str') return d.args.some((a) => occursIn(id, a, ctx));
  return false;
}

/**
 * Unify with occurs check. On success, bindings are recorded on the trail
 * (caller decides whether to keep or undo them). Unifying a variable with
 * a term that mentions it is the /infinite term/ case: the kernel refuses
 * it with a thrown, line-mapped PrologError instead of looping forever —
 * the lesson teaches exactly this.
 */
export function unify(a: Term, b: Term, ctx: Ctx): boolean {
  const x = deref(a, ctx);
  const y = deref(b, ctx);
  if (x.t === 'var') {
    if (y.t === 'var' && y.id === x.id) return true;
    if (occursIn(x.id, y, ctx)) throw new PrologError(`infinite term (occurs check): ${renderTerm(x)} = ${renderTerm(y)}`);
    bind(x, y, ctx);
    return true;
  }
  if (y.t === 'var') {
    if (occursIn(y.id, x, ctx)) throw new PrologError(`infinite term (occurs check): ${renderTerm(x)} = ${renderTerm(y)}`);
    bind(y, x, ctx);
    return true;
  }
  if (x.t === 'int' && y.t === 'int') return x.n === y.n;
  if (x.t === 'atom' && y.t === 'atom') return x.name === y.name;
  if (x.t === 'str' && y.t === 'str') {
    if (x.name !== y.name || x.args.length !== y.args.length) return false;
    const mark = ctx.trail.length;
    for (let i = 0; i < x.args.length; i++) {
      if (!unify(x.args[i]!, y.args[i]!, ctx)) {
        undoTo(mark, ctx);
        return false;
      }
    }
    return true;
  }
  return false;
}

/** Deep copy with every binding applied — a solution's ground view. */
export function reify(t: Term, ctx: Ctx): Term {
  const d = deref(t, ctx);
  if (d.t === 'str') return { t: 'str', name: d.name, args: d.args.map((a) => reify(a, ctx)) };
  return d;
}

export function freshVar(ctx: Ctx, name: string): Term {
  const id = ctx.nextVar++;
  ctx.bindings[id] = null;
  return { t: 'var', id, name };
}

/** Rename every clause variable to a fresh cell (standardisation apart). */
export function renameClause(head: Term, body: Term[], ctx: Ctx, map: Map<number, Term>): { head: Term; body: Term[] } {
  const rw = (t: Term): Term => {
    if (t.t === 'var') {
      let v = map.get(t.id);
      if (v === undefined) {
        v = freshVar(ctx, t.name);
        map.set(t.id, v);
      }
      return v;
    }
    if (t.t === 'str') return { t: 'str', name: t.name, args: t.args.map(rw) };
    return t;
  };
  return { head: rw(head), body: body.map(rw) };
}

// ─── rendering ──────────────────────────────────────────────────────────────

const INFIX: Record<string, true> = {
  '=': true, '\\=': true, '==': true, '\\==': true, 'is': true,
  '<': true, '>': true, '=<': true, '>=': true, '=:=': true, '=\\=': true,
  '+': true, '-': true, '*': true, '//': true, 'mod': true, ',': true, ';': true,
}

export function renderTerm(t: Term): string {
  if (t.t === 'int') return String(t.n);
  if (t.t === 'atom') return t.name;
  if (t.t === 'var') return t.name === '_' || t.name === '' ? `_G${t.id}` : t.name;
  // '.'/2 chains print as lists.
  if (t.name === '.' && t.args.length === 2) {
    const items: string[] = [];
    let cur: Term = t;
    while (cur.t === 'str' && cur.name === '.' && cur.args.length === 2) {
      items.push(renderTerm(cur.args[0]!));
      cur = cur.args[1]!;
    }
    if (cur.t === 'atom' && cur.name === '[]') return `[${items.join(', ')}]`;
    return `[${items.join(', ')} | ${renderTerm(cur)}]`;
  }
  if (t.args.length === 2 && INFIX[t.name] === true) return `${renderTerm(t.args[0]!)} ${t.name} ${renderTerm(t.args[1]!)}`;
  if (t.args.length === 0) return t.name;
  return `${t.name}(${t.args.map(renderTerm).join(', ')})`;
}

/** Render a term with the current substitution applied. */
export function renderResolved(t: Term, ctx: Ctx): string {
  return renderTerm(reify(t, ctx));
}

export function predOf(t: Term): string {
  if (t.t === 'atom') return `${t.name}/0`;
  if (t.t === 'str') return `${t.name}/${t.args.length}`;
  return '(_)/0'; // a bare variable goal — the engine reports it cleanly
}
