/**
 * The phone's picture of its Mac, built from what the Mac sends: the chat list, what waits on you, and each followed
 * chat's items. Pure, so it is tested without React Native.
 *
 * Applying anything twice changes nothing: a catch-up (Reset) can overlap with live events, so every item has an id
 * (a block's, a step's, a prompt's) and events at or below a chat's last number are skipped. A Reset's first page
 * starts the chat over. A message the phone sent shows at once and is replaced by the Mac's copy when it comes back
 * (matched by the id the phone gave it).
 */
import type { RemoteChat } from "../protocol/generated/RemoteChat";
import type { RemoteEvent } from "../protocol/generated/RemoteEvent";
import type { Waiting } from "../protocol/generated/Waiting";
import type { Pushed } from "../net/session";

export interface FileEdit {
  path: string;
  created: boolean;
  added: number;
  removed: number;
}

export type Item =
  | { kind: "user"; id: string; text: string; at: number | null; sentBy: string | null; sending?: boolean; failed?: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "step"; id: string; name: string; summary: string; done: boolean; isError: boolean; edits: FileEdit[]; tests: { passed: number; failed: number; skipped: number } | null }
  | { kind: "prompt"; id: string; toolName: string; input: unknown; state: "open" | "allowed" | "denied" | "withdrawn"; by: string | null; /** What this phone answered a question with. */ answer?: string }
  | { kind: "desktop"; id: string; what: string }
  | { kind: "turn"; id: string; isError: boolean; result: string | null; durationMs: number | null };

export interface ChatView {
  items: Item[];
  /** The number of the last event applied (in `epoch`). */
  seq: number;
  /** Earlier turns not loaded yet (Request::Earlier brings them). */
  hidden: number;
  thinking: boolean;
  /** A Reset in progress: pages after the first add to it. */
  resetting: boolean;
  /** How many events a catch-up covered when this phone had followed the chat before (0: none, or the first time). */
  caughtUp: number;
  /** Whether the Mac has sent the chat's history yet (what tells an empty chat from one still loading). */
  loaded: boolean;
  /** Why asking for the chat's history failed, while it has not come (null: nothing wrong, or not asked). */
  loadError: string | null;
}

export interface State {
  chats: RemoteChat[];
  waiting: Waiting[];
  views: Record<string, ChatView>;
  /** The Mac's run the numbers in `views` belong to (its Welcome's). */
  epoch: number | null;
}

export const initialState: State = { chats: [], waiting: [], views: {}, epoch: null };

export const emptyView: ChatView = { items: [], seq: 0, hidden: 0, thinking: false, resetting: false, caughtUp: 0, loaded: false, loadError: null };

export type Action =
  | { type: "welcome"; epoch: number }
  | { type: "pushed"; msg: Pushed }
  | { type: "waiting"; list: Waiting[] }
  | { type: "sending"; slot: string; clientId: string; text: string; at: number }
  | { type: "send_failed"; slot: string; clientId: string; error: string }
  /** The chat's history was asked for (again), or the asking failed. */
  | { type: "load_started"; slot: string }
  | { type: "load_failed"; slot: string; why: string }
  /** What this phone answered a question with, to show beside it afterwards (the Mac's events don't carry it). */
  | { type: "answered_with"; slot: string; requestId: string; text: string }
  | { type: "earlier"; slot: string; events: RemoteEvent[]; hidden: number };

/** The client id a message's `sent_by` ends with ("phone-…:<client id>"). */
const clientIdOf = (sentBy: string | null) => (sentBy?.includes(":") ? sentBy.slice(sentBy.lastIndexOf(":") + 1) : null);

function upsert(items: Item[], item: Item, merge?: (old: Item) => Item): Item[] {
  const i = items.findIndex((it) => it.kind === item.kind && it.id === item.id);
  if (i < 0) return [...items, item];
  const next = items.slice();
  next[i] = merge ? merge(items[i]) : item;
  return next;
}

function updateById<K extends Item["kind"]>(items: Item[], kind: K, id: string, f: (it: Extract<Item, { kind: K }>) => Item): Item[] {
  return items.map((it) => (it.kind === kind && it.id === id ? f(it as Extract<Item, { kind: K }>) : it));
}

/** The step a file edit or test run belongs to (one that started it, or a new one when catching up mid-turn). */
function onStep(items: Item[], id: string, f: (s: Extract<Item, { kind: "step" }>) => Item): Item[] {
  const has = items.some((it) => it.kind === "step" && it.id === id);
  const base: Item[] = has ? items : [...items, { kind: "step", id, name: "", summary: "", done: false, isError: false, edits: [], tests: null }];
  return updateById(base, "step", id, f);
}


/** One event, applied to a chat's view. */
export function applyEvent(view: ChatView, event: RemoteEvent): ChatView {
  const items = view.items;
  switch (event.kind) {
    case "user_text": {
      const clientId = clientIdOf(event.sent_by);
      // The Mac's copy of a message this phone sent takes its place.
      const mine = clientId ? items.findIndex((it) => it.kind === "user" && it.id === `local-${clientId}`) : -1;
      const item: Item = { kind: "user", id: clientId ? `local-${clientId}` : `u-${event.at ?? ""}-${event.text.slice(0, 40)}`, text: event.text, at: event.at, sentBy: event.sent_by };
      if (mine >= 0) {
        const next = items.slice();
        next[mine] = item;
        return { ...view, items: next, thinking: true };
      }
      return { ...view, items: upsert(items, item), thinking: !!event.sent_by };
    }
    case "thinking":
      return { ...view, thinking: true };
    case "text_delta": {
      const existing = items.find((it) => it.kind === "assistant" && it.id === event.block_id);
      // A block already finished (a catch-up had its whole text): a late piece adds nothing.
      if (existing && existing.kind === "assistant" && !existing.streaming) return view;
      return { ...view, thinking: false, items: upsert(items, { kind: "assistant", id: event.block_id, text: event.text, streaming: true }, (old) => ({ ...(old as Extract<Item, { kind: "assistant" }>), text: (old as Extract<Item, { kind: "assistant" }>).text + event.text })) };
    }
    case "assistant_text":
      return { ...view, thinking: false, items: upsert(items, { kind: "assistant", id: event.block_id, text: event.text, streaming: false }) };
    case "tool_started":
      return { ...view, items: upsert(items, { kind: "step", id: event.tool_use_id, name: event.name, summary: event.summary, done: false, isError: false, edits: [], tests: null }, (old) => ({ ...(old as Extract<Item, { kind: "step" }>), name: event.name, summary: event.summary })) };
    case "tool_finished":
      return { ...view, items: onStep(items, event.tool_use_id, (s) => ({ ...s, done: true, isError: event.is_error })) };
    case "file_edited":
      return {
        ...view,
        items: onStep(items, event.tool_use_id, (s) => ({ ...s, edits: [...s.edits.filter((e) => e.path !== event.path), { path: event.path, created: event.created, added: event.added, removed: event.removed }] })),
      };
    case "tests_ran":
      return { ...view, items: onStep(items, event.tool_use_id, (s) => ({ ...s, tests: { passed: event.passed, failed: event.failed, skipped: event.skipped } })) };
    case "turn_done": {
      // A turn is named for the message that began it, so the same end applied twice is one end.
      const began = [...items].reverse().find((it) => it.kind === "user");
      const done: Item = { kind: "turn", id: `turn-${began?.id ?? "start"}`, isError: event.is_error, result: event.result, durationMs: event.duration_ms };
      return { ...view, thinking: false, items: upsert(items.map((it) => (it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it)), done) };
    }
    case "permission_requested":
      return { ...view, items: upsert(items, { kind: "prompt", id: event.request_id, toolName: event.tool_name, input: event.input, state: "open", by: null }, (old) => old) };
    case "permission_withdrawn":
      return { ...view, items: updateById(items, "prompt", event.request_id, (p) => (p.state === "open" ? { ...p, state: "withdrawn" } : p)) };
    case "permission_resolved":
      return { ...view, items: updateById(items, "prompt", event.request_id, (p) => (p.state === "open" ? { ...p, state: event.allow ? "allowed" : "denied", by: event.by } : p)) };
    case "needs_desktop":
      return { ...view, items: upsert(items, { kind: "desktop", id: `desktop-${event.what}`, what: event.what }) };
    case "session_started":
    case "session_ended":
      // A new claude, or none: nothing it was asking can be answered any more.
      return { ...view, thinking: false, items: items.map((it) => (it.kind === "prompt" && it.state === "open" ? { ...it, state: "withdrawn" } : it)) };
    case "asleep":
      return view;
    case "conversation_reset":
      return { ...view, items: [], hidden: 0, thinking: false };
  }
}

const applyAll = (view: ChatView, events: RemoteEvent[]) => events.reduce(applyEvent, view);

/** Prompts that aren't waiting any more leave the home screen's stack. */
function settleWaiting(waiting: Waiting[], slot: string, event: RemoteEvent): Waiting[] {
  if (event.kind === "permission_resolved" || event.kind === "permission_withdrawn") return waiting.filter((w) => !(w.slot === slot && w.request_id === event.request_id));
  if (event.kind === "session_started" || event.kind === "session_ended") return waiting.filter((w) => w.slot !== slot);
  return waiting;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "welcome":
      // Another run of Lantern: its numbers start again, so what was followed starts over when subscribed again.
      if (state.epoch === action.epoch) return state;
      return { ...state, epoch: action.epoch, views: Object.fromEntries(Object.entries(state.views).map(([slot, v]) => [slot, { ...v, seq: 0 }])) };
    case "waiting":
      return { ...state, waiting: [...action.list].sort((a, b) => a.at - b.at) };
    case "sending": {
      const view = state.views[action.slot] ?? emptyView;
      const item: Item = { kind: "user", id: `local-${action.clientId}`, text: action.text, at: action.at, sentBy: null, sending: true };
      return { ...state, views: { ...state.views, [action.slot]: { ...view, items: upsert(view.items, item) } } };
    }
    case "load_started": {
      const view = state.views[action.slot];
      if (!view || view.loadError === null) return state;
      return { ...state, views: { ...state.views, [action.slot]: { ...view, loadError: null } } };
    }
    case "load_failed": {
      const view = state.views[action.slot] ?? emptyView;
      return { ...state, views: { ...state.views, [action.slot]: { ...view, loadError: action.why } } };
    }
    case "send_failed": {
      const view = state.views[action.slot];
      if (!view) return state;
      return { ...state, views: { ...state.views, [action.slot]: { ...view, items: updateById(view.items, "user", `local-${action.clientId}`, (u) => ({ ...u, sending: false, failed: action.error })) } } };
    }
    case "answered_with": {
      const view = state.views[action.slot];
      if (!view) return state;
      return { ...state, views: { ...state.views, [action.slot]: { ...view, items: updateById(view.items, "prompt", action.requestId, (p) => ({ ...p, answer: action.text })) } } };
    }
    case "earlier": {
      const view = state.views[action.slot] ?? emptyView;
      const earlier = applyAll({ ...emptyView }, action.events).items;
      return { ...state, views: { ...state.views, [action.slot]: { ...view, hidden: action.hidden, items: [...earlier, ...view.items.filter((it) => !earlier.some((e) => e.kind === it.kind && e.id === it.id))] } } };
    }
    case "pushed": {
      const msg = action.msg;
      switch (msg.type) {
        case "chats":
          return { ...state, chats: msg.chats };
        case "event": {
          const view = state.views[msg.slot] ?? emptyView;
          const waiting = settleWaiting(state.waiting, msg.slot, msg.event);
          if (msg.seq <= view.seq) return waiting === state.waiting ? state : { ...state, waiting };
          return { ...state, waiting, views: { ...state.views, [msg.slot]: { ...applyEvent(view, msg.event), seq: msg.seq } } };
        }
        case "reset": {
          const view = state.views[msg.slot] ?? emptyView;
          // Page 0 starts the chat over, keeping only messages this phone sent that the Mac hasn't echoed yet.
          const base: ChatView = msg.page === 0 ? { ...emptyView, items: view.items.filter((it) => it.kind === "user" && it.sending) } : view;
          const next = applyAll(base, msg.events);
          // A chat this phone already followed, started over because it was away too long: say how much it missed.
          const caughtUp = msg.page === 0 ? (view.seq > 0 && msg.seq > view.seq ? msg.seq - view.seq : 0) : view.caughtUp;
          return { ...state, views: { ...state.views, [msg.slot]: { ...next, seq: msg.seq, hidden: msg.hidden, resetting: !msg.done, caughtUp, loaded: true, loadError: null } } };
        }
      }
    }
  }
}

/** The prompts still open in a chat, oldest first (the full-screen decision shows the first). */
export const openPrompts = (view: ChatView | undefined) => (view?.items ?? []).filter((it): it is Extract<Item, { kind: "prompt" }> => it.kind === "prompt" && it.state === "open");
