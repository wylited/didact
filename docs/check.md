# `didact check`

`didact check` lints the org lesson pages and, with `--run`, verifies that
each block's `#+RESULTS:` block still matches what the code prints.

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

- `--pages DIR` — directory of `*.org` pages (default:
  `apps/site/src/pages` under the current directory).
- `--run` — execute blocks and compare their stdout with the canned
  results.
- `--python CMD` — interpreter for `--run` (default `python3`).
- `page-stem ...` — restrict the run to the named pages.
- `-h`, `--help` — print usage.

Pages are sorted by filename; a filter that matches nothing is an error
(`no pages matched`).

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

Each diagnostic prints as `line N: message`. Diagnostics currently come
from the core parser rather than a duplicated linter, so they stay in sync
with what the site actually renders.

## `--run`: RESULTS verification

With `--run`, each block is sent to a `BlockRunner`. The default runner
executes Python blocks in a fresh interpreter (a temporary `.py` file,
30-second timeout, no stdin); it returns `null` for every other language, so
those blocks are reported as `skipped`. A block whose code calls `input()`
is reported as an error because there is no stdin.

For a block with a following `#+RESULTS:` block, the runner's stdout is
compared with the canned text after stripping trailing newlines:

- equal → `ok`;
- different → `mismatch`, with the expected and actual output in the
  detail;
- nonzero exit → `error`, with an stderr excerpt.

A block with no canned results is run-only: success is `ok` as long as the
interpreter exits zero. Each block is independent — state does not carry
between blocks. Because the checker uses a fresh interpreter per block, a
block with `:session <name>` (which shares state with earlier blocks in the
browser) is reported as `skipped` rather than run; its output is not
verified by `--run`.

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
