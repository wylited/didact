// block-exercise.ts — exercise badge DOM + pass/fail judging for one block.

import type { RunResult } from './kernel';
import type { ExerciseOutcome, ExerciseSpec } from './teaching';

export type ExerciseState = 'pending' | 'running' | 'passed' | 'failed' | 'unchecked';

/** Trailing whitespace is insignificant when comparing exercise output. */
export function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/** Owns one block's exercise badge and verdict lifecycle. */
export class ExerciseController {
  readonly badge: HTMLElement | null;
  private readonly spec: ExerciseSpec | null;
  private readonly id: string | undefined;
  private readonly onResult: ((outcome: ExerciseOutcome) => void) | undefined;
  /** Last judged outcome, kept so Reset can restore it instead of
   *  discarding a completed pass/fail. */
  private result: 'passed' | 'failed' | null = null;
  /** True once the current execution has emitted its outcome. */
  private judged = false;

  constructor(
    spec: ExerciseSpec | null,
    id: string | undefined,
    initiallyPassed: boolean,
    onResult: ((outcome: ExerciseOutcome) => void) | undefined,
    doc: Document,
  ) {
    this.spec = spec;
    this.id = id;
    this.onResult = onResult;

    if (spec === null) {
      this.badge = null;
      return;
    }

    const badge = doc.createElement('span');
    badge.className = 'lw-block-exercise';
    badge.dataset.test = 'block-exercise';
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');
    this.badge = badge;

    // A previous visit's pass survives until this run is judged, so a
    // reset mid-rerun restores "passed" instead of forgetting it.
    if (initiallyPassed) this.result = 'passed';
    this.setState(
      spec.expected === null
        ? 'unchecked'
        : initiallyPassed ? 'passed' : 'pending',
    );
  }

  /** Mark a checked exercise running at the start of an execution. */
  begin(): void {
    if (this.spec !== null && this.spec.expected !== null) {
      this.judged = false;
      this.setState('running');
    }
  }

  /** Judge the exercise once a run or step reached a terminal result
   *  (finished or errored). Breakpoint pauses stay mid-flight. */
  check(result: RunResult, actual: string): void {
    const spec = this.spec;
    if (spec === null || spec.expected === null) return;
    const errored = result.error !== undefined && result.error !== '';
    if (!errored) {
      if (result.pausedAt !== undefined) return;
      if (result.finished !== true) return;
    }
    const passed = !errored
      && normalizeOutput(actual) === normalizeOutput(spec.expected);
    this.record(passed, actual);
  }

  /** Publish one outcome and paint the badge. Unchecked drills never call
   *  here, so they can never be reported as pass/fail. An outcome needs a
   *  stable id; without one the badge still updates but no host callback
   *  fires (an empty-id outcome would collide across blocks). */
  record(passed: boolean, actual: string): void {
    const spec = this.spec;
    if (spec === null || spec.expected === null) return;
    // One outcome per execution: extra terminal steps after the verdict
    // must not fire the host callback again.
    if (this.judged) return;
    this.judged = true;
    this.result = passed ? 'passed' : 'failed';
    this.setState(this.result);
    if (this.id === undefined) return;
    const outcome: ExerciseOutcome = {
      id: this.id,
      title: spec.title,
      passed,
      actual,
    };
    try {
      this.onResult?.(outcome);
    } catch {
      // a host callback must not break the block
    }
  }

  /** Reset an in-flight exercise badge back to its last judged verdict. */
  reset(): void {
    this.judged = false;
    if (this.badge?.dataset.state === 'running') {
      this.setState(this.result ?? 'pending');
    }
  }

  private setState(state: ExerciseState): void {
    if (this.badge === null) return;
    this.badge.dataset.state = state;
    this.badge.textContent = `Exercise · ${state}`;
  }
}
