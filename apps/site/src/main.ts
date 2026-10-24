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
const PAGE_ORDER = [
  'x86-64-assembly', 'riscv', 'mips',
  'elec2350-01-machine-model',
  'elec2350-02-arithmetic',
  'elec2350-03-memory',
  'elec2350-04-control-flow',
  'elec2350-05-encoding',
  'elec2350-06-procedures',
  'elec2350-07-datapath',
  'elec2350-08-control',
  'elec2350-09-pipelining',
  'elec2350-10-hazards',
  'elec2350-11-memory-hierarchy',
  'elec2350-12-exam-gym',
  'c', 'python', 'typst',
] as const;

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
