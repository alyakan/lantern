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

/** A message that says what was looked for: its place in the list, to scroll to, and its key. */
export interface Match {
  index: number;
  key: string;
}

/** The messages that say `query` (any case), the oldest first, one entry per message. Nothing for a query of under two characters. */
export function findRows(rows: Row[], query: string): Match[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const found: Match[] = [];
  rows.forEach((row, index) => {
    if (rowText(row)?.toLowerCase().includes(q)) found.push({ index, key: row.key });
  });
  return found;
}

/** The match being looked at: the one the cursor (a row's key) is on, else the newest, where looking starts. */
export function currentMatch(matches: Match[], cursor: string | null): Match | null {
  return matches.find((m) => m.key === cursor) ?? matches[matches.length - 1] ?? null;
}

/** The match a step away from the current one, older (-1) or newer (1), round to the other end at either end of the chat. */
export function stepMatch(matches: Match[], cursor: string | null, dir: 1 | -1): Match | null {
  const now = currentMatch(matches, cursor);
  if (!now) return null;
  const at = matches.indexOf(now);
  return matches[(at + dir + matches.length) % matches.length];
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

// What Claude asks to be said: "Say "admin merge"", "Reply “go”", "type `ship it`", "say **publish the draft**": a quoted or bold
// phrase straight after say, reply, type, send, write or answer. The quotes are straight, curly, or backticks, and may be in bold.
const SAY = /\b(?:say|reply|type|send|write|answer)\b(?:\s+(?:with|me|back))?\s*[:,\-–—]?\s*(?:\*\*|__)?\s*(?:"([^"\n]{2,60})"|“([^”\n]{2,60})”|`([^`\n]{2,60})`)/gi;
const SAY_BOLD = /\b(?:say|reply|type|send|write|answer)\b(?:\s+(?:with|me|back))?\s*[:,\-–—]?\s*\*\*([^*"“”`\n]{2,60})\*\*/gi;
/** How many suggestions at most, and how far from the end of the message Claude's asking is looked for (in lines). */
const SAID_MAX = 4;
const SAID_LINES = 8;

/**
 * The exact words Claude asks to be said at the end of its message ("Say "admin merge" and I'll merge it"), in the order it
 * asks, once each, so one press can say them. Only a phrase straight after a word like say or reply counts, near the end of
 * the message: a quotation in the middle of the explanation is not an ask.
 */
export function saidPhrases(text: string): string[] {
  const end = text.trim().split("\n").slice(-SAID_LINES).join("\n");
  const found: { at: number; phrase: string }[] = [];
  for (const m of end.matchAll(SAY)) found.push({ at: m.index ?? 0, phrase: m[1] ?? m[2] ?? m[3] });
  for (const m of end.matchAll(SAY_BOLD)) found.push({ at: m.index ?? 0, phrase: m[1] });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { phrase } of found.sort((a, b) => a.at - b.at)) {
    const clean = phrase.trim().replace(/[.,;:!]+$/, "").trim();
    if (clean.length < 2 || !/[\p{L}\p{N}]/u.test(clean) || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out.slice(0, SAID_MAX);
}

/**
 * Answers to offer under Claude's last message: the exact words it asks to be said ("Say "admin merge""), else Yes and No when
 * it ends on a yes-or-no question, none otherwise. Said by the words alone, so a question that isn't a yes or no (a "which
 * one?") gets none rather than a wrong one.
 */
export function quickReplies(text: string): string[] {
  const said = saidPhrases(text);
  return said.length > 0 ? said : yesOrNo(text);
}

function yesOrNo(text: string): string[] {
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
