/**
 * A change to a chat's settings made while it works (on the Mac or from a phone): switching restarts its agent, which would drop
 * the turn, so the change waits. "now" stops the turn, applies the change once it has stopped, and tells the agent to carry on;
 * "finished" applies it when the turn ends by itself, with nothing stopped. Several changes while it works are one wait, one
 * restart and (for "now") one message: the latest of each setting wins, and choosing what the chat already runs drops it.
 */
import { hasPendingPrompt, type State } from "../store";
import type { Permissions, Workflow } from "./workflow";

export type When = "now" | "finished";

/** What the conversation settings change (as the backend's `conversation_settings` takes it). */
export interface ConversationChange {
  provider?: string;
  model?: string | null;
  effort?: string | null;
}

export interface Change {
  permissions?: Permissions;
  workflow?: Exclude<Workflow, "team">;
  preset?: string;
  conversation?: ConversationChange;
}

/**
 * `waiting`: for the turn to end (or, for "now", the stop to land). `applying`: the restart is under way. `continuing`: applied
 * after a real stop, the carry-on message goes once the agent is ready.
 */
export interface Pending {
  change: Change;
  when: When;
  phase: "waiting" | "applying" | "continuing";
  /** The stop cut a turn short: once applied, the agent is told to carry on. */
  stopped?: boolean;
  /** A step is being checked before it is applied (Auto from a phone): nothing else is done meanwhile. */
  inFlight?: boolean;
  /** What to tell the user once it is all done (part of the change was refused when it came to be applied). */
  note?: string;
}

/**
 * What to apply next, one restart at a time (each reads the chat as the one before left it): Permissions and Workflow together,
 * then the preset, then the provider, model and effort. `rest` is what is left after it.
 */
export function nextStep(change: Change): { step: "settings" | "preset" | "conversation"; rest: Change } | null {
  const { permissions, workflow, preset, conversation } = change;
  const left = (c: Change) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) as Change;
  if (permissions || workflow) return { step: "settings", rest: left({ preset, conversation }) };
  if (preset) return { step: "preset", rest: left({ conversation }) };
  if (conversation) return { step: "conversation", rest: {} };
  return null;
}

/** What the chat runs on now, to drop a change that is already so. */
export interface Current {
  permissions: Permissions;
  workflow: Workflow;
  preset: string | null;
  conversation: ConversationChange;
}

/** The message that sends the agent on after a stop for a change. Written here, never by a phone. */
export const CONTINUE_TEXT = "[Lantern: the user changed this chat's settings while you were working, so your turn was stopped to apply them. Continue where you left off.]";

/** Whether a chat is busy in the way that makes a change wait: working, waiting on the user, or with messages queued. */
export function busy(s: State): boolean {
  return s.status === "running" || s.status === "starting" || s.queued.length > 0 || hasPendingPrompt(s.items);
}

const same = <T>(a: T | undefined, b: T | undefined) => a === b || (a == null && b == null);

/** `change` with what the chat already runs on taken out; null when nothing is left. */
function without(change: Change, current: Current): Change | null {
  const out: Change = {};
  if (change.permissions && change.permissions !== current.permissions) out.permissions = change.permissions;
  if (change.workflow && change.workflow !== current.workflow) out.workflow = change.workflow;
  if (change.preset && change.preset !== current.preset) out.preset = change.preset;
  if (change.conversation) {
    const c = change.conversation;
    const kept: ConversationChange = {};
    // Only against what is known: the backend may run another model or effort than the window last set (a phone changed it).
    const known = current.conversation;
    if (c.provider !== undefined && !("provider" in known && c.provider === known.provider)) kept.provider = c.provider;
    if (c.model !== undefined && !("model" in known && same(c.model, known.model))) kept.model = c.model;
    if (c.effort !== undefined && !("effort" in known && same(c.effort, known.effort))) kept.effort = c.effort;
    if (Object.keys(kept).length) out.conversation = kept;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The pending switch after `change` is asked for `when`: added to what waits (the later value of a setting wins), with what the
 * chat already runs dropped. "now" once asked stays "now". Null when nothing is left to change. A switch already under way
 * isn't added to: null then too, and the caller says so.
 */
export function queue(pending: Pending | undefined, change: Change, when: When, current: Current): Pending | null {
  if (pending && pending.phase !== "waiting") return null;
  const merged: Change = { ...pending?.change, ...change };
  if (pending?.change.conversation || change.conversation) merged.conversation = { ...pending?.change.conversation, ...change.conversation };
  const left = without(merged, current);
  if (!left) return null;
  return { change: left, when: pending?.when === "now" || when === "now" ? "now" : "finished", phase: "waiting" };
}

/** Whether a waiting switch can be applied: the turn has ended (by itself, or by the stop) and nothing is asked of the user. */
export function ready(s: State, p: Pending): boolean {
  if (p.phase !== "waiting") return false;
  if (s.status !== "idle" && s.status !== "ended") return false;
  if (hasPendingPrompt(s.items)) return false;
  // "When it finishes" waits for the messages queued behind the turn too: they are part of the work.
  return p.when === "now" || s.queued.length === 0;
}

/** Whether the turn that just ended was cut short by a stop, so the agent is told to carry on. */
export function wasStopped(s: State): boolean {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.type === "turn") return it.stopped === true;
    if (it.type === "user") return false;
  }
  return false;
}

/** The change in words, for the chat's line and a phone ("Auto, Step by step"). `presetName` names a preset by its id. */
export function describe(change: Change, presetName: (id: string) => string = (id) => id): string {
  const words: string[] = [];
  if (change.permissions) words.push(change.permissions === "auto" ? "Auto" : "Ask");
  if (change.workflow) words.push(change.workflow === "steps" ? "Step by step" : "Chat");
  if (change.preset) words.push(presetName(change.preset));
  const c = change.conversation;
  if (c?.provider) words.push(c.provider);
  if (c?.model !== undefined) words.push(c.model ?? "the default model");
  if (c?.effort !== undefined) words.push(c.effort ? `${c.effort} effort` : "the default effort");
  return words.join(", ");
}

/** A phone's change as the backend hands it on (one setting, or the provider's settings), or null for anything else. */
export function changeOf(raw: unknown): Change | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 200;
  if (r.permissions === "ask" || r.permissions === "auto") return { permissions: r.permissions };
  if (r.workflow === "chat" || r.workflow === "steps") return { workflow: r.workflow };
  if (text(r.preset)) return { preset: r.preset as string };
  const c = r.conversation;
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  const conversation: ConversationChange = {};
  if (text(o.provider)) conversation.provider = o.provider as string;
  for (const k of ["model", "effort"] as const) if (o[k] === null || text(o[k])) conversation[k] = o[k] as string | null;
  return Object.keys(conversation).length ? { conversation } : null;
}
