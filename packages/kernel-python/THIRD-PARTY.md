# Third-party assets — @literate/kernel-python

Everything in `vendor/` is copied unmodified from the `pyodide` npm package,
version 314.0.7 (Pyodide's CPython 3.14 build). These are exactly the five
files the browser fetches when the engine boots (verified against the
shipped `pyodide.js` loader); nothing else is requested at runtime and no
CDN is ever contacted.

| file               |     bytes | role                                                        |
|--------------------|-----------|-------------------------------------------------------------|
| `pyodide.js`       |    18,912 | UMD entry; classic script defining the global `loadPyodide` |
| `pyodide.asm.mjs`  | 1,250,344 | Emscripten JS glue (ESM), dynamically imported by pyodide.js |
| `pyodide.asm.wasm` | 9,598,218 | CPython 3.14 + core runtime compiled to WebAssembly         |
| `python_stdlib.zip`| 2,545,637 | Python standard library, mounted into the virtual FS at boot |
| `pyodide-lock.json`|   119,077 | package index used by `pyodide.loadPackage`                 |
| **total**          | **13,532,188** (≈ 12.9 MiB) |                                             |

## Licenses

- **Pyodide** (`pyodide.js`, `pyodide.asm.mjs`, `pyodide.asm.wasm`,
  `pyodide-lock.json`): Mozilla Public License 2.0 —
  <https://github.com/pyodide/pyodide/blob/main/LICENSE>
  (npm package metadata: `license: MPL-2.0`).
- **CPython and its standard library** (the interpreter inside the wasm
  core and the contents of `python_stdlib.zip`): Python Software
  Foundation License Version 2 — <https://docs.python.org/3/license.html>
- Pyodide's full third-party license overview (the wheels `loadPackage`
  could fetch — none are vendored or used here):
  <https://pyodide.org/en/stable/project/license.html>
