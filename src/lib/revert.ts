import type { RevertOutcome } from "../api";
import type { ChatItem } from "../store";

/** What a revert was asked to do: the chat's changes, the last turn, or a range of turns (a step). */
export interface RevertRequest {
  scope: "session" | "turn";
  /** The first turn of the range; null for the last turn (or with the session scope). */
  turn: number | null;
  toTurn: number | null;
}

/** The revert that Undo can take back: each file with the text it had before and the text the revert left. */
export interface RevertUndo {
  id: number;
  files: { path: string; target: string | null; expected: string | null }[];
  summary: string;
}

/** A file reverted since the chat's last message, for the note Claude gets with the next one. */
export interface RevertNote {
  path: string;
  /** It was created in the range and went to the Trash, rather than being put back. */
  trashed: boolean;
  /** How the range began, as "your message …" or "this chat began" (it reads "before …"). */
  since: string;
  /** The revert it came from, so Undo can take its notes back. */
  revert: number;
}

/** What the Changes pane and the Summary tab need to offer reverts, from the chat that's open. */
export interface RevertControls {
  slot: string;
  /** Why nothing can be reverted right now (Claude is working), or null. */
  blocked: string | null;
  /** The number of the chat's latest turn (null: none yet), to find the edits made after a range. */
  latestTurn: number | null;
  onReverted: (req: RevertRequest, outcomes: RevertOutcome[]) => void;
  undo: RevertUndo | null;
  onUndo: () => void;
}

/**
 * The revert a Changes view of `scope` asks for: the chat's changes, the last turn's, or a step's range (`stepRange`,
 * undefined on a chat that isn't a step-by-step page). "unknown" for a step whose turns aren't known (a reopened
 * session's earlier turns); null for scopes that come from git, where Lantern doesn't revert.
 */
export function revertFor(scope: "session" | "turn" | "git" | "pr" | "branch", stepRange: { from: number; to: number } | null | undefined): RevertRequest | "unknown" | null {
  if (scope === "session") return { scope: "session", turn: null, toTurn: null };
  if (scope !== "turn") return null;
  if (stepRange === undefined) return { scope: "turn", turn: null, toTurn: null };
  if (stepRange === null) return "unknown";
  return { scope: "turn", turn: stepRange.from, toTurn: stepRange.to };
}

/** One line for the chat after an Undo: what went back, and what was left alone because it changed since. */
export function undoSummary(outcomes: RevertOutcome[]): string {
  const conflicts = outcomes.filter((o) => o.status === "conflict").length;
  if (conflicts === 0) return "Undone.";
  return `Undone, except ${conflicts === 1 ? "one file" : `${conflicts} files`} that changed since the revert: ${conflicts === 1 ? "it was" : "they were"} left as ${conflicts === 1 ? "it is" : "they are"}.`;
}

/** What the request reverts, in words for a dialog: "before this chat began", "before your last message", … */
export function rangeText(req: RevertRequest): string {
  if (req.scope === "session") return "before this chat began";
  if (req.turn === null) return "before your last message";
  return "before this step";
}

/** The files a set of outcomes changed, each with what Undo needs to put it back. */
export function undoOf(outcomes: RevertOutcome[]): RevertUndo["files"] {
  return outcomes.filter((o) => o.status === "reverted" || o.status === "trashed").map((o) => ({ path: o.path, target: o.before, expected: o.after }));
}

/** One line for the chat and the Undo bar: what was reverted, what was trashed, and what was left alone and why. */
export function revertSummary(outcomes: RevertOutcome[]): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const reverted = outcomes.filter((o) => o.status === "reverted").length;
  const trashed = outcomes.filter((o) => o.status === "trashed").length;
  const conflicts = outcomes.filter((o) => o.status === "conflict").length;
  const refused = outcomes.filter((o) => o.status === "not_revertible").length;
  const parts: string[] = [];
  const gone = `${count(trashed, "created file", "created files")} ${trashed === 1 ? "was" : "were"} moved to the Trash`;
  if (reverted > 0) parts.push(`Reverted ${count(reverted, "file", "files")}${trashed > 0 ? `; ${gone}.` : "."}`);
  else if (trashed > 0) parts.push(`${gone.charAt(0).toUpperCase()}${gone.slice(1)}.`);
  if (conflicts > 0) parts.push(`${count(conflicts, "file", "files")} changed since you saw ${conflicts === 1 ? "it" : "them"}, so ${conflicts === 1 ? "it was" : "they were"} left as ${conflicts === 1 ? "it is" : "they are"}.`);
  if (refused > 0) {
    const why = [...new Set(outcomes.filter((o) => o.status === "not_revertible").map((o) => o.reason ?? "it can't be reverted"))];
    parts.push(`${count(refused, "file", "files")} couldn't be reverted: ${why.join(" ")}`);
  }
  return parts.join(" ") || "Nothing was changed.";
}

/** The number of the chat's latest turn, or null before any turn is numbered. */
export function latestTurnOf(items: ChatItem[]): number | null {
  let latest: number | null = null;
  for (const it of items) if (it.type === "user" && it.turn !== undefined) latest = latest === null ? it.turn : Math.max(latest, it.turn);
  return latest;
}

/** How a range began, for the note and the chat: the message that started it, or the chat itself. */
export function sinceLabel(items: ChatItem[], scope: RevertRequest["scope"], turn: number | null): string {
  if (scope === "session") return "this chat began";
  const users = items.filter((it): it is Extract<ChatItem, { type: "user" }> => it.type === "user" && !it.auto);
  const prompt = turn === null ? users[users.length - 1] : users.find((u) => u.turn === turn);
  if (!prompt) return "that turn";
  const text = prompt.text.replace(/\s+/g, " ").trim();
  return `your message "${text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text}"`;
}

/**
 * The note for Claude, sent in front of the next message: which files were put back, and that they may not hold what
 * Claude last wrote. Null when nothing was reverted.
 */
export function revertNote(notes: RevertNote[]): string | null {
  if (notes.length === 0) return null;
  const lines = notes.map((n) => (n.trashed ? `- ${n.path}: moved to the Trash (it didn't exist before ${n.since}).` : `- ${n.path}: put back to how it was before ${n.since}.`));
  return [
    "[Lantern note: since your last message the user reverted these files, so they may not hold what you last wrote. Read them before relying on them.]",
    ...lines,
  ].join("\n");
}

/** The message with the revert note in front of it (a slash command goes to Claude as it is, so it gets none). */
export function withRevertNote(text: string, notes: RevertNote[]): string {
  const note = text.startsWith("/") ? null : revertNote(notes);
  return note ? `${note}\n\n${text}` : text;
}
