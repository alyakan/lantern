import { chatState, type Chats } from "../sessions";
import type { ChatItem } from "../store";
import { attentionFor } from "./attention";
import { QUESTION_TOOL } from "./questions";
import { nodeStatus } from "./orchestraView";
import { quietFor } from "./quiet";
import { projectLabels, type ProjectOpen } from "./sidebar";

/** What a row is waiting for. `permission` is a plain request Allow and Deny answer; the others are answered where they are. */
export type InboxKind = "permission" | "question" | "plan" | "reproduce" | "merge" | "held" | "quiet" | "unread";

/** One thing waiting on the user: a chat or an agent, in some project, with what it needs. */
export interface InboxItem {
  /** One per chat or agent: it needs one thing at a time. */
  key: string;
  kind: InboxKind;
  slot: string;
  /** The chat is a team's Lead, or an agent of the team whose Lead is `team`. Null for a plain chat. */
  role: "chat" | "lead" | "agent";
  team: string | null;
  title: string;
  /** The project, with the team's name after it for a team's chat or agent. */
  where: string;
  /** In plain words. */
  need: string;
  /** Since when (ms): how long it has waited, or for a quiet agent since its last word; null when Lantern doesn't know (a team held back by its loop guard, say). */
  since: number | null;
  /** The pending request, for a plain permission: what Allow and Deny answer. */
  requestId: string | null;
  /**
   * Allow may be offered: the row shows the whole request, so the user can see everything they would approve. False
   * for anything it can't show whole (an edit, a long or multi-line command, a tool it doesn't know): Deny and Go only.
   */
  canAllow: boolean;
  /** The whole request as the row shows it (never clipped), when `canAllow`. */
  detail: string | null;
  /** It waits on an answer (the rest only finished unread). */
  needsYou: boolean;
}

type Pending = Extract<ChatItem, { type: "permission" }>;

const pendingIn = (items: ChatItem[]): { at: number; item: Pending } | null => {
  const at = items.findIndex((it) => it.type === "permission" && it.decision === null);
  return at < 0 ? null : { at, item: items[at] as Pending };
};

/** The tools that aren't a plain permission: Allow and Deny can't answer them (each has its own card in the chat). */
const KIND: Record<string, InboxKind> = { ExitPlanMode: "plan", Reproduce: "reproduce", [QUESTION_TOOL]: "question" };

/** The kinds that are a request Claude is waiting on: Go opens its own card, which shows all of it. */
export const REQUEST_KINDS: readonly InboxKind[] = ["permission", "question", "plan", "reproduce"];

/** A command longer than this, or a web address longer than the second, is too much to approve from a row. */
const COMMAND_MAX = 160;
const URL_MAX = 200;
const FULL_MAX = 600;

/** Newlines, other control characters and the marks that reorder or hide text: none of them may be in what Allow approves. */
const HIDING = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;

/** Bash's command: the other things its input may carry are only a note and a time limit, nothing that changes what runs. */
const BASH_KEYS = ["command", "description", "timeout"];
/** Tools that only read, with the inputs each takes: what a row may show whole. */
const READ_ONLY: Record<string, string[]> = {
  Read: ["file_path", "offset", "limit"],
  Glob: ["pattern", "path"],
  Grep: ["pattern", "path", "glob", "type", "output_mode", "-i", "-n", "-A", "-B", "-C", "head_limit", "multiline"],
  LS: ["path", "ignore"],
  WebSearch: ["query", "allowed_domains", "blocked_domains"],
  WebFetch: ["url", "prompt"],
};

const text = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * What a row shows of a pending request when it is all of it, or null when Allow mustn't be offered. Only a short
 * single-line Bash command and the read-only tools count; an edit or write, an unknown or MCP tool, a command with a
 * newline or over 160 characters, and any input carrying something the row wouldn't show are all null.
 */
export function wholeRequest(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const keys = Object.keys(o);
  if (toolName === "Bash") {
    const command = o.command;
    if (typeof command !== "string" || !command.trim() || command.length > COMMAND_MAX || HIDING.test(command)) return null;
    return keys.every((k) => BASH_KEYS.includes(k)) ? command : null;
  }
  const allowed = READ_ONLY[toolName];
  if (!allowed || keys.length === 0 || !keys.every((k) => allowed.includes(k))) return null;
  if (toolName === "WebFetch" && (typeof o.url !== "string" || o.url.length > URL_MAX)) return null;
  if (keys.some((k) => HIDING.test(text(o[k])))) return null;
  // One value is shown as it is; several as "name: value" lines.
  const shown = keys.length === 1 ? text(o[keys[0]]) : keys.map((k) => `${k}: ${text(o[k])}`).join("\n");
  return shown.length > FULL_MAX ? null : shown;
}

/**
 * Everything waiting on the user across every open project and team: permission requests and questions, plans and
 * reproductions to answer, merges to approve, teams held back until the user says go on, agents of a team that have
 * gone quiet while working (`quiet`: the time now and how long counts as quiet), and chats that finished while the user
 * was elsewhere (`unread`, by slot, since when). The ones that need an answer come first, the longest waiting
 * first, then the unread ones the same way. The sidebar's `needs` counts the first group.
 */
export function inboxItems(chats: Chats, open: Record<string, ProjectOpen>, opts: { titles?: Record<string, string>; unread: Record<string, number>; describe: (input: unknown) => string; quiet?: { now: number; after: number } }): InboxItem[] {
  const folders = Object.keys(open);
  const labels = projectLabels(folders);
  const out: InboxItem[] = [];
  folders.forEach((folder, i) => {
    for (const item of open[folder].items) {
      const lead = item.kind === "team" ? item.slot : null;
      const members = item.kind === "team" ? [{ slot: item.slot, title: item.title, role: "lead" as const }, ...item.agents.map((a) => ({ slot: a.slot, title: a.title, role: "agent" as const }))] : [{ slot: item.slot, title: item.title, role: "chat" as const }];
      for (const m of members) {
        const s = chats.slots[m.slot];
        if (!s) continue;
        const base = { key: m.slot, slot: m.slot, role: m.role, team: lead, title: m.title, where: item.kind === "team" && m.role === "agent" ? `${labels[i]} · ${item.title}` : labels[i], requestId: null, canAllow: false, detail: null, since: null };
        const pending = pendingIn(s.items);
        if (pending) {
          const kind = KIND[pending.item.toolName] ?? "permission";
          const said = attentionFor(s.items.slice(0, pending.at + 1), s.folder, opts.describe);
          const more = s.items.filter((it) => it.type === "permission" && it.decision === null).length - 1;
          const whole = kind === "permission" ? wholeRequest(pending.item.toolName, pending.item.input) : null;
          // Allowed from the row only when the row shows all of it, in full: then it says what, and the request itself follows.
          const need = whole === null ? (said?.body ?? "Needs an answer") : `Wants to use ${pending.item.toolName}`;
          out.push({ ...base, kind, need: `${need}${more > 0 ? ` (+${more} more)` : ""}`, since: pending.item.at ?? null, requestId: kind === "permission" ? pending.item.id : null, canAllow: whole !== null, detail: whole, needsYou: true });
          continue;
        }
        const proposal = m.role === "agent" && lead ? (chats.slots[lead]?.proposals ?? []).find((p) => p.worker === m.slot && p.status === "open") : undefined;
        if (proposal) {
          out.push({ ...base, kind: "merge", need: `Ready to merge ${proposal.branch} into ${proposal.into}`, since: proposal.at ?? null, needsYou: true });
          continue;
        }
        if (nodeStatus(s) === "held") {
          out.push({ ...base, kind: "held", need: "Its agents' updates are held until you say go on", needsYou: true });
          continue;
        }
        // Only a team's own agents: a plain chat may sit on one long command as long as it likes.
        if (opts.quiet && m.role !== "chat" && quietFor(s, opts.quiet.now, opts.quiet.after) !== null) {
          out.push({ ...base, kind: "quiet", need: "Quiet while working. It may be stuck: nudge it, interrupt it or restart it", since: s.activityAt, needsYou: true });
          continue;
        }
        const finished = opts.unread[m.slot];
        if (finished && chatState(s) === "done") {
          const said = attentionFor(s.items, s.folder, opts.describe);
          const need = said?.kind === "failed" ? said.body : said?.kind === "finished" && said.body !== "Done" ? `Finished: ${said.body}` : "Finished";
          out.push({ ...base, kind: "unread", need, since: finished, needsYou: false });
        }
      }
    }
  });
  // Oldest first within each group; one with no time known goes after the ones with.
  const age = (it: InboxItem) => it.since ?? Number.POSITIVE_INFINITY;
  return out.sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || age(a) - age(b));
}
