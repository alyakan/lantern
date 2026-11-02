import { CUT } from "./diffPreview";
import { highlight, type Token } from "./highlight";

/**
 * A file's change as the Mac sends it (a unified diff) read into rows a screen can draw: each line with its number in the old
 * and the new file, told apart by kind and not by a "+" or "-" in front of it, and coloured as the language it is written in.
 * The text is only drawn, never run, so a line the parser can't place is kept as the text it is.
 */

export type RowKind = "add" | "del" | "ctx" | "gap" | "note";

export interface DiffRow {
  kind: RowKind;
  /** The line's number in the file before the change (null for an added line, or when the diff gave none). */
  oldNo: number | null;
  /** The line's number in the file after it (null for a removed line, or when the diff gave none). */
  newNo: number | null;
  /** The line without its "+", "-" or space. For a gap, the line it goes on at; for a note, the words. */
  text: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const CUT_WORDS = CUT.trim();
const HEADER = /^(---|\+\+\+|diff |index )/;

/**
 * The rows of a unified diff. Its file headers are left out, and each place the diff skips lines is one "gap" row. A text with no
 * "@@" in it (not a diff the Mac makes, but one a test or an older Mac might send) is read by its first characters alone, with no numbers.
 */
export function parseUnifiedDiff(text: string): DiffRow[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunked = lines.some((l) => HUNK.test(l));
  const rows: DiffRow[] = [];
  let inHunk = !hunked;
  let seen = false;
  let oldNo: number | null = null;
  let newNo: number | null = null;
  const bump = (n: number | null) => (n === null ? null : n + 1);
  for (const line of lines) {
    if (line.startsWith(CUT_WORDS)) {
      rows.push({ kind: "note", oldNo: null, newNo: null, text: line });
      continue;
    }
    const h = HUNK.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      inHunk = true;
      // Lines above the first change are skipped too, unless the change starts at the top.
      if (seen || Math.max(oldNo, newNo) > 1) rows.push({ kind: "gap", oldNo: null, newNo: null, text: String(newNo || oldNo) });
      seen = true;
      continue;
    }
    // The file headers only count before a hunk (inside one, "--- x" is a removed "-- x"); with no hunk at all they count anywhere.
    if ((!inHunk || !hunked) && HEADER.test(line)) continue;
    // Words that are not a diff's line (a message in place of one) are kept whole as a note, never cut or hidden.
    const unplaced = () => rows.push({ kind: "note", oldNo: null, newNo: null, text: line });
    if (!inHunk) {
      unplaced();
      continue;
    }
    switch (line.charAt(0)) {
      case "+":
        rows.push({ kind: "add", oldNo: null, newNo, text: line.slice(1) });
        newNo = bump(newNo);
        break;
      case "-":
        rows.push({ kind: "del", oldNo, newNo: null, text: line.slice(1) });
        oldNo = bump(oldNo);
        break;
      case "\\":
        // "\ No newline at end of file": about the line before it, not a line.
        break;
      case " ":
      case "":
        rows.push({ kind: "ctx", oldNo, newNo, text: line.slice(1) });
        oldNo = bump(oldNo);
        newNo = bump(newNo);
        break;
      default:
        unplaced();
    }
  }
  return rows;
}

/** Where a file's language is named for the colouring, when its extension is not the name the scanner knows it by. */
const EXTENSIONS: Record<string, string> = { mjs: "js", cjs: "js", mts: "ts", cts: "ts", h: "c", hpp: "cpp", cc: "cpp", hh: "cpp", jsonc: "json", json5: "json", plist: "xml", svg: "xml", htm: "html", scss: "css", less: "css", markdown: "md", mdx: "md" };

/** The name of a file's language, for `highlight` and `isMarkdown`: its extension, said the way the scanner knows it. */
export function languageOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = name.slice(dot + 1).toLowerCase();
  return EXTENSIONS[ext] ?? ext;
}

export const isMarkdown = (path: string) => languageOf(path) === "md";

/** The old side of a hunk reads ctx and del lines, the new side ctx and add lines: each one is a file the language is read through. */
const onSide = (side: "old" | "new", kind: RowKind) => kind === "ctx" || kind === (side === "old" ? "del" : "add");

/** Rows between gaps: a hunk is read on its own, as the lines before it are not in the diff. */
function hunksOf(rows: DiffRow[]): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  rows.forEach((r, i) => {
    if (r.kind === "gap" || r.kind === "note") {
      if (i > from) out.push([from, i]);
      from = i + 1;
    }
  });
  if (rows.length > from) out.push([from, rows.length]);
  return out;
}

/**
 * Each row's words as coloured tokens for `lang`, read hunk by hunk and side by side (what a block comment opened in the removed
 * lines does not reach the added ones). A gap or a note has none. Every row's tokens join back to exactly its text.
 */
export function tokensOf(rows: DiffRow[], lang: string): Token[][] {
  const out: Token[][] = rows.map(() => []);
  for (const [from, to] of hunksOf(rows)) {
    for (const side of ["old", "new"] as const) {
      const mine: number[] = [];
      for (let i = from; i < to; i++) if (onSide(side, rows[i].kind)) mine.push(i);
      const lines = highlight(mine.map((i) => rows[i].text).join("\n"), lang);
      mine.forEach((i, n) => {
        // A context line is on both sides: the new side's reading is the one kept.
        if (rows[i].kind !== "ctx" || side === "new") out[i] = lines[n] ?? [{ kind: "plain", text: rows[i].text }];
      });
    }
  }
  return out;
}

/** A line of a markdown file, told by what it is. `text` is what is left of it once its marks are taken away. */
export type MdLine =
  | { kind: "text" | "quote" | "table" | "code" | "fence" | "rule"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; depth: number; marker: string; text: string };

const FENCE = /^\s*(```|~~~)/;

/** A line longer than this is read as plain words: a file's own text is untrusted, and its patterns should never have to chew on a huge line. */
const MD_MAX_LINE = 1000;

/** A heading's words without the closing hashes ("## Title ##"). */
function headingWords(s: string): string {
  const t = s.trimEnd();
  let end = t.length;
  while (end > 0 && t[end - 1] === "#") end--;
  return end < t.length && end > 0 && /\s/.test(t[end - 1]) ? t.slice(0, end).trimEnd() : t;
}

function mdLine(line: string): MdLine {
  if (line.length > MD_MAX_LINE) return { kind: "text", text: line };
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return { kind: "heading", level: heading[1].length, text: headingWords(heading[2]) };
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return { kind: "rule", text: line };
  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote) return { kind: "quote", text: quote[1] };
  const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (item) {
    const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
    const ordered = /\d/.test(item[2]);
    return { kind: "list", depth: Math.floor(item[1].replace(/\t/g, "  ").length / 2), marker: task ? (task[1] === " " ? "☐" : "☑") : ordered ? item[2] : "•", text: task ? task[2] : item[3] };
  }
  if (/^\s*\|.*\|\s*$/.test(line)) return { kind: "table", text: line };
  return { kind: "text", text: line };
}

/**
 * Each row of a markdown file as the kind of line it is (null for a gap or a note). Whether a line sits in a code fence is read
 * hunk by hunk and side by side, as the colouring is, so a fence the diff only half shows can colour the rest of its hunk.
 */
export function markdownOf(rows: DiffRow[]): (MdLine | null)[] {
  const out: (MdLine | null)[] = rows.map(() => null);
  for (const [from, to] of hunksOf(rows)) {
    for (const side of ["old", "new"] as const) {
      let fenced = false;
      for (let i = from; i < to; i++) {
        if (!onSide(side, rows[i].kind)) continue;
        const text = rows[i].text;
        let line: MdLine;
        if (FENCE.test(text)) {
          fenced = !fenced;
          line = { kind: "fence", text };
        } else line = fenced ? { kind: "code", text } : mdLine(text);
        if (rows[i].kind !== "ctx" || side === "new") out[i] = line;
      }
    }
  }
  return out;
}
