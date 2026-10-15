import { chatState, type Chats } from "../sessions";
import type { ChatItem } from "../store";
import { attentionFor } from "./attention";
import { QUESTION_TOOL } from "./questions";
import { nodeStatus } from "./orchestraView";
import { projectLabels, type ProjectOpen } from "./sidebar";

/** What a row is waiting for. `permission` is a plain request Allow and Deny answer; the others are answered where they are. */
export type InboxKind = "permission" | "question" | "plan" | "reproduce" | "merge" | "held" | "unread";

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
  /** Since when (ms); null when Lantern doesn't know (a team held back by its loop guard, say). */
  since: number | null;
  /** The pending request, for a plain permission: what Allow and Deny answer. */
  requestId: string | null;
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

/**
 * Everything waiting on the user across every open project and team: permission requests and questions, plans and
 * reproductions to answer, merges to approve, teams held back until the user says go on, and chats that finished while
 * the user was elsewhere (`unread`, by slot, since when). The ones that need an answer come first, the longest waiting
 * first, then the unread ones the same way. The sidebar's `needs` counts the first group.
 */
export function inboxItems(chats: Chats, open: Record<string, ProjectOpen>, opts: { titles?: Record<string, string>; unread: Record<string, number>; describe: (input: unknown) => string }): InboxItem[] {
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
        const base = { key: m.slot, slot: m.slot, role: m.role, team: lead, title: m.title, where: item.kind === "team" && m.role === "agent" ? `${labels[i]} · ${item.title}` : labels[i], requestId: null, since: null };
        const pending = pendingIn(s.items);
        if (pending) {
          const kind = KIND[pending.item.toolName] ?? "permission";
          const said = attentionFor(s.items.slice(0, pending.at + 1), s.folder, opts.describe);
          const more = s.items.filter((it) => it.type === "permission" && it.decision === null).length - 1;
          out.push({ ...base, kind, need: `${said?.body ?? "Needs an answer"}${more > 0 ? ` (+${more} more)` : ""}`, since: pending.item.at ?? null, requestId: kind === "permission" ? pending.item.id : null, needsYou: true });
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
