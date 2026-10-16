import { relativeTo } from "./diff";

/** Which kind of line a comment is on: one Claude added, one it removed, or one it left as it was. */
export type CommentKind = "added" | "removed" | "context";

/** A review comment on one line of a changed file, kept until it is sent or deleted. */
export interface DiffComment {
  id: string;
  /** The changed file, as the Changes list has it. */
  path: string;
  /** Whose line numbers `line` is in: the file as it is now ("new"), or as it was before the changes ("old", for removed lines). */
  side: "new" | "old";
  line: number;
  /** The line's text when the comment was made: how the comment finds its line again after the file changes, and what Claude is shown. */
  lineText: string;
  kind: CommentKind;
  text: string;
  /** The file no longer has this line (Claude changed it): the comment stays until it is deleted. */
  outdated?: boolean;
}

/** What the Changes pane needs to take comments and send them: the chat's list, how to change it, how to send it. */
export interface CommentControls {
  items: DiffComment[];
  /** Change the chat's comments; a function of the latest list, so two changes in a row both land. */
  update: (change: (all: DiffComment[]) => DiffComment[]) => void;
  /** Send every comment to the chat as one message (absent: the chat can't take a message right now). */
  send?: (text: string) => void;
}

/** The part of Monaco's line changes that matters here (its `ILineChange` has more). An end of 0 means that side has no lines. */
export interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

let seq = 0;
export const commentId = () => `dc-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const linesOf = (text: string) => text.split("\n").map((l) => l.replace(/\r$/, ""));

/** The text of a line (1-based), or "" past the end. */
export function lineText(text: string, line: number): string {
  return linesOf(text)[line - 1] ?? "";
}

/** The kind of line `line` is: removed on the old side, added when a change covers it on the new side, else unchanged. */
export function kindOf(side: "new" | "old", line: number, changes: LineChange[]): CommentKind {
  if (side === "old") return "removed";
  return changes.some((c) => c.modifiedEndLineNumber > 0 && line >= c.modifiedStartLineNumber && line <= c.modifiedEndLineNumber) ? "added" : "context";
}

/**
 * Unified view shows a change's removed lines in a block above its new lines, and a note can't sit between them: this is
 * the new-file line the block comes after (0: before the first line), or null when `line` isn't removed by any change.
 */
export function removedBlockAfter(line: number, changes: LineChange[]): number | null {
  const c = changes.find((c) => c.originalEndLineNumber > 0 && line >= c.originalStartLineNumber && line <= c.originalEndLineNumber);
  if (!c) return null;
  return c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber - 1;
}

/** The new-file line an unchanged old-file line became: the same number, moved by the lines changes above it added or removed. */
export function newLineOf(line: number, changes: LineChange[]): number {
  let shift = 0;
  for (const c of changes) {
    // A pure insertion's original range is empty and names the line it comes after.
    if ((c.originalEndLineNumber > 0 ? c.originalEndLineNumber : c.originalStartLineNumber) >= line) continue;
    shift += (c.modifiedEndLineNumber > 0 ? c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1 : 0) - (c.originalEndLineNumber > 0 ? c.originalEndLineNumber - c.originalStartLineNumber + 1 : 0);
  }
  return line + shift;
}

/** Where a comment's line is now: the same number if it still has the same text, else the nearest line with that text; null if none. */
export function findLine(lines: string[], line: number, text: string): number | null {
  if (lines[line - 1] === text) return line;
  // A blank line matches any other blank line, so it only counts where it was.
  if (text.trim() === "") return null;
  let best: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== text) continue;
    if (best === null || Math.abs(i + 1 - line) < Math.abs(best - line)) best = i + 1;
  }
  return best;
}

/**
 * The comments after `path`'s diff was read again: each follows its line to where the line is now (Claude may have added
 * lines above it), and one whose line is gone is marked outdated and kept. The same list back when nothing moved.
 */
export function reconcile(all: DiffComment[], path: string, original: string, current: string): DiffComment[] {
  const old = linesOf(original);
  const now = linesOf(current);
  let changed = false;
  const next = all.map((c) => {
    if (c.path !== path) return c;
    const found = findLine(c.side === "old" ? old : now, c.line, c.lineText);
    const moved: DiffComment = found === null ? (c.outdated ? c : { ...c, outdated: true }) : c.line === found && !c.outdated ? c : { ...c, line: found, outdated: false };
    if (moved !== c) changed = true;
    return moved;
  });
  return changed ? next : all;
}

const QUOTE_MAX = 120;

/** A line's text without its indent, cut to 120 characters. */
export function clipLine(text: string): string {
  const t = text.trim();
  return t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX)}…` : t;
}

/** A line's text as inline code, cut to 120 characters; backticks in it are fenced so they can't end the quote early. */
export function quoteLine(text: string): string {
  const cut = clipLine(text);
  const run = Math.max(0, ...(cut.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(run + 1);
  return run > 0 ? `${fence} ${cut} ${fence}` : `${fence}${cut}${fence}`;
}

const KIND_LABEL: Record<CommentKind, string> = { added: "added line", removed: "removed line", context: "unchanged line" };

/** The comments in the order they are read: file by file as they were first commented on, each file top to bottom. */
export function ordered(comments: DiffComment[]): DiffComment[] {
  const files = [...new Set(comments.map((c) => c.path))];
  return [...comments].sort((a, b) => files.indexOf(a.path) - files.indexOf(b.path) || a.line - b.line || (a.side === b.side ? 0 : a.side === "old" ? -1 : 1));
}

/**
 * The message that sends every comment to Claude, in one fixed format:
 *   Please address these review comments:
 *
 *   1. src/lib/x.ts line 42 (added line: `const a = 1`): the comment
 * A removed line is numbered in the file as it was and says "(before)". The comment is text for Claude, never a command.
 */
export function commentsMessage(comments: DiffComment[], folder: string | null): string {
  const lines = ordered(comments).map((c, i) => {
    const where = `${relativeTo(c.path, folder)} line ${c.line}${c.side === "old" ? " (before)" : ""}`;
    const what = c.lineText.trim() === "" ? `blank ${KIND_LABEL[c.kind]}` : `${KIND_LABEL[c.kind]}${c.outdated ? ", since changed" : ""}: ${quoteLine(c.lineText)}`;
    // A comment of several lines keeps them, lined up under its number.
    const text = c.text.trim().replace(/\n/g, "\n   ");
    return `${i + 1}. ${where} (${what}): ${text}`;
  });
  return `Please address these review comments:\n\n${lines.join("\n")}`;
}
