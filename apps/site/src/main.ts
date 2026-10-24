// Thin composition layer (see docs/architecture.md): everything — org
// parsing, block runtimes, machine panel, theme — lives in @literate/core.
// The app only supplies the pages and the kernel registry.
import { mountSite } from '@literate/core';
import { asm64Kernel } from '@literate/kernel-asm64';
import lessonSrc from './lesson.org?raw';

const root = document.getElementById('root');
if (!root) throw new Error('apps/site: #root not found');

mountSite({
  root,
  kernels: [asm64Kernel],
  pages: [{ title: 'x86-64 assembly', orgSource: lessonSrc }],
});
