import { chatState, chatTitle, type Chats } from "../sessions";
import type { RecentFolder } from "../types";
import { basename } from "./diff";
import { needingYou, orchestraNodes, teamNodes } from "./orchestraView";
import { orderProjects } from "./projectOrder";

/** How a chat reads in the sidebar. `draft`: text typed in its box but not sent. */
export type ChatDot = "running" | "waiting" | "draft" | "done";

export interface SidebarChat {
  slot: string;
  title: string;
  state: ChatDot;
  /** It finished while you were elsewhere and you haven't opened it since. */
  unread: boolean;
  /** How many tasks it still runs in the background. */
  background: number;
  sessionId: string | null;
  /** The chat on screen (an agent, when it's the one focused on the canvas). */
  active: boolean;
  pinned: boolean;
}

/** A chat, or a team: its Lead's chat with the agents it runs nested under it. */
export type SidebarItem = ({ kind: "chat" } & SidebarChat) | ({ kind: "team"; agents: SidebarChat[] } & SidebarChat);

/** What is open in one project: its chats and teams (the ones that need you first), and how many things need you. */
export interface ProjectOpen {
  items: SidebarItem[];
  /** Claude's session ids of everything open here, so a past chat that is open isn't listed twice. */
  sessionIds: string[];
  /** Chats, agents and merges waiting on you. */
  needs: number;
  /** Where to go to answer the first of them: the chat, or the team's canvas and the agent in it. */
  target: { slot: string; team: string | null } | null;
}

/** A project the sidebar's list of projects (History's filter, the saved order) has, with what is open in it. */
export interface SidebarProject {
  folder: string;
  /** The folder's name, with its parent's when another project has the same one. */
  label: string;
  /** Open chats and teams; empty when none is open. */
  items: SidebarItem[];
  needs: number;
  target: ProjectOpen["target"];
  /** There is something open in it. */
  hasOpen: boolean;
}

/** How a state reads, as words. */
export const DOT_LABEL: Record<ChatDot, string> = { running: "Working", waiting: "Needs you", draft: "Draft", done: "Done" };

/** What a chat shows: needing you beats an unread finish, which beats the plain state. */
export function markOf(chat: Pick<SidebarChat, "state" | "unread">): ChatDot | "unread" {
  return chat.unread && chat.state !== "waiting" ? "unread" : chat.state;
}

/** One open chat, team or agent as the sidebar's square (a team is its Lead, with the team's combined state). */
export interface CompactChip {
  slot: string;
  team: boolean;
  title: string;
  state: ChatDot;
  unread: boolean;
  /** On screen: the chat, or for a team its canvas or an agent focused on it. */
  active: boolean;
  /** "Working", "Needs you", "Unread"… */
  status: string;
  /** One or two capitals from the title, for the square. */
  initials: string;
  pinned: boolean;
  /** How many tasks it still runs in the background. */
  background: number;
}

export interface CompactGroup {
  folder: string;
  /** The project's name (with its parent's when another open project has the same one). */
  label: string;
  /** Two capitals of the project's name, for the label above its squares. */
  initials: string;
  chips: CompactChip[];
  /** The same chats and teams with their agents nested (the open pane's rows), and what needs you here. */
  items: SidebarItem[];
  needs: number;
}

const FILLER = new Set(["a", "an", "the", "of", "to", "for", "and", "in", "on"]);

/**
 * Capitals from a name: the first letters of its first two words (my-app: MA), skipping filler words (a, the, of, to,
 * for…). A single word gives its first `single` letters (a project's name: two, so lantern is LA; a chat's title: one).
 */
export function initials(name: string, single = 1): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w.toLowerCase()));
  const use = kept.length > 0 ? kept : words;
  const letters = use.length > 1 ? use.slice(0, 2).map((w) => [...w][0]) : [...(use[0] ?? "?")].slice(0, single);
  return letters.join("").toUpperCase();
}

/** A chat's initials from its title: a chat or team with no title yet ("New chat", "New team") is N. */
export const chatInitials = (title: string): string => (/^new (chat|team)$/i.test(title.trim()) ? "N" : initials(title));

/** An open chat, a team (its Lead, with its agents' state) or an agent, as a square with its status. */
export function chipOf(item: SidebarChat | SidebarItem): CompactChip {
  const mark = markOf(item);
  const team = "kind" in item && item.kind === "team";
  return {
    slot: item.slot,
    team,
    title: item.title,
    state: item.state,
    unread: item.unread,
    active: item.active || (team && "agents" in item && item.agents.some((a) => a.active)),
    status: mark === "unread" ? "Unread" : DOT_LABEL[mark],
    initials: chatInitials(item.title),
    pinned: item.pinned,
    background: item.background,
  };
}

/** Each folder's name for a list of projects: the folder's name, with its parent's when another one in the list has the same. */
export function projectLabels(folders: string[]): string[] {
  const names = folders.map(basename);
  return folders.map((folder, i) => {
    const parent = basename(folder.slice(0, Math.max(folder.lastIndexOf("/"), 0)) || "/");
    return names.filter((n) => n === names[i]).length > 1 ? `${names[i]} · ${parent}` : names[i];
  });
}

/**
 * What is open, as the collapsed sidebar lists it: the projects with something open, in the order the sidebar lists
 * them (the recent list's), each with its chats and teams. An agent is never listed on its own, only inside its team.
 */
export function compactGroups(open: Record<string, ProjectOpen>, recent: RecentFolder[], order: string[] = []): CompactGroup[] {
  const rank = (folder: string) => recent.findIndex((r) => r.path === folder);
  const newest = Object.keys(open)
    .filter((f) => open[f].items.length > 0)
    .sort((a, b) => rank(a) - rank(b));
  const folders = orderProjects(newest, order).listed;
  const names = folders.map(basename);
  const labels = projectLabels(folders);
  return folders.map((folder, i) => {
    const label = labels[i];
    const chips = open[folder].items.map(chipOf);
    return { folder, label, initials: initials(names[i], 2), chips, items: open[folder].items, needs: open[folder].needs };
  });
}

/** Everything that waits on you, in every project: what the title bar's button counts while the sidebar is hidden. */
export function needsYou(open: Record<string, ProjectOpen>): number {
  return Object.values(open).reduce((n, p) => n + p.needs, 0);
}

/**
 * Every open chat grouped by the project it is in. A team's Lead is one row with its agents under it (an agent is never
 * listed on its own, whatever its worktree's folder is); a chat with no folder yet isn't listed. Within a project the
 * chats that need you come first, the rest keep the order they were opened in.
 */
export function openProjects(chats: Chats, opts: { titles: Record<string, string>; drafts: Record<string, string>; unread: Record<string, number>; pinned: Record<string, string[]> }): Record<string, ProjectOpen> {
  const out: Record<string, ProjectOpen> = {};
  const pinnedIn = (folder: string | null, id: string | null) => !!folder && !!id && (opts.pinned[folder] ?? []).includes(id);
  const nodes = orchestraNodes(chats, () => "Lead");
  const row = (slot: string, waiting = false): SidebarChat => {
    const s = chats.slots[slot];
    const state = waiting ? "waiting" : chatState(s, opts.drafts[slot]);
    const agent = chats.agents[slot];
    return {
      slot,
      title: agent?.name ?? chatTitle(s, opts.titles),
      state,
      unread: !!opts.unread[slot] && state === "done",
      background: s.backgroundTasks.length,
      sessionId: s.sessionId,
      active: slot === chats.active,
      pinned: pinnedIn(s.folder, s.sessionId),
    };
  };
  for (const [slot, s] of Object.entries(chats.slots)) {
    if (!s.folder || chats.agents[slot]) continue;
    const project = (out[s.folder] ??= { items: [], sessionIds: [], needs: 0, target: null });
    if (s.sessionId) project.sessionIds.push(s.sessionId);
    if (!s.orchestrator) {
      const chat = row(slot);
      project.items.push({ kind: "chat", ...chat });
      if (chat.state === "waiting") {
        project.needs += 1;
        project.target ??= { slot, team: null };
      }
      continue;
    }
    // A team: the Lead, and every agent that reports to it.
    const members = teamNodes(nodes, slot);
    const needing = new Set(needingYou(members, chats.slots));
    const agents = members.filter((n) => n.role === "worker").map((n) => row(n.slot, needing.has(n.slot)));
    for (const a of agents) if (a.sessionId) project.sessionIds.push(a.sessionId);
    const lead = row(slot, needing.has(slot));
    const all = [lead, ...agents];
    const state: ChatDot = needing.size > 0 ? "waiting" : all.some((c) => c.state === "running") ? "running" : "done";
    project.items.push({ kind: "team", ...lead, title: lead.title === "New chat" ? "New team" : lead.title, state, unread: state !== "waiting" && all.some((c) => c.unread), background: all.reduce((n, c) => n + c.background, 0), active: lead.active, agents });
    if (needing.size > 0) {
      project.needs += needing.size;
      const first = [...needing][0];
      project.target ??= { slot: first, team: slot };
    }
  }
  // What needs you rises to the top of its project (a stable sort keeps the rest in the order they were opened).
  for (const project of Object.values(out)) project.items.sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting"));
  return out;
}

/**
 * The projects the sidebar lists, newest first, for orderProjects: those with a chat open (in the order of the recent
 * list, a project that isn't on it yet ahead of the rest), then the other recent folders. `hidden` folders (removed from
 * recents) only show while a chat is open in them. Before there is a saved order, this is the order shown.
 */
export function projectFolders(recent: RecentFolder[], hidden: string[], open: Record<string, unknown>): string[] {
  const rank = (folder: string) => recent.findIndex((r) => r.path === folder);
  const opened = Object.keys(open).sort((a, b) => rank(a) - rank(b));
  const others = recent.map((r) => r.path).filter((f) => !open[f] && !hidden.includes(f));
  return [...opened, ...others];
}

/**
 * The projects the sidebar knows, in the user's order (`order`, see orderProjects: a project not in it yet goes on top):
 * the ones History lists past chats of.
 */
export function sidebarProjects(input: { recent: RecentFolder[]; hidden: string[]; open: Record<string, ProjectOpen>; order?: string[] }): SidebarProject[] {
  const { recent, hidden, open } = input;
  const folders = orderProjects(projectFolders(recent, hidden, open), input.order ?? []).listed;
  const labels = projectLabels(folders);
  return folders.map((folder, i) => {
    const o = open[folder];
    return {
      folder,
      label: labels[i],
      items: o?.items ?? [],
      needs: o?.needs ?? 0,
      target: o?.target ?? null,
      hasOpen: !!o,
    };
  });
}
