// block.ts — splits a block's source into the pattern line and the
// test inputs. Format:
//   - blank lines and lines whose first non-space character is '#' are
//     ignored (so a '#' input cannot be written — use \s etc.);
//   - the first surviving line is the pattern between slashes — no
//     flags in v1;
//   - every later surviving line is one test input, verbatim except
//     that \n \t \r \f \v \\ are decoded (so inputs can hold characters
//     you cannot type in a block).

import type { InputLine } from './engine';

export type BlockResult =
  | { ok: true; pattern: string; patternText: string; patternLine: number; inputs: InputLine[] }
  | { ok: false; line: number; message: string };

const INPUT_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', '\\': '\\' };

export function decodeInput(s: string): string {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length && INPUT_ESCAPES[s[i + 1]!] !== undefined) {
      out += INPUT_ESCAPES[s[i + 1]!]!;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** Find the closing '/' of the pattern line, skipping escaped
 *  characters; returns its index or -1. */
function findClosingSlash(line: string): number {
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1; // the next character is escaped (e.g. \/ in the pattern)
      continue;
    }
    if (line[i] === '/') return i;
  }
  return -1;
}

export function parseBlock(src: string): BlockResult {
  const lines = src.split('\n');
  let pattern: string | null = null;
  let patternText = '';
  let patternLine = 0;
  const inputs: InputLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw === '') continue;
    if (raw.trimStart().startsWith('#')) continue;
    if (pattern === null) {
      const text = raw.trim();
      if (!text.startsWith('/')) {
        return {
          ok: false,
          line: i + 1,
          message: `the first line must be the pattern between slashes, like /a(b|c)+d/ — got '${text}'`,
        };
      }
      const close = findClosingSlash(text);
      if (close === -1) {
        return { ok: false, line: i + 1, message: 'the pattern line is missing its closing /' };
      }
      const rest = text.slice(close + 1).trim();
      if (rest !== '') {
        let isFlags = true;
        for (const ch of rest) {
          if (!(ch >= 'a' && ch <= 'z')) {
            isFlags = false;
            break;
          }
        }
        return {
          ok: false,
          line: i + 1,
          message: isFlags
            ? `flags after the closing / are not supported in v1 (found '${rest}') — there is no i, g or m`
            : `unexpected text after the closing /: '${rest}'`,
        };
      }
      pattern = text.slice(1, close);
      patternText = text;
      patternLine = i + 1;
    } else {
      inputs.push({ text: decodeInput(raw), line: i + 1 });
    }
  }
  if (pattern === null) {
    return { ok: false, line: 1, message: 'no pattern line: start the block with the pattern between slashes' };
  }
  if (inputs.length === 0) {
    return { ok: false, line: patternLine, message: 'no test inputs — add one input line after the pattern' };
  }
  return { ok: true, pattern, patternText, patternLine, inputs };
}
