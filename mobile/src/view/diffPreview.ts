/**
 * The change a file prompt asks to make, as a diff to read before approving: an Edit's old and new text, a MultiEdit's list,
 * a Write's contents. Claude's input is untrusted, so every read is checked, text is capped, and a character that can't be
 * seen is shown as its code instead of being drawn (a diff must not read one way and write another).
 */

export interface DiffLine {
  sign: "+" | "-" | " ";
  text: string;
}

export interface DiffBlock {
  /** "Edit 2 of 3" for one of several, else null. */
  title: string | null;
  lines: DiffLine[];
}

export interface DiffPreview {
  /** Whole new text (a Write) rather than a change to what is there. */
  kind: "change" | "new";
  blocks: DiffBlock[];
  added: number;
  removed: number;
  /** Lines left out to keep the phone's screen readable (the counts above still cover them). */
  hidden: number;
  /** Not the whole change: the Mac cut a long text short, or an edit could not be read, so the counts and lines are only part of it. */
  partial: boolean;
  /** An edit that replaces every place its text appears: what is drawn is one of them, and the counts are for one. */
  replaceAll: boolean;
}

/** How many lines are drawn in all, how many edits of a MultiEdit, how long one line may be, and how much of an input is read. */
export const MAX_LINES = 120;
export const MAX_EDITS = 12;
export const MAX_LINE_CHARS = 400;
const MAX_INPUT_CHARS = 200_000;
/** What the Mac puts at the end of a text it cut short (`protocol::CUT`): the rest of the text is on the Mac. */
export const CUT = "\n… (cut short: the rest is on your Mac)";
/** Lines of what an edit did not touch kept around it, for the eye to find its place. */
const CONTEXT = 2;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown): string | null => (typeof v === "string" ? v.slice(0, MAX_INPUT_CHARS) : null);
const isCut = (s: string) => s.endsWith(CUT);
const uncut = (s: string) => (isCut(s) ? s.slice(0, -CUT.length) : s);

// What can't be seen, or turns the text around it, as code point ranges (never an escaped regular expression: a line separator in
// one would split it): shown as its code. A tab and a line break are plain.
const UNSEEN: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
];
const showUnseen = (s: string) => {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += UNSEEN.some(([from, to]) => c >= from && c <= to) ? `⟦U+${c.toString(16).toUpperCase().padStart(4, "0")}⟧` : ch;
  }
  return out;
};

const lineOf = (sign: DiffLine["sign"], raw: string): DiffLine => ({ sign, text: showUnseen(raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}…` : raw) });
const linesOf = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** One replacement: the lines both share at the start and end as context, the rest as removed then added. */
export function editBlock(oldText: string, newText: string, title: string | null = null): { block: DiffBlock; added: number; removed: number } {
  const before = linesOf(oldText);
  const after = linesOf(newText);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const removed = before.slice(head, before.length - tail);
  const added = after.slice(head, after.length - tail);
  const lines: DiffLine[] = [
    ...before.slice(Math.max(0, head - CONTEXT), head).map((l) => lineOf(" ", l)),
    ...removed.map((l) => lineOf("-", l)),
    ...added.map((l) => lineOf("+", l)),
    ...before.slice(before.length - tail, before.length - tail + CONTEXT).map((l) => lineOf(" ", l)),
  ];
  return { block: { title, lines }, added: added.length, removed: removed.length };
}

/** Keeps the first `MAX_LINES` lines across the blocks, and says how many were left out. */
function capped(kind: DiffPreview["kind"], parts: { block: DiffBlock; added: number; removed: number }[], partial: boolean, replaceAll = false): DiffPreview {
  let room = MAX_LINES;
  let hidden = 0;
  const blocks: DiffBlock[] = [];
  for (const p of parts) {
    const take = p.block.lines.slice(0, Math.max(0, room));
    room -= take.length;
    hidden += p.block.lines.length - take.length;
    if (take.length > 0) blocks.push({ title: p.block.title, lines: take });
  }
  return { kind, blocks, added: parts.reduce((n, p) => n + p.added, 0), removed: parts.reduce((n, p) => n + p.removed, 0), hidden, partial, replaceAll };
}

/** The diff a prompt for `toolName` with `input` asks to make; null when it is not a file change (or says nothing to show). */
export function diffPreviewOf(toolName: string, input: unknown): DiffPreview | null {
  const i = rec(input);
  switch (toolName) {
    case "Edit": {
      const a = text(i.old_string);
      const b = text(i.new_string);
      if (a === null || b === null) return null;
      const partial = isCut(a) || isCut(b) || a.length >= MAX_INPUT_CHARS || b.length >= MAX_INPUT_CHARS;
      // Two texts cut at the same place can look equal while the rest differs: that is still a change, shown as partial.
      if (a === b && !partial) return null;
      return capped("change", [editBlock(uncut(a), uncut(b))], partial, i.replace_all === true);
    }
    case "MultiEdit": {
      const list: unknown = i.edits;
      if (!Array.isArray(list)) return null;
      let partial = list.length > MAX_EDITS;
      let replaceAll = false;
      const edits = list.slice(0, MAX_EDITS).flatMap((e, n) => {
        const r = rec(e);
        const a = text(r.old_string);
        const b = text(r.new_string);
        // An edit that can't be read is a change the phone can't show.
        if (a === null || b === null) {
          partial = true;
          return [];
        }
        if (r.replace_all === true) replaceAll = true;
        if (isCut(a) || isCut(b) || a.length >= MAX_INPUT_CHARS || b.length >= MAX_INPUT_CHARS) partial = true;
        else if (a === b) return [];
        return [editBlock(uncut(a), uncut(b), list.length > 1 ? `Edit ${n + 1} of ${list.length > MAX_EDITS ? `${MAX_EDITS}+` : list.length}` : null)];
      });
      return edits.length > 0 || partial ? capped("change", edits, partial, replaceAll) : null;
    }
    case "Write":
    case "NotebookEdit": {
      const body = text(toolName === "Write" ? i.content : i.new_source);
      if (body === null || body === "") return null;
      const lines = linesOf(uncut(body)).map((l) => lineOf("+", l));
      return capped("new", [{ block: { title: null, lines }, added: lines.length, removed: 0 }], isCut(body) || body.length >= MAX_INPUT_CHARS);
    }
    default:
      return null;
  }
}

/** "+12 −3" for a chip. */
export const countsOf = (d: Pick<DiffPreview, "added" | "removed">) => [d.added > 0 ? `+${d.added}` : "", d.removed > 0 ? `−${d.removed}` : ""].filter(Boolean).join(" ");

/** How many lines a prompt inside the chat shows of a change, before it asks to be opened. */
export const INLINE_LINES = 8;

/**
 * Whether the whole change can be read inside the chat, so swiping to allow it there is allowing what was seen: nothing cut or
 * left out, no "everywhere it appears", and short enough to be drawn in full.
 */
export function fitsInline(d: DiffPreview): boolean {
  return !d.partial && !d.replaceAll && d.hidden === 0 && d.blocks.reduce((n, b) => n + b.lines.length, 0) <= INLINE_LINES;
}
