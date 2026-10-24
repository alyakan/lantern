/**
 * The phone's sync: what the Mac pushes goes through the reducer in batches (once a frame, so streamed text doesn't
 * re-render on every piece), the chats the user follows are subscribed again from where they were whenever a connection
 * comes up, and the user's sends and answers go to the Mac. React reads it with useSyncExternalStore.
 */
import type { Request } from "../protocol/generated/Request";
import type { Controls } from "../protocol/generated/Controls";
import type { EarlierPage } from "../protocol/generated/EarlierPage";
import type { RemotePermissions } from "../protocol/generated/RemotePermissions";
import type { RemoteWorkflow } from "../protocol/generated/RemoteWorkflow";
import type { RemoteProject } from "../protocol/generated/RemoteProject";
import type { StartedChat } from "../protocol/generated/StartedChat";
import type { PairOffer } from "../protocol/generated/PairOffer";
import type { Suggestions } from "../protocol/generated/Suggestions";
import type { RemoteLiveCard } from "../protocol/generated/RemoteLiveCard";
import type { Waiting } from "../protocol/generated/Waiting";
import { UPLOAD_WAIT, type Pushed, type Session } from "../net/session";
import { newShellId } from "../view/shell";
import type { PickedImage } from "../view/attachments";
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

/** How long the phone keeps what Claude suggested before it asks the Mac again. */
export const SUGGESTIONS_KEPT_MS = 10 * 60 * 1000;

export class Sync {
  private suggested: { at: number; value: Suggestions } | null = null;
  private state: State = initialState;
  private listeners = new Set<() => void>();
  private queue: Action[] = [];
  private scheduled = false;
  private session: Session | null = null;
  private followed = new Set<string>();
  private readonly schedule: (fn: () => void) => void;
  private readonly now: () => number;
  private readonly newId: () => string;
  /** Told as a message goes to a Mac that keeps lock-screen cards (the phone starts the card then), and whether it was taken. */
  onSending: ((id: string, slot: string, project: string | null) => void) | null = null;
  onSent: ((id: string) => void) | null = null;
  onFailed: ((id: string) => void) | null = null;
  /** Told when a connection to the Mac came up. */
  onConnected: (() => void) | null = null;

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
    this.onConnected?.();
  };

  private ask<T>(request: Request, wait?: number): Promise<T> {
    if (!this.session) return Promise.reject(new Error("Not connected to your Mac."));
    return this.session.ask<T>(request, wait);
  }

  private subscribeTo(slot: string) {
    this.apply({ type: "load_started", slot });
    this.flush();
    const after = this.state.views[slot]?.seq ?? 0;
    // A failure is the chat's to show (it has nothing else to show), not swallowed.
    return this.ask({ op: "subscribe", slot, after, epoch: this.state.epoch ?? 0 }).catch((e: Error) => this.apply({ type: "load_failed", slot, why: e.message || "Couldn't load this chat." }));
  }

  /** Asks again for a chat whose history didn't come. */
  retryLoad(slot: string) {
    if (this.followed.has(slot)) void this.subscribeTo(slot);
  }

  async refreshWaiting() {
    try {
      const list = await this.ask<Waiting[]>({ op: "list_waiting" });
      if (Array.isArray(list)) this.apply({ type: "waiting", list });
    } catch {
      // Not connected: it is asked again when a connection comes up. Connected but it failed: what was known stays, and Home
      // shows that rather than waiting for ever on an answer that isn't coming.
      if (this.session) this.apply({ type: "waiting", list: this.state.waiting });
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

  /** Sends a message (with `images`, when it has some): it shows at once, and says why if it didn't go. */
  async send(slot: string, text: string, images: PickedImage[] = []) {
    const clientId = this.newId();
    this.apply({ type: "sending", slot, clientId, text, at: this.now(), ...(images.length > 0 ? { thumbs: images.map((i) => i.uri) } : {}) });
    let carded = false;
    try {
      // Only to a Mac that says it takes them: an older one would send the words and say nothing of the pictures.
      if (images.length > 0 && !this.has("images")) throw new Error("This Mac can't take photos yet. Update Lantern on it.");
      // A Mac that keeps cards: the card starts now, while the app is in front, not when the Mac has answered.
      if (this.has("liveactivity")) {
        carded = true;
        this.onSending?.(clientId, slot, this.state.chats.find((c) => c.slot === slot)?.project ?? null);
      }
      // Photos are megabytes to get across, so the Mac has longer to answer than for words.
      const request: Request = { op: "send", slot, text, client_id: clientId, ...(images.length > 0 ? { images: images.map((i) => ({ media_type: i.mediaType, data: i.data })) } : {}) };
      await (images.length > 0 ? this.ask(request, UPLOAD_WAIT) : this.ask(request));
      if (carded) this.onSent?.(clientId);
    } catch (e) {
      if (carded) this.onFailed?.(clientId);
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

  /** The projects a chat may be started in from this phone (those the user already works in on the Mac). */
  projects() {
    return this.ask<RemoteProject[]>({ op: "projects" });
  }

  /**
   * What Claude suggests doing next (drafts, from the recent chats). The Mac makes them with a call that costs usage, so
   * they are kept here for a few minutes too: coming back to Home doesn't ask again. `refresh` asks the Mac for new ones.
   */
  async suggest(refresh = false): Promise<Suggestions> {
    const kept = this.suggested;
    if (kept && !refresh && this.now() - kept.at < SUGGESTIONS_KEPT_MS) return kept.value;
    const value = await this.ask<Suggestions>({ op: "suggest", refresh });
    // Whatever the Mac sends is checked before it is kept or shown.
    if (!value || !Array.isArray(value.items)) throw new Error("Claude's suggestions didn't come through.");
    this.suggested = { at: this.now(), value };
    return value;
  }

  /**
   * Starts a chat in a project with a first message: the new chat's slot, once it is open on the Mac. It is on Ask unless
   * `permissions` is Auto (which the Mac allows only if its Settings let phones), with `preset` (one of controls()' ids) or
   * else the project's own.
   */
  async newChat(project: string, text: string, choice: { permissions?: RemotePermissions; preset?: string; workflow?: Exclude<RemoteWorkflow, "team"> } = {}): Promise<string> {
    // Only what was chosen is sent: a Mac that is older doesn't know the fields, and a chat on Ask asks for nothing more.
    const started = await this.ask<StartedChat>({ op: "new_chat", project, text, permissions: choice.permissions ?? null, preset: choice.preset ?? null, workflow: choice.workflow ?? null });
    return started.slot;
  }

  /** Whether this Mac says it can do `feature` (Welcome's features); an older Mac ends the connection at a request it doesn't know. */
  has(feature: string): boolean {
    return this.session?.welcome.features?.includes(feature) === true;
  }

  /** Whether this Mac can be asked what a phone may choose (Welcome lists "controls"). */
  get hasControls(): boolean {
    return this.has("controls");
  }

  /**
   * Runs a command typed after "!" on the Mac, in the chat's folder, as the window's own "!" mode does; the id it was given. Its
   * card fills in as the Mac's events come. Rejects with why not (the chat is asleep, too long…). Only for a Mac that lists
   * "shell": an older one ends the connection at a request it doesn't know.
   */
  async shellRun(slot: string, command: string): Promise<string> {
    const id = newShellId(this.now());
    await this.ask({ op: "shell", slot, id, command });
    return id;
  }

  /** Types a reply (a password, a code, y/n) into a running command; rejects with why not (it has ended…). */
  shellInput(slot: string, id: string, text: string) {
    return this.ask({ op: "shell_input", slot, id, text });
  }

  /** Stops a running command, and what it started. */
  shellStop(slot: string, id: string) {
    return this.ask({ op: "shell_stop", slot, id });
  }

  /** Closes a chat on the Mac, as the window's sidebar does; rejects with why not (Claude is busy, a team's chat…). */
  async close(slot: string): Promise<void> {
    await this.ask({ op: "close", slot });
  }

  /** What may be chosen for a chat: whether Auto is allowed, and the presets. Null for a Mac that can't say. */
  async controls(): Promise<Controls | null> {
    if (!this.hasControls) return null;
    const c = await this.ask<Controls>({ op: "controls" });
    // Whatever the Mac sends is checked before it is shown.
    if (!c || typeof c.allow_auto !== "boolean" || !Array.isArray(c.presets)) throw new Error("What you can choose didn't come through.");
    return { allow_auto: c.allow_auto, presets: c.presets.filter((p) => p && typeof p.id === "string" && typeof p.name === "string").map((p) => ({ id: p.id, name: p.name, summary: typeof p.summary === "string" ? p.summary : "" })) };
  }

  /** Puts a chat on Ask or Auto; rejects with why not (Auto is off on the Mac, Claude is busy…). */
  setPermissions(slot: string, permissions: RemotePermissions) {
    return this.ask({ op: "set_permissions", slot, permissions });
  }

  /** Puts a chat on Chat or Step by step (a Mac that lists "workflow"); rejects with why not (a team, busy…). */
  setWorkflow(slot: string, workflow: Exclude<RemoteWorkflow, "team">) {
    return this.ask({ op: "set_workflow", slot, workflow });
  }

  /** Puts a chat on one of controls()' presets; rejects with why not. */
  setPreset(slot: string, preset: string) {
    return this.ask({ op: "set_preset", slot, preset });
  }

  diff(slot: string, path: string) {
    return this.ask<string>({ op: "diff", slot, path });
  }

  /**
   * A new one-time pairing code to show another device (rejects with why not). Any code the Mac's window is showing stops
   * working. Only for a Mac that lists "pair": an older one ends the connection at a request it doesn't know. The answer is
   * secret until it is used or expires: it isn't kept here, and the screen that shows it lets go of it.
   */
  pairOffer() {
    return this.ask<PairOffer>({ op: "pair_offer" });
  }

  /** What a finished step printed, if the Mac still keeps it (rejects with why not). Only for a Mac that lists "output". */
  stepOutput(slot: string, toolUseId: string) {
    return this.ask<string>({ op: "step_output", slot, tool_use_id: toolUseId });
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

  /** Tells the Mac which card this phone shows on its lock screen (null: none now). Only to a Mac that keeps them. */
  liveActivity(state: { card: RemoteLiveCard | null }) {
    if (!this.has("liveactivity")) return Promise.resolve();
    return this.ask({ op: "live_activity", ...(state.card ? { card: state.card } : {}) });
  }
}
