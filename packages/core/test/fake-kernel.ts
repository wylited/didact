// fake-kernel.ts — minimal in-file Kernel implementation for behavioral
// tests: no network, no real engine, just records what the UI asked it
// to do and hands back a canned state.

import type { Kernel, LoadResult, Panel, RunResult, Session } from '../src/kernel';

export class FakeSession implements Session {
  loadedWith: string[] = [];
  runCalls = 0;
  lastBreakpoints: number[] | undefined;
  ran = false;
  /** Tests override this to make load() fail. */
  loadResult: LoadResult = { ok: true, summary: 'loaded · fake' };

  async load(src: string): Promise<LoadResult> {
    this.loadedWith.push(src);
    return this.loadResult;
  }

  async run(breakpoints?: number[]): Promise<RunResult> {
    this.runCalls++;
    this.lastBreakpoints = breakpoints;
    return { finished: true, steps: 3, exit: 'exit(0)' };
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    this.ran = true;
    return { ran: false, result: { finished: true, steps: 3, exit: 'exit(0)' } };
  }

  reset(): void {
    /* noop */
  }

  state(): Panel[] {
    return [
      { kind: 'console', id: 'con', title: 'Console', text: 'hello from fake kernel' },
      { kind: 'html', id: 'h', title: 'T', html: '<svg data-test="fake-svg"></svg>' },
    ];
  }

  dispose(): void {
    /* noop */
  }
}

export function fakeKernel(id = 'mips'): { kernel: Kernel; session: FakeSession } {
  const session = new FakeSession();
  const kernel: Kernel = {
    id,
    label: 'Fake · Kernel',
    features: { breakpoints: true, stepping: true },
    editorSyntax: 'asm-mips',
    createSession: () => session,
  };
  return { kernel, session };
}
