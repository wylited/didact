// columns-panel.ts — the Columns panel: why a `for` loop's variable holds a
// whole column, and which column this statement is on. MATLAB truth is
// that `for v = M` walks M's COLUMNS, not its elements — the panel says
// so in words, both addresses agree (that is the lesson), and each time
// through the loop the iteration counter moves. Pure data in, Panel out.

import type { LoopState } from './interp';
import type { Field, Panel } from './types';

/** MAT's row count is what makes address and linear index diverge. */
export interface ColumnsInput {
  /** Innermost live loop, or null at top level. */
  loop: LoopState | null;
  /** Shape of the matrix the loop walks (`for v = M`), when known. */
  walked: { name: string | null; rows: number; cols: number } | null;
}

/** MATLAB's for-loop truth, in one sentence. */
export const COLUMN_TRUTH =
  'for v = M runs once per COLUMN of M: v is rows(M) x 1, so A(i) also walks down column 1 first';

/** "column 2 of M(3x2) starts at A(4)" — the one-sentence lesson. */
export function columnNote(loop: LoopState, walked: { name: string | null; rows: number; cols: number }): string {
  const first = (loop.iter - 1) * walked.rows + 1;
  const shape = walked.name === null ? `${walked.rows}x${walked.cols}` : `${walked.name} (${walked.rows}x${walked.cols})`;
  return `column ${loop.iter} of ${shape} is element A(${first}) onward — ${first - 1} elements of column-major memory sit before it`;
}

export function columnsPanel(input: ColumnsInput): Panel {
  const { loop, walked } = input;
  if (loop === null) {
    return {
      kind: 'fields',
      id: 'columns',
      title: 'Columns',
      tip: 'No loop is running. Inside a for loop this panel names the column the body is on.',
      fields: [{
        key: 'loop',
        value: 'none',
        tip: 'the statement is at top level — no for/while iteration is in progress',
      }],
    };
  }

  const fields: Field[] = [];
  if (loop.kind === 'for') {
    const total = loop.total === null ? '?' : String(loop.total);
    fields.push({
      key: 'loop variable',
      value: loop.over,
      tip: `the iterator of the innermost for loop (line ${loop.line})`,
    });
    fields.push({
      key: 'column',
      value: `${loop.iter} of ${total}`,
      changed: true,
      tip: 'which column of the walked matrix is bound to the loop variable — it advances once per pass',
    });
  } else {
    fields.push({
      key: 'loop',
      value: `while · pass ${loop.iter}`,
      changed: true,
      tip: `a while loop has no iterator to bind; the count is how many times the condition has been tested (line ${loop.line})`,
    });
  }

  if (walked !== null) {
    fields.push({
      key: 'walked matrix',
      value: walked.name === null ? `${walked.rows}x${walked.cols}` : `${walked.name} · ${walked.rows}x${walked.cols}`,
      tip: `the matrix this loop walks — its first column is elements 1..${walked.rows} in linear order`,
    });
    if (walked.cols > 1) {
      const first = (loop.iter - 1) * walked.rows + 1; // 1-based linear index
      fields.push({
        key: 'column start',
        value: `A(${(loop.iter - 1) * walked.rows + 1})`,
        sub: `addr ${first - 1} · (col-1)*rows + row - 1`,
        tip: columnNote(loop, walked),
      });
    }
  }

  return {
    kind: 'fields',
    id: 'columns',
    title: 'Columns',
    tip: `${COLUMN_TRUTH}. The Matrices panel shows the same matrix one element at a time, in this order.`,
    fields,
  };
}

/** The panel's primary teaching line: the loop's variable and where the
 *  column it binds starts in memory (null without a walked matrix). */
export function columnSummary(input: ColumnsInput): string {
  const { loop, walked } = input;
  if (loop === null || loop.kind !== 'for') return '';
  if (walked === null) return columnNote(loop, { name: null, rows: 0, cols: 0 }).split(' — ')[0]!;
  return columnNote(loop, walked);
}
