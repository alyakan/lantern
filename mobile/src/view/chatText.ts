/** What a chat's rows say in words, for searching them, quoting them and answering what they ask. */
import type { Row } from "./timeline";

/** The words of a row someone might look for or copy: a message, a page, a summary; null for steps, prompts and turn lines. */
export function rowText(row: Row): string | null {
  switch (row.kind) {
    case "user":
    case "assistant":
    case "summary":
      return row.item.text;
    case "page":
      return `${row.page.kicker}: ${row.page.title}\n${row.page.body}`.trim();
    default:
      return null;
  }
}

export interface Hit {
  /** The row's place in the list, to scroll to. */
  index: number;
  key: string;
  who: "You" | "Claude";
  before: string;
  match: string;
  after: string;
}

const SNIPPET = 38;
const flat = (s: string) => s.replace(/\s+/g, " ");

/** The messages that say `query` (any case), the newest first, each with a little of what is around it. Nothing for a query of under two characters. */
export function searchRows(rows: Row[], query: string, limit = 40): Hit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: Hit[] = [];
  for (let i = rows.length - 1; i >= 0 && hits.length < limit; i--) {
    const text = rowText(rows[i]);
    if (!text) continue;
    const at = flat(text).toLowerCase().indexOf(q);
    if (at < 0) continue;
    const one = flat(text);
    const start = Math.max(0, at - SNIPPET);
    hits.push({
      index: i,
      key: rows[i].key,
      who: rows[i].kind === "user" ? "You" : "Claude",
      before: `${start > 0 ? "…" : ""}${one.slice(start, at)}`,
      match: one.slice(at, at + q.length),
      after: `${one.slice(at + q.length, at + q.length + SNIPPET)}${at + q.length + SNIPPET < one.length ? "…" : ""}`,
    });
  }
  return hits;
}

/** Text quoted for a reply: each line behind a ">", with room to write under it. */
export function quote(text: string): string {
  return `${text
    .trim()
    .split("\n")
    .map((l) => `> ${l}`.trimEnd())
    .join("\n")}\n\n`;
}

const ASKS = /\b(should i|shall i|do you want|would you like|want me to|ok(?:ay)? (?:to|if)|is that ok(?:ay)?|ready to|go ahead|happy (?:for me )?to|proceed|sound good|does that work)\b/i;

/**
 * Answers to offer under Claude's last message: Yes and No when it ends on a yes-or-no question, none otherwise. Said by the
 * words alone, so a question that isn't a yes or no (a "which one?") gets none rather than a wrong one.
 */
export function quickReplies(text: string): string[] {
  const paragraphs = text.trim().split(/\n\s*\n/);
  const last = (paragraphs[paragraphs.length - 1] ?? "").trim();
  const lines = last.split("\n");
  const end = lines[lines.length - 1].replace(/[*_`"')\]]+$/g, "").trim();
  if (!end.endsWith("?")) return [];
  // The question is the last sentence; one that opens with a wh-word wants more than a yes or a no.
  const question = (end.split(/[.!?]\s+/).pop() ?? end).replace(/^[-*•\d.)\s]+/, "");
  if (/^(which|what|where|when|how|who|why)\b/i.test(question)) return [];
  return ASKS.test(question) || /^(is|are|do|does|did|can|could|will|would|have|has)\b/i.test(question) ? ["Yes", "No"] : [];
}
