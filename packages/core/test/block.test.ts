// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { BlockRuntime, type SharedSession } from '../src/block';
import { mountSite } from '../src/site';
import type { SiteHandle } from '../src/site';
import type { OrgNode } from '../src/org';
import type {
  BlockRuntimeOptions,
  ExerciseOutcome,
  ExerciseSpec,
  StorageLike,
} from '../src/teaching';
import { fakeKernel, fakeResumableKernel, type FakeSession } from './fake-kernel';

const ORG = [
  '#+TITLE: Block Page',
  '',
  'Prose around the block.',
  '',
  '#+BEGIN_SRC mips',
  'addi $t0, $zero, 1',
  'addi $t1, $zero, 2',
  '#+END_SRC',
  '#+RESULTS:',
  ': canned output',
  '',
].join('\n');

interface Mounted {
  handle: SiteHandle;
  root: HTMLElement;
  session: FakeSession;
}

function mount(): Mounted {
  const { kernel, session } = fakeKernel('mips');
  const root = document.createElement('div');
  document.body.appendChild(root);
  const handle = mountSite({
    root,
    kernels: [kernel],
    pages: [{ title: 'Block Page', orgSource: ORG }],
    fonts: false,
  });
  return { handle, root, session };
}

/** Flush pending microtasks (no real timers): the click handler's async
 * run() chain resolves over a few awaits on already-settled promises. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const handles: SiteHandle[] = [];
const runtimes: BlockRuntime[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  for (const r of runtimes.splice(0)) r.dispose();
  location.hash = '';
  document.body.replaceChildren();
});

/* ---- direct BlockRuntime mounting (options + editor persistence) ---- */

const SAMPLE = 'addi $t0, $zero, 1\naddi $t1, $zero, 2';
const CODE_KEY = 'didact:code:';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

function srcNode(code: string, exercise: ExerciseSpec | null): Extract<OrgNode, { kind: 'src' }> {
  return {
    kind: 'src',
    lang: 'mips',
    name: null,
    caption: null,
    headers: '',
    code,
    exercise,
  };
}

interface MountedBlock {
  runtime: BlockRuntime;
  root: HTMLElement;
  results: HTMLElement;
  session: FakeSession;
}

function mountBlock(opts: {
  code?: string;
  exercise?: ExerciseSpec | null;
  runtimeOptions?: BlockRuntimeOptions;
  stepping?: boolean;
} = {}): MountedBlock {
  const { kernel: baseKernel, session } = fakeKernel('mips');
  const kernel = opts.stepping === false
    ? {
        ...baseKernel,
        features: { breakpoints: baseKernel.features?.breakpoints === true, stepping: false },
      }
    : baseKernel;
  const root = document.createElement('div');
  document.body.appendChild(root);
  const results = document.createElement('div');
  results.dataset.test = 'results';
  root.appendChild(results);
  const runtime = new BlockRuntime(
    srcNode(opts.code ?? SAMPLE, opts.exercise ?? null),
    1,
    kernel,
    root,
    results,
    { onActivity: () => {} },
    undefined,
    opts.runtimeOptions,
  );
  runtimes.push(runtime);
  return { runtime, root, results, session };
}

function editorOf(root: HTMLElement): EditorView {
  const editor = root.querySelector<HTMLElement>('.cm-editor');
  const view = editor === null ? null : EditorView.findFromDOM(editor);
  if (view === null) throw new Error('editor not mounted');
  return view;
}

function setSource(root: HTMLElement, text: string): void {
  const view = editorOf(root);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

/** Same platform test the runtime uses (`Mod` is Meta on Apple platforms). */
const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform)
  ? { metaKey: true }
  : { ctrlKey: true };

function pressKey(
  root: HTMLElement,
  key: string,
  init: KeyboardEventInit,
): KeyboardEvent {
  const content = root.querySelector<HTMLElement>('.cm-content');
  if (content === null) throw new Error('editor content not mounted');
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  content.dispatchEvent(event);
  return event;
}

describe('BlockRuntime: run and reset', () => {
  it('Run loads the edited source into the session, reports finished status, and fills the results slot', async () => {
    const { handle, root, session } = mount();
    handles.push(handle);
    const results = root.querySelector("[data-test='results']")!;
    expect(results.textContent).toContain('canned output');

    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();


    expect(session.loadedWith).toEqual(['addi $t0, $zero, 1\naddi $t1, $zero, 2']);
    expect(session.runCalls).toBe(1);
    const status = root.querySelector("[data-test='block-status']")!;
    expect(status.textContent).toContain('finished');
    expect(status.textContent).toContain('3 steps');
    // the console panel text replaced the canned results content
    expect(results.textContent).toContain('hello from fake kernel');
    expect(results.textContent).not.toContain('canned output');
    // the trusted html panel markup renders alongside the console text
    expect(results.querySelector('svg')).not.toBeNull();
  });

  it('Reset clears the run output from the results slot and re-arms status', async () => {
    const { handle, root } = mount();
    handles.push(handle);
    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();

    root.querySelector<HTMLButtonElement>("[data-test='block-reset']")!.click();
    const results = root.querySelector("[data-test='results']")!;
    expect(results.textContent).not.toContain('hello from fake kernel');
    expect(results.querySelector('svg')).toBeNull();
    expect(root.querySelector("[data-test='block-status']")!.textContent).toContain('reset');
  });

  it('surfaces a failed load as a red status and an error box, with or without a source line', async () => {
    const { handle, root, session } = mount();
    handles.push(handle);

    session.loadResult = { ok: false, line: 2, message: 'bad instruction' };
    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    let status = root.querySelector<HTMLElement>("[data-test='block-status']")!;
    let error = root.querySelector<HTMLElement>("[data-test='block-error']")!;
    expect(status.textContent).toContain('error · line 2: bad instruction');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('line 2: bad instruction');
    // a failed load never reaches the engine and clears the canned result
    expect(session.runCalls).toBe(0);
    expect(root.querySelector("[data-test='results']")!.textContent).toBe('');

    // a line-less failure (e.g. linker error) reports the message raw
    session.loadResult = { ok: false, message: 'undefined symbol' };
    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    status = root.querySelector<HTMLElement>("[data-test='block-status']")!;
    error = root.querySelector<HTMLElement>("[data-test='block-error']")!;
    expect(status.textContent).toBe('error · undefined symbol');
    expect(error.textContent).toBe('undefined symbol');
  });
 });

describe('BlockRuntime: loading status', () => {
  it('shows the kernel-neutral "working…" while a load is in flight, then the run status', async () => {
    const { handle, root, session } = mount();
    handles.push(handle);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    session.load = async () => { await gate; return { ok: true, summary: 'loaded · fake' }; };

    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    expect(root.querySelector("[data-test='block-status']")!.textContent).toBe('working…');

    release();
    await flushAsync();
    expect(root.querySelector("[data-test='block-status']")!.textContent).toContain('finished');
  });
});

describe('BlockRuntime: gutter breakpoints', () => {
  it('labels one gutter element per source line and toggles a breakpoint marker on mousedown', () => {
    const { handle, root } = mount();
    handles.push(handle);
    // two source lines → gutter-1 and gutter-2 rendered
    expect(root.querySelector("[data-test='gutter-1']")).not.toBeNull();
    const gutter = root.querySelector<HTMLElement>("[data-test='gutter-1']")!;
    expect(root.querySelector("[data-test='gutter-2']")).not.toBeNull();
    // no breakpoint marker before any click
    expect(root.querySelector("[data-test='breakpoint-1']")).toBeNull();

    // synthetic mouse events carry no layout, so CM6 resolves the click
    // to line 1 — but the toggle itself is the observable behavior
    gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(root.querySelector("[data-test='breakpoint-1']")).not.toBeNull();

    gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(root.querySelector("[data-test='breakpoint-1']")).toBeNull();
  });

  it('passes the active breakpoint lines to run()', async () => {
    const { handle, root, session } = mount();
    handles.push(handle);
    root.querySelector<HTMLElement>("[data-test='gutter-1']")!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    expect(session.lastBreakpoints).toEqual([1]);
  });
});

describe('BlockRuntime: saved code', () => {
  it('restores a saved draft when an id and storage are supplied', () => {
    const storage = new MemoryStorage();
    storage.setItem(CODE_KEY + 'block-1', 'saved draft');
    const { runtime } = mountBlock({ runtimeOptions: { id: 'block-1', storage } });
    expect(runtime.source).toBe('saved draft');
  });

  it('persists edits and drops the key when the text matches the sample', () => {
    const storage = new MemoryStorage();
    const { root } = mountBlock({ runtimeOptions: { id: 'block-1', storage } });

    setSource(root, 'edited code');
    expect(storage.getItem(CODE_KEY + 'block-1')).toBe('edited code');

    setSource(root, SAMPLE);
    expect(storage.getItem(CODE_KEY + 'block-1')).toBeNull();
  });

  it('does not touch storage without an id', () => {
    const storage = new MemoryStorage();
    const { root } = mountBlock({ runtimeOptions: { storage } });
    setSource(root, 'edited code');
    expect(storage.data.size).toBe(0);
  });

  it('revert restores the sample, clears the saved draft, and keeps the session output', async () => {
    const storage = new MemoryStorage();
    const { root, runtime, results, session } = mountBlock({
      runtimeOptions: { id: 'block-1', storage },
    });
    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    const output = results.textContent;
    const loads = session.loadedWith.length;
    let resets = 0;
    session.reset = () => { resets++; };

    setSource(root, 'edited code');
    root.querySelector<HTMLButtonElement>("[data-test='block-revert']")!.click();

    expect(runtime.source).toBe(SAMPLE);
    expect(storage.getItem(CODE_KEY + 'block-1')).toBeNull();
    // no session reset or reload: the machine state stays as it was
    expect(resets).toBe(0);
    expect(session.loadedWith.length).toBe(loads);
    expect(results.textContent).toBe(output);
  });

  it('Reset machine clears the output but keeps the code and saved draft', async () => {
    const storage = new MemoryStorage();
    const { root, runtime, results, session } = mountBlock({
      runtimeOptions: { id: 'block-1', storage },
    });
    setSource(root, 'edited code');
    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    expect(results.textContent).toContain('hello from fake kernel');
    let resets = 0;
    session.reset = () => { resets++; };

    root.querySelector<HTMLButtonElement>("[data-test='block-reset']")!.click();

    expect(resets).toBe(1);
    expect(runtime.source).toBe('edited code');
    expect(storage.getItem(CODE_KEY + 'block-1')).toBe('edited code');
    expect(results.textContent).not.toContain('hello from fake kernel');
    expect(root.querySelector("[data-test='block-status']")!.textContent).toContain('reset');
  });

  it('is silent when storage access throws', () => {
    const blocked: StorageLike = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    };
    const { root, runtime } = mountBlock({
      runtimeOptions: { id: 'block-1', storage: blocked },
    });
    expect(runtime.source).toBe(SAMPLE);
    expect(() => setSource(root, 'edited code')).not.toThrow();
    expect(() => {
      root.querySelector<HTMLButtonElement>("[data-test='block-revert']")!.click();
    }).not.toThrow();
    expect(runtime.source).toBe(SAMPLE);
  });
});

describe('BlockRuntime: copy code', () => {
  it('copies the current source through the clipboard API and flashes copied', async () => {
    const writes: string[] = [];
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { writes.push(text); } },
    });
    try {
      const { root } = mountBlock();
      setSource(root, 'edited code');
      root.querySelector<HTMLButtonElement>("[data-test='block-copy']")!.click();
      await flushAsync();
      expect(writes).toEqual(['edited code']);
      expect(root.querySelector("[data-test='block-status']")!.textContent).toContain('copied');
    } finally {
      if (original === undefined) Reflect.deleteProperty(navigator, 'clipboard');
      else Object.defineProperty(navigator, 'clipboard', original);
    }
  });

  it('shows a visible error when both clipboard paths fail', async () => {
    const clip = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const exec = Object.getOwnPropertyDescriptor(document, 'execCommand');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => false,
    });
    try {
      const { root } = mountBlock();
      root.querySelector<HTMLButtonElement>("[data-test='block-copy']")!.click();
      await flushAsync();

      const status = root.querySelector<HTMLElement>("[data-test='block-status']")!;
      expect(status.textContent).toBe(
        'copy failed — select the code and copy manually',
      );
      expect(status.classList.contains('lw-status-error')).toBe(true);
    } finally {
      if (clip === undefined) Reflect.deleteProperty(navigator, 'clipboard');
      else Object.defineProperty(navigator, 'clipboard', clip);
      if (exec === undefined) Reflect.deleteProperty(document, 'execCommand');
      else Object.defineProperty(document, 'execCommand', exec);
    }
  });

  it('restores a prior run error after the copied flash', async () => {
    const clip = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const { root, session } = mountBlock();
    session.run = async () => ({ finished: true, steps: 1, error: 'boom' });
    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();

    const status = root.querySelector<HTMLElement>("[data-test='block-status']")!;
    expect(status.textContent).toContain('error · boom');

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => {} },
    });
    const timers = vi.spyOn(window, 'setTimeout').mockReturnValue(1);
    try {
      root.querySelector<HTMLButtonElement>("[data-test='block-copy']")!.click();
      await flushAsync();
      expect(status.textContent).toBe('copied');
      expect(status.classList.contains('lw-status-error')).toBe(false);

      const flash = timers.mock.calls.at(-1)?.[0];
      expect(typeof flash).toBe('function');
      (flash as () => void)();
      expect(status.textContent).toContain('error · boom');
      expect(status.classList.contains('lw-status-error')).toBe(true);
    } finally {
      timers.mockRestore();
      if (clip === undefined) Reflect.deleteProperty(navigator, 'clipboard');
      else Object.defineProperty(navigator, 'clipboard', clip);
    }
  });
});

describe('BlockRuntime: keyboard shortcuts', () => {
  it('Mod-Enter runs and Shift-Enter steps, preventing the browser default', async () => {
    const { root, session } = mountBlock();

    const runEvent = pressKey(root, 'Enter', MOD_KEY);
    await flushAsync();
    expect(runEvent.defaultPrevented).toBe(true);
    expect(session.runCalls).toBe(1);

    const stepEvent = pressKey(root, 'Enter', { shiftKey: true });
    await flushAsync();
    expect(stepEvent.defaultPrevented).toBe(true);
    expect(session.ran).toBe(true);
  });

  it('does not step on Shift-Enter when the kernel has no stepping', async () => {
    const { root, session } = mountBlock({ stepping: false });

    pressKey(root, 'Enter', { shiftKey: true });
    await flushAsync();
    expect(session.ran).toBe(false);

    // Run stays available for every kernel.
    pressKey(root, 'Enter', MOD_KEY);
    await flushAsync();
    expect(session.runCalls).toBe(1);
  });

  it('ignores shortcuts while a run is already in flight', async () => {
    const { root, session } = mountBlock();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    session.load = async (src: string) => {
      session.loadedWith.push(src);
      await gate;
      return { ok: true, summary: 'loaded · fake' };
    };

    pressKey(root, 'Enter', MOD_KEY);
    await flushAsync();
    expect(session.loadedWith.length).toBe(1);

    const ignored = pressKey(root, 'Enter', MOD_KEY);
    await flushAsync();
    expect(ignored.defaultPrevented).toBe(true);
    expect(session.loadedWith.length).toBe(1);

    release();
    await flushAsync();
    expect(session.runCalls).toBe(1);
  });

  it('advertises only the platform Mod key on Run and Shift+Enter on Step', () => {
    const { root } = mountBlock();
    const run = root.querySelector<HTMLElement>("[data-test='block-run']")!;
    const step = root.querySelector<HTMLElement>("[data-test='block-step']")!;
    const apple = /Mac|iPhone|iPad/.test(navigator.platform);
    expect(run.getAttribute('aria-keyshortcuts'))
      .toBe(apple ? 'Meta+Enter' : 'Control+Enter');
    expect(step.getAttribute('aria-keyshortcuts')).toBe('Shift+Enter');
  });
});

describe('BlockRuntime: exercises', () => {
  it('passes only after a terminal execution and reports one outcome for a paused→finished run', async () => {
    const outcomes: ExerciseOutcome[] = [];
    const { root, session } = mountBlock({
      exercise: { title: 'Say hello', expected: 'hello from fake kernel   \n' },
      runtimeOptions: { id: 'ex-1', onExerciseResult: (o) => outcomes.push(o) },
    });
    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;
    expect(badge.dataset.state).toBe('pending');
    expect(badge.textContent).toBe('Exercise · pending');

    // The console stays empty until the terminal step, so a check made
    // before the program actually completes cannot satisfy the exercise.
    let consoleReady = false;
    session.state = () => [
      {
        kind: 'console' as const,
        id: 'con',
        title: 'Console',
        text: consoleReady ? 'hello from fake kernel' : '',
      },
    ];
    session.run = async () => ({ finished: false, pausedAt: 1, steps: 1 });
    session.step = async () => {
      consoleReady = true;
      return { ran: true, result: { finished: true, steps: 2 } };
    };

    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    session.load = async (src: string) => {
      session.loadedWith.push(src);
      await gate;
      return { ok: true, summary: 'loaded · fake' };
    };

    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    expect(badge.dataset.state).toBe('running');
    expect(outcomes).toHaveLength(0);

    release();
    await flushAsync();
    // Breakpoint pause: still mid-flight, not judged.
    expect(badge.dataset.state).toBe('running');
    expect(outcomes).toHaveLength(0);

    root.querySelector<HTMLButtonElement>("[data-test='block-step']")!.click();
    await flushAsync();
    expect(badge.dataset.state).toBe('passed');
    expect(badge.textContent).toBe('Exercise · passed');
    expect(outcomes).toEqual([{
      id: 'ex-1',
      title: 'Say hello',
      passed: true,
      actual: 'hello from fake kernel',
    }]);
  });

  it('fails a checked exercise whose output differs', async () => {
    const outcomes: ExerciseOutcome[] = [];
    const { root } = mountBlock({
      exercise: { title: 'Say goodbye', expected: 'goodbye' },
      runtimeOptions: { id: 'ex-2', onExerciseResult: (o) => outcomes.push(o) },
    });
    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();

    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;
    expect(badge.dataset.state).toBe('failed');
    expect(badge.textContent).toBe('Exercise · failed');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      id: 'ex-2',
      title: 'Say goodbye',
      passed: false,
      actual: 'hello from fake kernel',
    });
  });

  it('never passes or fails an unchecked exercise', async () => {
    const outcomes: ExerciseOutcome[] = [];
    const { root } = mountBlock({
      exercise: { title: 'Free practice', expected: null },
      runtimeOptions: { id: 'ex-3', onExerciseResult: (o) => outcomes.push(o) },
    });
    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;
    expect(badge.dataset.state).toBe('unchecked');

    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    expect(badge.dataset.state).toBe('unchecked');
    expect(badge.textContent).toBe('Exercise · unchecked');
    expect(outcomes).toHaveLength(0);
  });

  it('fails a checked exercise when the run errors', async () => {
    const outcomes: ExerciseOutcome[] = [];
    const { root, session } = mountBlock({
      exercise: { title: 'Break it', expected: 'hello from fake kernel' },
      runtimeOptions: { id: 'ex-4', onExerciseResult: (o) => outcomes.push(o) },
    });
    session.run = async () => ({ finished: true, steps: 1, error: 'boom' });

    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();

    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;
    expect(badge.dataset.state).toBe('failed');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.passed).toBe(false);
    expect(outcomes[0]!.actual).toBe('hello from fake kernel');
  });

  it('judges a paused program that steps to completion, reporting one outcome', async () => {
    const outcomes: ExerciseOutcome[] = [];
    const { root, session } = mountBlock({
      exercise: { title: 'Step it', expected: 'hello from fake kernel' },
      runtimeOptions: { id: 'ex-step', onExerciseResult: (o) => outcomes.push(o) },
    });
    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;
    session.run = async () => ({ finished: false, pausedAt: 2, steps: 1 });
    let stepCalls = 0;
    session.step = async () => {
      stepCalls++;
      return stepCalls === 1
        ? { ran: true, result: { finished: false, pausedAt: 3, steps: 2 } }
        : { ran: true, result: { finished: true, steps: 3 } };
    };

    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    expect(badge.dataset.state).toBe('running');
    expect(outcomes).toHaveLength(0);

    root.querySelector<HTMLButtonElement>("[data-test='block-step']")!.click();
    await flushAsync();
    expect(badge.dataset.state).toBe('running');
    expect(outcomes).toHaveLength(0);

    root.querySelector<HTMLButtonElement>("[data-test='block-step']")!.click();
    await flushAsync();
    expect(badge.dataset.state).toBe('passed');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      id: 'ex-step',
      title: 'Step it',
      passed: true,
      actual: 'hello from fake kernel',
    });
  });

  it('judges a terminal result returned with ran=false', async () => {
    const outcomes: ExerciseOutcome[] = [];
    const { root } = mountBlock({
      exercise: { title: 'Last step', expected: 'hello from fake kernel' },
      runtimeOptions: { id: 'ex-last', onExerciseResult: (o) => outcomes.push(o) },
    });

    root.querySelector<HTMLButtonElement>("[data-test='block-step']")!.click();
    await flushAsync();

    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;
    expect(badge.dataset.state).toBe('passed');
    expect(outcomes).toHaveLength(1);
  });

  it('returns a running exercise badge to pending on Reset, but keeps a completed verdict', async () => {
    const { root, session } = mountBlock({
      exercise: { title: 'Interrupted', expected: 'hello from fake kernel' },
      runtimeOptions: { id: 'ex-reset' },
    });
    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    session.load = async (src: string) => {
      session.loadedWith.push(src);
      await gate;
      return { ok: true, summary: 'loaded · fake' };
    };

    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    expect(badge.dataset.state).toBe('running');

    root.querySelector<HTMLButtonElement>("[data-test='block-reset']")!.click();
    expect(badge.dataset.state).toBe('pending');

    release();
    await flushAsync();
    expect(badge.dataset.state).toBe('passed');

    // A completed pass survives a later machine reset.
    root.querySelector<HTMLButtonElement>("[data-test='block-reset']")!.click();
    expect(badge.dataset.state).toBe('passed');
  });

  it('announces the badge state as a polite status', () => {
    const { root } = mountBlock({
      exercise: { title: 'Announced', expected: 'hello' },
      runtimeOptions: { id: 'ex-aria' },
    });
    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;
    expect(badge.getAttribute('role')).toBe('status');
    expect(badge.getAttribute('aria-live')).toBe('polite');
    expect(badge.dataset.test).toBe('block-exercise');
    expect(badge.dataset.state).toBe('pending');
    expect(badge.textContent).toBe('Exercise · pending');
  });

  it('paints the badge but emits no outcome when the block has no id', async () => {
    const outcomes: ExerciseOutcome[] = [];
    const { root } = mountBlock({
      exercise: { title: 'No id', expected: 'hello from fake kernel' },
      runtimeOptions: { onExerciseResult: (o) => outcomes.push(o) },
    });

    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();

    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;
    expect(badge.dataset.state).toBe('passed');
    expect(outcomes).toHaveLength(0);
  });

  it('starts a previously passed exercise in the passed state', () => {
    const { root } = mountBlock({
      exercise: { title: 'Already done', expected: 'hello' },
      runtimeOptions: { id: 'ex-5', exercisePassed: true },
    });
    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;
    expect(badge.dataset.state).toBe('passed');
    expect(badge.textContent).toBe('Exercise · passed');
  });
});

describe('BlockRuntime: reset wins over in-flight work', () => {
  it('drops a run that resolves after Reset: status, results, badge, and callback stay reset', async () => {
    const outcomes: ExerciseOutcome[] = [];
    const { root, results, session } = mountBlock({
      exercise: { title: 'Say hello', expected: 'hello from fake kernel' },
      runtimeOptions: { id: 'ex-race', onExerciseResult: (o) => outcomes.push(o) },
    });
    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    session.run = async () => {
      await gate;
      return { finished: true, steps: 3 };
    };

    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    expect(root.querySelector("[data-test='block-status']")!.textContent).toBe('running…');

    root.querySelector<HTMLButtonElement>("[data-test='block-reset']")!.click();
    expect(badge.dataset.state).toBe('pending');
    expect(
      root.querySelector<HTMLElement>("[data-test='block']")!.classList.contains('lw-running'),
    ).toBe(false);

    release();
    await flushAsync();

    // The late result must not repaint the reset block or judge the exercise.
    expect(root.querySelector("[data-test='block-status']")!.textContent).toContain('reset');
    expect(results.textContent).toBe('');
    expect(badge.dataset.state).toBe('pending');
    expect(outcomes).toHaveLength(0);
  });

  it('drops a step that resolves after Reset', async () => {
    const outcomes: ExerciseOutcome[] = [];
    const { root, results, session } = mountBlock({
      exercise: { title: 'Step race', expected: 'hello from fake kernel' },
      runtimeOptions: { id: 'ex-step-race', onExerciseResult: (o) => outcomes.push(o) },
    });
    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    session.step = async () => {
      await gate;
      return { ran: true, result: { finished: true, steps: 1 } };
    };

    root.querySelector<HTMLButtonElement>("[data-test='block-step']")!.click();
    await flushAsync();
    expect(badge.dataset.state).toBe('running');

    root.querySelector<HTMLButtonElement>("[data-test='block-reset']")!.click();
    release();
    await flushAsync();

    expect(root.querySelector("[data-test='block-status']")!.textContent).toContain('reset');
    expect(results.textContent).toBe('');
    expect(badge.dataset.state).toBe('pending');
    expect(outcomes).toHaveLength(0);
  });

  it('restores a previously passed badge when Reset interrupts a re-run', async () => {
    const { root, session } = mountBlock({
      exercise: { title: 'Already done', expected: 'hello from fake kernel' },
      runtimeOptions: { id: 'ex-seed', exercisePassed: true },
    });
    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;
    expect(badge.dataset.state).toBe('passed');

    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    session.run = async () => {
      await gate;
      return { finished: true, steps: 1 };
    };

    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    expect(badge.dataset.state).toBe('running');

    root.querySelector<HTMLButtonElement>("[data-test='block-reset']")!.click();
    expect(badge.dataset.state).toBe('passed');

    // the late result does not overwrite the restored pass
    release();
    await flushAsync();
    expect(badge.dataset.state).toBe('passed');
  });

  it("lets a shared sibling's Reset invalidate this block's in-flight run", async () => {
    const { kernel, session } = fakeKernel('mips');
    const shared: SharedSession = {
      session,
      name: 'demo',
      supported: true,
      loadedSource: null,
      queue: Promise.resolve(),
      blocks: [],
    };
    const outcomes: ExerciseOutcome[] = [];
    const mountShared = (
      code: string,
      exercise: ExerciseSpec | null,
    ): { runtime: BlockRuntime; root: HTMLElement; results: HTMLElement } => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      const results = document.createElement('div');
      results.dataset.test = 'results';
      root.appendChild(results);
      const index = shared.blocks.length + 1;
      const runtime = new BlockRuntime(
        srcNode(code, exercise),
        index,
        kernel,
        root,
        results,
        { onActivity: () => {} },
        shared,
        { id: `shared-${index}`, onExerciseResult: (o) => outcomes.push(o) },
      );
      runtimes.push(runtime);
      return { runtime, root, results };
    };
    const a = mountShared('print("A")', {
      title: 'Sibling A',
      expected: 'hello from fake kernel',
    });
    const b = mountShared('print("B")', null);
    const badge = a.root.querySelector<HTMLElement>("[data-test='block-exercise']")!;

    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    session.run = async () => {
      await gate;
      return { finished: true, steps: 3 };
    };

    a.root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    expect(badge.dataset.state).toBe('running');

    b.runtime.reset();
    expect(shared.loadedSource).toBeNull();

    release();
    await flushAsync();

    expect(a.root.querySelector("[data-test='block-status']")!.textContent).toContain('reset');
    expect(a.results.textContent).toBe('');
    expect(badge.dataset.state).toBe('pending');
    expect(outcomes).toHaveLength(0);
  });

  it("fails a checked exercise when a Step's reload fails after a pass", async () => {
    const outcomes: ExerciseOutcome[] = [];
    const { root, session } = mountBlock({
      exercise: { title: 'Reload me', expected: 'hello from fake kernel' },
      runtimeOptions: { id: 'ex-step-load', onExerciseResult: (o) => outcomes.push(o) },
    });
    const badge = root.querySelector<HTMLElement>("[data-test='block-exercise']")!;

    // First run proves the exercise.
    root.querySelector<HTMLButtonElement>("[data-test='block-run']")!.click();
    await flushAsync();
    expect(badge.dataset.state).toBe('passed');
    expect(outcomes).toHaveLength(1);

    // Editing forces Step to reload; the reload fails.
    setSource(root, 'broken code');
    session.loadResult = { ok: false, line: 1, message: 'bad instruction' };
    root.querySelector<HTMLButtonElement>("[data-test='block-step']")!.click();
    await flushAsync();

    expect(root.querySelector("[data-test='block-status']")!.textContent)
      .toContain('error · line 1: bad instruction');
    expect(badge.dataset.state).toBe('failed');
    expect(outcomes).toHaveLength(2);
    expect(outcomes[1]).toMatchObject({
      id: 'ex-step-load',
      title: 'Reload me',
      passed: false,
      actual: '',
    });
  });

  it("forgets the shared session's program when a reload fails", async () => {
    const { kernel, session } = fakeKernel('mips');
    const code = 'print("A")';
    const shared: SharedSession = {
      session,
      name: 'demo',
      supported: true,
      loadedSource: code,
      queue: Promise.resolve(),
      blocks: [],
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    const results = document.createElement('div');
    results.dataset.test = 'results';
    root.appendChild(results);
    const runtime = new BlockRuntime(
      srcNode(code, null),
      1,
      kernel,
      root,
      results,
      { onActivity: () => {} },
      shared,
      { id: 'shared-fail' },
    );
    runtimes.push(runtime);

    session.loadResult = { ok: false, message: 'no such program' };
    await runtime.run();
    expect(shared.loadedSource).toBeNull();
    expect(root.querySelector("[data-test='block-status']")!.textContent)
      .toContain('error · no such program');
  });

  it("clears a sibling's loaded identity when this block's shared resume fails", async () => {
    const { kernel, session } = fakeResumableKernel('python');
    const aCode = 'print("A")';
    const bCode = 'print("B")';
    const shared: SharedSession = {
      session,
      name: 'demo',
      supported: true,
      loadedSource: null,
      queue: Promise.resolve(),
      blocks: [],
    };
    const mountShared = (
      code: string,
      id: string,
    ): { runtime: BlockRuntime; root: HTMLElement; results: HTMLElement } => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      const results = document.createElement('div');
      results.dataset.test = 'results';
      root.appendChild(results);
      const runtime = new BlockRuntime(
        srcNode(code, null),
        shared.blocks.length + 1,
        kernel,
        root,
        results,
        { onActivity: () => {} },
        shared,
        { id },
      );
      runtimes.push(runtime);
      return { runtime, root, results };
    };
    const a = mountShared(aCode, 'shared-a');
    const b = mountShared(bCode, 'shared-b');

    // B is the program loaded into the shared session.
    await b.runtime.run();
    expect(shared.loadedSource).toBe(bCode);
    expect(b.results.textContent).toContain('hello from fake kernel');

    const resume = session.resume.bind(session);
    const resumed: string[] = [];
    session.resume = async (src: string) => {
      resumed.push(src);
      return src === aCode ? { ok: false, message: 'cannot resume A' } : resume(src);
    };

    // A's failed resume empties the session, so B's identity is stale.
    await a.runtime.run();
    expect(resumed).toEqual([aCode]);
    expect(shared.loadedSource).toBeNull();
    expect(a.root.querySelector("[data-test='block-status']")!.textContent)
      .toContain('error · cannot resume A');

    // B must reload its own source before stepping, and keep its output.
    await b.runtime.step();
    expect(resumed).toEqual([aCode, bCode]);
    expect(b.results.textContent).toContain('hello from fake kernel');
  });
});
