// xray.ts — pure panel-building logic for the python kernel.
//
// Everything here takes plain data (the JSON payloads the Python helper
// returns) and produces `Panel[]` / strings. Nothing touches Pyodide, the
// DOM or globals, so `test/xray.test.ts` asserts every rule by construction
// on fixed inputs — the tests are honest unit tests of the render logic, and
// `test/toolkit.test.ts` separately checks the Python that feeds it.
//
// Contract reminder (packages/core/src/panel.ts): a `fields` row renders as
//   key (bold) … value (right, margin-left:auto) / sub (own line, 65%)
// with a 2px left rule when `changed`. Listing rows render addr · bytes ·
// text; `line` + `current` give the block runtime its editor decoration.

import type { Field, ListingRow, Panel } from './types';

// ─── the shapes the Python helper returns ──────────────────────────────────

/** The `meta` object of one `lw_trace()` row — the row's flow role. */
export interface TraceMeta {
  line: number;
  stmt: number;
  hits: number;
  end?: number;
  outer?: boolean;
  loop?: number;
  head?: boolean;
  gate?: boolean;
  tail?: boolean;
  branch?: number;
  then?: boolean;
  else?: boolean;
  name?: string;
}

/** The flat row the panel renders: the helper's [line, stmt, hits, meta]
 *  arrays folded into one object (see `flattenTrace`). */
export interface TraceRow extends TraceMeta {
  /** The line begins a top-level statement. */
  outer?: boolean;
  /** The loop statement this line belongs to. */
  loop?: number;
  head?: boolean;
  gate?: boolean;
  tail?: boolean;
  /** The `if` statement this line's arm belongs to. */
  branch?: number;
  then?: boolean;
  else?: boolean;
  /** A def/class name, for the row's tip. */
  name?: string;
}

/** `lw_snapshot()` / `lw_values()`: name → grouped variable data. */
export interface VarInfo {
  group: 'scalar' | 'collection' | 'class' | 'function' | 'module';
  type: string;
  repr: string;
  size: number | null;
}

/** `lw_flow()`: loop trip counts and branch tallies observed by the hook. */
export interface FlowData {
  hits: number;
  overflow: boolean;
  /** [loop line, iterations run]. */
  loops: [number, number][];
  /** [if line, [then count, else count]]. */
  branches: [number, [number, number]][];
}

/** `lw_annotations()`: [label, declared, observed, ok]. */
export type AnnotationRow = [string, string, string, boolean];

/** `lw_fail()`: the failure story. */
export interface FailureData {
  error: string;
  traceback: [string, number][];
  /** The formatted traceback (the lesson's frames only, source lines
   *  included) as the console prints it. */
  text?: string;
}

// ─── trace rendering ───────────────────────────────────────────────────────

const MAX_TRACE_ROWS = 400;

/**
 * `lw_trace()` returns parallel arrays per row — [line, stmt, hits, meta] —
 * which keeps the JSON compact; the panels want one flat object per row.
 * Rows are returned in the helper's order (source order).
 */
export function flattenTrace(raw: readonly (readonly [number, number, number, TraceMeta | null])[]): TraceRow[] {
  return raw.map(([line, stmt, hits, meta]) => ({
    ...(meta ?? {}),
    line,
    stmt,
    hits,
  }));
}

function rowTip(row: TraceRow): string {
  const parts: string[] = [];
  if (row.outer === true) {
    parts.push(row.name !== undefined && row.name !== ''
      ? `statement · defines ${row.name}`
      : 'top-level statement');
  }
  if (row.loop !== undefined) {
    if (row.gate === true) parts.push(`loop test at line ${row.loop}`);
    if (row.head === true) parts.push(`loop header · one hit per iteration of the loop at line ${row.loop}`);
    if (row.tail === true) parts.push(`loop body's last line · one hit per pass through the loop at line ${row.loop}`);
  }
  if (row.branch !== undefined) {
    if (row.then === true) parts.push(`then-arm of the if at line ${row.branch}`);
    if (row.else === true) parts.push(`else-arm of the if at line ${row.branch}`);
  }
  return parts.join(' · ');
}

/**
 * The "Flow" summary, as one human sentence per fact (the panel's bytes
 * column stays free). Deterministic: loops and branches are listed in line
 * order, counts are integers.
 */
export function flowSummary(flow: FlowData): string {
  if (flow.hits === 0) return 'no lines executed';
  const parts: string[] = [`${flow.hits} line${flow.hits === 1 ? '' : 's'} executed`];
  for (const [line, trips] of flow.loops) {
    parts.push(`loop at line ${line}: ${trips} iteration${trips === 1 ? '' : 's'}`);
  }
  for (const [line, arms] of flow.branches) {
    parts.push(`if at line ${line}: then ${arms[0]}×, else ${arms[1]}×`);
  }
  if (flow.overflow) parts.push('trace stopped at the record budget');
  return parts.join(' · ');
}

/** The trace table plus the flow summary, as one `html` panel section. */
export function traceHtml(
  rows: readonly TraceRow[],
  source: readonly string[],
  flow: FlowData,
  opts: { current?: number; failureLine?: number; failure?: FailureData | null } = {},
): string {
  const failure = opts.failure ?? null;
  const esc = escapeHtml;
  const body: string[] = [];
  body.push(`<div class="py-flow">${esc(flowSummary(flow))}</div>`);
  body.push('<table class="py-trace">');
  let shown = 0;
  for (const row of rows) {
    if (shown >= MAX_TRACE_ROWS) {
      body.push(`<tr><td colspan="3" class="py-more">… ${rows.length - shown} more lines</td></tr>`);
      break;
    }
    const cls: string[] = ['py-row'];
    if (row.hits === 0) cls.push('py-unhit');
    if (opts.failureLine === row.line) cls.push('py-failed');
    else if (opts.current === row.line) cls.push('py-current');
    if (row.outer === true) cls.push('py-outer');
    const hits = row.hits === 0 ? '·' : String(row.hits);
    const text = esc(source[row.line - 1] ?? '');
    const tip = rowTip(row);
    const tipAttr = tip === '' ? '' : ` data-tip="${esc(tip)}"`;
    body.push(
      `<tr class="${cls.join(' ')}" data-line="${row.line}" data-hits="${row.hits}"${tipAttr}>` +
      `<td class="py-num">${row.line}</td>` +
      `<td class="py-hits">${hits}</td>` +
      `<td class="py-code">${text}</td>` +
      '</tr>',
    );
    shown++;
  }
  body.push('</table>');
  if (failure !== undefined && failure !== null) {
    body.push(`<div class="py-fail">${esc(failure.error)}</div>`);
  }
  return body.join('');
}

// ─── variables ─────────────────────────────────────────────────────────────

const GROUP_ORDER: readonly VarInfo['group'][] = [
  'scalar', 'collection', 'function', 'class', 'module',
];

const GROUP_LABEL: Record<VarInfo['group'], string> = {
  scalar: 'scalars',
  collection: 'collections',
  function: 'functions',
  class: 'classes',
  module: 'modules-imported',
};

/** Deterministic name order: Python's `sorted()` semantics (code units). */
export function orderedNames(names: readonly string[]): string[] {
  const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...names].sort(byCodeUnit);
}

/**
 * One `fields` row per variable. `value` = repr (the helper caps it at 200
 * chars with a single '…', and the full repr goes in `tip`); `sub` carries
 * the type and, for collections, the length and a short summary.
 */
export function varRow(
  name: string,
  info: VarInfo,
  baseline: ReadonlyMap<string, string>,
  full?: string,
): Field {
  // A row is marked when its repr differs from the baseline the caller
  // diffed against (the helper's previous snapshot; the empty namespace
  // before a block's first run — so a fresh block marks everything it
  // defines, and a re-run marks only what moved).
  const before = baseline === null ? undefined : baseline.get(name);
  const tipParts: string[] = [];
  if (full !== undefined && full !== info.repr) tipParts.push(full);
  tipParts.push(`${name} is a ${info.type}`);
  return {
    key: name,
    value: info.repr === '' ? '∅' : info.repr,
    sub: subText(info),
    changed: before !== info.repr,
    tip: tipParts.join(' — '),
  };
}

function subText(info: VarInfo): string {
  if (info.group === 'collection' && info.size !== null) {
    return `${info.type} · len ${info.size} · ${collectionSummary(info)}`;
  }
  return info.type;
}

/** Item noun for a collection type, singular and plural. */
function itemNoun(type: string): [string, string] {
  switch (type) {
    case 'dict': return ['key', 'keys'];
    case 'str': return ['char', 'chars'];
    case 'bytes':
    case 'bytearray': return ['byte', 'bytes'];
    default: return ['item', 'items'];
  }
}

function collectionSummary(info: VarInfo): string {
  const n = info.size ?? 0;
  const [one, many] = itemNoun(info.type);
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** Rows grouped in panel order: group label rows first, then its members. */
export function groupedFields(
  vars: ReadonlyMap<string, VarInfo>,
  prev: ReadonlyMap<string, string> | null,
  opts: { limit?: number; full?: ReadonlyMap<string, string> } = {},
): Field[] {
  const limit = opts.limit ?? 200;
  // `null` means "the block has not run yet": the empty namespace is the
  // baseline, so everything the first snapshot holds reads as its result.
  const baseline: ReadonlyMap<string, string> = prev ?? new Map();
  const rows: Field[] = [];
  const names = orderedNames([...vars.keys()]);
  let count = 0;
  for (const group of GROUP_ORDER) {
    const members = names.filter((n) => vars.get(n)!.group === group);
    if (members.length === 0) continue;
    rows.push({
      key: `${GROUP_LABEL[group]} · ${members.length}`,
      value: '',
      sub: '',
      changed: false,
      tip: '',
    });
    for (const name of members) {
      if (count >= limit) {
        rows.push({ key: `… ${names.length - count} more names`, value: '', sub: '', changed: false });
        return rows;
      }
      rows.push(varRow(name, vars.get(name)!, baseline, opts.full?.get(name)));
      count++;
    }
  }
  return rows;
}

// ─── failures ──────────────────────────────────────────────────────────────

/** The traceback as listing rows, innermost frame marked current. */
export function tracebackRows(failure: FailureData): ListingRow[] {
  return failure.traceback.map(([fn, line], i) => ({
    addr: line,
    bytes: fn,
    text: `${fn === '<module>' ? 'the block' : fn + '()'} at line ${line}`,
    line,
    current: i === failure.traceback.length - 1,
  }));
}

// ─── annotations ───────────────────────────────────────────────────────────

/** One row per declared annotation: declared vs observed, mismatches marked. */
export function annotationFields(rows: readonly AnnotationRow[]): Field[] {
  return sortAnnotationRows(rows).map(([label, declared, observed, ok]) => ({
    key: label,
    value: `${declared} → ${observed}`,
    sub: ok ? 'observed matches' : 'observed type does not match the annotation',
    changed: !ok,
    tip: ok
      ? `${label} is annotated ${declared}; every observed value had that type`
      : `${label} is annotated ${declared} but ${observed} was seen — annotations are not enforced at run time`,
  }));
}

function sortAnnotationRows(rows: readonly AnnotationRow[]): AnnotationRow[] {
  return [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ─── panel assembly ────────────────────────────────────────────────────────

/** What a run or step has done so far — the progress heartbeat. */
export interface Progress {
  /** 1-based, inclusive range of the statement that just ran. */
  from: number;
  to: number;
  /** Statements finished so far, and how many the block has. */
  done: number;
  total: number;
  /** True while the run is still going (live snapshots). */
  live: boolean;
}

export interface XrayData {
  source: readonly string[];
  trace: readonly TraceRow[] | null;
  flow: FlowData | null;
  vars: ReadonlyMap<string, VarInfo>;
  prevVars: ReadonlyMap<string, string> | null;
  frames: readonly [string, number][];
  failure: FailureData | null;
  locals: ReadonlyMap<string, VarInfo>;
  annotations: readonly AnnotationRow[];
  console: string;
  running: boolean;
  /** Present while a run/step stream is reporting; null at rest. */
  progress?: Progress | null;
  /** The trace-hook mechanism the engine used ('monitoring' | 'settrace'). */
  hook?: string | null;
}

/** The whole under-the-hood snapshot, in reading order. */
export function buildPanels(d: XrayData): Panel[] {
  const panels: Panel[] = [];
  if (d.progress !== null && d.progress !== undefined) {
    panels.push(progressPanel(d.progress));
  }
  const current = d.failure !== null
    ? d.failure.traceback[d.failure.traceback.length - 1]?.[1]
    : undefined;
  if (d.trace !== null && d.flow !== null) {
    panels.push({
      kind: 'html',
      id: 'py-trace',
      title: 'Trace · executed lines',
      tip: 'One row per source line, in order; the middle column counts executions. Rows never reached show ·.',
      html: traceHtml(d.trace, d.source, d.flow, {
        current,
        failureLine: d.failure !== null ? current : undefined,
        failure: d.failure,
      }),
    });
  }
  if (d.frames.length > 0) {
    panels.push({
      kind: 'listing',
      id: 'py-stack',
      title: 'Call stack',
      tip: 'Frames of the block\'s module — innermost last',
      rows: d.frames.map(([fn, line], i) => ({
        addr: i,
        bytes: '',
        text: `${fn === '<module>' ? 'module (top level)' : fn} · line ${line}`,
        line,
        current: i === d.frames.length - 1,
      })),
    });
  }
  if (d.failure !== null && d.failure.traceback.length > 0) {
    panels.push({
      kind: 'listing',
      id: 'py-traceback',
      title: 'Traceback',
      tip: d.failure.error,
      rows: tracebackRows(d.failure),
    });
  }
  if (d.vars.size > 0) {
    panels.push({
      kind: 'fields',
      id: 'py-vars',
      title: 'Variables · grouped',
      tip: 'The block namespace, grouped; a marked row changed since the last snapshot.',
      fields: groupedFields(d.vars, d.prevVars),
    });
  }
  if (d.locals.size > 0) {
    panels.push({
      kind: 'fields',
      id: 'py-locals',
      title: 'Locals · failing frame',
      tip: 'The innermost frame\'s locals at the moment of the exception',
      fields: groupedFields(d.locals, null),
    });
  }
  if (d.annotations.length > 0) {
    panels.push({
      kind: 'fields',
      id: 'py-annotations',
      title: 'Types · declared vs observed',
      tip: 'Annotations are hints: the observed column is what the run actually used.',
      fields: annotationFields(d.annotations),
    });
  }
  panels.push({
    kind: 'console',
    id: 'py-console',
    title: 'Console · stdout + stderr',
    text: d.console,
  });
  return panels;
}

/**
 * The heartbeat: which statements the run has covered, and how far along the
 * block it is. A fields panel rather than a second console — the console is
 * the program's own output and must stay copyable verbatim.
 */
export function progressPanel(p: Progress): Panel {
  const percent = p.total === 0 ? 100 : Math.round((p.done / p.total) * 100);
  const where = p.from === p.to ? `line ${p.from}` : `lines ${p.from}–${p.to}`;
  return {
    kind: 'fields',
    id: 'py-progress',
    title: p.live ? 'Progress · running' : 'Progress · last run',
    tip: 'Top-level statements the run covered; the trace below says how often each line ran.',
    fields: [
      {
        key: 'statements',
        value: `${Math.min(p.done, p.total)}/${p.total}`,
        sub: `${percent}% · ${where}`,
        changed: p.live,
      },
    ],
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Split a source into its lines exactly as Python counts them. */
export function sourceLines(src: string): string[] {
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => l.replace(/\r$/, ''));
}
