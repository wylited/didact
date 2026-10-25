import { defineConfig } from 'vite';

// Engine assets are static files under apps/site/public — vendor/
// (unicorn/keystone/capstone), vendor-typst/, vendor-python/ and
// vendor-c/, each copied from the kernel's node_modules by
// scripts/sync-vendors.mjs — so each kernel's default vendor base
// `<page-base>/<dir>/` resolves in dev and dist with base './' and
// no bundler magic.

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@didact/core': new URL('../../packages/core/src', import.meta.url)
        .pathname,
      '@didact/kernel-asm64': new URL(
        '../../packages/kernel-asm64/src',
        import.meta.url,
      ).pathname,
      '@didact/kernel-riscv': new URL(
        '../../packages/kernel-riscv/src',
        import.meta.url,
      ).pathname,
      '@didact/kernel-mips': new URL(
        '../../packages/kernel-mips/src',
        import.meta.url,
      ).pathname,
      '@didact/kernel-c': new URL(
        '../../packages/kernel-c/src',
        import.meta.url,
      ).pathname,
      '@didact/kernel-python': new URL(
        '../../packages/kernel-python/src',
        import.meta.url,
      ).pathname,
      '@didact/kernel-typst': new URL(
        '../../packages/kernel-typst/src',
        import.meta.url,
      ).pathname,
    },
  },
});
