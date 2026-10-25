// Loader for the Emscripten builds (@alexaltea/* npm dependencies).
//
// How each wrapper finds its WASM (verified by reading the shipped sources):
//  - unicorn_x86.js  — classic-script UMD defining global `MUnicorn`; the x86
//    WASM binary is EMBEDDED in the JS (findWasmBinary() → binaryDecode(...)),
//    so no .wasm fetch happens at all.
//  - keystone.js / capstone.js — classic-script UMD defining globals
//    `MKeystone` / `MCapstone`; each fetches `<name>.wasm` resolved through
//    Emscripten's locateFile() (default: scriptDirectory + name). We pass an
//    explicit `locateFile` AND a pre-fetched `wasmBinary` so resolution never
//    depends on document.currentScript or the page base path.
//
// The assets are served as plain static files: sync-vendors copies them
// from node_modules into the app's public root, and the default base
// `<page-base>/vendor/` resolves correctly under Vite dev/build/preview
// with base './'. If the app serves them elsewhere it calls
// setVendorBase() before creating a session. No network
// beyond same-origin asset fetches happens at runtime.

export interface KeystoneAsmResult {
  mc: Uint8Array;
  count: number;
  failed: boolean;
}

export interface KeystoneAssembler {
  asm(assembly: string, address?: number | bigint): KeystoneAsmResult;
  option(opt: number, value: number): void;
  close(): void;
}

export interface KeystoneModule {
  Keystone: new (arch: number, mode: number) => KeystoneAssembler;
  ARCH_X86: number;
  MODE_64: number;
  OPT_SYNTAX: number;
  OPT_SYNTAX_INTEL: number;
}

export interface CsInstruction {
  address: number;
  size: number;
  bytes: Uint8Array;
  mnemonic: string;
  op_str: string;
}

export interface CapstoneDisassembler {
  disasm(code: Uint8Array, address: number | bigint): CsInstruction[];
  close(): void;
}

export interface CapstoneModule {
  Capstone: new (arch: number, mode: number) => CapstoneDisassembler;
  ARCH_X86: number;
  MODE_64: number;
}

export interface UnicornInstance {
  mem_map(addr: number, size: number, prot: number): void;
  mem_write(addr: number, bytes: Uint8Array): void;
  mem_read(addr: number, size: number): Uint8Array;
  reg_write_i64(regid: number, value: bigint): void;
  reg_read_i64(regid: number): bigint;
  emu_start(begin: number | bigint, until: number | bigint, timeout: number, count: number): void;
  emu_stop(): void;
  hook_add(
    type: number,
    cb: (handle: number, addr?: bigint, size?: number, user?: unknown) => void,
    user?: Record<string, unknown>,
    begin?: number,
    end?: number,
    extra?: number,
  ): void;
  context_alloc(): unknown;
  context_save(ctx: unknown): void;
  context_restore(ctx: unknown): void;
  context_free(ctx: unknown): void;
  close(): void;
}

export interface UnicornModule {
  Unicorn: new (arch: number, mode: number) => UnicornInstance;
  ARCH_X86: number;
  MODE_64: number;
  PROT_ALL: number;
  HOOK_CODE: number;
  HOOK_INSN: number;
  X86_INS_SYSCALL: number;
  ERR_OK: number;
}

export interface Engines {
  unicorn: UnicornModule;
  keystone: KeystoneModule;
  capstone: CapstoneModule;
}

declare global {
  interface Window {
    MUnicorn?: (moduleArg?: object) => Promise<UnicornModule>;
    MKeystone?: (moduleArg?: object) => Promise<KeystoneModule>;
    MCapstone?: (moduleArg?: object) => Promise<CapstoneModule>;
  }
}

let vendorDir = new URL('vendor/', document.baseURI).href;

/** Point the loader at a different same-origin directory for the assets. */
export function setVendorBase(url: string): void {
  vendorDir = url.endsWith('/') ? url : url + '/';
}

function loadScript(src: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const existing = document.querySelector<HTMLScriptElement>(`script[data-vendor="${src}"]`);
  if (existing && existing.dataset.loaded === '1') return Promise.resolve();
  if (existing) {
    existing.addEventListener('load', () => resolve());
    existing.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
    return promise;
  }
  const s = document.createElement('script');
  s.src = src;
  s.dataset.vendor = src;
  s.addEventListener('load', () => {
    s.dataset.loaded = '1';
    resolve();
  });
  s.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
  document.head.appendChild(s);
  return promise;
}

async function fetchWasm(name: string): Promise<ArrayBuffer> {
  const res = await fetch(vendorDir + name);
  if (!res.ok) throw new Error(`failed to fetch vendor asset ${name} from ${vendorDir} (HTTP ${res.status})`);
  return res.arrayBuffer();
}

let enginesPromise: Promise<Engines> | null = null;

/** Load (once) the vendored unicorn/keystone/capstone engines. */
export function loadEngines(): Promise<Engines> {
  if (!enginesPromise) {
    enginesPromise = (async () => {
      const [ksWasm, csWasm] = await Promise.all([fetchWasm('keystone.wasm'), fetchWasm('capstone.wasm')]);
      await Promise.all([
        loadScript(vendorDir + 'unicorn_x86.js'),
        loadScript(vendorDir + 'keystone.js'),
        loadScript(vendorDir + 'capstone.js'),
      ]);
      const { MUnicorn, MKeystone, MCapstone } = window;
      if (!MUnicorn || !MKeystone || !MCapstone) {
        throw new Error('vendored engine scripts did not define MUnicorn/MKeystone/MCapstone');
      }
      const [unicorn, keystone, capstone] = await Promise.all([
        MUnicorn(),
        MKeystone({ locateFile: (path: string) => vendorDir + path, wasmBinary: ksWasm }),
        MCapstone({ locateFile: (path: string) => vendorDir + path, wasmBinary: csWasm }),
      ]);
      return { unicorn, keystone, capstone };
    })();
    enginesPromise.catch(() => {
      enginesPromise = null; // allow a retry after a transient fetch failure
    });
  }
  return enginesPromise;
}

/**
 * Thin, forgiving wrapper around one Keystone instance.
 *
 * Quirk (verified against @alexaltea/keystone-js@0.9.2): an assembly call that
 * fails with `failed: true` leaves the engine usable, but one that returns
 * `count: 0, failed: false` poisons the handle — the NEXT call crashes the
 * WASM. We therefore close and re-create the engine after every failure.
 */
export class KeystoneFacade {
  private handle: KeystoneAssembler;

  constructor(private readonly mod: KeystoneModule) {
    this.handle = this.create();
  }

  assemble(text: string, address: number): { ok: true; bytes: Uint8Array } | { ok: false } {
    let r: KeystoneAsmResult;
    try {
      r = this.handle.asm(text, address);
    } catch {
      this.recreate();
      return { ok: false };
    }
    if (r.failed || r.count < 1 || r.mc.length < 1) {
      this.recreate();
      return { ok: false };
    }
    return { ok: true, bytes: r.mc };
  }

  private create(): KeystoneAssembler {
    const a = new this.mod.Keystone(this.mod.ARCH_X86, this.mod.MODE_64);
    a.option(this.mod.OPT_SYNTAX, this.mod.OPT_SYNTAX_INTEL);
    return a;
  }

  private recreate(): void {
    try {
      this.handle.close();
    } catch {
      // a poisoned handle may throw on close; the replacement is fresh
    }
    this.handle = this.create();
  }
}
