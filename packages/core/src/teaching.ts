// teaching.ts — shared contracts for learner-facing teaching primitives.
// Kept separate from block.ts so the parser, renderer, runtime, and site can
// agree on exercise metadata without circular imports.

import type { Extension } from '@codemirror/state';

/** An exercise attached to the next source block by org directives:
 *  `#+EXERCISE: <title>` and optional `#+CHECK: <expected output>`.
 *  `expected === null` marks the drill unchecked: the runtime reports
 *  whether it ran, but never claims pass/fail and never emits an
 *  {@link ExerciseOutcome}. */
export interface ExerciseSpec {
  title: string;
  expected: string | null;
}

/** Result of checking one exercise after a terminal execution (finished or
 *  errored) of a block that has an `id`. Paused executions are not judged.
 *  `actual` is the block's console output (never kernel markup), so the
 *  site can store/compare it. */
export interface ExerciseOutcome {
  /** Stable page-scoped block id, the same one used for editor
   *  persistence. Required: a block without an id is never reported, so
   *  every outcome carries a non-empty id. */
  id: string;
  title: string;
  passed: boolean;
  actual: string;
}

/** The storage subset the block editor uses. `localStorage` satisfies it;
 *  tests inject a small in-memory version. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Optional host integration for one block. All fields are optional so a
 *  standalone BlockRuntime (tests, embeds) behaves exactly as before. */
export interface BlockRuntimeOptions {
  /** Stable page-scoped id: the key for saved code, exercise results, and
   *  completion. Required for persistence and for emitting exercise
   *  outcomes; without it a block runs normally but is never reported. */
  id?: string;
  /** Storage backend; defaults to `globalThis.localStorage` when present. */
  storage?: StorageLike | null;
  /** Storage key prefix for saved drafts (default `'didact:'`). */
  storagePrefix?: string;
  /** True when this exercise already passed in a previous visit. */
  exercisePassed?: boolean;
  /** Called after each checked exercise reaches a terminal execution.
   *  Requires `id`: id-less blocks update their badge but emit nothing. */
  onExerciseResult?: (outcome: ExerciseOutcome) => void;
  /** Custom CodeMirror theme extension (defaults to Ayu Light). */
  editorTheme?: Extension;
  /** Additional CodeMirror extensions appended to the editor state. */
  editorExtensions?: readonly Extension[];
  /** Explicit CodeMirror language extension overriding `kernel.editorSyntax`
   *  (`null` disables syntax highlighting). */
  editorLanguage?: Extension | null;
  /** Lock the editor against user edits while keeping execution controls. */
  readOnly?: boolean;
}
