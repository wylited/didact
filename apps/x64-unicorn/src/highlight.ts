// CodeMirror 6 pieces: an Intel-assembly StreamLanguage, a highlight style,
// a dark editor theme and a reusable line-highlight extension used for the
// current-instruction marker and the error-line marker.

import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

interface AsmLineState {
  seenFirst: boolean;
}

const RE_COMMENT = /;.*/;
const RE_STRING = /^"(?:[^"\\]|\\.)*"?/;
const RE_CHAR = /^'(?:[^'\\]|\\.)*'?/;
const RE_DIRECTIVE = /^(?:section|segment|db|dw|dd|dq|equ|times)\b/i;
const RE_WORD = /^[A-Za-z_.$][\w.$]*/;
const RE_NUMBER = /^(?:0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+)\b/;

export const asmLanguage = StreamLanguage.define<AsmLineState>({
  startState: () => ({ seenFirst: false }),
  token(stream, state): string | null {
    if (stream.sol()) state.seenFirst = false;
    if (stream.eatSpace()) return null;
    if (stream.match(RE_COMMENT)) return 'comment';
    if (stream.match(RE_STRING)) return 'string';
    if (stream.match(RE_CHAR)) return 'string';
    if (!state.seenFirst && stream.match(RE_DIRECTIVE)) {
      state.seenFirst = true;
      return 'keyword';
    }
    const word = stream.match(RE_WORD);
    if (word) {
      if (!state.seenFirst) {
        state.seenFirst = true;
        // A word followed by ':' (no space eaten yet) is a label definition.
        return stream.peek() === ':' ? 'label' : 'mnemonic';
      }
      return 'operand';
    }
    if (stream.match(RE_NUMBER)) return 'number';
    stream.next();
    return null;
  },
  tokenTable: {
    label: t.labelName,
    mnemonic: t.operator,
    operand: t.variableName,
  },
  languageData: { commentTokens: { line: ';' } },
});

export const asmHighlightStyle = HighlightStyle.define([
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: t.string, class: 'tok-string' },
  { tag: t.number, class: 'tok-number' },
  { tag: t.labelName, class: 'tok-label' },
  { tag: t.operator, class: 'tok-mnemonic' },
  { tag: t.variableName, class: 'tok-operand' },
]);

export const editorTheme = EditorView.theme(
  {
    '&': {
      height: 'auto',
      backgroundColor: 'transparent',
      color: 'var(--fg)',
      fontSize: '13px',
    },
    '.cm-scroller': {
      fontFamily: 'var(--mono)',
      lineHeight: '1.5',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--muted)',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent' },
    '.cm-content': { caretColor: 'var(--accent)' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(94, 158, 255, 0.28)' },
    '.cm-line.cm-current-instr': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
    },
    '.cm-line.cm-error-line': {
      backgroundColor: 'color-mix(in srgb, var(--error) 18%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--error) 45%, transparent)',
    },
  },
  { dark: true },
);

export interface LineHighlighter {
  extension: Extension;
  set(view: EditorView, line: number | null): void;
}

/**
 * A Decoration.line-based marker that highlights one 1-based document line.
 * `set(view, null)` clears it.
 */
export function makeLineHighlight(cls: string): LineHighlighter {
  const effect = StateEffect.define<number | null>();
  const field = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(_value, tr) {
      for (const e of tr.effects) {
        if (!e.is(effect)) continue;
        const line = e.value;
        if (line === null || line < 1 || line > tr.state.doc.lines) return Decoration.none;
        const pos = tr.state.doc.line(line).from;
        return Decoration.set([Decoration.line({ class: cls }).range(pos)]);
      }
      return Decoration.none;
    },
  });
  return {
    extension: field,
    set(view: EditorView, line: number | null): void {
      view.dispatch({ effects: effect.of(line) });
    },
  };
}
