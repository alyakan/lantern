import type { Chats } from "../sessions";
import { PROJECT_COLORS } from "./projectColors";
import { permissionsOf, workflowOf } from "./workflow";
import { summary, type Harness } from "./harness";
import type { ProjectOpen } from "./sidebar";
import { CLAUDE, CLAUDE_CAPABILITIES, capabilitiesOf } from "./provider";
import type { ProviderInfo } from "../types";

/**
 * What the window tells the backend's session hub about its open chats: the title it shows, and a chat that is asleep
 * (its claude stopped to save memory, or restored and not opened yet), with its session. Where a chat stands otherwise
 * (working, waiting on you) the hub knows from the chat's events, so it isn't sent.
 */
export interface WindowChat {
  slot: string;
  folder: string;
  title: string;
  asleep: boolean;
  session_id: string | null;
  /** "ask" or "auto"; null for a chat the store doesn't have yet. */
  permissions: "ask" | "auto" | null;
  /** The id of the preset (which models do what) it runs on. */
  preset: string | null;
  /** The colour the sidebar gives its project, "#rrggbb", so a phone shows the same. */
  color: string | null;
  /** "chat", "steps" (Step by step) or "team"; null for a chat the store doesn't have yet. */
  workflow: "chat" | "steps" | "team" | null;
  /**
   * What the chat runs, or ran, on when that isn't Claude Code (a local model on an endpoint, Codex): a name to show. A phone shows it,
   * and what is said in the chat and its title are never put to Claude for a phone's suggestions. Said only then, for a restored chat
   * that isn't open yet too.
   */
  provider?: string;
}

/**
 * `presetOf`: the id of the preset each chat's claude was started with. `projectColors`: each folder's colour, an index into
 * PROJECT_COLORS (see assignColors). `providerOf`: the name of what a chat runs on when that isn't Claude Code, else null.
 */
export function windowChats(chats: Chats, open: Record<string, ProjectOpen>, presetOf: Record<string, string> = {}, projectColors: Record<string, number> = {}, providerOf: (slot: string) => string | null = () => null): WindowChat[] {
  return Object.entries(open).flatMap(([folder, project]) =>
    project.items.map((item) => {
      const s = chats.slots[item.slot];
      const provider = providerOf(item.slot);
      return { slot: item.slot, folder: s?.folder ?? folder, title: item.title, asleep: s?.status === "asleep", session_id: s?.sessionId ?? null, permissions: s ? permissionsOf(s) : null, preset: presetOf[item.slot] ?? null, color: PROJECT_COLORS[projectColors[folder]] ?? null, workflow: s ? workflowOf(s) : null, ...(provider ? { provider } : {}) };
    }),
  );
}

/** Where a phone may start a chat, as the backend lists it: the provider's id, name, and what it can do that the sheet needs to know. */
export interface WindowProvider {
  id: string;
  name: string;
  /** It has an Auto mode. */
  auto: boolean;
  /** The window's presets (which model does what, in Claude Code) apply to it. */
  presets: boolean;
}

/**
 * What a phone is offered to start a chat on: only a provider whose approval cards a phone can answer (Claude Code, an endpoint:
 * not Codex, whose cards it can't), and only when there is a choice of more than one (the backend empties a list of one). `nameOf` is
 * what the window calls a provider on screen.
 */
export function windowProviders(listed: ProviderInfo[], nameOf: (id: string) => string): WindowProvider[] {
  const offered = listed.filter((l) => capabilitiesOf(l).phone_approvals);
  // Claude Code is always one of them, whether or not the list has it yet.
  const all = offered.some((l) => l.id === CLAUDE) ? offered : [{ id: CLAUDE, capabilities: CLAUDE_CAPABILITIES }, ...offered];
  return all.map((l) => ({ id: l.id, name: nameOf(l.id), auto: capabilitiesOf(l).supports_auto_mode, presets: capabilitiesOf(l).supports_advisor }));
}

/** What a phone may choose between, as the backend lists it (Settings › Models): the preset's id, name and one line. */
export interface WindowPreset {
  id: string;
  name: string;
  summary: string;
}

export function windowPresets(presets: Harness[]): WindowPreset[] {
  return presets.map((h) => ({ id: h.id, name: h.name, summary: summary(h) }));
}

/** What the window knows when it checks a phone's request, read from its own settings and presets, never from the request. */
export interface RemoteContext {
  /** Settings › Remote control: "Let paired phones use Auto". */
  allowAuto: boolean;
  /** The ids of the presets the window offers. */
  presetIds: string[];
  /** Where the window lets a phone start a chat (see `windowProviders`); none listed: only the project's own. */
  providers?: WindowProvider[];
}

/** Why a phone may not have this workflow, or null: a chat or Step by step; a team is started and left on the Mac. */
function checkWorkflow(workflow: string): string | null {
  return workflow === "chat" || workflow === "steps" ? null : "A phone can only start a chat or Step by step.";
}

/** Why a phone may not have this mode or preset, or null: Auto only when the Mac lets phones use it, a preset only if it is one of the Mac's. */
function checkChoice(permissions: string, preset: string | null, ctx: RemoteContext): string | null {
  if (permissions !== "ask" && permissions !== "auto") return "A phone can only choose Ask or Auto.";
  if (permissions === "auto" && !ctx.allowAuto) return "Auto from a phone is off. Turn it on in Settings, under Remote control.";
  if (preset !== null && !ctx.presetIds.includes(preset)) return "That isn't one of your presets.";
  return null;
}

/** Why a phone may not start a chat where it asks, or null: only on a provider the window listed, and without Auto or a Claude preset where it has none. */
function checkProvider(provider: string | null, permissions: string, preset: string | null, ctx: RemoteContext): string | null {
  if (provider === null) return null;
  const listed = (ctx.providers ?? []).find((p) => p.id === provider);
  if (!listed) return "That isn't one of your providers.";
  if (permissions === "auto" && !listed.auto) return `${listed.name} has no Auto mode: it asks before it acts.`;
  if (preset !== null && !listed.presets) return `${listed.name} runs on its own model: the presets don't apply to it.`;
  return null;
}

/** What the backend asks of the window when a phone starts a chat (see remote::NewChatRequest). */
export interface RemoteNewChat {
  id: string;
  folder: string;
  text: string;
  permissions: string;
  /** The id of one of the window's presets, or null for the project's own. */
  preset?: string | null;
  /** "chat" or "steps"; a team is started at the Mac. Missing: a chat. */
  workflow?: string | null;
  /** The id of one of the providers the window listed, or null (missing too) for the project's own. */
  provider?: string | null;
}

/**
 * Whether the window starts the chat a phone asked for, and why not. The backend has checked the same things, but any window
 * can emit the event this one listens for, so this window checks for itself: the chat starts on Ask, or on Auto only when the
 * Mac's setting lets phones (`ctx`, read from the window's own settings, never from the event), with one of the window's
 * presets or the project's own, in a project the user already works in, with a message written and not enormous.
 */
export function checkRemoteNewChat(r: RemoteNewChat, isKnownProject: boolean, validText: boolean, ctx: RemoteContext = { allowAuto: false, presetIds: [] }): string | null {
  const choice = checkChoice(r.permissions, r.preset ?? null, ctx) ?? checkProvider(r.provider ?? null, r.permissions, r.preset ?? null, ctx);
  if (choice) return choice;
  const flow = checkWorkflow(r.workflow ?? "chat");
  if (flow) return flow;
  if (!validText) return "Write what the chat should start with.";
  if (!isKnownProject) return "That isn't one of your projects.";
  return null;
}

/** What the backend asks of the window when a phone puts a chat on Ask or Auto, or on a preset (see remote::SetPermissionsRequest). */
export interface RemoteSetPermissions {
  slot: string;
  permissions: string;
}
export interface RemoteSetPreset {
  slot: string;
  preset: string;
}
export interface RemoteSetWorkflow {
  slot: string;
  workflow: string;
}

/** What the backend asks of the window when a phone closes a chat (see remote::CloseRequest). */
export interface RemoteClose {
  slot: string;
}

/** What the window knows of the chat a phone wants to close. */
export interface CloseTarget {
  known: boolean;
  /** A team's Lead or one of its agents: closing it is a decision about the whole team, made at the Mac. */
  team: boolean;
  /** Working or waiting on someone: it is stopped first. */
  busy: boolean;
  /** Background tasks (a workflow, a subagent, a command) that closing would stop: the sidebar asks the user, and nobody is at the Mac to answer. */
  background: number;
}

/** Whether the window closes a chat for a phone, and why not (the backend has checked too; any window can emit what this one listens for). */
export function checkRemoteClose(t: CloseTarget): string | null {
  if (!t.known) return "That chat isn't open on your Mac.";
  if (t.team) return "That chat is part of a team: close it on your Mac.";
  if (t.busy) return "Claude is busy in this chat. Stop it first, then close it.";
  if (t.background > 0) return "This chat has background tasks running, which closing would stop.";
  return null;
}

/** What the window knows of the chat a phone wants to switch. */
export interface SwitchTarget {
  /** The window has this chat (and it is not an agent of a team: its Lead sets what it runs on). */
  known: boolean;
  idle: boolean;
  asleep: boolean;
  /** Background tasks (a workflow, a subagent, a command) that a restart would stop: the window asks the user about that, and nobody is at the Mac to answer. */
  background: number;
}

/**
 * Whether the window switches a chat for a phone, and why not: the same checks as the backend's (it checks again because any
 * window can emit what it listens for), and never over background tasks, which a restart would stop without anyone to ask.
 */
export function checkRemoteSwitch(change: { permissions: string } | { preset: string } | { workflow: string }, target: SwitchTarget, ctx: RemoteContext): string | null {
  const choice = "permissions" in change ? checkChoice(change.permissions, null, ctx) : "workflow" in change ? checkWorkflow(change.workflow) : checkChoice("ask", change.preset, ctx);
  if (choice) return choice;
  if (!target.known) return "That chat isn't open on your Mac.";
  if (target.asleep) return "This chat is asleep. Wake it first.";
  if (!target.idle) return "Claude is busy in this chat. Change it once it has finished.";
  if (target.background > 0) return "This chat has background tasks running, which switching would stop.";
  return null;
}

