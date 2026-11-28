# `didact check`

`didact check` (`@didact/cli`) lints `.org` lesson pages and, with `--run`,
verifies that each block's `#+RESULTS:` block and `#+CHECK:` expected output
still match what the code prints. It runs natively on **Node 24+**
(`#!/usr/bin/env node`) — no Bun installation is required.

```sh
pnpm check                    # lint every page
pnpm verify                   # lint + run Python blocks
didact check --pages DIR      # lint another site's pages
didact check --run python      # only the python page
```

## Usage

```
didact check [--pages DIR] [--run] [--python CMD] [page-stem ...]
```

- `--pages DIR` — directory of `*.org` pages. When omitted, `didact check`
  defaults to `src/pages` under the current working directory and falls back
  to `apps/site/src/pages` (for monorepo root invocations).
- `--run` — execute blocks and compare their stdout with both canned
  `#+RESULTS:` and any `#+CHECK:` expected output.
- `--python CMD` — interpreter for `--run` (default `python3`).
- `page-stem ...` — restrict the run to the named pages.
- `-h`, `--help` — print usage.

Pages are sorted by filename; passing an unknown `page-stem` is an error
(`page not found: <stem>` / `pages not found: …`), and an empty pages
directory fails with `no pages matched`.

## Syntax diagnostics

Without `--run`, every page is parsed with `@didact/core`'s
`parseOrgChecked`, which reports constructs the subset renderer silently
drops or misrenders:

- unsupported `#+` directives and unknown keywords;
- `#+NAME:` not followed by a source block;
- unclosed `#+BEGIN_SRC`;
- `#+END_SRC` without a matching `#+BEGIN_SRC`;
- numbered lists, blockquotes, and Markdown links;
- `:` output lines outside a `#+RESULTS` block;
- a missing `#+TITLE:`.

Each diagnostic prints as `line N [warning|error]: message`. Diagnostics
currently come from the core parser rather than a duplicated linter, so they
stay in sync with what the site actually renders.

## `--run`: RESULTS and CHECK verification

With `--run`, each block is sent to a `BlockRunner`. The default runner
executes Python blocks in a fresh interpreter (a temporary `.py` file,
30-second timeout that kills the child with SIGKILL, no stdin); it returns
`null` for every other language, so those blocks are reported as `skipped`.
Because no stdin is provided, a real `input()` call raises `EOFError` and the
block fails; mentioning `input()` in a comment or string does not affect the
run.

A `#+BEGIN_SRC` line with no language is rendered and scanned as `text`, so
the default runner skips it like any other non-Python block; a custom runner
can still verify its `#+RESULTS:` or `#+CHECK:`.

`#+EXERCISE: <title>` and `#+CHECK: <expected output>` are promises to the
next source block, like `#+NAME:`. A `#+CHECK:` without an `#+EXERCISE:`
still attaches (with the title `Exercise`); an `#+EXERCISE:` without a
`#+CHECK:` is an unchecked drill.

Promises are scoped to their fold, matching how the page renders: a block
inside a `#+BEGIN_HINT`/`#+BEGIN_SOLUTION` region may consume a promise
written before the fold, but a `#+NAME:`/`#+EXERCISE:`/`#+CHECK:` written
inside the fold never attaches to a block outside it. A comment region does
not disturb promises written before it.

Code inside a `#+BEGIN_COMMENT` … `#+END_COMMENT` region is ignored by the
block scanner: the region is skipped case-insensitively, and a missing
`#+END_COMMENT` makes it run to the end of the page. A disabled block
therefore never appears in the report, is never executed by `--run`, and is
never compared with a stale `#+RESULTS:` or `#+CHECK:`; exercise directives
inside the region are dropped with it.

For a block with an associated `#+RESULTS:` block, the runner's stdout is
compared with the canned text after stripping trailing newlines. The colon
after `#+RESULTS` is optional, blank and comment lines between the block and
its results are ignored, and a named `#+RESULTS: <name>` targets the block
with that `#+NAME`; if no preceding block carries that name the results
block is ignored rather than attached to the nearest block.

For a block with a `#+CHECK:`, the runner's stdout is compared with the
expected body after normalization: CRLF becomes LF, trailing whitespace is
ignored on every line, and trailing newlines are insignificant. The same
normalization is applied to the expected body, so `#+CHECK: 30` matches
`30\n` and `30  \r\n`. A block with a `#+CHECK:` is executed even when it
has no `#+RESULTS:` block.

A block may have both forms. Both are verified against the same execution:
a mismatch in either one is a failure whose detail names the failing check
(`canned #+RESULTS`, `#+CHECK`, or both) and shows `-expected`/`+actual`
lines for each. The outcomes are:

- every present check equal → `ok`;
- any present check different → `mismatch`, with the expected and actual
  output in the detail;
- nonzero exit → `error`, with an stderr excerpt.

A block with no canned results and no `#+CHECK:` is run-only: success is
`ok` as long as the interpreter exits zero. An unchecked drill (an
`#+EXERCISE:` with no `#+CHECK:`) is not run merely to exercise it: without
`#+RESULTS:` it is reported as `skipped`. Each block is independent — state
does not carry between blocks. Because the checker uses a fresh interpreter
per block, a block with `:session <name>` (which shares state with earlier
blocks in the browser) is reported as `skipped` rather than run; its output
is not verified by `--run`.

## Exit codes

`didact check` exits `1` when any syntax diagnostic is reported, or when any
run block ends in `error`/`mismatch`; `0` otherwise. It prints one line per
page (`<name>  <n> diagnostics  <n> blocks  <status>`), the diagnostics and
failing block details, and a final summary
(`N pages, D diagnostics, B blocks, F failures`).

## Checking another site

The linter only needs a directory of org files:

```sh
pnpm exec didact check --pages ../other-site/pages --run
```

Path resolution for `--pages` is relative to the current working directory.
