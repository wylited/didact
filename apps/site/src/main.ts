// Thin composition layer (see docs/architecture.md): everything — org
// parsing, block runtimes, machine panel, theme — lives in @literate/core.
// The app only supplies the pages and the kernel registry.
import { mountSite } from '@literate/core';
import type { PageSpec } from '@literate/core';
import { asm64Kernel } from '@literate/kernel-asm64';
import { riscvKernel } from '@literate/kernel-riscv';
import { mipsKernel } from '@literate/kernel-mips';
import { cKernel } from '@literate/kernel-c';
import { pythonKernel } from '@literate/kernel-python';
import { typstKernel } from '@literate/kernel-typst';

// Nav order, by page file stem (not alphabetical, not glob order).
const PAGE_ORDER = ['x86-64-assembly', 'riscv', 'mips', 'c', 'python', 'typst'] as const;

// Every lesson is one .org file in src/pages; the nav title comes from its
// #+TITLE: line (the file stem is the fallback).
const sources = import.meta.glob('./pages/*.org', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const pages: PageSpec[] = PAGE_ORDER.map((name) => {
  const orgSource = sources[`./pages/${name}.org`];
  if (orgSource === undefined) throw new Error(`apps/site: page "${name}" not found in src/pages`);
  const title = orgSource.match(/^#\+TITLE:\s*(.+)$/m)?.[1]?.trim() || name;
  return { title, orgSource };
});

const root = document.getElementById('root');
if (!root) throw new Error('apps/site: #root not found');

mountSite({
  root,
  kernels: [asm64Kernel, riscvKernel, mipsKernel, cKernel, pythonKernel, typstKernel],
  pages,
});
