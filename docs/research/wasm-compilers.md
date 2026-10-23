# Client-side compilers compiled to WebAssembly

Research for the literate website: which C/C++ (and other) compilers can be shipped **as WebAssembly** and run **fully in the browser** (no server), so lessons can compile and execute user code client-side. Researched 2026-10-23 via repos, npm/PyPI registries, live demo assets (HTTP `Content-Length` measured), and project blogs.

## Taxonomy

1. **Real clang/LLVM compiled to wasm** (wasmer/wasi-sdk lineage): `binji/wasm-clang`, `YoWASP/clang`, Wasmer's `clang/clang` (WASIX).
2. **Full Emscripten in the browser**: `jprendes/emception`.
3. **Interactive C++ interpreter (Clang-Repl) in wasm**: `xeus-cpp` (JupyterLite kernel).
4. **TinyCC in wasm**: `44670/tcc-wasm` (fork with a real wasm backend), `lupyuen/tcc-riscv32-wasm` (emits RISC-V ELF), `pixeltris/webc86` (archived).
5. **Emulated machine running the real native compiler**: WebVM/CheerpX (Debian gcc), jslinux.
6. **Other languages**: `rubrc` (rustc/cargo), LFortran in JupyterLite.

## Comparison table

| Project | Language | Maturity (last activity) | Approx. download size | License | Embeddable | How output runs |
|---|---|---|---|---|---|---|
| [binji/wasm-clang](https://github.com/binji/wasm-clang) | C/C++ (clang 8.0.1 + lld) | Demo/"alpha demoware"; last push 2023-12; unmaintained | ~60 MB wire (clang 31.2 MB + lld 19.5 MB + sysroot.tar 9.3 MB, as served gzip) | Apache-2.0 | Demo page + worker; not a packaged lib, but small clean JS (memfs + WASI shim) that is routinely forked | Emits `wasm32-wasi` module; demo instantiates it in-browser with its own JS WASI shim |
| [@yowasp/clang](https://npmjs.com/package/@yowasp/clang) ([Codeberg](https://codeberg.org/YoWASP/clang)) | C/C++ (clang + wasm-ld, tracks LLVM) | Automated releases; LLVM 22.1.0 auto-build 2026-03; GitHub mirrors archived 2026-03, canonical on Codeberg | ~105 MB unpacked (npm 22.0.0) | Apache-2.0 | **Yes — first-class**: ES module, `runClang([...])`, file I/O API via runtime-js; CDN/bundler or Node | Emits `wasm32-wasi` object/executable; run with any JS WASI shim (incl. the same YoWASP runtime) |
| Wasmer `clang/clang` (WASIX) | C (wasi-sdk + wasix-libc) | Active product ([blog 2024-10](https://wasmer.io/posts/clang-in-browser)); `@wasmer/sdk` maintained | ~100 MB uncompressed (vendor targets ~30 MB compressed) | LLVM: Apache-2.0 (+LLVM exception); package itself declares none; SDK MIT | **Yes** — `Wasmer.fromRegistry("clang/clang")`, mountable in-memory dirs, documented JS example | Emits WASI/WASIX `.wasm`; run client-side via `Wasmer.fromFile(wasm).entrypoint.run()` |
| [jprendes/emception](https://github.com/jprendes/emception) | C/C++ — **entire Emscripten** (llvm-box: clang/lld/…; binaryen; python.wasm `emcc`; quicknode) | Repo last push 2024-07; npm 1.x frozen; ⚠ npm `emception@>=2.0.0` (2026) is an **unrelated takeover** — pin `1.0.15` | ~291 MB unpacked (npm 1.0.15, 103 files); est. ~70–100 MB compressed wire | MIT OR Apache-2.0 | **Yes** — npm package, worker-based `Emception` class, `runCommand()`; buildable from Docker | Emits a normal Emscripten module (wasm+JS glue) that runs natively in the browser |
| [compiler-research/xeus-cpp](https://github.com/compiler-research/xeus-cpp) (`xcpp`) | Interactive C++ (Clang-Repl/LLVM) | Active; releases in 2026; browser story via JupyterLite ([blog](https://blog.jupyter.org/posts/2025/c-in-jupyter-interpreting-c-in-the-web/)) | Tens of MB (emscripten-forge bundle; not measured) | BSD-3-Clause | As a **JupyterLite kernel** (jupyterlite-xeus, Pyodide-style) — not a general JS lib | No separate artifact: cells are interpreted incrementally in-tab, code linked as side modules |
| [44670/tcc-wasm](https://github.com/44670/tcc-wasm) | C (TinyCC fork **with wasm32 backend**) | Personal project, last push 2026-05; 3 stars; live IDE | **~0.8 MB total** (tcc.wasm 713 KB + libc.wasm 96 KB, measured) | LGPL-2.1 | **Yes** — UMD `TccWasmRuntime` (`CompilerHost`, `AppRuntime`, `runApp(src,{stdin,files})`, WAT dump); offline PWA IDE at [tcc.44670.org](https://tcc.44670.org/) | Emits real wasm modules (imports satisfied by `libc.wasm`); executed natively via `WebAssembly` in the same runtime |
| [WebVM / CheerpX](https://webvm.io) | C/C++ + anything (real Debian gcc, make, …) | Active, commercially backed; `@leaningtech/cheerpx` 1.4.0 (2026-10) | ~5.7 MB to interactive prompt; ~600 MB image, lazily fetched in chunks | Custom licence (free with restrictions; commercial licence offered) | Partially — embeddable `@leaningtech/cheerpx`, but licence-gated and heavyweight | Output is x86 ELF, executed inside CheerpX's x86→wasm JIT (emulated), never leaves the VM |
| [oligamiq/rubrc](https://github.com/oligamiq/rubrc) | Rust (+ cargo, clang, llvm, rust-analyzer) | Pre-release/experimental (v2 WIP) | Very large (rustc+cargo+LLVM+rust-analyzer wasm modules; not measured) | MIT OR Apache-2.0 | Demo app (SolidJS + worker); not packaged as a lib | Emits `wasm32-wasip1` (runs in browser) or `x86_64-linux-musl` (download only); needs COOP/COEP |

## Project details, pros/cons

### 1. binji/wasm-clang — the original "clang in the browser" demo
- Repo: https://github.com/binji/wasm-clang (342★, Apache-2.0, last push 2023-12-07). Demo: https://binji.github.io/wasm-clang. Ben Smith's CppCon 2019 demo.
- Compiles C/C++ (clang **8.0.1**, 2019-era) with lld (`wasm-ld`) to `wasm32-wasi`; JS in-memory WASI filesystem supplies sources/headers/libs; compilation runs in a Web Worker; resulting module is instantiated and run in-page.
- Measured artifacts (as served by GitHub Pages): `clang` 31.2 MB, `lld` 19.5 MB, `sysroot.tar` 9.3 MB.

**Pros**
- End-to-end architecture proven: edit → compile → link → run, 100% client-side; the template most later projects copied.
- Small, readable codebase (memfs, worker, WASI shim) — easy to fork and tailor; Apache-2.0.
- Output is plain WASI wasm, runnable with a tiny shim.

**Cons**
- Effectively unmaintained since 2023; pinned to clang 8 (no new C/C++ standards, old bugs).
- "Alpha demoware" by author's own admission; no library API or packaging.
- ~60 MB payload for a demo-era toolchain.

### 2. YoWASP/clang — automated LLVM builds as a real JS library
- Repo: https://codeberg.org/YoWASP/clang (GitHub mirror archived 2026-03; last autorelease commit "[autorelease] Upgrade to LLVM 22.1.0", 2026-03-01). npm: `@yowasp/clang` (latest `22.0.0-git20542-10`, published 2026-03-12, ~105 MB unpacked).
- whitequark's packaging pipeline: clang + wasm-ld built as `wasm32-wasi`, distributed via npm; browser/Node embedding through `runtime-js` (native WebAssembly + JS WASI shim). API: `import { runClang } from "@yowasp/clang"; await runClang(["clang","--version"])`, with a documented file-transfer API.

**Pros**
- **Tracks upstream LLVM automatically** (LLVM 22.1.0 era) — freshest clang of any option here.
- Real embedding story: npm/ESM, clean function API, browser **and** Node, no runtime lock-in beyond a WASI shim.
- Apache-2.0; Yosys/nextpnr precedent shows the pipeline is battle-tested.

**Cons**
- ~105 MB download (clang is clang); no bundled C library/sysroot — you must package headers/libs yourself and mount them.
- Bus-factor: single maintainer's automation; org repos archived (canonical moved to Codeberg) — the FPGA tools were sunset even though clang kept auto-releasing.
- Subprocess-free design: driver-style multi-tool invocations (clang → lld) must be orchestrated from JS.

### 3. Wasmer `clang/clang` — WASIX toolchain behind the Wasmer JS SDK
- Blog + demo: https://wasmer.io/posts/clang-in-browser (2024-10); package `clang/clang` on the Wasmer registry; runs via `@wasmer/sdk` in Chrome/Firefox/Safari.
- wasi-sdk/clang rebuilt for **WASIX** (adds `posix_spawn` etc. so clang can spawn `wasm-ld` itself); ~100 MB uncompressed today, vendor goal ~30 MB served compressed. Documented JS: fetch package from registry, mount an in-memory `Directory`, run entrypoint, then `Wasmer.fromFile(wasm)` to execute the freshly compiled program client-side.

**Pros**
- Actively maintained by a company; full toolchain (compiles, links, even `wasm-opt` via `--use wasmer/wasm-opt`).
- Best-documented JS embedding example (compile → capture wasm → run) of the "big" options.
- Output is standard-enough WASI/WASIX wasm runnable by the same SDK in-browser.

**Cons**
- Ties the site to the Wasmer JS SDK runtime and (by default) their registry for the 100 MB package.
- WASIX is a fork of the WASI standard; adoption outside Wasmer is limited (noted in HN discussion of the launch).
- Size: 100 MB until their compression work lands; one 2024 bug report of Firefox panics in the SDK.

### 4. jprendes/emception — the whole Emscripten toolchain, in a tab
- Repo: https://github.com/jprendes/emception (357★, MIT OR Apache-2.0, last push 2024-07-27). Demo: https://jprendes.github.io/emception/.
- Clever size engineering: `llvm-box` bundles clang/lld/llc/llvm-nm/llvm-ar/llvm-objcopy into one wasm binary (busybox-style); `binaryen-box` bundles wasm-as/wasm-opt/etc.; `emcc` is a Python script, so it ships CPython compiled to wasm plus "quicknode" (Node in wasm) and brotli/wasm-package helpers.
- npm `emception` **1.0.15** (2024-03): 291 MB unpacked. ⚠ Versions ≥2.0.0 (published 2026 by `gameguild-gg`) are a **different codebase** that took over the package name — pin `^1.0.15` or build from the repo's Docker script.

**Pros**
- Closest to "the real thing": full Emscripten pipeline including binaryen optimization; output is a stock Emscripten module that runs natively in the browser — exactly what students would produce locally.
- Designed as an embeddable worker library from day one; permissive dual license.
- Ecosystem precedent: it is the standard answer for "Emscripten in the browser".

**Cons**
- Huge: ~291 MB unpacked on disk (compressed wire cost still likely 70–100+ MB); slow first load even cached.
- Repository frozen since mid-2024 → clang version frozen; maintenance now depends on forking.
- npm namespace confusion (hostile/unrelated 2.x+) is a real supply-chain trap.

### 5. xeus-cpp (`xcpp`) — C++ *interpreter* for the browser (JupyterLite path)
- Repo: https://github.com/compiler-research/xeus-cpp (BSD-3-Clause, active, 2026 releases). Live browser notebooks: links in README (JupyterLite + emscripten-forge). Announced in "[C++ in Jupyter — interpreting C++ in the web](https://blog.jupyter.org/posts/2025/c-in-jupyter-interpreting-c-in-the-web/)".
- Clang-Repl-based kernel compiled to wasm; cells are parsed/executed incrementally in the same tab (generated code linked as side modules). No separate compile-link-run artifact.

**Pros**
- Purpose-built for teaching in a notebook (the exact literate-website use case); keeps state across cells; no linker step per snippet.
- Healthy, funded project (compiler-research/CERN-adjacent); wasm builds are a first-class target.
- Permissive BSD-3.

**Cons**
- Embedding model is "Jupyter kernel", not a JS library — adopting it outside JupyterLite means speaking the Jupyter protocol or reusing their kernel harness.
- Interpreter semantics (Clang-Repl) differ subtly from batch clang compilation; C, not the focus (C++ first).
- Payload measured in tens of MB (clang-based), still heavy.

### 6. 44670/tcc-wasm — TinyCC fork with a genuine wasm32 backend
- Repo: https://github.com/44670/tcc-wasm (LGPL-2.1, last push 2026-05-03, 3★). Contains `WASM_DESIGN.md`, `lib/wasm32-libc.c`, wasm32 test-suite with `.wat` fixtures; ships `tcc.wasm` (713,231 B) + `libc.wasm` (95,592 B). Live offline-capable IDE: https://tcc.44670.org/.
- The site's `runtime.js` is a UMD module `TccWasmRuntime` exposing `CompilerHost`, `AppRuntime`, `runApp(source, {stdin, files})` and WAT dumping — i.e., directly consumable as a library. Upstream TCC has **no** wasm backend; this fork adds one (upstream emits x86/ARM/RISC-V only).

**Pros**
- **~0.8 MB total** — three orders of magnitude smaller than clang options; instant load, works offline (PWA).
- True wasm output (no emulator), simple embeddable JS API with stdin/files/seeded FS; WAT inspection is a nice teaching hook.
- TCC-class compile speed; ideal for "C for beginners" lessons.

**Cons**
- Fork of a niche project by one author; TCC itself is lightly maintained upstream and ISOC99-era C only (no C++).
- LGPL-2.1 (fine for site use via file distribution, but needs care if we statically link against/modify it).
- Homegrown wasm libc subset — stdlib coverage and correctness far below wasi-libc.

### 7. WebVM (CheerpX) — real gcc via x86 virtualization
- Site: https://webvm.io; engine `@leaningtech/cheerpx` (npm 1.4.0, 2026-10) — x86→wasm JIT + Linux syscall emulation running unmodified Debian. gcc/clang/python/node preinstalled; ext2 image lazily fetched in HTTP-range chunks (~5.7 MB to a bash prompt; ~600 MB full image).

**Pros**
- Zero porting: any Linux compiler/tool (gcc, make, autotools) works unmodified.
- Actively developed, self-hostable from a Dockerfile.

**Cons**
- Output is x86 ELF that only runs *inside* the VM — never native wasm; heavyweight for per-lesson embedding.
- Custom licence: free tier has restrictions; commercial use requires a paid licence.
- Not an API you can drive from prose blocks cheaply (terminal-centric).

### 8. Minor / adjacent projects (one-liners)
- **rubrc** (https://github.com/oligamiq/rubrc, MIT OR Apache-2.0, pre-release): rustc+cargo+clang/llvm+rust-analyzer as wasm modules in a worker; emits runnable `wasm32-wasip1`; requires COOP/COEP. The notable rustc-in-browser datapoint — the official Rust Playground remains server-side.
- **lupyuen/tcc-riscv32-wasm**: TCC (compiled with Zig to wasm) emitting **RISC-V ELF**, executed in a browser NuttX/RISC-V emulator; barebones (2022).
- **pixeltris/webc86**: TCC→x86 executed in a wasm 8086 emulator; archived PoC.
- **eliot-akira/tcc-wasm**: pushed Jan 2026, no license/README — avoid.
- **jslinux** (bellard.org/jslinux): proprietary Linux-in-browser with tcc/gcc images; embedding requires a commercial deal.
- **LFortran in JupyterLite** (Jupyter blog, 2026): same emscripten-forge pattern as xeus-cpp — evidence this delivery model is maturing.
- **Pyodide-style WASI executors** for *running* outputs: browsers have no native WASI; every option above either supplies its own shim (wasm-clang, YoWASP runtime-js, TccWasmRuntime), uses the Emscripten runtime (emception), or uses the Wasmer JS SDK (`wasmer-js`) — wasmtime has no browser build.

## Verdict — top 2 for future C/C++ lesson support

**#1 — YoWASP/clang (`@yowasp/clang`).** Best combination of: a real *library* API (`runClang`, file transfer, ES module), an automatically up-to-date LLVM (22.x), Apache-2.0, and standard `wasm32-wasi` output that any small WASI shim can execute in-page. Costs to plan for: ~100 MB cached payload, self-packaged sysroot/headers, and orchestrating clang→wasm-ld from JS. It is the least lock-in and the least likely to rot technically, even though the org is low-bus-factor (automation keeps shipping).

**#2 — jprendes/emception (pin npm 1.x).** The only turnkey *full Emscripten*: compile → binaryen-optimize → produce a stock Emscripten module that runs natively in the browser, behind a worker-ready API, MIT/Apache-2.0. Costs: ~300 MB unpacked, clang frozen at the 2024 build, and the npm-name hijack (must pin `^1.0.15` or vendor the build).

**Honorable mentions.** Wasmer `clang/clang` if we ever standardize on the Wasmer JS SDK (actively maintained, but WASIX/ecosystem lock-in and 100 MB). **44670/tcc-wasm** if we want C snippets with near-zero payload (~0.8 MB) and can accept TCC's C99 subset, LGPL, and single maintainer — a superb fit for *intro C* lessons even before we tackle C++. **xeus-cpp** becomes attractive only if we adopt the JupyterLite kernel protocol wholesale.

**Cross-cutting note:** all clang-class payloads are one-time downloads if we cache them in a Service Worker/Cache Storage — acceptable for a lesson site, but a lazy "load compiler on first C block" strategy is required.

## Sources

- https://github.com/binji/wasm-clang · https://binji.github.io/wasm-clang (asset sizes measured via HTTP)
- https://codeberg.org/YoWASP/clang · https://yowasp.org · npm `@yowasp/clang`
- https://wasmer.io/posts/clang-in-browser · https://github.com/wapm-packages/clang · https://news.ycombinator.com/item?id=41767644
- https://github.com/jprendes/emception · npm `emception` (1.x vs 2.x+ provenance) · https://jprendes.github.io/emception
- https://github.com/compiler-research/xeus-cpp · https://blog.jupyter.org/posts/2025/c-in-jupyter-interpreting-c-in-the-web/
- https://github.com/44670/tcc-wasm · https://tcc.44670.org (tcc.wasm/libc.wasm sizes measured) · https://github.com/TinyCC/tinycc
- https://webvm.io · npm `@leaningtech/cheerpx` (licence text) · https://github.com/leaningtech/webvm
- https://github.com/oligamiq/rubrc · https://github.com/lupyuen/tcc-riscv32-wasm · https://github.com/pixeltris/webc86 · https://bellard.org/jslinux/
