# Architecture (v0.2) — kernel-extensible literate system

pnpm monorepo, TypeScript strict everywhere, no UI framework, Vite only at
the app layer. Packages export **source TS** (`main: src/index.ts`); the app
typechecks and bundles them — no per-package build step, no dist artifacts.

```
packages/core            @literate/core     org parser, block runtime, panel host, theme
packages/kernel-asm64    @literate/kernel-asm64   x86-64 via Unicorn/Keystone/Capstone wasm
apps/site                @literate/site     the website (lesson.org + kernel registration)
```

Wiring: app aliases `@literate/core` → `../../packages/core/src` (tsconfig
`paths` + vite `resolve.alias`); same for kernels. One `tsc --noEmit` in
`apps/site` covers all three (include `../../packages/*/src`).

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
      text: string };

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
  | { ok: false; line: number; message: string }; // 1-based source line

export interface RunResult {
  finished: boolean;
  steps: number;
  exit?: string;      // 'exit(0)'
  error?: string;     // budget exceeded, runtime fault, …
}

export interface Session {
  load(src: string): Promise<LoadResult>;
  run(): Promise<RunResult>;
  step(): Promise<{ ran: boolean; result?: RunResult }>;
  reset(): void;                      // back to just-assembled state
  state(): Panel[];                   // full under-the-hood snapshot
  dispose(): void;
}

export interface Kernel {
  readonly id: string;                // org lang tag, e.g. 'asm'
  readonly label: string;             // 'x86-64 · Unicorn'
  createSession(): Session;
}
```

Rules: sessions are single-tenant (one per block); `state()` must be cheap
and complete (core re-renders the whole panel from it); async signatures
today so pyodide-style kernels need no contract change later.

## Core responsibilities (`@literate/core`)

- `parseOrg(src): OrgDoc` — grammar per `docs/design.md`.
- `mountSite({ root, orgSource, kernels, fonts? })` → renders document,
  block runtimes, panel host. Returns handle with `dispose()`.
- Block runtime: CodeMirror 6 editor (Ayu Light), per-block controls +
  status + error box + results slot; running/attached highlights; current
  line decoration on step; `data-test` hooks.
- Panel host: renders `Session.state()` panels (generic renderers for the
  four Panel kinds), attach/detach logic, global tooltip engine for
  `[data-tip]`.
- Styles: the textbook-light theme (CSS custom properties, no radius,
  Atkinson Hyperlegible via @fontsource import, mono stack for code/panel).

## kernel-asm64 responsibilities

- Vendor unicorn/keystone/capstone wasm exactly as v0.1
  `apps/x64-unicorn/public/vendor` (copy it; keep THIRD-PARTY.md + GPLv2
  notes) — but load via ES imports the app can code-split; loading must
  stay fetch-free where possible.
- Port v0.1 `apps/x64-unicorn/src/{asm,machine}.ts` logic: two-pass keystone
  label resolution, syscall interception, budget, stepping (HOOK_CODE),
  context restore — reshaped to `Kernel`/`Session`.
- Panel data: registers fields (+tips per register: role, Linux calling
  convention), EFLAGS fields (+per-flag tips), disassembly listing
  (+per-mnemonic tips for the common set; generic fallback tip), .data
  hexdump, console.
- Exports `asm64Kernel: Kernel` (id `'asm'`).

## apps/site responsibilities

- Thin composition: import lesson.org raw, register `[asm64Kernel]`, mount.
- `src/lesson.org`: port the v0.1 x86-unicorn lesson, updated workflow copy
  (per-block controls, panel attach/detach, tooltips). Two executable blocks
  (hello; sum loop printing 55).
- index.html (noscript in body), favicon optional, title plain text.
