import type { Kernel } from './types';
import { SqlSession } from './session';

/** The SQL teaching kernel: a pure-TypeScript tokenizer, statement parser
 *  and row-at-a-time interpreter whose every step is one visible row
 *  operation, with the query plan as the centerpiece panel. */
export const sqlKernel: Kernel = {
  id: 'sql',
  label: 'SQL · query engine',
  editorSyntax: 'sql',
  features: { breakpoints: true, stepping: true },
  createSession: () => new SqlSession(),
};
