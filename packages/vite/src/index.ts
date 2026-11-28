import type { Plugin } from 'vite';
import { didactTypst, type DidactTypstOptions } from './typst/vite.ts';
import {
  didactVendors,
  type DidactVendorsOptions,
  type VendorKernelId,
} from './vendors.ts';

export interface DidactViteOptions {
  /**
   * Build-time Typst math & diagram prerendering options.
   * Pass `false` to disable prerendering while still resolving
   * `virtual:didact-typst` to an empty artifacts object.
   */
  typst?: DidactTypstOptions | false;
  /**
   * WASM kernel vendor asset serving/emission options.
   * Pass `false` to disable vendor asset handling.
   */
  vendors?: DidactVendorsOptions | false;
  /**
   * Shorthand for `typst.pagesDir`. Ignored when `typst` is `false`.
   * A nested `typst.pagesDir` wins over this value.
   */
  pagesDir?: string;
  /**
   * Shorthand for `typst.cacheDir`. Ignored when `typst` is `false`.
   * A nested `typst.cacheDir` wins over this value.
   */
  cacheDir?: string;
  /**
   * Shorthand for `vendors.kernels`. Ignored when `vendors` is `false`.
   * A nested `vendors.kernels` wins over this value.
   */
  kernels?: readonly VendorKernelId[];
}

function resolveTypstOptions(options: DidactViteOptions): DidactTypstOptions | false {
  if (options.typst === false) return false;
  const resolved: DidactTypstOptions = { ...options.typst };
  delete resolved.pagesDir;
  delete resolved.cacheDir;
  const pagesDir = options.typst?.pagesDir ?? options.pagesDir;
  const cacheDir = options.typst?.cacheDir ?? options.cacheDir;
  if (pagesDir !== undefined) resolved.pagesDir = pagesDir;
  if (cacheDir !== undefined) resolved.cacheDir = cacheDir;
  return resolved;
}

function resolveVendorsOptions(options: DidactViteOptions): DidactVendorsOptions | false {
  if (options.vendors === false) return false;
  const resolved: DidactVendorsOptions = { ...options.vendors };
  delete resolved.kernels;
  const kernels = options.vendors?.kernels ?? options.kernels;
  if (kernels !== undefined) resolved.kernels = kernels;
  return resolved;
}

/**
 * Normalize `DidactViteOptions` shorthands into the nested plugin option
 * objects, dropping keys whose value is `undefined` so the plugins keep their
 * own defaults. Nested values always win over the top-level shorthands.
 */
export function resolveDidactViteOptions(options: DidactViteOptions = {}): {
  typst: DidactTypstOptions | false;
  vendors: DidactVendorsOptions | false;
} {
  return { typst: resolveTypstOptions(options), vendors: resolveVendorsOptions(options) };
}

/** Combined Vite plugin preset for Didact sites: Typst prerendering + WASM vendor assets. */
export function didactVite(options: DidactViteOptions = {}): Plugin[] {
  const resolved = resolveDidactViteOptions(options);
  const plugins: Plugin[] = [];
  if (resolved.typst === false) {
    plugins.push(didactTypst({ enabled: false }));
  } else {
    plugins.push(didactTypst(resolved.typst));
  }
  if (resolved.vendors !== false) {
    plugins.push(didactVendors(resolved.vendors));
  }
  return plugins;
}

export {
  assertDiagramQuality,
  blockLocation,
  compileDiagram,
  compileMath,
  configureTypstEngine,
  didactTypst,
  formatDiagnostic,
  mathLayoutCss,
  prerenderOrgPages,
  prerenderPageFiles,
  responsiveSvg,
  TYPST_RESOLVED_ID,
  TYPST_VIRTUAL_ID,
  type BlockKind,
  type DidactTypstOptions,
  type TypstEngineConfig,
} from './typst/index.ts';

export {
  didactVendors,
  normalizeBase,
  resolveVendorFiles,
  type DidactVendorsOptions,
  type VendorFile,
  type VendorGroup,
  type VendorKernelId,
} from './vendors.ts';
