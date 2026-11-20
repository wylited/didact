// modes.ts — small StreamLanguage highlighters for block syntaxes that
// @codemirror/legacy-modes does not cover (or covers only for a different
// language). Assembly dialects live in asm.ts; this file is for the rest.
// Same shape as asm.ts's defineAsm: one token() that emits the standard
// highlight tag names thememirror's ayuLight HighlightStyle colors.
// Deliberately small — keywords, operators, comments, strings, numbers —
// enough for a lesson block to read at a glance, not a grammar.

import { StreamLanguage } from '@codemirror/language';
import type { StreamParser, StringStream } from '@codemirror/language';

function wordSet(words: string): Record<string, true> {
  return Object.fromEntries(words.split(' ').map((w) => [w, true as const]));
}

/** SQLite's keyword vocabulary (what kernel-sql's engine accepts), in
 *  lower case: the tokenizer folds case before the lookup. */
const SQL_KEYWORDS = wordSet(
  'abort action add after all alter always analyze and as asc attach autoincrement ' +
  'before begin between by cascade case cast check collate column commit conflict ' +
  'constraint create cross current current_date current_time current_timestamp ' +
  'database default deferrable deferred delete desc distinct do drop each else end ' +
  'escape except exclude exclusive exists explain fail filter first following for ' +
  'foreign from full generated glob group groups having if ignore immediate in index ' +
  'indexed initially inner insert instead intersect into is isnull join key last ' +
  'left like limit match materialized natural no not nothing notnull nulls of ' +
  'offset on or order others outer over partition plan pragma preceding primary ' +
  'query raise range recursive references regexp reindex release rename replace ' +
  'restrict returning right rollback row rows savepoint select set table temp ' +
  'temporary then ties to transaction trigger unbounded union unique update using ' +
  'vacuum values view virtual when where window with without',
);
const SQL_TYPES = wordSet(
  'bigint blob boolean char character date datetime decimal double float int integer ' +
  'numeric real text time timestamp varchar',
);

/** Patterns "*", "+", "?", "{", "}", "(", ")", "[", "]", "|", ".", "^", "$",
 *  and the escapes "\d" "\w" "\s" "\." "\[" … (a regex has almost no other
 *  punctuation, so the operator tag is the safe default). */
const REGEX_META = /^(?:[\\^$.*+?()[\]{}])/;

/** WAT instructions the teaching interpreter's lessons use, by prefix
 *  family; any other i32./i64./f32./f64./local./… name is also an
 *  instruction (returned as `keyword` by prefix below). */
/** Node keywords, standalone (`func` after `(`). */
const WAT_NODES = wordSet(
  'module func param result local global memory data table elem type import export start',
);

const WAT_OPCODES = wordSet(
  'nop drop select unreachable block loop end if then else call call_indirect ' +
  'return br br_if br_table local.get local.set local.tee global.get global.set ' +
  'memory.size memory.grow i32.load i32.store i32.const f32.const f64.const i64.const',
);

/** Typst's expression heads and pipeline keywords: everything written after
 *  a `#` (set, show, let, if, for, while, import, include, table, heading, …). */
const TYPST_KEYWORDS = wordSet(
  'set show let if else for while in import include break continue return ' +
  'context none auto true false not and or as',
);

function keywordOf(word: string, set: Record<string, true>): boolean {
  return word.toLowerCase() in set;
}

/**
 * SQL: `--` line comments and `/* *\/` block comments, '…' strings ('' is
 * an escaped quote), "…" / `…` quoted identifiers, numbers, keywords,
 * type names, niladic `null`/`true`/`false`.
 */
export const sqlSpec: StreamParser<{ block: boolean }> = {
  name: 'sql',
  startState: () => ({ block: false }),
  token(stream: StringStream, state: { block: boolean }): string | null {
    if (state.block) {
      if (stream.match(/^.*?\*\//)) state.block = false;
      else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('--')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.block = true;
      if (stream.match(/^.*?\*\//)) state.block = false;
      else stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/^'(?:[^']|'')*'?/)) return 'string';
    if (stream.match(/^"(?:[^"]|"")*"?/)) return 'typeName';
    if (stream.match(/^`[^`]*`?/)) return 'typeName';
    if (stream.match(/^(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/)) return 'number';
    const word = stream.match(/^[A-Za-z_][A-Za-z0-9_$]*/) as unknown as RegExpMatchArray | null;
    if (word !== null) {
      const lower = word[0].toLowerCase();
      // literals first: they are atoms, not keywords, whatever the
      // keyword vocabulary lists
      if (lower === 'null' || lower === 'true' || lower === 'false') return 'atom';
      if (lower in SQL_KEYWORDS) return 'keyword';
      if (lower in SQL_TYPES) return 'typeName';
      return null; // table / column identifiers stay plain
    }
    if (stream.match(/^(?:<>|!=|<=|>=|\|\||[-+*/%=<>.,;:()])/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '--', block: { open: '/*', close: '*/' } } },
};

/** The language defined from the spec above (what the editor mounts). */
export const sqlMode = StreamLanguage.define(sqlSpec);

/**
 * Regular expressions as kernel-regex reads them: `/pattern/` on one line.
 * Inside the slashes, metacharacters and escapes are operators, `{3}` /
 * `[a-z]` glue as single units, `#` starts a line comment (the kernel's
 * block format ignores such lines). Text outside `/…/` is a test input
 * and stays plain.
 */
export const regexpSpec: StreamParser<{ inPattern: boolean }> = {
  name: 'regexp',
  startState: () => ({ inPattern: false }),
  token(stream: StringStream, state: { inPattern: boolean }): string | null {
    // a fresh line can only OPEN a pattern
    if (stream.sol()) state.inPattern = false;
    if (stream.eatSpace()) return null;
    if (stream.match('#')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (!state.inPattern) {
      // the line must start with the slash (after indentation): `0/`,
      // `^/` and a bare `zz` are test input and stay plain
      const lead = (/^\s*/.exec(stream.string as string)?.[0].length ?? 0);
      if (stream.pos === lead && stream.match('/')) {
        state.inPattern = true;
        return 'operator';
      }
      stream.skipToEnd();
      return null;
    }
    if (stream.match('/')) {
      state.inPattern = false;
      return 'operator';
    }
    if (stream.match(/^\{\d*(?:,\d*)?\}/)) return 'operator';
    // A character class is one unit right up to its `]`; `[^…]` reads as
    // a negated atom. The scanner never runs past end of line, and an
    // unclosed class still highlights to the line's end.
    if (stream.match(/^\[\^(?:\\.|[^\\\]])*\]/)) return 'atom';
    if (stream.match(/^\[(?:\\.|[^\\\]])*\]/)) return 'string';
    // an escape is one unit: `\d`, `\.`, `\/`
    if (stream.match(/^\\/) ) { stream.next(); return 'operator'; }
    if (stream.match(REGEX_META)) return 'operator';
    stream.next();
    return null; // literal characters
  },
  languageData: { commentTokens: { line: '#' } },
};

/** The language defined from the spec above (what the editor mounts). */
export const regexpMode = StreamLanguage.define(regexpSpec);

/**
 * WebAssembly text, the folded WAT the kernel executes: `(module`, `(func
 * $name (export "main") (param i32) …`, `i32.add`, `local.get`, `$name`
 * identifiers, `;;` line and `(; … ;)` block comments.
 */
export const watSpec: StreamParser<{ depth: number; blockComment: number }> = {
  name: 'wat',
  startState: () => ({ depth: 0, blockComment: 0 }),
  token(stream: StringStream, state: { depth: number; blockComment: number }): string | null {
    if (state.blockComment > 0) {
      // the whole comment is one token: nested `(;` / `;)` only change
      // the depth, and an unterminated one stops at end of line
      for (;;) {
        if (stream.eol()) {
          state.blockComment = 0;
          break;
        }
        if (stream.match('(;')) {
          state.blockComment++;
        } else if (stream.match(';)')) {
          state.blockComment--;
          if (state.blockComment === 0) break;
        } else {
          stream.next();
        }
      }
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match(';;')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('(;')) {
      state.blockComment = 1;
      // …and read straight through to its `;)` in the same token
      for (;;) {
        if (stream.eol()) {
          state.blockComment = 0;
          break;
        }
        if (stream.match('(;')) state.blockComment++;
        else if (stream.match(';)')) {
          state.blockComment--;
          if (state.blockComment === 0) break;
        } else stream.next();
      }
      return 'comment';
    }
    if (stream.match('(')) {
      state.depth++;
      // the paren itself is punctuation; the node or instruction that
      // follows is the keyword (`func`, `param`, `i32.add`, `local.get`)
      return 'punctuation';
    }
    if (stream.match(')')) {
      state.depth = Math.max(0, state.depth - 1);
      return 'punctuation';
    }
    if (stream.match(/^"[^"]*"?/)) return 'string';
    if (stream.match(/^\$[^\s()";]*/)) return 'labelName';
    const num = stream.match(/^-[0-9]/) !== null;
    if (stream.match(/^-?(?:0[xX][0-9a-fA-F_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)/)) return 'number';
    if (num) return 'number';
    const word = stream.match(/^[A-Za-z][A-Za-z0-9_.]*/) as unknown as RegExpMatchArray | null;
    if (word !== null) {
      const w = word[0];
      if (w in WAT_NODES || w in WAT_OPCODES || /^(?:i32|i64|f32|f64)[._]/.test(w)) return 'keyword';
      if (/^(?:i32|i64|f32|f64|v128|funcref|externref)$/.test(w)) return 'typeName';
      return 'atom'; // module field names: module, func, mut, align, offset …
    }
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: ';;', block: { open: '(;', close: ';)' } } },
};

/** The language defined from the spec above (what the editor mounts). */
export const watMode = StreamLanguage.define(watSpec);

/**
 * Typst markup mode (what a block body is), not Typst code: headings,
 * list markers, strong/emphasis, math `$…$`, code expressions after `#`.
 * Inside `#{ … }` the code is followed only far enough to mark comments,
 * strings, keywords and numbers — a reading aid, not the Typst parser.
 */
export const typstSpec: StreamParser<{ inCode: boolean }> = {
  name: 'typst',
  startState: () => ({ inCode: false }),
  token(stream: StringStream, state: { inCode: boolean }): string | null {
    if (stream.eatSpace()) return null;

    // `#{ … }` code (the only Typst code a lesson block writes inline).
    if (state.inCode) {
      if (stream.match('//')) {
        stream.skipToEnd();
        return 'comment';
      }
      if (stream.match(/^\/\*[^\n]*(?:\*\/|$)/)) return 'comment';
      if (stream.match('*/')) return 'comment';
      if (stream.match(/^"[^"]*"?/)) return 'string';
      if (stream.match(/^[#{}()\[\],;:]/)) return 'punctuation';
      if (stream.match(/^\d+(?:\.\d+)?(?:pt|em|cm|mm|in|fr|%)?/)) return 'number';
      const word = stream.match(/^[A-Za-z_][A-Za-z0-9_-]*/) as unknown as RegExpMatchArray | null;
      if (word !== null) return keywordOf(word[0], TYPST_KEYWORDS) ? 'keyword' : null;
      const ch = stream.next();
      return ch !== null && ch !== undefined && '=<>+-*/!'.includes(ch) ? 'operator' : null;
    }

    // Markup — what a Typst block body is.
    if (stream.match('#{')) {
      state.inCode = true;
      return 'punctuation';
    }
    if (stream.peek() === '#') {
      stream.next();
      const word = stream.match(/^[A-Za-z_][A-Za-z0-9_-]*/) as unknown as RegExpMatchArray | null;
      if (word === null) return 'punctuation';
      return keywordOf(word[0], TYPST_KEYWORDS) ? 'keyword' : 'variableName';
    }
    if (stream.sol() && stream.match(/^=+\s/)) return 'keyword';
    if (stream.sol() && stream.match(/^[-+]\s/)) return 'punctuation';
    if (stream.sol() && stream.match(/^\/\s/)) return 'punctuation';
    if (stream.match(/^\*[^*\n]+\*/)) return 'strong';
    if (stream.match(/^_[^_\n]+_/)) return 'emphasis';
    if (stream.match(/^`[^`\n]*`?/)) return 'string';
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.peek() === '$') {
      // Inline math `$ … $`; `$` with no partner yields to the rest of the line.
      if (stream.match(/^\$[^$\n]*\$/)) return 'string';
    }
    // Prose: one run, up to the next markup.
    if (stream.match(/^[^#$`*_\/\n][^#$`*\/\n]*|^[#$`*_\/\n]/)) return null;
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//' } },
};

/** The language defined from the spec above (what the editor mounts). */
export const typstMode = StreamLanguage.define(typstSpec);
