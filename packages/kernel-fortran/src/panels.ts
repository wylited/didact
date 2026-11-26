// panels.ts — the under-the-hood story for a Fortran block:
//   Workspace — every main-program variable with its declared type/shape;
//   Modules   — module variables (shared, saved across calls);
//   Arrays    — the most recently written array, one row per ELEMENT in
//               column-major order, with its flat address (the layout
//               lesson: column 1 first, then column 2);
//   Loops     — the innermost DO loop's variable, bounds and pass count;
//   Call stack— program frame plus one row per active procedure;
//   Console   — PRINT/WRITE output.

import type { Interpreter } from './interp';
import { extent, preview, subsAt, typeLabel, type ArrayV } from './value';
import type { Field, ListingRow, Panel } from './types';

const MAX_PANEL_ROWS = 64;

export function workspacePanel(interp: Interpreter, prev: Map<string, string>): Panel {
  const fields: Field[] = [];
  for (const entry of interp.workspaceEntries()) {
    const text = preview(entry.value);
    fields.push({
      key: entry.name,
      value: text,
      sub: typeLabel(entry.value),
      changed: prev.get(entry.name) !== text,
      tip: `${entry.name} is ${typeLabel(entry.value)}${entry.info.implicit ? ' (implicit typing)' : ''}`,
    });
  }
  return {
    kind: 'fields',
    id: 'workspace',
    title: 'Workspace',
    fields,
    tip: 'main-program variables — arrays are one flat column-major buffer, which the Arrays panel shows element by element',
  };
}

export function modulesPanel(interp: Interpreter): Panel | null {
  const entries = interp.moduleEntries();
  if (entries.length === 0) return null;
  const fields: Field[] = entries.map((entry) => ({
    key: `${entry.module}%${entry.name}`,
    value: preview(entry.value),
    sub: typeLabel(entry.value),
    tip: `module variable ${entry.module}%${entry.name} — one copy, saved for the life of the session`,
  }));
  return {
    kind: 'fields',
    id: 'modules',
    title: 'Modules',
    fields,
    tip: 'module variables are shared by every procedure that USEs the module',
  };
}

export function arraysPanel(interp: Interpreter): Panel {
  const write = interp.lastWrite;
  const rows: ListingRow[] = [];
  if (write === null) {
    rows.push({
      addr: 0,
      bytes: '',
      text: 'no array written yet',
      current: true,
      tip: 'assign an array (a = [1, 2, 3]) to see its column-major memory layout',
    });
    return { kind: 'listing', id: 'arrays', title: 'Arrays', rows };
  }
  const entry = interp.valueByName(write.name);
  if (entry === undefined || entry.k !== 'array') {
    rows.push({ addr: 0, bytes: '', text: `${write.name} is no longer an array`, line: write.line });
    return { kind: 'listing', id: 'arrays', title: 'Arrays', rows };
  }
  const arr = entry as ArrayV;
  if (!arr.allocated) {
    rows.push({
      addr: 0, bytes: '', text: `${write.name} is unallocated`, line: write.line,
      current: true, tip: 'an ALLOCATABLE array stores nothing until ALLOCATE gives it bounds',
    });
    return { kind: 'listing', id: 'arrays', title: 'Arrays', rows };
  }
  if (arr.data.length === 0) {
    rows.push({
      addr: 0, bytes: '', text: `${write.name} is empty (${arr.dims.map(extent).join('x')})`,
      line: write.line, current: true,
    });
    return { kind: 'listing', id: 'arrays', title: 'Arrays', rows };
  }
  const touched = write.addrs === null ? null : new Set(write.addrs);
  let shown = 0;
  for (let k = 0; k < arr.data.length && shown < MAX_PANEL_ROWS; k++) {
    const subs = subsAt(arr.dims, k);
    const elem = arr.data[k]!;
    const value = elem.k === 'character' ? `'${elem.v}'` : preview(elem);
    rows.push({
      addr: k,
      bytes: '',
      text: `${write.name}(${subs.join(',')}) = ${value}`,
      line: write.line,
      current: touched === null || touched.has(k),
      tip: `${write.name}(${subs.join(',')}) sits at flat offset ${k} — column-major: the first subscript runs fastest`,
    });
    shown++;
  }
  if (shown < arr.data.length) {
    rows.push({
      addr: shown,
      bytes: '',
      text: `… ${arr.data.length - shown} more elements`,
      tip: `the panel shows the first ${MAX_PANEL_ROWS} of ${arr.data.length} elements, always column-major`,
    });
  }
  return {
    kind: 'listing',
    id: 'arrays',
    title: 'Arrays',
    rows,
    tip: `${write.name} is ${arr.dims.map(extent).join('x')} (${arr.data.length} elements), column-major: A(1,1), A(2,1), … then column 2`,
  };
}

export function loopsPanel(interp: Interpreter): Panel {
  const loop = interp.loop;
  if (loop === null) {
    return {
      kind: 'fields',
      id: 'loops',
      title: 'Loops',
      fields: [{ key: 'loop', value: 'none', tip: 'the statement is not inside a DO loop' }],
      tip: 'inside a DO loop this panel names the variable, bounds, stride and pass count',
    };
  }
  const fields: Field[] = [];
  if (loop.kind === 'do') {
    fields.push({ key: 'loop variable', value: loop.varName ?? '?', tip: `DO variable (line ${loop.line})` });
    fields.push({
      key: 'iteration',
      value: `${loop.iter} of ${loop.total ?? '?'}`,
      changed: true,
      tip: 'how many times the body has started — it advances once per pass',
    });
    fields.push({
      key: 'bounds',
      value: `${loop.start}:${loop.end}:${loop.step}`,
      tip: 'start:end:stride, evaluated once before the first pass',
    });
  } else {
    fields.push({
      key: 'loop',
      value: `DO WHILE · pass ${loop.iter}`,
      changed: true,
      tip: `the condition is re-tested before every pass (line ${loop.line})`,
    });
  }
  return {
    kind: 'fields',
    id: 'loops',
    title: 'Loops',
    fields,
    tip: 'Fortran evaluates the bounds once; the iteration count is computed before the first pass',
  };
}

export function stackPanel(interp: Interpreter): Panel {
  const rows: ListingRow[] = interp.frames.map((frame, i) => {
    const locals = [...frame.scope.vars.keys()].join(', ');
    return {
      addr: i,
      bytes: '',
      text: `${i === 0 ? 'program' : frame.name}${frame.scope.kind === 'module' ? ' · module' : ''} · ${locals === '' ? '(no locals)' : locals}`,
      line: frame.line,
      current: i === interp.frames.length - 1,
      tip: i === 0
        ? 'the main program: its variables are the Workspace panel'
        : `${frame.name}'s locals; host association lets an internal procedure read and write its host's variables`,
    };
  });
  return {
    kind: 'listing',
    id: 'stack',
    title: 'Call stack',
    rows,
    tip: 'one row per active program unit; the last row is where execution is now',
  };
}
