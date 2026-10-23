// org.ts — hand-written org-mode subset parser (grammar per docs/design.md,
// "Org-mode compatibility"). The lesson stays a real .org file (valid in
// Emacs / org-babel); this parser renders it client-side.

export interface SrcBlock {
  lang: string;
  /** Babel headers (`:results …`), parsed and ignored. */
  headers: string[];
  lines: string[];
  name: string | null;
  /** Canned `#+RESULTS:` content, or null when the block has none. */
  results: string | null;
  /** true when lang is this app's executable language. */
  executable: boolean;
}

export type OrgNode =
  | { t: "heading"; depth: number; text: string }
  | { t: "para"; text: string }
  | { t: "list"; items: string[] }
  | { t: "table"; rows: string[][] }
  | { t: "src"; block: SrcBlock }
  | { t: "example"; lines: string[] };

export interface OrgDoc {
  title: string | null;
  subtitle: string | null;
  nodes: OrgNode[];
}

/** The org language tag this app executes. */
export const ASM_LANG = "asm-riscv";

export function parseOrg(src: string): OrgDoc {
  const lines = src.split(/\r?\n/);
  const nodes: OrgNode[] = [];
  let title: string | null = null;
  let subtitle: string | null = null;
  let pendingName: string | null = null;
  let lastSrc: SrcBlock | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length > 0) {
      nodes.push({ t: "para", text: para.join(" ") });
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // headings must start at column 0 with stars (checked on the raw line)
    const heading = /^(\*+)\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      nodes.push({ t: "heading", depth: heading[1]!.length, text: heading[2]!.trim() });
      i++;
      continue;
    }

    if (trimmed === "") {
      flushPara();
      i++;
      continue;
    }

    if (trimmed.startsWith("#+")) {
      // `#+KEYWORD: value` and colon-less block delimiters (`#+BEGIN_SRC …`)
      const kw = /^#\+([A-Za-z_]+):?(.*)$/.exec(trimmed);
      if (!kw) {
        i++;
        continue; // malformed keyword — ignore like org does
      }
      const key = kw[1]!.toUpperCase();
      const val = kw[2]!;

      if (key === "TITLE") {
        title = val.trim();
        i++;
      } else if (key === "SUBTITLE") {
        subtitle = val.trim();
        i++;
      } else if (key === "NAME") {
        pendingName = val.trim();
        i++;
      } else if (key === "RESULTS") {
        // canned results: following `: …` fixed-width lines and/or a
        // #+BEGIN_EXAMPLE block, attached to the nearest preceding src block
        flushPara();
        i++;
        const out: string[] = [];
        while (i < lines.length) {
          const fw = /^:\s?(.*)$/.exec(lines[i]!);
          if (!fw) break;
          out.push(fw[1]!);
          i++;
        }
        if (i < lines.length && lines[i]!.trim() === "#+BEGIN_EXAMPLE") {
          i++;
          while (i < lines.length && lines[i]!.trim() !== "#+END_EXAMPLE") {
            out.push(lines[i]!);
            i++;
          }
          if (i < lines.length) i++; // past #+END_EXAMPLE
        }
        if (lastSrc) lastSrc.results = out.join("\n");
      } else if (key === "BEGIN_SRC") {
        flushPara();
        const parts = val.trim().split(/\s+/).filter((p) => p !== "");
        const lang = parts.shift() ?? "";
        const body: string[] = [];
        i++;
        while (i < lines.length && lines[i]!.trim() !== "#+END_SRC") {
          body.push(lines[i]!);
          i++;
        }
        if (i < lines.length) i++; // past #+END_SRC
        const block: SrcBlock = {
          lang,
          headers: parts,
          lines: body,
          name: pendingName,
          results: null,
          executable: lang.toLowerCase() === ASM_LANG,
        };
        pendingName = null;
        nodes.push({ t: "src", block });
        lastSrc = block;
      } else if (key === "BEGIN_EXAMPLE") {
        flushPara();
        const body: string[] = [];
        i++;
        while (i < lines.length && lines[i]!.trim() !== "#+END_EXAMPLE") {
          body.push(lines[i]!);
          i++;
        }
        if (i < lines.length) i++;
        nodes.push({ t: "example", lines: body });
      } else {
        i++; // any other keyword (OPTIONS, AUTHOR, …) is ignored
      }
      continue;
    }

    // `# comment` (not `#+`) is hidden
    if (trimmed.startsWith("#")) {
      i++;
      continue;
    }

    // org table row
    if (trimmed.startsWith("|")) {
      flushPara();
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const cells = lines[i]!
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
        const isSeparator = cells.length > 0 && cells.every((c) => /^[-+:]*-[-+:]*$/.test(c) || c === "");
        if (!isSeparator) rows.push(cells);
        i++;
      }
      nodes.push({ t: "table", rows });
      continue;
    }

    // bullet list (- item / + item)
    const bullet = /^[-+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const raw = lines[i]!;
        const t = raw.trim();
        const m = /^[-+]\s+(.*)$/.exec(t);
        if (m) {
          items.push(m[1]!);
          i++;
          continue;
        }
        // indented continuation line: still part of the previous item
        if (items.length > 0 && raw !== "" && /^\s/.test(raw) && !t.startsWith("#")) {
          items[items.length - 1] += " " + t;
          i++;
          continue;
        }
        break;
      }
      nodes.push({ t: "list", items });
      continue;
    }

    // plain paragraph text (single newlines fold, like org)
    para.push(trimmed);
    i++;
  }
  flushPara();
  return { title, subtitle, nodes };
}
