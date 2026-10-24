# Architecture (v0.2) — kernel-extensible literate system

pnpm monorepo, TypeScript strict everywhere, no UI framework, Vite only at
the app layer. Packages export **source TS** (`main: src/index.ts`); the app
typechecks and bundles them — no per-package build step, no dist artifacts.

```
packages/core            @literate/core           org parser, block runtime, panel host, theme
packages/kernel-asm64    @literate/kernel-asm64   x86-64 via Unicorn/Keystone/Capstone wasm
packages/kernel-riscv    @literate/kernel-riscv   RV32IM interpreter (pure TypeScript)
packages/kernel-mips     @literate/kernel-mips    MIPS32 interpreter (pure TypeScript)
packages/kernel-c        @literate/kernel-c       C via vendored clang wasm (wasm32-wasi)
packages/kernel-python   @literate/kernel-python  Python via vendored Pyodide
packages/kernel-typst    @literate/kernel-typst   Typst via vendored compiler wasm + fonts
apps/site                @literate/site           the website (src/pages/*.org + kernel registration)
```

Wiring: app aliases `@literate/core` and each `@literate/kernel-*` →
`../../packages/*/src` (tsconfig `paths` + vite `resolve.alias`); one
`tsc --noEmit` in `apps/site` covers all packages (include
`../../packages/*/src`).

## Kernel contract (owned by core, verbatim)

`packages/core/src/kernel.ts`:

```ts
/** One rendered under-the-hood section. */
export type Panel =
  | { kind: 'fields'; id: string; title: string; tip?: string;
      fields: Field[] }
  | { kind: 'listing'; id: string; title: string; tip?: string;
      rows: ListingRow[] }
  | { kind: 'hexdump'; id: string; title: string; tip?: string;
      rows: { addr: number; bytes: number[]; ascii: string }[] }
  | { kind: 'console'; id: string; title: string; tip?: string;
      text: string }
  /** Trusted kernel-generated markup (e.g. rendered SVG), never raw user
   *  input; rendered inline in the panel and the block's results slot. */
  | { kind: 'html'; id: string; title: string; tip?: string;
      html: string };

export interface Field {
  key: string;          // 'rax' | 'ZF' | …
  value: string;        // hex display
  sub?: string;         // signed decimal etc.
  changed?: boolean;    // since previous step
  tip?: string;         // hover explanation (teaching text)
}

export interface ListingRow {
  addr: number;
  bytes: string;        // rendered hex bytes
  text: string;         // mnemonic + operands
  line?: number;        // 1-based source line in the block
  current?: boolean;
  tip?: string;
}

export type LoadResult =
  | { ok: true; summary: string }                 // 'loaded · 8 instructions'
  | { ok: false; line?: number; message: string }; // 1-based source line, if known

export interface RunResult {
  finished: boolean;
  steps: number;
  exit?: string;      // 'exit(0)'
  error?: string;     // budget exceeded, runtime fault, …
  /** 1-based source line where execution paused at a breakpoint. */
  pausedAt?: number;
}

export interface Session {
  load(src: string): Promise<LoadResult>;
  /**
   * Run to completion, or stop immediately *before* executing any
   * instruction whose 1-based source line is in `breakpoints`. Kernels
   * that cannot honor breakpoints ignore the argument.
   */
  run(breakpoints?: number[]): Promise<RunResult>;
  step(): Promise<{ ran: boolean; result?: RunResult }>;
  reset(): void;                      // back to just-assembled state
  state(): Panel[];                   // full under-the-hood snapshot
  dispose(): void;
}

export interface Kernel {
  readonly id: string;                // org lang tag, e.g. 'asm'
  readonly label: string;             // 'x86-64 · Unicorn'
  /** UI capabilities; a missing/false flag hides the affordance. */
  readonly features?: { breakpoints?: boolean; stepping?: boolean };
  /** Editor syntax for this kernel's blocks; mapped to a CodeMirror
   *  language by core (see packages/core/src/languages.ts). */
  readonly editorSyntax?:
    | 'asm-intel'
    | 'asm-riscv'
    | 'asm-mips'
    | 'c'
    | 'python'
    | 'plain';
  createSession(): Session;
}
```

Rules: sessions are single-tenant (one per block); `state()` must be cheap
and complete (core re-renders the whole panel from it); async signatures
today so pyodide-style kernels need no contract change later.

## Core responsibilities (`@literate/core`)


- `parseOrg(src): OrgDoc` — grammar per `docs/design.md`.
- `mountSite({ root, fonts?, kernels, pages })` → renders the nav bar +
  active page document, block runtimes, panel host. Handle exposes
  `blocks`, `panel`, `activeIndex`, `show(index)`, `dispose()`.
- Block runtime: CodeMirror 6 editor (Ayu Light), per-block controls +
  status + error box + results slot; running/attached highlights; current
  line decoration on step and breakpoint pause; gutter breakpoints when
  `features.breakpoints` (Step button hidden when `features.stepping ===
  false`); `data-test` hooks.
- Panel host: renders `Session.state()` panels (generic renderers for the
  five Panel kinds, `html` via trusted `innerHTML`), attach/detach
  (detach unmounts the panel and collapses the layout), global tooltip
  engine for `[data-tip]` — comment-only tooltips on listing rows.
- Styles: the textbook-light theme (CSS custom properties, no radius,
  Atkinson Hyperlegible via @fontsource import, mono stack for code/panel,
  nav bar + detached single-column state).

## kernel-asm64 responsibilities

- Vendor unicorn/keystone/capstone wasm under `packages/kernel-asm64/vendor/`
  (licenses in THIRD-PARTY.md + GPLv2 notes), copied to
  `apps/site/public/vendor/` for serving; load via ES imports the app can
  code-split; loading must stay fetch-free where possible.
- Two-pass keystone label resolution, syscall interception, budget,
  stepping (HOOK_CODE), context restore — shaped to `Kernel`/`Session`.
- Panel data: registers fields, EFLAGS fields, disassembly listing
  (row `tip` = the source line's trailing `;` comment), .data hexdump,
  console.
- Exports `asm64Kernel: Kernel` (id `'asm'`, editorSyntax `'asm-intel'`).

## apps/site responsibilities

- Thin composition: glob `src/pages/*.org` raw, order them by the
  `PAGE_ORDER` array in `src/main.ts` (stems of the page files; the nav
  title comes from each file's `#+TITLE:` line), register
  `[asm64Kernel, riscvKernel, mipsKernel, cKernel, pythonKernel,
  typstKernel]`, mount with `pages`.
- `src/pages/*.org`: one lesson per kernel (`x86-64-assembly`, `riscv`,
  `mips`, `c`, `python`, `typst`), with per-block controls, breakpoints,
  panel attach/detach, pages.
- index.html (noscript in body), favicon optional, title plain text.
