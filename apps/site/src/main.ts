// Thin composition layer (see docs/architecture.md): everything — org
// parsing, block runtimes, machine panel, theme — lives in @didact/core.
// The app only supplies the pages and the kernel registry.
import { mountSite, resolvePages } from '@didact/core';
import { asm64Kernel } from '@didact/kernel-asm64';
import { riscvKernel } from '@didact/kernel-riscv';
import { mipsKernel } from '@didact/kernel-mips';
import { cKernel } from '@didact/kernel-c';
import { cppKernel } from '@didact/kernel-cpp';
import { fortranKernel } from '@didact/kernel-fortran';
import { pythonKernel } from '@didact/kernel-python';
import { jsKernel } from '@didact/kernel-javascript';
import { lispKernel } from '@didact/kernel-lisp';
import { elispKernel } from '@didact/kernel-elisp';
import { wasmKernel } from '@didact/kernel-wasm';
import { luaKernel } from '@didact/kernel-lua';
import { matlabKernel } from '@didact/kernel-matlab';
import { prologKernel } from '@didact/kernel-prolog';
import { regexKernel } from '@didact/kernel-regex';
import { sqlKernel } from '@didact/kernel-sql';
import { typstKernel } from '@didact/kernel-typst';
// Pre-rendered prose math and static diagrams compiled from src/pages/*.org
// by @didact/vite. The interactive typst kernel stays separate.
import typstArtifacts from 'virtual:didact-typst';

// Nav order, by page file stem (not alphabetical, not glob order).
const PAGE_ORDER = [
  'x86-64-assembly',
  'riscv',
  'mips',
  'c',
  'cpp',
  'fortran',
  'wasm',
  'python',
  'sql',
  'matlab',
  'lua',
  'javascript',
  'regex',
  'lisp',
  'elisp',
  'prolog',
  'typst',
] as const;

const sources = import.meta.glob('./pages/*.org', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const pages = resolvePages(sources, PAGE_ORDER);

const root = document.getElementById('root');
if (!root) throw new Error('apps/site: #root not found');

mountSite({
  root,
  kernels: [
    asm64Kernel,
    riscvKernel,
    mipsKernel,
    cKernel,
    cppKernel,
    fortranKernel,
    wasmKernel,
    pythonKernel,
    sqlKernel,
    matlabKernel,
    jsKernel,
    regexKernel,
    lispKernel,
    elispKernel,
    prologKernel,
    luaKernel,
    typstKernel,
  ],
  pages,
  brand: 'Didact',
  // The lesson list is the primary way around the site; in-page contents
  // are one click away.
  navView: 'pages',
  typst: { artifacts: typstArtifacts },
});
