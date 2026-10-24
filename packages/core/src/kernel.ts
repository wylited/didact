// kernel.ts — the kernel contract, verbatim from docs/architecture.md.
// Kernels implement `Kernel`; each executable block owns one `Session`.

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
  | { ok: false; line: number; message: string }; // 1-based source line

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
  createSession(): Session;
}

