import { describe, expect, it } from 'vitest';
import { didactVite, resolveDidactViteOptions } from '../src/index';

describe('resolveDidactViteOptions', () => {
  it('maps top-level shorthands into nested options', () => {
    expect(
      resolveDidactViteOptions({ pagesDir: 'src/pages', cacheDir: '.cache', kernels: ['asm'] }),
    ).toEqual({
      typst: { pagesDir: 'src/pages', cacheDir: '.cache' },
      vendors: { kernels: ['asm'] },
    });
  });

  it('lets nested options win over shorthands', () => {
    const kernels = ['typst'] as const;
    const resolved = resolveDidactViteOptions({
      pagesDir: 'a',
      cacheDir: 'b',
      kernels: ['asm'],
      typst: { pagesDir: 'nested' },
      vendors: { kernels },
    });
    expect(resolved.typst).not.toBe(false);
    expect(resolved.vendors).not.toBe(false);
    if (resolved.typst === false || resolved.vendors === false) return;
    expect(resolved.typst.pagesDir).toBe('nested');
    expect(resolved.typst.cacheDir).toBe('b');
    expect(resolved.vendors.kernels).toBe(kernels);
  });

  it('falls back to the shorthand when the nested value is explicitly undefined', () => {
    const resolved = resolveDidactViteOptions({
      typst: { pagesDir: undefined },
      pagesDir: 'top',
    });
    expect(resolved.typst).toEqual({ pagesDir: 'top' });
    expect(resolved.vendors).toEqual({});
  });

  it('disables plugins entirely when nested options are false', () => {
    expect(
      resolveDidactViteOptions({ typst: false, vendors: false, pagesDir: 'x', kernels: ['asm'] }),
    ).toEqual({ typst: false, vendors: false });
  });

  it('passes perPage through the nested typst options', () => {
    const resolved = resolveDidactViteOptions({
      typst: { perPage: true },
      pagesDir: 'src/pages',
    });
    expect(resolved.typst).toEqual({ perPage: true, pagesDir: 'src/pages' });
  });

  it('produces empty objects by default', () => {
    expect(resolveDidactViteOptions({})).toEqual({ typst: {}, vendors: {} });
    expect(resolveDidactViteOptions()).toEqual({ typst: {}, vendors: {} });
  });
});

describe('didactVite', () => {
  it('returns both plugins by default', () => {
    const plugins = didactVite();
    expect(plugins).toHaveLength(2);
    expect(plugins[0]?.name).toBe('didact-typst');
    expect(plugins[1]?.name).toBe('didact-vendors');
  });

  it('still returns the typst plugin when typst is false', () => {
    const plugins = didactVite({ typst: false });
    expect(plugins).toHaveLength(2);
    expect(plugins[0]?.name).toBe('didact-typst');
  });

  it('omits the vendors plugin when vendors is false', () => {
    const plugins = didactVite({ vendors: false });
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe('didact-typst');
  });
});
