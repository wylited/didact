// pattern.ts — parses the text between the slashes into an AST.
// The subset: literals (incl. punctuation and control escapes), `.`,
// classes, the predefined \d \D \w \W \s \S, anchors ^ $, capturing and
// (?:…) groups, alternation, concatenation, and the quantifiers
// * + ? {n} {n,} {n,m}. Everything outside the subset — backreferences,
// lookahead/lookbehind, lazy quantifiers, named groups, unicode classes,
// word boundaries — is refused with an error naming the feature, mapped
// to the pattern's 1-based source line. All errors carry the line; the
// pattern itself is one line, so every parse error lands there.

/** A pattern-level failure with its 1-based source line. */
export class RegexError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
  }
}

/** One character range; single characters are lo === hi. */
export interface ClassItem {
  lo: string;
  hi: string;
}

export type PatternNode =
  | { kind: 'char'; ch: string }
  | { kind: 'any' }
  | { kind: 'class'; negated: boolean; items: ClassItem[]; src: string }
  | { kind: 'anchor'; which: '^' | '$' }
  | { kind: 'group'; index: number | null; body: PatternNode }
  | { kind: 'alt'; branches: PatternNode[] }
  | { kind: 'concat'; parts: PatternNode[] }
  /** max === Infinity for * + {n,}. */
  | { kind: 'repeat'; min: number; max: number; body: PatternNode };

export interface Pattern {
  root: PatternNode;
  /** Number of capturing groups, numbered by opening parenthesis. */
  groups: number;
}

const MAX_GROUPS = 99;

/** The exact member lists behind \d \w \s (and their complements). */
function predefinedClass(c: string): { negated: boolean; items: ClassItem[] } {
  const range = (lo: string, hi: string): ClassItem => ({ lo, hi });
  const one = (ch: string): ClassItem => ({ lo: ch, hi: ch });
  switch (c) {
    case 'd': return { negated: false, items: [range('0', '9')] };
    case 'D': return { negated: true, items: [range('0', '9')] };
    case 'w': return { negated: false, items: [range('A', 'Z'), range('a', 'z'), range('0', '9'), one('_')] };
    case 'W': return { negated: true, items: [range('A', 'Z'), range('a', 'z'), range('0', '9'), one('_')] };
    case 's': return { negated: false, items: [one(' '), one('\t'), one('\n'), one('\r'), one('\f'), one('\v')] };
    case 'S': return { negated: true, items: [one(' '), one('\t'), one('\n'), one('\r'), one('\f'), one('\v')] };
  }
  return { negated: false, items: [] }; // unreachable; see caller
}

const CONTROL_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v' };

class PatternParser {
  pos = 0;
  groupCount = 0;

  constructor(private readonly src: string, private readonly line: number) {}

  private fail(message: string): never {
    throw new RegexError(message, this.line);
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
  }

  parse(): Pattern {
    const root = this.parseAlternation();
    if (this.pos < this.src.length) {
      // parseAlternation only stops early on an unmatched ')'.
      this.fail("unmatched ')' — escape a literal ) as \\)");
    }
    return { root, groups: this.groupCount };
  }

  private parseAlternation(): PatternNode {
    const branches = [this.parseConcat()];
    while (this.peek() === '|') {
      this.pos += 1;
      branches.push(this.parseConcat());
    }
    return branches.length === 1 ? branches[0]! : { kind: 'alt', branches };
  }

  private parseConcat(): PatternNode {
    const parts: PatternNode[] = [];
    for (;;) {
      const c = this.peek();
      if (c === '' || c === '|' || c === ')') break;
      parts.push(this.parsePiece());
    }
    return parts.length === 1 ? parts[0]! : { kind: 'concat', parts };
  }

  private parsePiece(): PatternNode {
    const c = this.peek();
    if (c === '*' || c === '+' || c === '?') {
      this.fail(`quantifier '${c}' has nothing to repeat`);
    }
    if (c === '{') {
      const bad = this.scanBraces();
      if (bad === null) {
        this.fail("'{' is never closed — a quantifier looks like {n}, {n,} or {n,m} (a literal { is \\{)");
      }
      if (bad.valid) {
        this.fail(`quantifier '{${bad.inner}}' has nothing to repeat`);
      }
      this.fail(`bad quantifier '{${bad.inner}}' — expected {n}, {n,} or {n,m} (a literal { is \\{)`);
    }
    const atom = this.parseAtom();
    const q = this.peek();
    if (q === '*' || q === '+' || q === '?') {
      this.pos += 1;
      this.refuseLazy(q);
      const min = q === '+' ? 1 : 0;
      return { kind: 'repeat', min, max: Infinity, body: atom };
    }
    if (q === '{') {
      const { min, max } = this.parseCounted();
      this.refuseLazy(`{${min},${max === Infinity ? '' : max}}`);
      return { kind: 'repeat', min, max, body: atom };
    }
    return atom;
  }

  /** A lazy quantifier is out of the subset — leftmost-longest has no
   *  "try shortest first" to be lazy about. */
  private refuseLazy(q: string): void {
    if (this.peek() === '?') {
      this.fail(`lazy quantifier '${q}?' is not supported: matching here is leftmost-longest, so there is no try-shortest-first`);
    }
  }

  /** Read {n} {n,} {n,m}; the '{' is at this.pos. */
  private parseCounted(): { min: number; max: number } {
    const bad = this.scanBraces();
    if (bad === null) {
      this.fail("'{' is never closed — a quantifier looks like {n}, {n,} or {n,m} (a literal { is \\{)");
    }
    if (!bad.valid) {
      this.fail(`bad quantifier '{${bad.inner}}' — expected {n}, {n,} or {n,m} (a literal { is \\{)`);
    }
    const inner = bad.inner;
    const comma = inner.indexOf(',');
    const min = parseInt(inner.slice(0, comma === -1 ? inner.length : comma), 10);
    let max: number;
    if (comma === -1) max = min;
    else {
      const rest = inner.slice(comma + 1);
      max = rest === '' ? Infinity : parseInt(rest, 10);
    }
    if (max !== Infinity && min > max) {
      this.fail(`bad quantifier '{${inner}}' — the minimum ${min} is greater than the maximum ${max}`);
    }
    this.pos = bad.end + 1;
    return { min, max };
  }

  /** Locate the matching '}' and validate the shape by hand (no regex
   *  used to build regexes). Returns null when '}' never comes. */
  private scanBraces(): { inner: string; end: number; valid: boolean } | null {
    let i = this.pos + 1;
    while (i < this.src.length && this.src[i] !== '}') i += 1;
    if (i >= this.src.length) return null;
    const inner = this.src.slice(this.pos + 1, i);
    // shape: digits, then optionally ',' with optional digits, and the
    // first number must be present ({,3} is refused).
    let j = 0;
    while (j < inner.length && inner[j]! >= '0' && inner[j]! <= '9') j += 1;
    if (j === 0) return { inner, end: i, valid: false };
    if (j === inner.length) return { inner, end: i, valid: true };
    if (inner[j] !== ',') return { inner, end: i, valid: false };
    let k = j + 1;
    while (k < inner.length && inner[k]! >= '0' && inner[k]! <= '9') k += 1;
    return { inner, end: i, valid: k === inner.length };
  }

  private parseAtom(): PatternNode {
    const c = this.peek();
    if (c === '(') return this.parseGroup();
    if (c === ')') this.fail("unmatched ')' — escape a literal ) as \\)");
    if (c === '}') this.fail("unmatched '}' — a literal } is written \\}");
    if (c === '.') {
      this.pos += 1;
      return { kind: 'any' };
    }
    if (c === '^' || c === '$') {
      this.pos += 1;
      return { kind: 'anchor', which: c };
    }
    if (c === '[') return this.parseClass();
    if (c === '\\') {
      this.pos += 1;
      return this.parseEscape();
    }
    this.pos += 1;
    return { kind: 'char', ch: c };
  }

  private parseGroup(): PatternNode {
    this.pos += 1; // past '('
    let index: number | null = null;
    if (this.peek() === '?') {
      const c2 = this.peek(1);
      if (c2 === ':') {
        this.pos += 2;
      } else if (c2 === '=') {
        this.fail('lookahead (?=…) is not supported: it needs a sub-match peeking ahead — v1 keeps the engine strictly one pass, left to right');
      } else if (c2 === '!') {
        this.fail('negative lookahead (?!…) is not supported: it needs a sub-match peeking ahead — v1 keeps the engine strictly one pass, left to right');
      } else if (c2 === '<') {
        const c3 = this.peek(2);
        if (c3 === '=') this.fail('lookbehind (?<=…) is not supported: the engine runs strictly left to right');
        if (c3 === '!') this.fail('negative lookbehind (?<!…) is not supported: the engine runs strictly left to right');
        this.fail('named groups (?<name>…) are not supported in v1 — use plain (…)');
      } else if (c2 === 'P' && this.peek(2) === '<') {
        this.fail('named groups (?P<name>…) are not supported in v1 — use plain (…)');
      } else if (c2 === '') {
        this.fail("unclosed group: the '(' is never closed");
      } else {
        this.fail(`unsupported group '(?${c2}' — only (…) and (?:…) exist in v1`);
      }
    } else {
      this.groupCount += 1;
      if (this.groupCount > MAX_GROUPS) {
        this.fail(`too many capturing groups: ${this.groupCount} > ${MAX_GROUPS}`);
      }
      index = this.groupCount;
    }
    const body = this.parseAlternation();
    if (this.peek() !== ')') {
      this.fail("unclosed group: the '(' is never closed");
    }
    this.pos += 1;
    return { kind: 'group', index, body };
  }

  private parseEscape(): PatternNode {
    const c = this.peek();
    if (c === '') this.fail('trailing backslash: \\ escapes nothing');
    this.pos += 1;
    if (c >= '0' && c <= '9') {
      if (c !== '0') {
        this.fail(`backreferences (\\${c}) are not supported: an NFA has no memory of what an earlier group matched — that takes unbounded store, which finite automata do not have`);
      }
      this.fail(`unknown escape \\${c} — supported: \\d \\D \\w \\W \\s \\S, \\n \\t \\r \\f \\v, and \\ before punctuation`);
    }
    const isLetter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    if (isLetter) {
      const lower = c.toLowerCase();
      if (lower === 'd' || lower === 'w' || lower === 's') {
        const def = predefinedClass(c);
        return { kind: 'class', negated: def.negated, items: def.items, src: `\\${c}` };
      }
      if (CONTROL_ESCAPES[c] !== undefined) return { kind: 'char', ch: CONTROL_ESCAPES[c]! };
      if (lower === 'p') {
        this.fail('unicode classes (\\p{L}) are not supported in v1 — write the characters out in a class, or use \\d \\w \\s');
      }
      if (lower === 'b') {
        this.fail(`word boundaries (\\${c}) are not supported in v1 — combine ^, $ and classes`);
      }
      if (lower === 'k') {
        this.fail('backreferences by name (\\k<name>) are not supported: an NFA has no memory of what an earlier group matched');
      }
      this.fail(`unknown escape \\${c} — supported: \\d \\D \\w \\W \\s \\S, \\n \\t \\r \\f \\v, and \\ before punctuation`);
    }
    // Escaped punctuation (and anything non-letter) is that literal.
    return { kind: 'char', ch: c };
  }

  private parseClass(): PatternNode {
    const start = this.pos;
    this.pos += 1; // past '['
    const negated = this.peek() === '^';
    if (negated) this.pos += 1;
    const items: ClassItem[] = [];
    if (this.peek() === ']') {
      this.fail('empty class: [] needs at least one member (] always ends a class, and there are no escapes inside classes in v1)');
    }
    for (;;) {
      const c = this.peek();
      if (c === '') this.fail("unclosed class: '[' is never closed");
      if (c === ']') break;
      if (c === '\\') {
        this.fail('escapes inside classes are not supported in v1 — spell out members like [a-z09]');
      }
      this.pos += 1;
      const lo = c;
      // '-': a range when something other than ']' follows it.
      if (this.peek() === '-' && this.peek(1) !== '' && this.peek(1) !== ']') {
        this.pos += 1; // past '-'
        const hi = this.peek();
        if (hi === '') this.fail("unclosed class: '[' is never closed");
        if (hi === '\\') {
          this.fail('escapes inside classes are not supported in v1 — spell out members like [a-z09]');
        }
        if (hi < lo) this.fail(`bad range '${lo}-${hi}': the start must not come after the end`);
        this.pos += 1;
        items.push({ lo, hi });
      } else {
        items.push({ lo, hi: lo });
      }
    }
    this.pos += 1; // past ']'
    return { kind: 'class', negated, items, src: this.src.slice(start, this.pos) };
  }
}

/** Parse the pattern body (the text between the slashes). */
export function parsePattern(body: string, line: number): Pattern {
  return new PatternParser(body, line).parse();
}
