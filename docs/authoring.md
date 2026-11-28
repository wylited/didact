# Authoring Lessons in Org Mode

Didact lessons are plain `.org` files that remain valid org-babel documents in
Emacs. Every file in your pages directory becomes one lesson when listed in your
site's page order (see [`docs/getting-started.md`](getting-started.md)).

## Page metadata and structure

Start every page with `#+TITLE:` (required — `didact check` warns if it is
missing) and an optional `#+SUBTITLE:`:

```org
#+TITLE: Recursion and the Call Stack
#+SUBTITLE: Stepping through stack frames one call at a time

A function calls itself by pushing a fresh frame onto the call stack.

* Base cases

Every recursive function needs a stopping condition.

** Counting down

Watch the call stack grow and unwind.
```

- `*` headings become `<h2>`, `**` become `<h3>`, `***` become `<h4>`.
- `<h2>` and `<h3>` headings automatically populate the navigation rail's
  **Contents** tree with stable slug anchors (`#/<page-slug>/<section-slug>`).
- Lines starting with `# ` are hidden comments.
- Multi-line comments use `#+BEGIN_COMMENT` … `#+END_COMMENT`
  (case-insensitive); everything inside — including `#+BEGIN_SRC` blocks — is
  dropped at parse time and ignored by `didact check`.

## Inline markup, lists, and tables

| Org syntax | Rendered result |
| --- | --- |
| `*bold*` | **bold** |
| `/italic/` | *italic* |
| `=code=` or `~verbatim~` | `inline code` (literal — `$` inside is never parsed as math) |
| `- item` | Unordered bullet list |
| `\| col A \| col B \|` | Table (first row before `\|---\|` becomes the header row) |
| `\$` | Literal `$` character |

## Links

| Syntax | Target |
| --- | --- |
| `[[file:python.org][Python]]` | Another lesson page (resolved by filename, stem, or slug) |
| `[[file:python.org::*Execution traces and loop-variable scope][loops]]` | A specific heading on another lesson page |
| `[[file:python.org::#section-slug][loops]]` | A section anchor on another lesson page |
| `[[*Base cases][base cases]]` or `[[#base-cases]]` | A heading or section on the current page |
| `[[https://example.com][Example]]` / `[[mailto:a@b.com]]` | External link |

Bare `[[python.org::*Heading]]` works too. An unresolved internal link renders
inert (`data-test="link-broken"`) rather than navigating to a dead hash.

## Executable code blocks

A `#+BEGIN_SRC <lang>` block is executable when `<lang>` matches a registered
kernel id; any other language renders as a clean read-only listing.

```org
#+NAME: sum-loop
#+BEGIN_SRC python
total = 0
for n in range(1, 6):
    total += n
print(total)
#+END_SRC

#+RESULTS:
: 15
```

- **`#+NAME:`** gives the block a stable identity (`#sum-loop`) for saved
  drafts and exercise progress. Named blocks survive reordering on the page;
  unnamed blocks are content-hashed from their sample source.
- **`#+RESULTS:`** shows canned output until the learner runs the block, when
  live output replaces the slot. `didact check --run` verifies canned results
  against real execution.
- **Editor shortcuts:** `Cmd/Ctrl+Enter` runs the block, `Shift+Enter` steps
  one unit (when the kernel supports stepping), and `Cmd/Ctrl+Z` /
  `Cmd/Ctrl+Shift+Z` (or `Ctrl+Y`) undo and redo edits.
- **Breakpoints:** On kernels that support breakpoints, click a line number in
  the editor gutter to toggle a breakpoint before pressing **Run**.

## Shared state with `:session`

Add `:session <name>` to two or more blocks of the same language on a page to
share a single live session across them (following org-babel semantics):

```org
#+BEGIN_SRC python :session demo
def double(x):
    return x * 2
#+END_SRC

#+BEGIN_SRC python :session demo
print(double(21))
#+END_SRC
```

- Sessions are **page-scoped**: switching pages disposes them.
- Clicking **Reset** (`⟲`) on any block in a shared group resets the shared
  session and clears output across every member block in that group.
- **9 of 17 kernels support `:session`** (`Session.resume()`):
  `python`, `fortran`, `sql`, `matlab`, `elisp`, `prolog`, `lisp`, `lua`, and
  `javascript`.
- The remaining 8 kernels (`asm`, `riscv`, `mips`, `c`, `cpp`, `wasm`, `regex`,
  `typst`) do not share session state; `:session` blocks for them still run
  isolated and display an unsupported-session indicator in the block header.

## Hints and solutions (folds)

Wrap optional scaffolding in `#+BEGIN_HINT` … `#+END_HINT` or
`#+BEGIN_SOLUTION` … `#+END_SOLUTION` (case-insensitive). Both render as closed
`<details>` folds titled **Show hint** and **Show solution**.

```org
#+BEGIN_HINT
Think about what happens when =n= reaches =0=.
#+END_HINT

#+BEGIN_SOLUTION
#+BEGIN_SRC javascript
function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
console.log(fact(5));
#+END_SRC
#+END_SOLUTION
```

Folds parse recursively through the full grammar: they can contain prose,
lists, tables, executable blocks, and nested folds. Executable block numbering
and page search include fold contents in document order.

## Exercises and automated checks

Turn any executable block into a self-checked exercise by placing
`#+EXERCISE:` and `#+CHECK:` immediately above it:

```org
#+NAME: ex-squares
#+EXERCISE: Sum of first 5 squares
#+CHECK: 55
#+BEGIN_SRC python
# Fix the loop to sum 1^2 + 2^2 + ... + 5^2
total = 0
for n in range(1, 5):
    total += n * n
print(total)
#+END_SRC
```

- `#+EXERCISE: <title>` titles the exercise badge (defaults to `Exercise` if
  omitted when `#+CHECK:` is present).
- `#+CHECK: <expected output>` sets the expected console output. Comparison
  normalizes CRLF to LF, trims trailing spaces/tabs per line, and ignores
  trailing blank lines.
- A block with `#+EXERCISE:` but no `#+CHECK:` renders an **unchecked** drill
  badge and never counts toward automated completion.
- Passing verdicts persist in storage and update the page footer's
  `Exercises n/m` counter and the Pages rail checkmark (`✓`). Pages without
  checked exercises show a manual **Mark complete** toggle instead.
- The four block-promise directives (`#+NAME:`, `#+CAPTION:`, `#+EXERCISE:`,
  and `#+CHECK:`) apply to the next `#+BEGIN_SRC` block and clear after it. A
  promise written inside a fold never leaks out to a block after the fold.
  Dangling `#+NAME:`, `#+EXERCISE:`, and `#+CHECK:` directives emit parser
  warnings; a dangling `#+CAPTION:` is ignored without a warning.

## Typst math and static diagrams

When your site enables `didactVite()` / `didactTypst()`:

- **Inline math:** `$sum_(k=1)^n k = (n(n+1))/2$` compiles at build time to
  MathML (with SVG fallback). Spaces immediately inside `$ … $` disable math
  parsing so prose currency stays literal.
- **Display math:** `$$ integral_0^1 x^2 dif x = 1/3 $$` renders as a centered
  display equation.
- **Static diagrams:** Add `:results svg` (or `:file <path>`) to a `typst`
  block, optionally preceded by `#+CAPTION:`:

```org
#+CAPTION: Request flow
#+BEGIN_SRC typst :results svg
#import "@preview/fletcher:0.5.8": diagram, node, edge
#diagram(
  node((0, 0), [Browser], stroke: 0.8pt),
  node((1.5, 0), [WASM kernel], stroke: 0.8pt),
  edge((0, 0), (1.5, 0), "->"),
)
#+END_SRC
```

Static diagram blocks compile once at build time and may import any pinned
`@preview/name:version` package. A plain `#+BEGIN_SRC typst` block (without
`:results svg` or `:file`) stays an interactive in-browser Typst block. See
[`docs/typst-web.md`](typst-web.md) for the full Typst authoring reference.

## Linting and verifying lessons

The Org subset intentionally omits constructs it does not render (numbered
lists, Markdown `[text](url)` links, `>` blockquotes, unknown `#+` directives,
stray `#+END_SRC`, unclosed blocks, dangling `#+NAME:` promises, and missing
`#+TITLE:`). Unsupported constructs appear in a warning banner on the page
(unless `showOrgWarnings: false`) and fail `didact check`:

```sh
didact check                  # lint all *.org pages
didact check --run            # lint + verify Python #+RESULTS: and #+CHECK:
didact check --pages lessons  # check a custom directory
```

See [`docs/check.md`](check.md) for full CLI options and exit codes.
