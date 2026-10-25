// Thin composition layer (see docs/architecture.md): everything — org
// parsing, block runtimes, machine panel, theme — lives in @didact/core.
// The app only supplies the pages and the kernel registry.
import { mountSite } from '@didact/core';
import type { PageSpec } from '@didact/core';
import { asm64Kernel } from '@didact/kernel-asm64';
import { riscvKernel } from '@didact/kernel-riscv';
import { mipsKernel } from '@didact/kernel-mips';
import { cKernel } from '@didact/kernel-c';
import { pythonKernel } from '@didact/kernel-python';
import { typstKernel } from '@didact/kernel-typst';

// Nav order, by page file stem (not alphabetical, not glob order).
const PAGE_ORDER = ['x86-64-assembly', 'riscv', 'mips', 'c', 'python', 'typst'] as const;

// Every lesson is one .org file in src/pages; the nav title comes from its
// #+TITLE: line (the file stem is the fallback).
const sources = import.meta.glob('./pages/*.org', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;


const pages: PageSpec[] = [];
for (const name of PAGE_ORDER) {
  const orgSource = sources[`./pages/${name}.org`];
  if (orgSource === undefined) {
    // A typo'd stem must not blank the site — skip loudly instead.
    console.warn(`apps/site: page "${name}" is in PAGE_ORDER but ./pages/${name}.org does not exist — skipped`);
    continue;
  }
  pages.push({
    title: orgSource.match(/^#\+TITLE:\s*(.+)$/m)?.[1]?.trim() || name,
    orgSource,
  });
}
for (const path of Object.keys(sources)) {
  if (PAGE_ORDER.includes(path.replace(/^\.\/pages\/|\.org$/g, '') as never)) continue;
  console.warn(`apps/site: ${path} is not in PAGE_ORDER — page not shown (add its stem to PAGE_ORDER in src/main.ts)`);
}
if (pages.length === 0) throw new Error('apps/site: no pages resolved — check src/pages/*.org and PAGE_ORDER');

const root = document.getElementById('root');
if (!root) throw new Error('apps/site: #root not found');

mountSite({
  root,
  kernels: [asm64Kernel, riscvKernel, mipsKernel, cKernel, pythonKernel, typstKernel],
  pages,
});
