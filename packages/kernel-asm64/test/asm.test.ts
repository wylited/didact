import { describe, expect, it } from 'vitest';
import {
  CODE_BASE,
  assemble,
  lineComments,
  type AssembleResult,
} from '../src/asm';
import type { KeystoneFacade } from '../src/vendor';

/**
 * Deterministic stand-in for Keystone: encodes the exact texts our fixtures
 * produce after label substitution + radix pinning, so the assembler's own
 * contract (layout, two-pass resolution, line map, errors) is asserted
 * independently of the wasm engine.
 */
function fakeKeystone(
  encode: (text: string, addr: number) => number[] | null,
): KeystoneFacade {
  return {
    assemble(text: string, addr: number) {
      const bytes = encode(text, addr);
      return bytes === null
        ? { ok: false }
        : { ok: true, bytes: Uint8Array.from(bytes) };
    },
  } as unknown as KeystoneFacade;
}

/** Encoder for the fixed instruction set used by the fixtures below. */
function stdEncoder(text: string, addr: number): number[] | null {
  if (text === 'ret') return [0xc3];
  if (text === 'syscall') return [0x0f, 0x05];
  if (text === 'mov rax, 0x3c') return [0x48, 0xc7, 0xc0, 0x3c, 0x00, 0x00, 0x00];
  const movRadix = /^mov r(ax|bx|cx|dx), (0[bB][01]+|0[oO][0-7]+)$/.exec(text);
  if (movRadix) {
    // Fixed encoding for prefixed literals: REX.W C7 /0 imm32 carrying the
    // literal's own value — proves the text reached the engine untouched.
    const reg = { ax: 0, cx: 1, dx: 2, bx: 3 }[movRadix[1] as 'ax' | 'bx' | 'cx' | 'dx'];
    const lit = movRadix[2]!;
    const imm = Number.parseInt(lit.slice(2), lit[1] === 'b' || lit[1] === 'B' ? 2 : 8);
    return [0x48, 0xc7, 0xc0 | reg, imm & 0xff, 0, 0, 0];
  }
  const jmp = /^jmp 0x([0-9a-f]+)$/.exec(text);
  if (jmp) {
    // rel8 short jump; verifies the assembler resolved the label to the
    // absolute target and passed the instruction's final address.
    const target = Number.parseInt(jmp[1]!, 16);
    const rel = target - (addr + 2);
    if (rel < -128 || rel > 127) return null;
    return [0xeb, rel & 0xff];
  }
  return null;
}

const ks = () => fakeKeystone(stdEncoder);

describe('assemble: two-pass label resolution', () => {
  it('resolves a forward jmp to a label defined later, shrinking from the rel8 size', () => {
    const src = [
      'start:', // line 1
      '    jmp end', // line 2 (forward reference)
      'end:', // line 3
      '    ret', // line 4
    ].join('\n');

    const r: AssembleResult = assemble(src, ks());
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);

    // start=0x401000 (2-byte jmp), end=0x401002 (1-byte ret).
    expect([...r.program.code]).toEqual([0xeb, 0x00, 0xc3]);
    expect(r.program.labels.get('start')).toBe(CODE_BASE);
    expect(r.program.labels.get('end')).toBe(CODE_BASE + 2);
    expect(r.program.sourceLines).toEqual([
      { line: 2, addr: CODE_BASE, size: 2, text: `jmp 0x${(CODE_BASE + 2).toString(16)}` },
      { line: 4, addr: CODE_BASE + 2, size: 1, text: 'ret' },
    ]);
  });

  it('encodes a backward rel8 jump with a negative displacement byte', () => {
    const src = [
      'start:', // line 1
      '    ret', // line 2 → 1 byte @0x401000
      'loop:', // line 3
      '    jmp start', // line 4 → 2 bytes @0x401001, target 0x401000
    ].join('\n');

    const r = assemble(src, ks());
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);

    // rel = target − (addr + 2) = 0x401000 − 0x401003 = −3 → byte 0xfd.
    expect([...r.program.code]).toEqual([0xc3, 0xeb, 0xfd]);
    expect(r.program.labels.get('start')).toBe(CODE_BASE);
    expect(r.program.labels.get('loop')).toBe(CODE_BASE + 1);
    expect(r.program.sourceLines).toEqual([
      { line: 2, addr: CODE_BASE, size: 1, text: 'ret' },
      { line: 4, addr: CODE_BASE + 1, size: 2, text: `jmp 0x${CODE_BASE.toString(16)}` },
    ]);
    // the displacement byte really is the signed negative offset
    const disp = r.program.code[2]!;
    expect(disp).toBe(0xfd);
    expect((disp << 24) >> 24).toBe(-3);
  });
});

describe('assemble: exact encoding of a fixed instruction sequence', () => {
  it('assembles mov rax,60 / syscall / ret to exact bytes and a correct line map', () => {
    // Decimal 60 must be radix-pinned to 0x3c before reaching the engine.
    const src = [
      'start:', // line 1
      '    mov rax, 60', // line 2 → 7 bytes
      '    syscall', // line 3 → 2 bytes
      '    ret', // line 4 → 1 byte
    ].join('\n');

    const r = assemble(src, ks());
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);

    expect(r.program.code.length).toBe(10);
    expect([...r.program.code]).toEqual([
      0x48, 0xc7, 0xc0, 0x3c, 0x00, 0x00, 0x00,
      0x0f, 0x05,
      0xc3,
    ]);
    expect(r.program.sourceLines).toEqual([
      { line: 2, addr: CODE_BASE, size: 7, text: 'mov rax, 0x3c' },
      { line: 3, addr: CODE_BASE + 7, size: 2, text: 'syscall' },
      { line: 4, addr: CODE_BASE + 9, size: 1, text: 'ret' },
    ]);
  });
});

describe('assemble: radix pinning leaves prefixed literals untouched', () => {
  it('hands 0b/0B/0o/0O literals to the engine verbatim (decimal still pinned)', () => {
    const src = [
      'start:', // line 1
      '    mov rax, 0b101', // line 2 → binary 5
      '    mov rbx, 0B11', // line 3 → binary 3
      '    mov rcx, 0o17', // line 4 → octal 15
      '    mov rdx, 0O7', // line 5 → octal 7
      '    ret', // line 6
    ].join('\n');
    const r = assemble(src, ks());
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);

    // The engine must see the user's literal text: rewriting `0b101` to
    // `0x0b101` (=45313) or `0o17` to `0x0o17` changes or breaks the program.
    expect(r.program.sourceLines.map((l) => l.text)).toEqual([
      'mov rax, 0b101',
      'mov rbx, 0B11',
      'mov rcx, 0o17',
      'mov rdx, 0O7',
      'ret',
    ]);
    // Each `mov r, imm32` is 7 bytes; byte 4 of each is the value the
    // encoder derived from the ORIGINAL literal: 5, 3, 15, 7.
    expect([...r.program.code]).toEqual([
      0x48, 0xc7, 0xc0, 5, 0, 0, 0,
      0x48, 0xc7, 0xc3, 3, 0, 0, 0,
      0x48, 0xc7, 0xc1, 15, 0, 0, 0,
      0x48, 0xc7, 0xc2, 7, 0, 0, 0,
      0xc3,
    ]);
  });
});

describe('assemble: error reporting carries exact 1-based lines', () => {
  it('reports an unknown label on the exact line that references it', () => {
    const src = ['start:', '    mov rax, 60', '    jmp nowhere'].join('\n'); // jmp on line 3
    const r = assemble(src, ks());
    expect(r).toEqual({
      ok: false,
      errors: [{ line: 3, message: "unknown label 'nowhere'" }],
    });
  });

  it('reports an unencodable mnemonic on its exact line', () => {
    const src = ['start:', '    frobnicate rax'].join('\n'); // line 2
    const r = assemble(src, ks());
    expect(r).toEqual({
      ok: false,
      errors: [{ line: 2, message: "cannot assemble this instruction: 'frobnicate rax'" }],
    });
  });

  it('reports two errors on lines 2 and 4 together, in source order', () => {
    const src = [
      'start:', // line 1
      '    frobnicate rax', // line 2 — unencodable
      '    ret', // line 3 — fine
      '    frobnicate rbx', // line 4 — unencodable
    ].join('\n');
    const r = assemble(src, ks());
    expect(r).toEqual({
      ok: false,
      errors: [
        { line: 2, message: "cannot assemble this instruction: 'frobnicate rax'" },
        { line: 4, message: "cannot assemble this instruction: 'frobnicate rbx'" },
      ],
    });
  });
});

describe('lineComments: trailing-comment map', () => {
  it('maps 1-based lines to trimmed comments, skipping uncommented lines and ; inside literals', () => {
    const src = [
      'start:', // 1: no comment
      '    mov rax, 60 ; exit code', // 2
      "    mov bl, ';'", // 3: ';' is a char literal, not a comment
      '    ret', // 4: no comment
      '    syscall   ;   spaced   ', // 5: trimmed
    ].join('\n');
    const map = lineComments(src);
    expect([...map.entries()]).toEqual([
      [2, 'exit code'],
      [5, 'spaced'],
    ]);
  });

  it('the program-level map composes with assemble(): every listing row can find its comment', () => {
    const src = [
      'start:', // 1
      '    mov rax, 60 ; exit code', // 2
      '    syscall', // 3
      '    ret ; done', // 4
    ].join('\n');
    const r = assemble(src, ks());
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);

    // This is exactly how the session derives listing tips: sourceLines ×
    // lineComments — the program-level exposure the comment-map work landed.
    const comments = lineComments(src);
    expect(r.program.sourceLines.map((l) => [l.line, comments.get(l.line)])).toEqual([
      [2, 'exit code'],
      [3, undefined],
      [4, 'done'],
    ]);
  });
});
