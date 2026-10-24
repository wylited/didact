// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { mountSite } from '../src/site';
import type { SiteHandle } from '../src/site';
import { fakeKernel, type FakeSession } from './fake-kernel';

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
afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  location.hash = '';
  document.body.replaceChildren();
});

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
    // a failed load never reaches the engine
    expect(session.runCalls).toBe(0);

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
