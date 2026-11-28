// block-editor.ts — CodeMirror 6 editor setup for executable blocks:
// undo/redo history, learner shortcuts (Mod-Enter / Shift-Enter),
// current/error line decorations, and optional breakpoint gutter.

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  Compartment,
  EditorState,
  Range,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  keymap,
  lineNumbers,
  ViewPlugin,
} from '@codemirror/view';
import { ayuLight } from 'thememirror';
import type { Kernel } from './kernel';
import { loadEditorLanguage } from './languages';

export interface LineMarks {
  current: number | null;
  error: number | null;
}

const setMarks = StateEffect.define<Partial<LineMarks>>();

const marksField = StateField.define<LineMarks>({
  create: () => ({ current: null, error: null }),
  update(value, tr) {
    let v = value;
    for (const e of tr.effects) {
      if (e.is(setMarks)) v = { ...v, ...e.value };
    }
    if (!tr.docChanged) return v;
    // keep marks on their text when the student edits around them
    const shift = (line: number | null): number | null => {
      if (line === null) return null;
      const clamped = Math.min(tr.startState.doc.lines, Math.max(1, line));
      const from = tr.changes.mapPos(tr.startState.doc.line(clamped).from);
      return tr.state.doc.lineAt(Math.max(0, from)).number;
    };
    return { current: shift(v.current), error: shift(v.error) };
  },
});

const markDecos = EditorView.decorations.compute([marksField], (state) => {
  const { current, error } = state.field(marksField);
  const ranges: Range<Decoration>[] = [];
  const add = (line: number | null, cls: string): void => {
    if (line !== null && line >= 1 && line <= state.doc.lines) {
      const deco = Decoration.line({ class: cls });
      ranges.push(deco.range(state.doc.line(line).from));
    }
  };
  add(current, 'lw-current-line');
  add(error, 'lw-error-line');
  return Decoration.set(ranges);
});

/* ---- breakpoints (kernels with features.breakpoints): clicking a line
   number toggles a breakpoint on that 1-based line; filled black square
   markers live in a slim gutter; run() passes the active lines on. */

const toggleBreakpoint = StateEffect.define<number>(); // 1-based line

/** Sorted active breakpoint lines, mapped through doc changes with the
 *  same keep-marks-on-their-text approach as `marksField`. */
const breakpointsField = StateField.define<number[]>({
  create: () => [],
  update(value, tr) {
    let v = value;
    for (const e of tr.effects) {
      if (!e.is(toggleBreakpoint)) continue;
      v = v.includes(e.value)
        ? v.filter((l) => l !== e.value)
        : [...v, e.value].sort((a, b) => a - b);
    }
    if (!tr.docChanged) return v;
    const shift = (line: number): number => {
      const clamped = Math.min(tr.startState.doc.lines, Math.max(1, line));
      const from = tr.changes.mapPos(tr.startState.doc.line(clamped).from);
      return tr.state.doc.lineAt(Math.max(0, from)).number;
    };
    const out: number[] = [];
    for (const line of v) {
      const shifted = shift(line);
      if (!out.includes(shifted)) out.push(shifted);
    }
    return out.sort((a, b) => a - b);
  },
});

class BreakpointMarker extends GutterMarker {
  constructor(readonly line: number) {
    super();
  }
  override eq(other: BreakpointMarker): boolean {
    return other.line === this.line;
  }
  override toDOM(view: EditorView): Node {
    const doc = view.dom.ownerDocument ?? document;
    const el = doc.createElement('div');
    el.className = 'lw-bp';
    el.dataset.test = `breakpoint-${this.line}`;
    return el;
  }
}

/** Hidden width template: the marker gutter keeps its width before the
 *  first breakpoint is placed. */
class BpSpacer extends GutterMarker {
  override eq(): boolean {
    return true;
  }
  override toDOM(view: EditorView): Node {
    const doc = view.dom.ownerDocument ?? document;
    const el = doc.createElement('div');
    el.className = 'lw-bp';
    return el;
  }
}

const breakpointGutter = gutter({
  class: 'lw-bp-gutter',
  markers(view) {
    const { doc } = view.state;
    return RangeSet.of(
      view.state
        .field(breakpointsField)
        .filter((line) => line >= 1 && line <= doc.lines)
        .map((line) => ({
          from: doc.line(line).from,
          to: doc.line(line).from,
          value: new BreakpointMarker(line),
        })),
      true,
    );
  },
  lineMarkerChange: (update) =>
    update.startState.field(breakpointsField, false)
    !== update.state.field(breakpointsField, false),
  initialSpacer: () => new BpSpacer(),
});

/** data-test=gutter-N on every rendered line-number element (the hidden
 *  width spacer and non-numeric elements are skipped). */
function labelLineNumberEls(view: EditorView): void {
  for (const el of view.dom.querySelectorAll<HTMLElement>(
    '.cm-lineNumbers .cm-gutterElement',
  )) {
    if (el.style.visibility === 'hidden') continue;
    const n = Number(el.textContent);
    if (Number.isInteger(n) && n >= 1) el.dataset.test = `gutter-${n}`;
  }
}

const labelGutterNumbers = EditorView.updateListener.of((update) => {
  if (
    update.docChanged || update.viewportChanged
    || update.geometryChanged || update.heightChanged
  ) {
    labelLineNumberEls(update.view);
  }
});

/** Holds the language extension so a lazily loaded mode can reconfigure
 *  the mounted editor in place. */
const languageCompartment = new Compartment();

export interface BlockEditorConfig {
  parent: HTMLElement;
  initialCode: string;
  canBreak: boolean;
  canStep: boolean;
  /** Synchronous language override supplied by the host; wins over
   *  `syntax` and never triggers a lazy load. */
  language: Extension | null;
  /** Kernel syntax to load lazily when `language` is null/undefined. */
  syntax?: Kernel['editorSyntax'];
  theme?: Extension;
  extensions?: readonly Extension[];
  readOnly?: boolean;
  onRun: () => void;
  onStep: () => void;
  onDocChanged: () => void;
}

/** Build and mount one block's CodeMirror 6 editor. */
export function createBlockEditor(config: BlockEditorConfig): EditorView {
  // Mod-Enter always runs. Shift-Enter maps to Step only when the kernel
  // exposes stepping; otherwise it must keep the editor's default action.
  const learnerKeys = [
    {
      key: 'Mod-Enter',
      run: (): boolean => {
        config.onRun();
        return true;
      },
    },
  ];
  if (config.canStep) {
    learnerKeys.push({
      key: 'Shift-Enter',
      run: (): boolean => {
        config.onStep();
        return true;
      },
    });
  }

  const extensions: Extension[] = [
    // clicking a line number toggles a breakpoint on that line
    config.canBreak
      ? lineNumbers({
          domEventHandlers: {
            mousedown: (view, line): boolean => {
              const n = view.state.doc.lineAt(line.from).number;
              view.dispatch({ effects: toggleBreakpoint.of(n) });
              return true;
            },
          },
        })
      : lineNumbers(),
    history(),
    // learner shortcuts take precedence over history and default keymaps
    keymap.of(learnerKeys),
    keymap.of(historyKeymap),
    keymap.of(defaultKeymap),
    languageCompartment.of(config.language ?? []),
    config.theme ?? ayuLight,
    marksField,
    markDecos,
    labelGutterNumbers,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) config.onDocChanged();
    }),
  ];
  if (config.canBreak) extensions.push(breakpointsField, breakpointGutter);
  if (config.readOnly === true) {
    extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
  }
  if (config.extensions !== undefined && config.extensions.length > 0) {
    extensions.push(...config.extensions);
  }

  let destroyed = false;
  extensions.push(ViewPlugin.define(() => ({
    destroy: () => {
      destroyed = true;
    },
  })));

  const view = new EditorView({
    parent: config.parent,
    state: EditorState.create({ doc: config.initialCode, extensions }),
  });
  labelLineNumberEls(view);

  // Mount immediately in plain text; upgrade in place once the mode for
  // this kernel has loaded. A host-provided `language` (or a block whose
  // kernel declares no syntax) skips the load entirely.
  const syntax = config.syntax;
  if (config.language == null && syntax !== undefined) {
    void loadEditorLanguage(syntax).then((language) => {
      if (destroyed) return;
      view.dispatch({
        effects: languageCompartment.reconfigure(language ?? []),
      });
      view.dom.dataset.language = syntax;
    }).catch(() => {
      /* a missing mode leaves the block in plain text */
    });
  }
  return view;
}

export function dispatchLineMarks(view: EditorView, marks: Partial<LineMarks>): void {
  view.dispatch({ effects: setMarks.of(marks) });
}

/** Active breakpoint lines (sorted), or undefined when breakpoints are off. */
export function getBreakpointLines(view: EditorView, canBreak: boolean): number[] | undefined {
  if (!canBreak) return undefined;
  return view.state.field(breakpointsField, false);
}
