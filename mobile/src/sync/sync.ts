/**
 * The phone's sync: what the Mac pushes goes through the reducer in batches (once a frame, so streamed text doesn't
 * re-render on every piece), the chats the user follows are subscribed again from where they were whenever a connection
 * comes up, and the user's sends and answers go to the Mac. React reads it with useSyncExternalStore.
 */
import type { Request } from "../protocol/generated/Request";
import type { EarlierPage } from "../protocol/generated/EarlierPage";
import type { Waiting } from "../protocol/generated/Waiting";
import type { Pushed, Session } from "../net/session";
import { initialState, reducer, type Action, type State } from "./reducer";

export interface SyncDeps {
  /** Runs `fn` before the next frame (requestAnimationFrame in the app). */
  schedule?: (fn: () => void) => void;
  now?: () => number;
  newId?: () => string;
}

const defaultSchedule = (fn: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => fn()) : setTimeout(fn, 16));
let ids = 0;
const defaultId = () => `m-${Date.now().toString(36)}-${(++ids).toString(36)}`;

export class Sync {
  private state: State = initialState;
  private listeners = new Set<() => void>();
  private queue: Action[] = [];
  private scheduled = false;
  private session: Session | null = null;
  private followed = new Set<string>();
  private readonly schedule: (fn: () => void) => void;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(d: SyncDeps = {}) {
    this.schedule = d.schedule ?? defaultSchedule;
    this.now = d.now ?? Date.now;
    this.newId = d.newId ?? defaultId;
  }

  getState = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Queues an action for the next frame (what the Mac pushes, the user's sends and the screens' tests all come through here). */
  apply(action: Action) {
    this.queue.push(action);
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.flush());
  }

  /** Applies what is queued now (tests call it instead of waiting for a frame). */
  flush() {
    this.scheduled = false;
    if (this.queue.length === 0) return;
    const before = this.state;
    for (const a of this.queue.splice(0)) this.state = reducer(this.state, a);
    if (this.state !== before) for (const l of this.listeners) l();
  }

  /** What the Mac pushed (Connection's onPushed). A chat list that moved on also refreshes what waits on you. */
  onPushed = (msg: Pushed) => {
    if (msg.type === "chats") {
      const statuses = (cs: State["chats"]) => cs.map((c) => `${c.slot}:${c.status}`).join(",");
      if (statuses(msg.chats) !== statuses(this.state.chats)) void this.refreshWaiting();
    }
    this.apply({ type: "pushed", msg });
  };

  /** Forgets everything (the phone was unpaired): the next Mac starts from nothing. */
  reset() {
    this.queue = [];
    this.session = null;
    this.followed.clear();
    this.state = initialState;
    for (const l of this.listeners) l();
  }

  /** A connection came up (Connection's onSession): follow the same chats from where they were. */
  onSession = (session: Session) => {
    this.session = session;
    this.apply({ type: "welcome", epoch: session.welcome.epoch });
    this.flush();
    for (const slot of this.followed) void this.subscribeTo(slot);
    void this.refreshWaiting();
  };

  private ask<T>(request: Request): Promise<T> {
    if (!this.session) return Promise.reject(new Error("Not connected to your Mac."));
    return this.session.ask<T>(request);
  }

  private subscribeTo(slot: string) {
    this.flush();
    const after = this.state.views[slot]?.seq ?? 0;
    return this.ask({ op: "subscribe", slot, after, epoch: this.state.epoch ?? 0 }).catch(() => {});
  }

  async refreshWaiting() {
    try {
      const list = await this.ask<Waiting[]>({ op: "list_waiting" });
      if (Array.isArray(list)) this.apply({ type: "waiting", list });
    } catch {
      // Not connected: it is asked again when a connection comes up.
    }
  }

  /** Opens a chat: its events come from now on. */
  follow(slot: string) {
    if (this.followed.has(slot)) return;
    this.followed.add(slot);
    void this.subscribeTo(slot);
  }

  unfollow(slot: string) {
    this.followed.delete(slot);
    void this.ask({ op: "unsubscribe", slot }).catch(() => {});
  }

  /** Sends a message: it shows at once, and says why if it didn't go. */
  async send(slot: string, text: string) {
    const clientId = this.newId();
    this.apply({ type: "sending", slot, clientId, text, at: this.now() });
    try {
      await this.ask({ op: "send", slot, text, client_id: clientId });
    } catch (e) {
      this.apply({ type: "send_failed", slot, clientId, error: (e as Error).message });
    }
  }

  /** Allows or denies a prompt (a question's answers with it); rejects with why (it was answered already…). */
  async answer(slot: string, requestId: string, allow: boolean, answers: Record<string, string> | null = null, message: string | null = null) {
    try {
      await this.ask({ op: "answer", slot, request_id: requestId, allow, message, answers });
      const text = allow && answers ? Object.values(answers).filter(Boolean).join(", ") : "";
      if (text) this.apply({ type: "answered_with", slot, requestId, text });
    } finally {
      void this.refreshWaiting();
    }
  }

  interrupt(slot: string) {
    return this.ask({ op: "interrupt", slot });
  }

  wake(slot: string) {
    return this.ask({ op: "wake", slot });
  }

  diff(slot: string, path: string) {
    return this.ask<string>({ op: "diff", slot, path });
  }

  async loadEarlier(slot: string) {
    const hidden = this.state.views[slot]?.hidden ?? 0;
    if (hidden === 0) return;
    const page = await this.ask<EarlierPage>({ op: "earlier", slot, hidden });
    this.apply({ type: "earlier", slot, events: page.events, hidden: page.hidden });
  }

  registerPushToken(token: string) {
    return this.ask({ op: "push_token", token });
  }
}
