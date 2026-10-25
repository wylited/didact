// The three canonical MIPS programs: fixtures for test/ and test/smoke.ts,
// and the exact source of the executable blocks in
// apps/site/src/pages/mips.org (kept in sync by hand — the page embeds
// verbatim copies of these strings).

const helloProgram = `# hello-mips.asm — your first two syscalls
        .data
msg:    .asciiz "Hello, MIPS!\\n"      # NUL-terminated string in .data
        .text
main:   li      $v0, 4                  # syscall 4: print string at $a0
        la      $a0, msg                # la = load address (a pseudo-op)
        syscall
        li      $v0, 10                 # syscall 10: exit
        syscall`;

const sumProgram = `# sum-1-to-10.asm — accumulate 1..10 in $t0, print it
        .text
main:   li      $t0, 0                  # sum = 0
        li      $t1, 1                  # i = 1
loop:   addu    $t0, $t0, $t1           # sum += i
        addiu   $t1, $t1, 1             # i++
        ble     $t1, 10, loop           # while (i <= 10) loop
        move    $a0, $t0                # print sum (55)
        li      $v0, 1                  # syscall 1: print int in $a0
        syscall
        li      $a0, 10                 # 10 = '\\n'
        li      $v0, 11                 # syscall 11: print char in $a0
        syscall
        li      $v0, 10                 # exit
        syscall`;

const factProgram = `# fact-10.asm — factorial(10) = 3628800 via mult / mflo
        .text
main:   li      $a0, 10                 # n = 10
        jal     fact                    # call fact; $ra <- return address
        move    $a0, $v0                # print the result
        li      $v0, 1
        syscall
        li      $a0, 10                 # '\\n'
        li      $v0, 11
        syscall
        li      $v0, 10
        syscall

fact:   li      $v0, 1                  # result = 1
        li      $t0, 2                  # i = 2
loop:   mult    $v0, $t0                # hi:lo = result * i (a full 64 bits)
        mflo    $v0                     # result <- low 32 bits
        addiu   $t0, $t0, 1             # i++
        ble     $t0, $a0, loop          # while (i <= n)
        jr      $ra                     # return: pc <- $ra`;

export const PROGRAMS = { hello: helloProgram, sum: sumProgram, factorial: factProgram } as const;
