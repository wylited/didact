// Teaching tooltips: concise, textbook-register explanations for every
// panel section, register, flag, and the common instruction set.

/** Per-register tooltips: name, role, and Linux x86-64 ABI usage. */
export const REGISTER_TIPS: Record<string, string> = {
  rax: 'Accumulator. General-purpose; in the Linux x86-64 ABI it carries the syscall number and holds the return value of a call.',
  rbx: 'Base. Callee-saved general-purpose register; a function must restore it before returning.',
  rcx: 'Counter. Fourth function argument in the Linux x86-64 ABI; also used by shift/rotate instructions as the count.',
  rdx: 'Data. Third function argument; the high half of multiply/divide results; with rax, the second half of 128-bit products.',
  rsi: 'Source index. Second function argument; traditionally the source pointer for string/memory operations.',
  rdi: 'Destination index. First function argument; traditionally the destination pointer for string/memory operations.',
  rbp: 'Base pointer. Callee-saved frame pointer that marks the start of the current stack frame; commonly repurposed as a general register.',
  rsp: 'Stack pointer. Points at the last value pushed onto the stack; push/pop/call/ret update it automatically.',
  r8: 'Fifth function argument in the Linux x86-64 ABI; otherwise general-purpose.',
  r9: 'Sixth function argument in the Linux x86-64 ABI; otherwise general-purpose.',
  r10: 'General-purpose scratch register; the Linux kernel copies the syscall number from rax into r10 inside syscalls.',
  r11: 'General-purpose scratch register; commonly used for intermediate results that need not survive a call.',
  r12: 'Callee-saved general-purpose register; a function must restore it before returning.',
  r13: 'Callee-saved general-purpose register; a function must restore it before returning.',
  r14: 'Callee-saved general-purpose register; a function must restore it before returning.',
  r15: 'Callee-saved general-purpose register; a function must restore it before returning.',
  rip: 'Instruction pointer. Holds the address of the next instruction to execute; jumps and calls overwrite it.',
};

/** Per-flag tooltips: what the flag means and when the CPU sets it. */
export const FLAG_TIPS: Record<string, string> = {
  ZF: 'Zero flag. Set when the result of an operation is zero — cmp sets it when its two operands are equal.',
  CF: 'Carry flag. Set when an unsigned arithmetic result does not fit in the destination, e.g. a subtraction that goes below zero.',
  SF: 'Sign flag. Copies the most significant bit of the result; set when a signed result is negative.',
  OF: 'Overflow flag. Set when a signed result has the wrong sign — e.g. adding two positives yields a negative.',
  PF: 'Parity flag. Set when the low byte of the result contains an even number of 1 bits.',
  AF: 'Auxiliary carry flag. Set when a carry or borrow occurred between the low and high nibbles of the result; used by BCD arithmetic.',
};

/** Section-level tooltips for the five under-the-hood panels. */
export const SECTION_TIPS = {
  registers:
    'The 16 general-purpose 64-bit registers plus rip. Each shows the raw hex value and the same bits read as a signed decimal number; a value that changed in the last step is highlighted. Under the Linux x86-64 ABI, arguments arrive in rdi, rsi, rdx, rcx, r8, r9 and results come back in rax.',
  flags:
    'The status flags inside EFLAGS. cmp and test set them from their operands; conditional jumps read them to decide whether to branch.',
  disassembly:
    'The assembled machine code, one instruction per row: address, raw bytes, and the decoded mnemonic. The highlighted row is where rip points — the next instruction to execute; the source line shows which block line produced it.',
  memory:
    'The first 256 bytes of the .data section at 0x601000, 16 bytes per row with an ASCII rendering on the right. Byte values changed by the program appear here live.',
  output:
    'Program output. write(1, …) and write(2, …) syscalls append their bytes here as UTF-8 text, up to 1 MiB.',
} as const;

const MNEMONIC_TIPS: Record<string, string> = {
  mov: 'Copies the right operand into the left one; memory-to-memory and immediate-to-memory sizing rules apply.',
  lea: 'Loads the address of the right operand (not its contents) into the left one — handy for address arithmetic.',
  add: 'Adds the right operand to the left one and stores the result in the left; sets the arithmetic flags.',
  sub: 'Subtracts the right operand from the left one and stores the result in the left; sets the arithmetic flags.',
  imul: 'Signed multiply: one-operand form multiplies rax, two/three-operand forms multiply the given operands.',
  idiv: 'Signed divide: divides rdx:rax (or the smaller pair for 32/16/8-bit) by the operand; quotient in rax, remainder in rdx.',
  cmp: 'Compares by subtracting the right operand from the left and only keeping the flags — the operands stay unchanged.',
  test: 'Tests by AND-ing the operands and only keeping the flags; test rax, rax checks rax for zero/sign.',
  jmp: 'Unconditional jump: rips to the target label or address.',
  call: 'Pushes the return address and jumps to the target — the start of a procedure.',
  ret: 'Pops the return address call pushed and jumps back to it.',
  push: 'Decrements rsp and stores the operand at the new top of stack.',
  pop: 'Loads the value at the top of stack into the operand and increments rsp.',
  syscall: 'Enters the kernel: rax selects the syscall, arguments come in rdi, rsi, rdx, r10, r8, r9, result returns in rax.',
  nop: 'Does nothing except advance rip — a one-byte placeholder.',
};

// Conditional-jump family: one teaching sentence per condition suffix.
const JCC_TIPS: Record<string, string> = {
  e: 'Jumps when ZF=1, i.e. the two compared values are equal.',
  z: 'Jumps when ZF=1, i.e. the two compared values are equal.',
  ne: 'Jumps when ZF=0, i.e. the two compared values differ.',
  nz: 'Jumps when ZF=0, i.e. the two compared values differ.',
  s: 'Jumps when SF=1, i.e. the (signed) result was negative.',
  ns: 'Jumps when SF=0, i.e. the (signed) result was non-negative.',
  g: 'Jumps when signed greater-than: ZF=0 and SF=OF.',
  nle: 'Jumps when signed greater-than: ZF=0 and SF=OF.',
  ge: 'Jumps when signed greater-or-equal: SF=OF.',
  nl: 'Jumps when signed greater-or-equal: SF=OF.',
  l: 'Jumps when signed less-than: SF≠OF.',
  nge: 'Jumps when signed less-than: SF≠OF.',
  le: 'Jumps when signed less-or-equal: ZF=1 or SF≠OF.',
  ng: 'Jumps when signed less-or-equal: ZF=1 or SF≠OF.',
  a: 'Jumps when unsigned above: CF=0 and ZF=0.',
  nbe: 'Jumps when unsigned above: CF=0 and ZF=0.',
  ae: 'Jumps when unsigned above-or-equal: CF=0.',
  nb: 'Jumps when unsigned above-or-equal: CF=0.',
  nc: 'Jumps when unsigned above-or-equal: CF=0 (no carry).',
  b: 'Jumps when unsigned below: CF=1.',
  nae: 'Jumps when unsigned below: CF=1.',
  c: 'Jumps when unsigned below: CF=1 (carry).',
  be: 'Jumps when unsigned below-or-equal: CF=1 or ZF=1.',
  na: 'Jumps when unsigned below-or-equal: CF=1 or ZF=1.',
  o: 'Jumps when OF=1 (signed overflow occurred).',
  no: 'Jumps when OF=0 (no signed overflow).',
  p: 'Jumps when PF=1 (even parity).',
  pe: 'Jumps when PF=1 (even parity).',
  np: 'Jumps when PF=0 (odd parity).',
  po: 'Jumps when PF=0 (odd parity).',
};

/**
 * Tooltip for one disassembly row. Covers the common teaching set, the whole
 * conditional-jump family, and a generic fallback.
 */
export function mnemonicTip(text: string): string {
  const mnemonic = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (MNEMONIC_TIPS[mnemonic]) return MNEMONIC_TIPS[mnemonic];
  if (mnemonic === 'j') return 'Unconditional jump: rip is set to the target address.';
  if (mnemonic.startsWith('j')) {
    const cond = JCC_TIPS[mnemonic.slice(1)];
    if (cond) return `Conditional jump: ${cond}`;
    return `A jump instruction — executes in one step; rip moves to the target only when its condition holds.`;
  }
  if (mnemonic.startsWith('set')) {
    return 'Sets its byte operand to 1 when the condition holds, 0 otherwise.';
  }
  return `The ${mnemonic || 'instruction'} executes in one step — advance a step to watch its effect on the registers, flags and memory.`;
}
