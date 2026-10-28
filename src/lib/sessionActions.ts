import { createContext } from "react";
import type { ChatItem } from "../store";
import type { SessionSummary } from "../types";
import { countChanges, relativeTo } from "./diff";
import { stepLabel, stepTarget } from "./activity";
import { usageLine } from "./cost";
import { outsideHooks } from "./hookItems";

/** What the History menu does to a past session, for the folder it lists. Null where there's no folder to act in. */
export interface SessionActions {
  folder: string;
  /** The folder's pinned sessions. */
  pinned: string[];
  onTogglePin: (sessionId: string) => void;
  /** Saves a name for the session in Lantern; resolves once it's saved. */
  onRename: (sessionId: string, title: string) => Promise<void>;
  /** Saves the session as a markdown document (the save dialog asks where). */
  onExport: (sessionId: string, title: string) => void;
}

export const SessionActionsContext = createContext<SessionActions | null>(null);

/** The shell's quoting of one word: single quotes, and a ' inside them written as '\'' so the word comes out as it went in. */
export const shellQuote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

/** What to type in a terminal to pick the session up in Claude Code: from its folder. */
export const resumeCommand = (folder: string, sessionId: string) => `cd ${shellQuote(folder)} && claude --resume ${shellQuote(sessionId)}`;

/** A pinned session first, then the rest, each in the order they were listed (newest first). */
export function pinnedFirst(sessions: SessionSummary[], pinned: string[]): SessionSummary[] {
  return [...sessions.filter((s) => pinned.includes(s.id)), ...sessions.filter((s) => !pinned.includes(s.id))];
}

/** A file name for an exported session: its title, lowercased and dashed, so it's readable in Finder. */
export function exportFileName(title: string): string {
  const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return `${slug || "session"}.md`;
}

/**
 * A session as markdown: each prompt and reply as written, and each tool step on one line (an edit with its counts, a
 * subagent with how many steps it took). Permission prompts and the work inside a subagent are left out.
 */
export function sessionMarkdown(title: string, items: ChatItem[], folder: string | null): string {
  const out: string[] = [`# ${title}`, ""];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(...list, "");
    list = [];
  };
  // A post-hook and what Claude did for it aren't part of the conversation as it was had.
  for (const it of outsideHooks(items)) {
    if (it.type === "tool") {
      list.push(`- ${stepLine(it, folder)}`);
    } else if (it.type === "shell") {
      list.push(`- Ran \`${it.command}\`${it.code === null ? "" : ` (exit ${it.code})`}`);
    } else if (it.type === "user") {
      flush();
      // Not something the user typed (Claude replied to a background task on its own): said so, not labelled "You".
      if (it.auto) out.push(`_${it.text}_`, "");
      else out.push("**You**", "", it.text, "");
    } else if (it.type === "assistant") {
      flush();
      out.push("**Claude**", "", it.text, "");
    } else if (it.type === "turn") {
      flush();
      const note = [it.stopped && "Stopped.", it.isError && `The turn ended with an error${it.result ? `: ${it.result}` : "."}`, usageLine(it.cost ?? null, it.tokens ?? null)].filter(Boolean);
      if (note.length) out.push(`_${note.join(" · ")}_`, "");
    }
  }
  flush();
  return out.join("\n").replace(/\n+$/, "\n");
}

function stepLine(step: Extract<ChatItem, { type: "tool" }>, folder: string | null): string {
  const failed = step.status === "error" ? " (failed)" : "";
  if (step.edit) {
    const { added, removed } = countChanges(step.edit.hunks);
    return `${step.edit.created ? "Created" : "Edited"} ${relativeTo(step.edit.path, folder)} (+${added} −${removed})${failed}`;
  }
  const target = stepTarget(step, folder);
  const subagent = step.children.length ? ` (${step.children.length} steps)` : "";
  return `${stepLabel(step)}${target ? `: ${target}` : ""}${subagent}${failed}`;
}
