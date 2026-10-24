// Session: compiles typst source to a rendered page through the vendored
// typst-wasm engine. `load` compiles once to validate (mapping the engine's
// 1-based diagnostic line to the block's error line), `run` reuses or
// re-performs that compile and exposes the engine's own SVG markup as an
// html panel (rendered in the panel and the block's results slot), warnings
// in a console panel, and page count / compile time as fields. There is no
// execution model to step through: typesetting is a one-shot transform, so
// `step` never runs and `features.stepping` is false.

import { loadEngine, type TypstDiagnostic, type TypstEngine } from './vendor';
import type { Field, LoadResult, Panel, RunResult, Session } from './types';

/** Pages wider than this (in px, at 96 dpi) get `width: 100%` instead. */
const MAX_INLINE_PX = 680;

/** One compile's outcome: either pages, or error diagnostics. */
type Outcome =
  | { ok: true; pages: string[]; ms: number; warnings: TypstDiagnostic[] }
  | { ok: false; errors: TypstDiagnostic[] };

interface EngineForCompile {
  addSource(path: string, text: string): Promise<unknown>;
  compile(opts: { main: string; format: 'svg' }): Promise<{
    pages: { output: string }[];
    diagnostics: TypstDiagnostic[];
  }>;
}

export class TypstSession implements Session {
  private static nextId = 0;
  /** Per-session virtual file, so concurrent blocks never collide. */
  private readonly path = `block-${++TypstSession.nextId}.typ`;
  private src = '';
  private loaded = false;
  private ran = false;
  private outcome: Outcome | null = null;
  private engineError: string | null = null;

  async load(src: string): Promise<LoadResult> {
    this.src = src;
    this.ran = false;
    this.outcome = null;
    let engine: TypstEngine;
    try {
      engine = await loadEngine();
    } catch (e) {
      this.engineError = e instanceof Error ? e.message : String(e);
      this.loaded = false;
      return { ok: false, line: 0, message: `engine unavailable: ${this.engineError}` };
    }
    this.engineError = null;
    try {
      const outcome = await compileDoc(engine, this.path, src);
      this.loaded = true;
      this.outcome = outcome;
      if (!outcome.ok) {
        const d = firstError(outcome.errors, this.path);
        return { ok: false, line: lineOf(d), message: messageOf(d) };
      }
      return {
        ok: true,
        summary: `compiled · ${outcome.pages.length} page${outcome.pages.length === 1 ? '' : 's'} · ${Math.round(outcome.ms)} ms`,
      };
    } catch (e) {
      this.loaded = false;
      this.engineError = e instanceof Error ? e.message : String(e);
      return { ok: false, line: 0, message: `engine failure: ${this.engineError}` };
    }
  }

  async run(_breakpoints?: number[]): Promise<RunResult> {
    if (this.engineError !== null) {
      return { finished: false, steps: 0, error: this.engineError };
    }
    if (!this.loaded) {
      return { finished: false, steps: 0, error: 'nothing loaded' };
    }
    if (this.outcome === null) {
      // Reset cleared the compiled output: compile again from the loaded source.
      try {
        this.outcome = await compileDoc(await loadEngine(), this.path, this.src);
      } catch (e) {
        return { finished: false, steps: 0, error: e instanceof Error ? e.message : String(e) };
      }
    }
    if (!this.outcome.ok) {
      const d = firstError(this.outcome.errors, this.path);
      return { finished: false, steps: 0, error: `compile failed (line ${lineOf(d)}): ${messageOf(d)}` };
    }
    this.ran = true;
    return { finished: true, steps: 0, exit: 'exit(0)' };
  }

  async step(): Promise<{ ran: boolean; result?: RunResult }> {
    return { ran: false };
  }

  reset(): void {
    this.ran = false;
    this.outcome = null; // back to the just-loaded state
  }

  state(): Panel[] {
    if (this.engineError !== null) {
      return [{ kind: 'console', id: 'typst-engine', title: 'engine', text: this.engineError }];
    }
    const outcome = this.outcome;
    if (outcome === null) return [];
    const panels: Panel[] = [];
    if (outcome.ok && this.ran) {
      panels.push({
        kind: 'html',
        id: 'typst-page',
        title: 'page',
        html: renderPages(outcome.pages),
      });
    }
    const diags = outcome.ok ? outcome.warnings : outcome.errors;
    if (diags.length > 0) {
      panels.push({
        kind: 'console',
        id: 'typst-diagnostics',
        title: outcome.ok ? 'warnings' : 'diagnostics',
        text: diags.map(formatDiagnostic).join('\n'),
      });
    }
    if (outcome.ok) {
      const fields: Field[] = [
        { key: 'pages', value: String(outcome.pages.length) },
        { key: 'compile', value: `${Math.round(outcome.ms)} ms` },
      ];
      if (outcome.warnings.length > 0) {
        fields.push({ key: 'warnings', value: String(outcome.warnings.length) });
      }
      panels.push({ kind: 'fields', id: 'typst-doc', title: 'document', fields });
    }
    return panels;
  }

  dispose(): void {
    // The engine (and its fonts) is shared across sessions; just drop state.
    this.outcome = null;
    this.loaded = false;
    this.ran = false;
    this.engineError = null;
  }
}

/** Compile `src` at `path`; engine errors become a failed Outcome. */
async function compileDoc(
  engine: EngineForCompile,
  path: string,
  src: string,
): Promise<Outcome> {
  const t0 = now();
  await engine.addSource(path, src);
  try {
    const result = await engine.compile({ main: path, format: 'svg' });
    return {
      ok: true,
      pages: result.pages.map((p) => p.output),
      ms: now() - t0,
      warnings: result.diagnostics,
    };
  } catch (cause) {
    const diags = diagnosticsOf(cause);
    if (diags === null) throw cause;
    return { ok: false, errors: diags };
  }
}

/** Extract typst diagnostics from a thrown CompileError, if that's what it is. */
function diagnosticsOf(cause: unknown): TypstDiagnostic[] | null {
  if (typeof cause === 'object' && cause !== null && 'diagnostics' in cause) {
    const diags: unknown = cause.diagnostics;
    if (Array.isArray(diags) && diags.every(isTypstDiagnostic)) return diags;
  }
  return null;
}

function isTypstDiagnostic(d: unknown): d is TypstDiagnostic {
  if (typeof d !== 'object' || d === null || !('message' in d) || !('hints' in d)) {
    return false;
  }
  return typeof d.message === 'string' && Array.isArray(d.hints);
}

function firstError(errors: TypstDiagnostic[], path: string): TypstDiagnostic {
  return (
    errors.find((d) => (!d.file || d.file === path) && d.severity === 'error') ??
    errors[0] ?? { message: 'unknown typst error', severity: 'error', hints: [] }
  );
}

function lineOf(d: TypstDiagnostic): number {
  return typeof d.line === 'number' && d.line > 0 ? d.line : 0;
}

function messageOf(d: TypstDiagnostic): string {
  return d.hints.length > 0 ? `${d.message} (${d.hints.join('; ')})` : d.message;
}

function formatDiagnostic(d: TypstDiagnostic): string {
  const at = d.file ? `${d.file}:${lineOf(d)}:${d.column ?? 1}` : `line ${lineOf(d)}`;
  return `${at}: ${d.severity}: ${messageOf(d)}`;
}

/**
 * Stack the engine's page SVGs. Typst sizes each `<svg>` in typographic
 * points; pages wider than MAX_INLINE_PX are switched to `width: 100%`
 * (the viewBox keeps the aspect ratio) so they fit the panel.
 */
function renderPages(pages: string[]): string {
  const svgs = pages.map(responsiveSvg).join('\n');
  return `<div style="display:inline-flex;flex-direction:column;gap:8px;max-width:100%">${svgs}</div>`;
}

function responsiveSvg(svg: string): string {
  const open = /^<svg\b[^>]*>/.exec(svg);
  if (open === null) return svg;
  const width = /\swidth="([\d.]+)pt"/.exec(open[0]);
  if (width === null) return svg;
  const px = (parseFloat(width[1]!) * 4) / 3;
  if (px <= MAX_INLINE_PX) return svg;
  return svg
    .replace(/\swidth="[\d.]+pt"/, ' width="100%"')
    .replace(/\sheight="[\d.]+pt"/, '')
    .replace('<svg', '<svg style="height:auto"');
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
