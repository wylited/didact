import { defineConfig } from 'vite';

// Vendored engine files (unicorn/keystone/capstone wasm + UMD loader shims)
// are static assets under apps/site/public/vendor — copied there from
// packages/kernel-asm64/vendor (see apps/site/README.md) — so the kernel's
// default vendor base `<page-base>/vendor/` resolves in dev and dist with
// base './' and no bundler magic.

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@literate/core': new URL('../../packages/core/src', import.meta.url)
        .pathname,
      '@literate/kernel-asm64': new URL(
        '../../packages/kernel-asm64/src',
        import.meta.url,
      ).pathname,
    },
  },
});
