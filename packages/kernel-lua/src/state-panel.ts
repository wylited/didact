// state-panel.ts — the Values panel: every name the block assigned, with
// the Lua type tag assignment gave it and a one-line note on what that
// means. The story of a dynamically typed language is exactly this tag:
//   • `local x` and `x = …` look identical at the use site, but only the
//     first is a frame local — the second is a key of _G;
//   • every number is an integer or a float, decided by the literal and
//     the operator (/ is always float; 3 // 2 is 1, 1 / 2 is 0.5);
//   • nil and false are the only falsy values — 0 and "" are true.
// Pure data in, Panel out: a unit test drives it without an interpreter.

import type { Field, Panel } from './types';

/** One assignment target, as the session recorded it. */
export interface ValuedName {
  name: string;
  value: string;   // toStr(v): '3', '3.0', 'hi', 'true', 'table: 0x0004'
  type: string;    // typeName(v): nil | boolean | number | string | table | function
  /** `local` declaration vs. a write to a global (a _G key). */
  local: boolean;
  /** Assigned `nil`: reading the name now yields nil (or an unset key). */
  erased: boolean;
  /** In scope right now: a local bound in a live frame, or a _G key. */
  live: boolean;
  /** Written since the previous snapshot (drives the changed highlight). */
  changed: boolean;
}

/** What `= value` of this type does, in one line. */
export function assignmentNote(type: string): string {
  switch (type) {
    case 'nil':
      return 'nil — the absence of a value: reading it is nil, assigning it erases a table key';
    case 'boolean':
      return 'boolean — only nil and false are falsy; 0 and "" are true';
    case 'number':
      return 'number — an integer or a float, decided by the literal and the operator (/ always gives a float)';
    case 'string':
      return 'string — immutable, and always truthy, even ""';
    case 'table':
      return 'table — a reference: assignment aliases the table, it never copies it';
    case 'function':
      return 'function — a value like any other; assigning it does not call it';
    default:
      return `${type} value`;
  }
}

/** What shadows what: a local hides a global of the same name. */
export function scopeNote(local: boolean): string {
  return local
    ? "local: bound in the block's scope, not a key in _G"
    : 'global: nothing was declared, so this is a key in _G';
}

export function valuesPanel(names: readonly ValuedName[]): Panel {
  const fields: Field[] = names.map((n) => ({
    key: n.name,
    value: n.value,
    sub: `${n.type} · ${n.local ? 'local' : 'global'}${n.live || !n.local ? '' : ' · out of scope'}`,
    ...(n.changed ? { changed: true } : {}),
    tip: `${n.name} ← ${n.erased ? 'assigned nil' : `a ${n.type} value`}. ${assignmentNote(n.type)}. ${scopeNote(n.local)}` +
      (n.local && !n.live ? '. Its scope has ended, so the name is no longer bound.' : ''),
  }));
  return {
    kind: 'fields',
    id: 'lua-values',
    title: `Values · ${names.length} name${names.length === 1 ? '' : 's'}`,
    tip: 'Every name the block assigned, with the type tag the assignment gave it — in Lua the type travels with the value, not the name.',
    fields,
  };
}
