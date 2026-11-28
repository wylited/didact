// smoke.ts — bun smoke test for @didact/kernel-fortran.
// Run from the repo root: `bun packages/kernel-fortran/test/smoke.ts`.
// Covers the Session contract (load/run/step/breakpoints/resume/reset),
// column-major panels, modules, derived types, formatted I/O and errors.

import { readFileSync } from 'node:fs';

import { fortranKernel } from '../src/kernel';
import type { Panel, RunResult, Session } from '../src/types';

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

function consoleOf(panels: Panel[]): string {
  const p = panels.find((x) => x.id === 'console');
  return p !== undefined && p.kind === 'console' ? p.text : '';
}

function rowsOf(panels: Panel[], id: string): { addr: number; text: string }[] {
  const p = panels.find((x) => x.id === id);
  return p !== undefined && p.kind === 'listing' ? p.rows : [];
}

function fieldsOf(panels: Panel[], id: string): { key: string; value: string }[] {
  const p = panels.find((x) => x.id === id);
  return p !== undefined && p.kind === 'fields' ? p.fields : [];
}

async function load(src: string): Promise<Session> {
  const s = fortranKernel.createSession();
  const r = await s.load(src);
  if (!r.ok) throw new Error(`load failed: line ${r.line}: ${r.message}`);
  return s;
}

async function run(src: string, bps?: number[]): Promise<{ r: RunResult; s: Session }> {
  const s = await load(src);
  return { r: await s.run(bps), s };
}

console.log('registration');
{
  eq('id', fortranKernel.id, 'fortran');
  eq('label', fortranKernel.label, 'Fortran · interpreter');
  eq('syntax', fortranKernel.editorSyntax, 'fortran');
  check('stepping + breakpoints', fortranKernel.features?.stepping === true
    && fortranKernel.features.breakpoints === true);
}

console.log('programs · loops · arrays');
{
  const { r, s } = await run(`program p
  implicit none
  integer :: i, a(2,3)
  do i = 1, 3
    print *, i
  end do
  a = reshape([(i, i=1,6)], [2,3])
end program p`);
  eq('run finishes', r.error ?? 'ok', 'ok');
  eq('loop output', consoleOf(s.state()), '1\n2\n3\n');
  const rows = rowsOf(s.state(), 'arrays');
  eq('array rows', rows.length, 6);
  eq('column-major first row', rows[0]?.text, 'a(1,1) = 1');
  eq('column-major second row', rows[1]?.text, 'a(2,1) = 2');
  eq('column-major third row', rows[2]?.text, 'a(1,2) = 3');
}

console.log('sections · reductions · intrinsics');
{
  const { s } = await run(`program p
  implicit none
  integer :: a(3,4), i
  a = reshape([(i, i=1,12)], [3,4])
  print *, a(2,:)
  print *, sum(a, dim=1)
  print *, matmul(reshape([1.,2.,3.,4.],[2,2]), reshape([1.,0.,0.,1.],[2,2]))
  print *, dot_product([1,2,3], [1,2,3])
end program p`);
  eq('section + reductions', consoleOf(s.state()).trimEnd(),
    '2 5 8 11\n6 15 24 33\n1.0 2.0 3.0 4.0\n14');
}

console.log('modules · procedures · derived types');
{
  const { s } = await run(`module m
  implicit none
  integer :: counter = 0
contains
  subroutine bump(n)
    integer, intent(inout) :: n
    counter = counter + 1
    n = n + 1
  end subroutine bump
end module m
program p
  use m, only: counter, bump
  implicit none
  type :: particle
    real :: x = 0.0
    real :: v = 1.0
  end type particle
  type(particle) :: q
  integer :: x
  x = 10
  call bump(x)
  q = particle(2.0, 3.0)
  q%x = q%x + q%v
  print *, x, counter, q%x
end program p`);
  eq('module state + derived component', consoleOf(s.state()).trimEnd(), '11 1 5.0');
}

console.log('formatted I/O');
{
  const { s } = await run(`program p
  implicit none
  real :: x
  integer :: i
  x = 1.0/3.0
  i = 42
  write(*,'(F8.4)') x
  write(*,'(I5)') i
  write(*,'(ES12.4)') 1234.0
end program p`);
  eq('exact fields', consoleOf(s.state()), '  0.3333\n   42\n  1.2340E+03\n');
}

console.log('session driver');
{
  const s = await load(`program p
  implicit none
  integer :: i
  do i = 1, 3
    print *, i
  end do
end program p`);
  const paused = await s.run([5]);
  eq('breakpoint line', paused.pausedAt, 5);
  eq('paused before print', consoleOf(s.state()), '');
  const step = await s.step();
  eq('step ran', step.ran, true);
  eq('step output', consoleOf(s.state()), '1\n');
  eq('loop panel', fieldsOf(s.state(), 'loops')[1]?.value, '2 of 3');
  const done = await s.run();
  eq('finished', done.finished, true);
  eq('full output', consoleOf(s.state()), '1\n2\n3\n');

  const t = await load(`program p
  implicit none
  integer :: n
  n = 41
end program p`);
  await t.run();
  const resumed = await t.resume(`n = n + 1
print *, n`);
  check('resume accepted', resumed.ok);
  await t.run();
  eq('resume keeps state', consoleOf(t.state()), '42\n');
}

console.log('errors');
{
  const { r } = await run(`program p
  implicit none
  integer :: a(3)
  a(4) = 1
end program p`);
  eq('bounds error', r.error, 'line 4: subscript 4 is out of bounds 1:3');

  const s = fortranKernel.createSession();
  const read = await s.load(`program p
  read *, n
end program p`);
  check('READ refused at load', !read.ok && read.message.includes('not in the teaching subset: READ'));
}

console.log('apps/site page round-trip');
{
  interface Block {
    name: string;
    check?: string;
    session?: string;
    source: string;
    results: string;
  }

  const page = readFileSync(
    new URL('../../../apps/site/src/pages/fortran.org', import.meta.url),
    'utf8',
  );
  const lines = page.split('\n');
  const blocks: Block[] = [];
  let solution: Block | undefined;
  let inSolution = false;
  let pendingName = '';
  let pendingCheck: string | undefined;

  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (/^#\+BEGIN_SOLUTION\s*$/.test(line)) {
      inSolution = true;
      i++;
      continue;
    }
    if (/^#\+END_SOLUTION\s*$/.test(line)) {
      inSolution = false;
      i++;
      continue;
    }
    const nameMatch = /^#\+NAME:\s*(\S+)/.exec(line);
    if (nameMatch !== null) {
      pendingName = nameMatch[1]!;
      i++;
      continue;
    }
    const checkMatch = /^#\+CHECK:\s*(.+)$/.exec(line);
    if (checkMatch !== null) {
      pendingCheck = checkMatch[1]!.trim();
      i++;
      continue;
    }
    const beginMatch = /^#\+BEGIN_SRC\s+(\S+)(.*)$/.exec(line);
    if (beginMatch === null) {
      i++;
      continue;
    }

    const lang = beginMatch[1]!;
    const header = beginMatch[2] ?? '';
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !/^#\+END_SRC\s*$/.test(lines[j]!)) {
      body.push(lines[j]!);
      j++;
    }
    i = j + 1;

    const resultLines: string[] = [];
    let k = i;
    while (k < lines.length && lines[k]!.trim() === '') k++;
    if (k < lines.length && /^#\+RESULTS?:/.test(lines[k]!)) {
      k++;
      while (k < lines.length && lines[k]!.startsWith(': ')) {
        resultLines.push(lines[k]!.slice(2));
        k++;
      }
      i = k;
    }

    if (lang === 'fortran') {
      const sessionMatch = /:session\s+(\S+)/.exec(header);
      const block: Block = {
        name: pendingName,
        check: pendingCheck,
        session: sessionMatch?.[1],
        source: body.join('\n'),
        results: resultLines.length === 0 ? '' : `${resultLines.join('\n')}\n`,
      };
      if (inSolution) solution = block;
      else blocks.push(block);
    }

    pendingName = '';
    pendingCheck = undefined;
  }

  eq('page fortran blocks executed', blocks.length + (solution === undefined ? 0 : 1), 7);

  const sessions = new Map<string, Session>();
  let exerciseCheck: string | undefined;

  for (const block of blocks) {
    const label = block.name === '' ? 'unnamed fortran block' : block.name;
    let s: Session;
    if (block.session === undefined) {
      s = fortranKernel.createSession();
      const r = await s.load(block.source);
      check(`${label} loads`, r.ok, r.ok ? '' : r.message);
      if (!r.ok) continue;
    } else {
      const shared = sessions.get(block.session);
      if (shared === undefined) {
        s = fortranKernel.createSession();
        sessions.set(block.session, s);
        const r = await s.load(block.source);
        check(`${label} opens session ${block.session}`, r.ok, r.ok ? '' : r.message);
        if (!r.ok) continue;
      } else {
        s = shared;
        const r = await s.resume!(block.source);
        check(`${label} resumes session ${block.session}`, r.ok, r.ok ? '' : r.message);
        if (!r.ok) continue;
      }
    }

    const r = await s.run();
    check(`${label} runs without error`, r.error === undefined, r.error ?? '');
    const out = consoleOf(s.state());
    if (block.check !== undefined) {
      const got = out.trimEnd();
      const want = block.check;
      exerciseCheck = want;
      // Row 1 of the page's 2x3 column-major reshape holds 1, 3, 5.
      eq(`${label} console`, got, '9');
      check(`${label} rejects #+CHECK: ${want}`, got !== want, `got ${got}`);
    } else {
      eq(`${label} #+RESULTS`, out, block.results);
    }
  }

  check('page has a #+SOLUTION block', solution !== undefined);
  if (solution !== undefined) {
    const s = fortranKernel.createSession();
    const loaded = await s.load(solution.source);
    check('solution loads', loaded.ok, loaded.ok ? '' : loaded.message);
    if (loaded.ok) {
      const r = await s.run();
      check('solution runs without error', r.error === undefined, r.error ?? '');
      const got = consoleOf(s.state()).trimEnd();
      eq('solution console', got, '12');
      check(
        `solution satisfies #+CHECK: ${exerciseCheck ?? ''}`,
        exerciseCheck !== undefined && got === exerciseCheck,
        `got ${got}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failure${failures.length === 1 ? '' : 's'}: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nall ${pass} checks passed`);
