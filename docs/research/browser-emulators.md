# Browser CPU emulators & assemblers for an assembly teaching UI

Research date: 2026-10-23. Goal: fully client-side "literate website" where lessons show
x86-64 assembly, assemble it in the browser, single-step it, display all registers after
each step, and intercept `write` syscalls (`syscall` instruction, RAX=1) to show program
output. ARM/RISC-V support is a future "nice to have".

## TL;DR verdict

**Best pick: `@alexaltea/unicorn-js` (Unicorn 2.1.4 via WASM) + `@alexaltea/keystone-js` (Keystone 0.9.2) for assembly, optionally `@alexaltea/capstone-js` for disassembly labels in the stepping UI.**

Unicorn is the only actively-maintained browser option that exposes exactly the primitives we
need natively: map memory, write machine code at an address, `emu_start(begin, until, timeout, count=1)`
for exact single-stepping, `UC_HOOK_CODE` per-instruction callbacks, `UC_HOOK_INSN` +
`X86_INS_SYSCALL` for syscall interception, and per-register reads (`reg_read_i64`) plus
`mem_read`/`mem_write`. v86/JSLinux/qemu-wasm are full-PC virtual machines: great for
"boot Linux in a tab", wrong shape for an assemble→step→registers widget (no instruction
stepping API, heavy images).

**Runner-up: `ax-x86`** — a tiny purpose-built x86-64 *user-space* WASM emulator with
mnemonic-level hooks, a built-in `write`-syscall recipe, and BigInt register reads. Smallest
and simplest API, but only ~65 mnemonics implemented (no FPU/SSE), AGPL-3.0, and dormant
since 2024.

## Comparison table

| Project | ISA | Stepping API | Register read API | Syscall hook | Size (browser payload) | License | Maturity |
|---|---|---|---|---|---|---|---|
| **@alexaltea/unicorn-js** 2.1.4 | x86-16/32/64, ARM, AArch64, MIPS, PPC, RISC-V, s390x, SPARC, m68k, TriCore | `emu_start(begin, until, 0, 1)` (count=1); `HOOK_CODE` callback per instruction + `emu_stop()` | `reg_read_i32/i64(regid)` per reg (GPRs, RIP, EFLAGS; i64 → BigInt) | `hook_add(HOOK_INSN, cb, data, begin, end, X86_INS_SYSCALL)` | x86-only build **915 KB** (single .js, wasm embedded); all-arch 9.26 MB | GPLv2 | Unicorn core battle-tested (QEMU TCG); JS port refreshed 2026-06, 603★, active |
| **@alexaltea/keystone-js** 0.9.2 (assembler) | x86, ARM, ARM64, MIPS, PPC, SPARC, SystemZ, Hexagon, EVM — **no RISC-V** | n/a (assembler) | n/a | n/a | keystone.js 69 KB + keystone.wasm **4.33 MB** multi-arch (~300 KB/arch if self-built) | GPLv2 (upstream dual GPLv2/commercial) | Upstream Keystone dormant since 0.9.2 (2021) but stable; port republished 2026-06 |
| **@alexaltea/capstone-js** 5.0.9 (disassembler) | x86, ARM, ARM64, MIPS, PPC, SPARC (+ Capstone 5.x set incl. RISC-V) | n/a (disassembler) | n/a | n/a | capstone.js 331 KB + capstone.wasm **3.30 MB** multi-arch | BSD-3-Clause | Port republished 2026-06; Capstone core very mature |
| **v86** 0.5.472 | x86 32-bit only (Pentium-4-ish + SSE3). **No 64-bit, no trap-flag single-step, no debug regs** | none public: debug build's step advances a whole time slice (`cpu.main_loop()`), not one instruction | via debug UI / internal `cpu` object (undocumented for stepping) | none for user code (syscalls happen inside guest Linux kernel) | libv86.mjs + v86.wasm ≈ **19.6 MB** unpacked + BIOS/disk images | BSD-2-Clause | Very mature, 23.6k★, actively pushed (2026-10); official npm `v86` with provenance |
| **JSLinux** (bellard.org) | x86, x86_64 (AVX-512/APX!), RISC-V 32/64 | none (URL params for VM config only) | none | none | served from bellard.org; x86 build **not redistributable** (RISC-V core = TinyEMU, MIT-ish) | proprietary x86 build; old 2011 code "redistribution prohibited" | Maintained by Bellard (AVX-512 added 2026); iframe-embed only |
| **qemu-wasm** (ktock) | x86-64, AArch64, RISC-V 64 full-system QEMU | none exposed (boots whole machines; TCG→WASM JIT) | none | guest-OS level only | no npm; multi-MB WASM + guest images (Alpine demo) | GPLv2 (QEMU) + unmerged experimental patches | Experimental research port (FOSDEM 2025 talk), 408★, last push 2026-02 |
| **ax-x86** 0.6.0 (runner-up) | x86-64 user-mode subset (315 opcodes/65 mnemonics, no FPU/SSE) | `hook_before_mnemonic(Mnemonic.Syscall, …)` + `ax.execute()`; per-mnemonic hooks make stepping easy | `reg_read_64(Register.RAX)` etc. (BigInt) | first-class: README shows full `write` syscall handler recipe | **1.25 MB** npm | **AGPL-3.0** | Small/hobby, 92★, last push 2024-03 — dormant |
| **petabyt/unicorn-wasm** | Unicorn (TCI interpreter build) | C API compiled to wasm; DIY JS binding | same | same | build-it-yourself | GPLv2 | Fork, no npm, minimal docs |
| **@kernelforge/ntsim-unicorn** | Unicorn/QEMU-TCG wasm backend | specialized ntsim backend API | specialized | specialized | npm package | (ntsim-specific) | Niche, tied to ntsim labs |

## Project details

### 1. Unicorn.js (`@alexaltea/unicorn-js`) — the pick

- **Repo:** <https://github.com/AlexAltea/unicorn.js> · **npm:** `@alexaltea/unicorn-js@2.1.4`
  (published 2026-06-19, tracks **Unicorn 2.1.4**) · **CDN:**
  `https://cdn.jsdelivr.net/npm/@alexaltea/unicorn-js/dist/unicorn_x86.js` · **License:** GPLv2
  (Unicorn itself is GPLv2).
- **Package layout:** single-file Emscripten builds with the WASM embedded (no extra .wasm fetch);
  per-arch subpaths: `require('@alexaltea/unicorn-js/x86')` → 915 KB. All-arch `unicorn.js` is
  9.26 MB. Also `arm` (837 KB), `aarch64` (1.52 MB), `riscv` (564 KB) — the same factory API.
- **API surface we need — everything exists** (verified in `src/unicorn-wrapper.js` and
  `tests/test_hooks.js`):

```js
const MUnicorn = require('@alexaltea/unicorn-js/x86');
MUnicorn().then((uc) => {                       // async Emscripten factory (promise)
  const BASE = 0x1000000;
  const e = new uc.Unicorn(uc.ARCH_X86, uc.MODE_64);

  // Load machine code at an address (map RWX page, then write bytes)
  e.mem_map(BASE, 2 * 1024 * 1024, uc.PROT_ALL);
  e.mem_write(BASE, assembledBytes);            // Uint8Array from Keystone

  // Registers: write initial state, read back after each step
  e.reg_write_i64(uc.X86_REG_RSP, BigInt(BASE + 0x100000));
  const rip = e.reg_read_i64(uc.X86_REG_RIP);   // BigInt (built with WASM_BIGINT)
  const rax = e.reg_read_i64(uc.X86_REG_RAX);
  // …same for RBX..R15, X86_REG_EFLAGS, X86_REG_RIP, segment regs, ST/XMM via raw reg_write

  // Per-instruction callback (UC_HOOK_CODE) — fires synchronously before each insn
  e.hook_add(uc.HOOK_CODE, (ucHandle, address, size, userData) => {
    // address arrives as BigInt ('vijii' signature); snapshot regs here for the UI
  }, {}, BASE, BASE + codeLen);                  // begin/end range filters the hook

  // x86-64 syscall interception (UC_HOOK_INSN + X86_INS_SYSCALL):
  // trailing arg = instruction id to match (variadic uc_hook_add extra)
  e.hook_add(uc.HOOK_INSN, () => {
    const nr   = e.reg_read_i64(uc.X86_REG_RAX);   // 1 = write
    const fd   = e.reg_read_i64(uc.X86_REG_RDI);
    const buf  = e.reg_read_i64(uc.X86_REG_RSI);
    const len  = e.reg_read_i64(uc.X86_REG_RDX);
    const text = new TextDecoder().decode(e.mem_read(Number(buf), Number(len)));
    showOutput(text);                               // teach: this is write(1, …)
    e.reg_write_i64(uc.X86_REG_RAX, len);           // return value
    // Unicorn treats the syscall insn as executed; no manual RIP fix-up
  }, {}, BASE, BASE + codeLen, uc.X86_INS_SYSCALL);

  // Exact single-step: emu_start(begin, until, timeout, count) — count=1 runs ONE insn
  e.emu_start(ripNow, 0, 0, 1);
  // …or run-to-end / run-until with a HOOK_CODE that calls e.emu_stop() on a breakpoint
});
```

- Reference syscall-hook semantics: Unicorn's own `samples/sample_x86.c` does
  `uc_hook_add(uc, &h, UC_HOOK_INSN, hook_syscall, NULL, 1, 0, UC_X86_INS_SYSCALL)` where the
  callback reads `UC_X86_REG_RAX` (nr), services it, writes RAX back; the engine then continues
  past the `syscall` (bytes `0F 05`).
- Also available: `context_alloc/save/restore` (cheap CPU-state snapshots → time-travel UI,
  cheaper than re-running), `mem_read/mem_write/mem_map/mem_protect/mem_unmap`,
  `hook_add(HOOK_MEM_* …)` for watchpoints, `ctl_set_cpu_model` (pick e.g. Skylake for newer
  insn coverage), and `query(MODE)`.
- **Pros:** exactly the teaching primitives; mature QEMU-derived x86-64 core (full SSE/AVX
  depending on CPU model); per-arch 915 KB build; fresh npm publish (June 2026) with a Node
  test suite (`npm test` runs `test_hooks.js` covering the syscall hook path); single-arch
  variants for ARM/RISC-V lessons later.
- **Cons:** **GPLv2** — fine for a client-side educational site (the license triggers
  obligations when you distribute; shipping the wasm blob publicly counts as distribution, so
  the site's own glue needn't be GPL but the emu source must remain available — have legal
  eyes on it if the site is commercial); Emscripten marshalling caveats below; no
  assembler/disassembler included (pair with Keystone/Capstone).

### 2. Keystone.js (`@alexaltea/keystone-js`) — the assembler half

- **Repo:** <https://github.com/AlexAltea/keystone.js> · **npm:** `@alexaltea/keystone-js@0.9.2`
  (published 2026-06-16) · **License:** GPLv2 (upstream is dual GPLv2/commercial).
- **Size:** loader 69 KB + `keystone.wasm` 4.33 MB multi-arch; README notes a per-platform
  subset averages ~300 KB but only the full bundle is on npm (self-build with
  `python3 build.py x86` for a slim one).

```js
import MKeystone from "@alexaltea/keystone-js";
MKeystone().then((ks) => {
  const a = new ks.Keystone(ks.ARCH_X86, ks.MODE_64);
  a.option(ks.OPT_SYNTAX, ks.OPT_SYNTAX_INTEL);
  const result = a.asm("inc rax\nmov rbx, 42");
  // result.failed, result.count, result.mc = Uint8Array machine code
  a.close();
});
```

- **Pros:** Intel or AT&T syntax; instant text→bytes in-browser; same author/idiom as
  unicorn.js and capstone.js (three-piece toolchain); x86-32/64 + ARM/AArch64/MIPS.
- **Cons / gotchas:** **no assembler directives or sections** (`.text`, `.data` etc. fail —
  keystone-engine issue #204); **labels work only within one `asm()` call and the base
  address is NOT applied to label resolution** (keystone-engine issue #43) — for
  `loop:`/`jmp loop` teaching code, pass the real load address or compute displacements
  yourself; **no RISC-V** in upstream Keystone; upstream engine dormant (0.9.2 ≈ 2021) but
  stable for basic x86-64 lessons.

### 3. Capstone.js (`@alexaltea/capstone-js`) — optional disassembler for the UI

- **Repo:** <https://github.com/AlexAltea/capstone.js> · **npm:** `@alexaltea/capstone-js@5.0.9`
  (published 2026-06-15, Capstone 5.x) · **License:** BSD-3-Clause (permissive!).
- **Size:** loader 331 KB + `capstone.wasm` 3.30 MB multi-arch.

```js
MCapstone().then((cs) => {
  const d = new cs.Capstone(cs.ARCH_X86, cs.MODE_64);
  d.disasm(new Uint8Array([0x55, 0x31, 0xD2]), 0x10000)
   .forEach(i => console.log(i.address.toString(16), i.mnemonic, i.op_str));
  d.close();
});
```

Use it to render the "current instruction" line (mnemonic + operands + bytes) next to the
register panel each step. Keystone knows what it assembled, but Capstone also decodes
anything a student pastes; BSD license is uncontaminated.

### 4. v86 (`copy/v86`, npm `v86`)

- **Repo:** <https://github.com/copy/v86> (23.6k★, pushed 2026-10) · **npm:** `v86@0.5.472`
  (official, provenance-published from CI) · **Site:** <https://copy.sh/v86/> · **License:**
  BSD-2-Clause · **Size:** ~19.6 MB package + BIOS/VGA ROMs + guest images.
- **API:** constructor `new V86({ screen_container, bios:{url}, vga_bios:{url}, cdrom:{url},
  autostart:true })`; TypeScript defs in `v86.d.ts`; examples for serial, save/restore state,
  two instances, networking. There is also `emulator.save_state()/restore_state()`.
- **Dealbreakers for us** (from the project's own README):
  - "**Single stepping (trap flag, debug registers)**" is on the *missing features* list.
  - "**64-bit extensions**" are on the *missing features* list — x86-64 guest code can't run.
  - The debug build's "step" runs one scheduler time slice (`emulator.v86.cpu.main_loop()`),
    i.e. many instructions, not one; registers are only inspectable at those burst boundaries.
  - It's a full PC: to get a `write` syscall you must boot a whole Linux image; you can't
    intercept instruction-level syscalls from the embedding API.
- **Where it fits:** if we later want a lesson like "here is a real Linux boot", embed v86 in
  an iframe/panel next to the micro-stepping lessons. Not the stepping engine.

### 5. JSLinux (bellard.org)

- **Site:** <https://bellard.org/jslinux/> (x86, x86_64 with AVX-512/APX, RISC-V 32/64).
- **Embedding:** URL-parameter iframe only, e.g.
  `https://bellard.org/jslinux/vm.html?cpu=x86&url=buildroot-x86.cfg&mem=128`. No JS API, no
  stepping, no register access, no syscall hooks.
- **License:** the current x86 build is **not redistributable**; only the RISC-V engine is
  available via TinyEMU (MIT-style). Old deobfuscated 2011 copies explicitly forbid
  redistribution. Fine to hotlink for a "look, real Linux" sidebar; unusable as a component.

### 6. qemu-wasm (`ktock/qemu-wasm`)

- **Repo:** <https://github.com/ktock/qemu-wasm> · **Demo:**
  <https://ktock.github.io/qemu-wasm-demo/alpine-x86_64.html> (boots Alpine x86-64; TCG JIT
  emitting WASM) · **License:** GPLv2, experimental unmerged QEMU patches; no npm; last push
  2026-02; ~408★.
- Full-system emulator with whole-machine payloads; no per-instruction or register API from
  JS. Interesting only as a future "run a compiled C program under a real kernel" demo, and it
  is heavy (multi-MB WASM + disk images) and experimental (FOSDEM 2025). Not a teaching-step
  engine.

### 7. ax (`ax-x86`) — runner-up

- **Repo:** <https://github.com/xarantolus/ax> · **npm:** `ax-x86@0.6.0` (2023-02; repo last
  push 2024-03) · **License:** **AGPL-3.0** · **Size:** 1.25 MB.
- Purpose-built Rust→WASM x86-64 *user-space* emulator; API is refreshingly direct:

```js
import init, { Axecutor, Mnemonic, Register } from 'ax-x86';
await init();
const ax = new Axecutor(code, 0x1000n, 0x1000n);      // BigInt addresses!
ax.hook_before_mnemonic(Mnemonic.Syscall, async (ax) => {
  const [nr, fd, buf, len] = [ax.reg_read_64(Register.RAX), /*RDI*/…, /*RSI*/…, /*RDX*/…];
  if (nr === 1n) print(new TextDecoder().decode(ax.mem_read_bytes(buf, len)));
  ax.reg_write_64(Register.RAX, len);
  return ax.commit();                                  // commit() | stop() | unchanged()
});
await ax.execute();
const rax = ax.reg_read_64(Register.RAX);
```

- **Pros:** smallest payload; SysV-ABI stack setup (`init_stack_program_start`), ELF loading,
  mnemonic hooks (step on any instruction class), README literally documents the `write`
  syscall recipe; used by a real teaching playground (MemeAssembly playground).
- **Cons:** only 315 opcodes / 65 mnemonics (37 complete) — covers mov/arith/jmp/call/push/pop
  but no FPU/SSE; flags limited to CF/PF/ZF/SF/OF; AGPL-3.0 (stronger copyleft than GPLv2);
  dormant ~2.5 years. Great fallback if unicorn.js proves too heavy or too GPL-awkward, but
  students will quickly hit unimplemented instructions.

### Other Unicorn-WASM ports (for completeness)

- `petabyt/unicorn-wasm` — Unicorn with TCI (interpreter) patches so it compiles to WASM
  without a JIT backend; build-your-own, no npm binding, README is stock Unicorn. GPLv2.
- `@kernelforge/ntsim-unicorn` (npm) — Unicorn/QEMU-TCG WASM backend purpose-built for the
  ntsim teaching labs; API is lab-specific.

## Emscripten / async pitfalls (unicorn.js, keystone.js, capstone.js)

1. **Everything is async at init only.** `MUnicorn()`, `MKeystone()`, `MCapstone()` return
   Promises that resolve once the WASM is fetched+compiled. After that, all calls
   (`emu_start`, `asm`, `reg_read`) are **synchronous** — they'll block the UI thread. For a
   teaching UI this is fine (one instruction is microseconds), but "run 10M instructions"
   must be chunked (e.g. N steps per `requestAnimationFrame` tick) or moved to a Worker.
2. **64-bit values are BigInts, not Numbers.** The 2026 builds use Emscripten's
   `WASM_BIGINT`: `mem_write`/`emu_start` take `BigInt` addresses, `reg_read_i64` returns
   `BigInt`, and `HOOK_CODE` callback addresses arrive as `BigInt` (signature `'vijii'`).
   Old unicorn.js ports (pre-2026, e.g. the 2016–2018 era code floating on CDNs) lost
   precision passing u64 through JS doubles — do **not** use those; pin
   `@alexaltea/unicorn-js@2.1.4`.
3. **Variadic `uc_hook_add` marshalling for `HOOK_INSN`.** The C API is variadic; on wasm32
   the JS wrapper hand-builds a `va_list` buffer so the trailing `extra` argument
   (`X86_INS_SYSCALL`) reaches `va_arg`. This is the single most fragile line of glue —
   upstream regression-tests it in `tests/test_hooks.js` ("if that marshalling is wrong …
   the hook never matches SYSCALL"). If you fork or rebuild, keep that test.
4. **Hook callbacks must not throw.** They're invoked synchronously from C via
   `Module.addFunction`. A JS exception inside a callback will not propagate as a clean C
   error — wrap hook bodies in `try/catch`, record the error, and call `e.emu_stop()` to
   unwind to JS. (Unicorn also exposes `ERR_EXCEPTION` for C-side throws.)
5. **Manual resource lifetime.** Every `hook_add` allocates an Emscripten function-table
   slot + a C-side hook; `hook_del(h)` (or `e.close()`) is required — GC won't collect them.
   Prefer one engine instance per lesson run, or save/restore contexts
   (`context_alloc`/`context_save`/`context_restore`) instead of re-instantiating.
6. **Emscripten HEAP copies.** Each `reg_read`/`mem_read` mallocs a temp HEAP buffer and
   copies. Reading the 16 GPRs + RIP + flags per step is ~19 small ccall round-trips — fine
   for stepping UX; avoid in tight run loops (read on stop instead, or use `HOOK_CODE` to
   snapshot lazily).
7. **`emu_start(begin, until, timeout, count)` semantics.** `until=0` means "no stop
   address"; `count=1` gives exact single-instruction steps; `timeout` is µs (`0` =
   infinite). After a step, read `X86_REG_RIP` to learn where to resume. Errors throw JS
   strings with `uc_strerror` text (`ERR_FETCH_UNMAPPED` etc.) — map them to friendly
   lesson messages ("your jump left mapped memory").
8. **One Module instance per emscripten factory.** The dist files each export a factory;
   creating multiple `Unicorn` objects is fine, but the underlying WASM memory is shared
   per factory instance. If you run lessons in parallel (multiple code panes), instantiate
   the factory once and create several `Unicorn` handles, or spawn one Worker per pane.

## ARM / RISC-V outlook

- **Unicorn.js**: first-class — per-arch builds `unicorn_arm.js` (837 KB),
  `unicorn_aarch64.js` (1.52 MB), `unicorn_riscv.js` (564 KB), with `ARCH_RISCV` /
  `MODE_RISCV64` and RISCV_REG_* constants included. The same step/hook/syscall (ECALL via
  HOOK_INTR/INSN) model applies.
- **Keystone.js**: ARM, ARM64, MIPS, PPC, SPARC, SystemZ, Hexagon — **no RISC-V assembler**.
  A future RISC-V lesson would need a different assembler (e.g. a small WASM build of GNU as,
  or hand-rolled encoder for the tiny RV32I subset taught).
- **Capstone.js 5.x**: decodes ARM/AArch64 and (Capstone 5) RISC-V, so the UI disassembly
  panel extends naturally.
- **qemu-wasm/JSLinux**: both run RISC-V system images, but see caveats above.

## Decision

- **Pick:** `@alexaltea/unicorn-js/x86` (915 KB, GPLv2) as the stepping engine +
  `@alexaltea/keystone-js` (assembler; note label/directive limits) + optionally
  `@alexaltea/capstone-js` (BSD-3, disassembly view). This trio covers assemble → load →
  single-step → registers → syscall intercept entirely client-side with documented,
  tested APIs, and Unicorn's per-arch builds give ARM/RISC-V headroom (modulo a RISC-V
  assembler).
- **Runner-up:** `ax-x86` (1.25 MB, AGPL-3.0) if we want the smallest possible stack and can
  live within ~65 mnemonics and a dormant upstream; its README's write-syscall hook is
  almost exactly our lesson 1.
- **Do not build the stepping UI on** v86 (no 64-bit, no trap-flag stepping), JSLinux (no
  API, no redistribution), or qemu-wasm (full-system, experimental).

## Links

- Unicorn.js: https://github.com/AlexAltea/unicorn.js · https://www.npmjs.com/package/@alexaltea/unicorn-js · wrapper source: `src/unicorn-wrapper.js`, syscall-hook test: `tests/test_hooks.js`
- Unicorn C API syscall sample: `samples/sample_x86.c` in https://github.com/unicorn-engine/unicorn
- Keystone.js: https://github.com/AlexAltea/keystone.js · label caveats: keystone-engine issues #43, #204
- Capstone.js: https://github.com/AlexAltea/capstone.js
- v86: https://github.com/copy/v86 · https://www.npmjs.com/package/v86 · https://copy.sh/v86/
- JSLinux: https://bellard.org/jslinux/ (faq.html, tech.html) · TinyEMU: https://bellard.org/tinyemu/
- qemu-wasm: https://github.com/ktock/qemu-wasm · demo: https://ktock.github.io/qemu-wasm-demo/
- ax: https://github.com/xarantolus/ax · https://www.npmjs.com/package/ax-x86 · docs: https://ax.010.one/docs/
- unicorn-wasm (TCI fork): https://github.com/petabyt/unicorn-wasm · ntsim backend: https://www.npmjs.com/package/@kernelforge/ntsim-unicorn
