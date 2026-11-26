// fortran.test.ts — behavioral tests for the free-form Fortran teaching
// interpreter: exact console bytes, exact column-major panel contents,
// exact line-mapped errors. Each test pins one real behavior.

import { describe, expect, it } from 'vitest';
import { fortranKernel } from '../src/kernel';
import type { LoadResult, Panel, RunResult, Session } from '../src/types';

type FieldsPanel = Extract<Panel, { kind: 'fields' }>;
type ListingPanel = Extract<Panel, { kind: 'listing' }>;

function out(panels: Panel[]): string {
  const c = panels.find((p) => p.id === 'console');
  return c !== undefined && c.kind === 'console' ? c.text : '';
}

function fields(panels: Panel[], id = 'workspace'): FieldsPanel['fields'] {
  const p = panels.find((x) => x.id === id);
  return p !== undefined && p.kind === 'fields' ? p.fields : [];
}

function rows(panels: Panel[], id: string): ListingPanel['rows'] {
  const p = panels.find((x) => x.id === id);
  return p !== undefined && p.kind === 'listing' ? p.rows : [];
}

async function session(src: string): Promise<Session> {
  const s = fortranKernel.createSession();
  const load: LoadResult = await s.load(src);
  if (!load.ok) throw new Error(`load failed: line ${load.line}: ${load.message}`);
  return s;
}

async function run(src: string, bps?: number[]): Promise<{ r: RunResult; s: Session }> {
  const s = await session(src);
  const r = await s.run(bps);
  return { r, s };
}

async function runOut(src: string): Promise<string> {
  const { r, s } = await run(src);
  expect(r.error).toBeUndefined();
  return out(s.state()).trimEnd();
}

async function runRaw(src: string): Promise<string> {
  const { r, s } = await run(src);
  expect(r.error).toBeUndefined();
  return out(s.state());
}

describe('fortran kernel registration', () => {
  it('is the fortran-syntax kernel with stepping and breakpoints', () => {
    expect(fortranKernel.id).toBe('fortran');
    expect(fortranKernel.label).toBe('Fortran · interpreter');
    expect(fortranKernel.editorSyntax).toBe('fortran');
    expect(fortranKernel.features).toEqual({ breakpoints: true, stepping: true });
  });
});

describe('programs, loops, and list-directed output', () => {
  it('runs a counted DO loop and prints each value', async () => {
    expect(await runOut(`program p
  implicit none
  integer :: i
  do i = 1, 3
    print *, i
  end do
end program p`)).toBe('1\n2\n3');
  });

  it('supports DO WHILE, EXIT and CYCLE', async () => {
    expect(await runOut(`program p
  implicit none
  integer :: i
  i = 0
  do while (i < 10)
    i = i + 1
    if (mod(i, 2) == 0) cycle
    if (i > 7) exit
    print *, i
  end do
  print *, 'done'
end program p`)).toBe('1\n3\n5\n7\ndone');
  });

  it('select case matches ranges, exact values and default', async () => {
    expect(await runOut(`program p
  implicit none
  integer :: i
  do i = 1, 5
    select case (i)
    case (1:2)
      print *, 'low', i
    case (4)
      print *, 'four'
    case default
      print *, 'other', i
    end select
  end do
end program p`)).toBe('low 1\nlow 2\nother 3\nfour\nother 5');
  });
});

describe('arrays: column-major layout, sections, reductions', () => {
  it('stores a 2x3 array column-major and shows every address', async () => {
    const { r, s } = await run(`program p
  implicit none
  integer :: a(2,3), i
  a = reshape([(i, i=1,6)], [2,3])
end program p`);
    expect(r.error).toBeUndefined();
    const panel = s.state();
    expect(fields(panel).find((f) => f.key === 'a')).toMatchObject({
      value: '2x3 [1, 2, 3, 4, 5, 6]',
      sub: 'integer(4) · 2x3',
    });
    expect(rows(panel, 'arrays').map((row) => [row.addr, row.text])).toEqual([
      [0, 'a(1,1) = 1'],
      [1, 'a(2,1) = 2'],
      [2, 'a(1,2) = 3'],
      [3, 'a(2,2) = 4'],
      [4, 'a(1,3) = 5'],
      [5, 'a(2,3) = 6'],
    ]);
  });

  it('reduces a scalar subscript (rank drops) and keeps section order', async () => {
    expect(await runOut(`program p
  implicit none
  integer :: a(3,4), i
  a = reshape([(i, i=1,12)], [3,4])
  print *, a(2,:)
  print *, a(:,3)
  print *, a(1:2,2:3)
  print *, sum(a, dim=1)
end program p`)).toBe('2 5 8 11\n7 8 9\n4 5 7 8\n6 15 24 33');
  });

  it('does whole-array arithmetic, MATMUL and DOT_PRODUCT', async () => {
    expect(await runOut(`program p
  implicit none
  real :: a(2,2), b(2,2)
  integer :: v(3)
  a = reshape([1.,2.,3.,4.], [2,2])
  b = 2.0
  print *, a*b
  print *, matmul(a, b)
  v = [1,2,3]
  print *, dot_product(v, v)
end program p`)).toBe('2.0 4.0 6.0 8.0\n8.0 12.0 8.0 12.0\n14');
  });

  it('honours explicit lower bounds', async () => {
    expect(await runOut(`program p
  implicit none
  real :: a(0:2)
  a(0) = 10.0
  a(1) = 20.0
  a(2) = 30.0
  print *, a, lbound(a), ubound(a)
end program p`)).toBe('10.0 20.0 30.0 0 2');
  });

  it('applies WHERE only to selected elements', async () => {
    expect(await runOut(`program p
  implicit none
  real :: a(5)
  a = [-2., -1., 0., 1., 2.]
  where (a > 0.0) a = sqrt(a)
  print *, a
end program p`)).toBe('-2.0 -1.0 0.0 1.0 1.414214');
  });
});

describe('modules, procedures, host association', () => {
  it('shares module state and writes an INTENT(INOUT) scalar back', async () => {
    expect(await runOut(`module m
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
  integer :: x
  x = 10
  call bump(x)
  print *, x, counter
end program p`)).toBe('11 1');
  });

  it('recurses through an internal function with RESULT', async () => {
    expect(await runOut(`program p
  implicit none
  print *, fact(5)
contains
  recursive function fact(n) result(r)
    integer, intent(in) :: n
    integer :: r
    if (n <= 1) then
      r = 1
    else
      r = n * fact(n-1)
    end if
  end function fact
end program p`)).toBe('120');
  });

  it('passes an assumed-length character dummy without truncation', async () => {
    expect(await runOut(`program p
  implicit none
  character(len=8) :: s
  s = 'hello'
  call shout(s)
  print *, len(s), s
contains
  subroutine shout(t)
    character(len=*), intent(inout) :: t
    t = trim(t)//'!!'
  end subroutine shout
end program p`)).toBe('8 hello!!');
  });

  it('resets an INTENT(OUT) array before the body runs', async () => {
    expect(await runOut(`program p
  implicit none
  real :: a(3)
  a = 99.0
  call zero(a)
  print *, a
contains
  subroutine zero(x)
    real, intent(out) :: x(:)
    x = 0.0
  end subroutine zero
end program p`)).toBe('0.0 0.0 0.0');
  });
});

describe('derived types', () => {
  it('constructs, copies and updates components', async () => {
    expect(await runOut(`program p
  implicit none
  type :: particle
    real :: x = 0.0
    real :: v = 1.0
  end type particle
  type(particle) :: q
  q = particle(2.0, 3.0)
  q%x = q%x + q%v
  print *, q%x
end program p`)).toBe('5.0');
  });

  it('maps a component over an array of derived values', async () => {
    expect(await runOut(`program p
  implicit none
  type :: particle
    real :: x = 0.0
  end type particle
  type(particle) :: ps(2)
  ps(1)%x = 1.5
  ps(2)%x = 2.5
  ps%x = ps%x * 2.0
  print *, ps(1)%x, ps(2)%x
end program p`)).toBe('3.0 5.0');
  });
});

describe('kinds, allocation, character and formatting', () => {
  it('keeps REAL(4) at float32 and REAL(8) at float64', async () => {
    expect(await runOut(`program p
  implicit none
  real(4) :: x
  real(8) :: y
  x = 1.0/3.0
  y = 1.0d0/3.0d0
  print *, x, y
  print *, kind(x), kind(y)
end program p`)).toBe('0.3333333 0.3333333333333333\n4 8');
  });

  it('allocates and deallocates with ALLOCATED reflecting the state', async () => {
    expect(await runOut(`program p
  implicit none
  real, allocatable :: a(:,:)
  allocate(a(2,2))
  a = reshape([1.,2.,3.,4.], [2,2])
  print *, allocated(a), size(a), a(2,2)
  deallocate(a)
  print *, allocated(a)
end program p`)).toBe('T 4 4.0\nF');
  });

  it('pads and truncates CHARACTER assignment, and slices substrings', async () => {
    expect(await runOut(`program p
  implicit none
  character(len=5) :: s
  s = 'ab'
  print *, '['//s//']'
  s(2:3) = 'XY'
  print *, s
  print *, len_trim(s), trim(s), index('hello','ll')
end program p`)).toBe('[ab   ]\naXY  \n3 aXY 3');
  });

  it('writes exact F/I/A/ES/E fields, including format reversion', async () => {
    expect(await runRaw(`program p
  implicit none
  real :: x
  integer :: i
  x = 1.0/3.0
  i = 42
  write(*,'(F8.4)') x
  write(*,'(I5)') i
  write(*,'(A)') 'hi'
  write(*,'(2(F6.2,1X))') 1.5, 2.5
  write(*,'(ES12.4)') 1234.0
  write(*,'(E12.4)') 1234.0
  write(*,'(3I4)') (i, i=1,7)
end program p`)).toBe([
      '  0.3333',
      '   42',
      'hi',
      '  1.50   2.50 ',
      '  1.2340E+03',
      '  0.1234E+04',
      '   1   2   3',
      '   4   5   6',
      '   7',
    ].join('\n') + '\n');
  });
});

describe('session driver: stepping, breakpoints, resume', () => {
  const loop = `program p
  implicit none
  integer :: i
  do i = 1, 3
    print *, i
  end do
end program p`;

  it('pauses before a breakpoint line and shows the live DO loop', async () => {
    const s = await session(loop);
    const first = await s.run([5]);
    expect(first.pausedAt).toBe(5);
    expect(first.finished).toBe(false);
    expect(out(s.state())).toBe('');
    expect(fields(s.state(), 'loops').map((f) => `${f.key}=${f.value}`)).toEqual([
      'loop variable=i', 'iteration=1 of 3', 'bounds=1:3:1',
    ]);

    const step = await s.step();
    expect(step.ran).toBe(true);
    expect(out(s.state())).toBe('1\n');
    expect(fields(s.state(), 'loops')[1]?.value).toBe('2 of 3');
    expect(await s.run([5])).toMatchObject({ pausedAt: 5 });
    expect(out(s.state())).toBe('1\n');
    expect(await s.run()).toMatchObject({ finished: true });
    expect(out(s.state())).toBe('1\n2\n3\n');
  });

  it('runs to completion from a pause and reports exit(0)', async () => {
    const s = await session(loop);
    await s.run([5]);
    const done = await s.run();
    expect(done).toMatchObject({ finished: true, exit: 'exit(0)' });
    expect(out(s.state())).toBe('1\n2\n3\n');
  });

  it('resumes a named session with the previous block variables live', async () => {
    const s = await session(`program p
  implicit none
  integer :: n
  n = 41
end program p`);
    expect(await s.run()).toMatchObject({ finished: true });
    const resumed = await s.resume(`n = n + 1
print *, n`);
    expect(resumed.ok).toBe(true);
    expect(await s.run()).toMatchObject({ finished: true });
    expect(out(s.state())).toBe('42\n');
  });

  it('reset returns to the just-loaded state', async () => {
    const s = await session(loop);
    await s.run();
    s.reset();
    expect(out(s.state())).toBe('');
    expect(await s.run()).toMatchObject({ finished: true });
    expect(out(s.state())).toBe('1\n2\n3\n');
  });
});

describe('errors are line-mapped and honest about the subset', () => {
  it('refuses an undeclared name under IMPLICIT NONE', async () => {
    const { r } = await run(`program p
  implicit none
  print *, nope
end program p`);
    expect(r.error).toBe("line 3: no implicit typing: 'nope' is not declared (add IMPLICIT NONE and a declaration)");
  });

  it('checks array bounds with the declared bounds in the message', async () => {
    const { r } = await run(`program p
  implicit none
  integer :: a(3)
  a(4) = 1
end program p`);
    expect(r.error).toBe('line 4: subscript 4 is out of bounds 1:3');
  });

  it('refuses READ and POINTER at load time with a line', async () => {
    const read = await session(`program p
  implicit none
  read *, n
end program p`).catch((e: Error) => e);
    expect(String(read)).toContain('not in the teaching subset: READ');

    const s = fortranKernel.createSession();
    const load = await s.load(`program p
  implicit none
  integer, pointer :: p
end program p`);
    expect(load).toMatchObject({ ok: false, line: 3 });
    expect(load.ok === false ? load.message : '').toContain('POINTER');
  });

  it('reports shape mismatch on assignment', async () => {
    const { r } = await run(`program p
  implicit none
  integer :: a(2,2)
  a = [1,2,3]
end program p`);
    expect(r.error).toBe('line 4: shapes do not conform: \'a\' is 2x2, right side is 3');
  });
});

describe('control-flow and procedure edge cases', () => {
  it('handles ELSE IF chains and single-line IF', async () => {
    expect(await runOut(`program p
  implicit none
  integer :: i
  i = 3
  if (i > 2) print *, 'big'
  if (i < 2) then
    print *, 'small'
  else if (i == 3) then
    print *, 'three'
  else
    print *, 'other'
  end if
end program p`)).toBe('big\nthree');
  });

  it('applies WHERE / ELSEWHERE / ELSEWHERE masks in order', async () => {
    expect(await runOut(`program p
  implicit none
  real :: a(5)
  a = [-2., -1., 0., 1., 2.]
  where (a > 0)
    a = 1.0
  elsewhere (a < 0)
    a = -1.0
  elsewhere
    a = 0.0
  end where
  print *, a
end program p`)).toBe('-1.0 -1.0 0.0 1.0 1.0');
  });

  it('binds keyword actual arguments by dummy name', async () => {
    expect(await runOut(`program p
  implicit none
  call show(b=2, a=1)
contains
  subroutine show(a, b)
    integer, intent(in) :: a, b
    print *, a, b
  end subroutine show
end program p`)).toBe('1 2');
  });

  it('keeps a SAVE local between calls', async () => {
    expect(await runOut(`program p
  call tick()
  call tick()
contains
  subroutine tick()
    integer, save :: n = 0
    n = n + 1
    print *, n
  end subroutine tick
end program p`)).toBe('1\n2');
  });

  it('finds an external procedure after a bare main program', async () => {
    expect(await runOut(`implicit none
integer :: n
n = 1
call bump(n)
print *, n
subroutine bump(n)
  integer, intent(inout) :: n
  n = n + 1
end subroutine bump`)).toBe('2');
  });
});

describe('expression and selection details', () => {
  it('matches open-ended CASE ranges on the correct side', async () => {
    expect(await runOut(`program p
  implicit none
  integer :: i
  do i = 1, 5
    select case (i)
    case (:2)
      print *, 'low', i
    case (4:)
      print *, 'high', i
    case default
      print *, 'mid', i
    end select
  end do
end program p`)).toBe('low 1\nlow 2\nmid 3\nhigh 4\nhigh 5');
  });

  it('keeps array-of-derived component sections live', async () => {
    expect(await runOut(`program p
  implicit none
  type :: t
    real :: x = 0.0
  end type t
  type(t) :: ps(3)
  ps%x = [1., 2., 3.]
  ps(2:3)%x = 9.0
  print *, ps%x
end program p`)).toBe('1.0 9.0 9.0');
  });

  it('applies ** right-associatively and unary minus below it', async () => {
    expect(await runOut(`program p
  implicit none
  print *, 2**3**2
  print *, -2**2, (-2)**2
  print *, 7/2, -7/2, mod(-7,2), modulo(-7,2)
end program p`)).toBe('512\n-4 4\n3 -3 -1 1');
  });

  it('supports multi-item implied-DO in an I/O list', async () => {
    expect(await runOut(`program p
  implicit none
  integer :: i
  write(*,'(I2,1X,I2)') (i, i*i, i=1,2)
end program p`)).toBe(' 1  1\n 2  4');
  });
});

describe('HPC-flavoured extras', () => {
  it('runs DO CONCURRENT indices and SYNC ALL', async () => {
    expect(await runOut(`program p
  implicit none
  integer :: a(3,2), i, j
  do concurrent (i = 1:3, j = 1:2)
    a(i,j) = i + j
  end do
  sync all
  print *, a
end program p`)).toBe('2 3 4 3 4 5');
  });

  it('prints hexadecimal, octal and binary fields', async () => {
    expect(await runOut(`program p
  implicit none
  integer :: n
  n = 255
  write(*,'(Z8.8)') n
  write(*,'(B8.8)') n
  write(*,'(O4.4)') n
end program p`)).toBe('000000FF\n11111111\n0377');
  });

  it('saves every local after a bare SAVE statement', async () => {
    expect(await runOut(`program p
  call tick()
  call tick()
contains
  subroutine tick()
    integer :: n
    save
    n = n + 1
    print *, n
  end subroutine tick
end program p`)).toBe('1\n2');
  });
});

describe('kind selection', () => {
  it('picks kinds with SELECTED_REAL_KIND / SELECTED_INT_KIND', async () => {
    expect(await runOut(`program p
  implicit none
  integer, parameter :: dp = selected_real_kind(15, 307)
  integer, parameter :: i8 = selected_int_kind(18)
  print *, dp, i8, selected_real_kind(6, 37), bit_size(0), bit_size(0_8)
end program p`)).toBe('8 8 4 32 64');
  });
});

describe('safety limits', () => {
  it('reports declaration-time errors from load with a line', async () => {
    const session = fortranKernel.createSession();
    const result = await session.load('program p\n  integer :: a(2000000)\nend program p');
    expect(result.ok).toBe(false);
    expect(result.line).toBe(2);
    expect(result.message).toContain('teaching limit');
  });
});

describe('run budget', () => {
  it('stops an empty infinite loop instead of hanging', async () => {
    const session = fortranKernel.createSession();
    await session.load('program p\n  do\n  end do\nend program p');
    const result = await session.run();
    expect(result.finished).toBe(false);
    expect(result.error).toContain('run budget exceeded');
  });
});

describe('review regressions', () => {
  it('rebases assumed-shape dummies to 1 and resolves bounds after all actuals bind', async () => {
    expect(await runOut(`program p
  implicit none
  integer :: a(4)
  a = [4,3,2,1]
  call rev(a,4)
  print *, a
contains
  subroutine rev(x,n)
    integer, intent(inout) :: x(n)
    integer, intent(in) :: n
    integer :: tmp(n), i
    do i=1,n
      tmp(i) = x(n-i+1)
    end do
    x = tmp
  end subroutine rev
end program p`)).toBe('1 2 3 4');
  });

  it('evaluates a dummy CHARACTER length after association and preserves the actual length', async () => {
    expect(await runOut(`program p
  implicit none
  character(len=8) :: s
  s = '        '
  call shout(s,5)
  print *, '[', trim(s), ']', len(s)
contains
  subroutine shout(t,n)
    integer, intent(in) :: n
    character(len=n), intent(inout) :: t
    t = 'hello'
  end subroutine shout
end program p`)).toBe('[ hello ] 8');
  });

  it('assigns the DO variable before a zero-trip loop and leaves the terminating value', async () => {
    expect(await runOut(`program p
  implicit none
  integer :: i
  i = 99
  do i=1,10,3
  end do
  print *, i
  do i=1,0
  end do
  print *, i
end program p`)).toBe('13\n1');
  });

  it('accepts keyword forms of the SELECTED_*_KIND intrinsics', async () => {
    expect(await runOut(`program p
  implicit none
  print *, selected_real_kind(p=15, r=307), selected_int_kind(r=18), selected_char_kind(kind='ascii')
end program p`)).toBe('8 8 1');
  });

  it('honours positional MASK and BACK arguments', async () => {
    expect(await runOut(`program p
  implicit none
  print *, sum([1,2,3],1,[.true.,.false.,.true.])
  print *, maxloc([1,2,2], back=.true.)
  print *, index('abab','ab', back=.true.)
end program p`)).toBe('4\n3\n3');
  });

  it('uses the integer model for DIGITS/RANGE and zero-fills wide shifts', async () => {
    expect(await runOut(`program p
  implicit none
  print *, digits(1), range(1), digits(1_8), range(1_8), ishft(1,32)
end program p`)).toBe('31 9 63 18 0');
  });

  it('reports ERROR STOP as a run error, not a successful exit', async () => {
    const { r } = await run(`program p
  implicit none
  print *, 1
  error stop 'bad'
end program p`);
    expect(r.finished).toBe(false);
    expect(r.error).toBe("line 4: error stop: bad");
  });

  it('treats OPEN/CLOSE as no-ops and still writes to the console', async () => {
    expect(await runOut(`program p
  implicit none
  open(unit=10, file='x')
  write(10,*) 'hello'
  close(10)
end program p`)).toBe('hello');
  });

  it('cycles RESHAPE PAD', async () => {
    expect(await runOut(`program p
  implicit none
  integer :: a(5)
  a = reshape([1,2], [5], pad=[9,8])
  print *, a
end program p`)).toBe('1 2 9 8 9');
  });

  it('registers USE-associated derived types and selects on LOGICAL', async () => {
    expect(await runOut(`module m
  implicit none
  type :: t
    integer :: x
  end type t
end module m
program p
  use m, only: t
  implicit none
  type(t) :: v
  logical :: b
  v%x = 3
  b = .true.
  select case (b)
  case (.true.)
    print *, v%x
  end select
end program p`)).toBe('3');
  });

  it('resumes a block that defines a procedure and applies its own IMPLICIT NONE', async () => {
    const s = fortranKernel.createSession();
    const src = `program p
  implicit none
  integer :: n
  n = 1
  print *, f(n)
contains
  integer function f(x)
    integer, intent(in) :: x
    f = x + 1
  end function f
end program p`;
    expect((await s.load(src)).ok).toBe(true);
    expect((await s.run()).error).toBeUndefined();
    expect((await s.resume!(src)).ok).toBe(true);
    expect((await s.run()).error).toBeUndefined();
    expect(out(s.state()).trimEnd()).toBe('2');

    const t = fortranKernel.createSession();
    await t.load('program p\n  integer :: n\n  n = 1\nend program p');
    await t.run();
    expect((await t.resume!('implicit none\nprint *, nope')).ok).toBe(true);
    const bad = await t.run();
    expect(bad.error).toContain("no implicit typing: 'nope' is not declared");
  });

  it('maps array-cap load failures to the declaration line', async () => {
    const s = fortranKernel.createSession();
    const result = await s.load(`program p
  implicit none
  type :: t
    integer :: x(1000000)
  end type t
  type(t) :: a(10000)
end program p`);
    expect(result.ok).toBe(false);
    expect(result.line).toBe(6);
    expect(result.message).toContain('scalar slots');
  });

  it('keeps the Arrays panel on a caller array after a procedure-local write', async () => {
    const { s } = await run(`program p
  implicit none
  integer :: a(3)
  a = [1,2,3]
  call touch
contains
  subroutine touch
    integer :: b(2)
    b = [7,8]
  end subroutine touch
end program p`);
    expect(rows(s.state(), 'arrays')[0]?.text).toContain('a(1)');
  });
});
