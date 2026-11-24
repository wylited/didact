// babel.ts — org-babel header argument parsing.
//
// The text after `#+BEGIN_SRC <lang>` is otherwise Emacs documentation:
// babel uses it for tangling, export, and execution options that the site
// does not implement. Only the options the site actually honors are
// extracted here; today that is `:session <name>`.

export interface BabelOptions {
  /** Session name from `:session <name>`, when present. */
  session?: string;
}

/** Parse a src block's header string. Unknown options are ignored, and a
 *  bare `:session` (no name) is treated as absent. */
export function parseBabelHeaders(headers: string): BabelOptions {
  const match = /(?:^|\s):session\s+(\S+)/i.exec(headers);
  return match === null ? {} : { session: match[1] };
}
