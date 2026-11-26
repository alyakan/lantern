/**
 * The phone's sync: what the Mac pushes goes through the reducer in batches (once a frame, so streamed text doesn't
 * re-render on every piece), the chats the user follows are subscribed again from where they were whenever a connection
 * comes up, and the user's sends and answers go to the Mac. React reads it with useSyncExternalStore.
 */
import type { Held, OutboxStore } from "../outbox";
import type { Request } from "../protocol/generated/Request";
import type { Controls } from "../protocol/generated/Controls";
import type { EarlierPage } from "../protocol/generated/EarlierPage";
import type { RemoteWhen } from "../protocol/generated/RemoteWhen";
import type { RemotePermissions } from "../protocol/generated/RemotePermissions";
import type { RemoteWorkflow } from "../protocol/generated/RemoteWorkflow";
import type { RemoteProject } from "../protocol/generated/RemoteProject";
import type { RemoteDesk } from "../protocol/generated/RemoteDesk";
import type { RemoteWork } from "../protocol/generated/RemoteWork";
import type { RemoteWebCard } from "../protocol/generated/RemoteWebCard";
import type { RemoteWorkStep } from "../protocol/generated/RemoteWorkStep";
import type { RemoteDeskRoute } from "../protocol/generated/RemoteDeskRoute";
import type { RemoteDeskExchange } from "../protocol/generated/RemoteDeskExchange";
import type { RemoteDeskReply } from "../protocol/generated/RemoteDeskReply";
import type { RemoteDeskTalk } from "../protocol/generated/RemoteDeskTalk";
import type { StartedChat } from "../protocol/generated/StartedChat";
import type { PairOffer } from "../protocol/generated/PairOffer";
import type { RemoteStorage } from "../protocol/generated/RemoteStorage";
import type { RemoteUserTodos } from "../protocol/generated/RemoteUserTodos";
import type { RemoteTodoEdit } from "../protocol/generated/RemoteTodoEdit";
import type { Suggestions } from "../protocol/generated/Suggestions";
import type { RemoteLiveCard } from "../protocol/generated/RemoteLiveCard";
import type { Waiting } from "../protocol/generated/Waiting";
import type { RemoteChanges } from "../protocol/generated/RemoteChanges";
import type { RemoteChangeScope } from "../protocol/generated/RemoteChangeScope";
import type { Insights } from "../protocol/generated/Insights";
import type { InsightsRange } from "../protocol/generated/InsightsRange";
import { UPLOAD_WAIT, type Pushed, type Session } from "../net/session";
import { artifactList, type Artifact } from "../view/artifacts";
import { newShellId } from "../view/shell";
import type { PickedImage } from "../view/attachments";
import { initialState, reducer, type Action, type State } from "./reducer";

/** What a new chat may be started on (see Sync.startChat). */
export type NewChatChoice = { permissions?: RemotePermissions; preset?: string; workflow?: Exclude<RemoteWorkflow, "team">; provider?: string; model?: string; effort?: string; account?: string };

/** A start as Sync keeps it while it goes (see Sync.startChat). */
interface KeptStart {
  id: string;
  project: string;
  text: string;
  choice: NewChatChoice;
  images: PickedImage[];
  /** The first message's id, the same however often it is sent, so the Mac takes it once. */
  clientId: string;
  slot: string | null;
  queued: string[];
  /** Being asked of the Mac now. */
  going: boolean;
}

/** How long the Mac has to make a new chat: its window opens it (a few seconds), and a slow Mac or a busy window takes longer. */
export const NEW_CHAT_WAIT = 45_000;
/** How long a chat's first message may take: the Mac holds it until the chat's agent is up, which it gives a minute and a half. */
export const FIRST_SEND_WAIT = 120_000;

export interface SyncDeps {
  /** Runs `fn` before the next frame (requestAnimationFrame in the app). */
  schedule?: (fn: () => void) => void;
  now?: () => number;
  newId?: () => string;
  /** Where messages written offline are kept until they go (the Keychain in the app; nowhere but memory unless given). */
  outbox?: OutboxStore;
}

const NO_STORE: OutboxStore = { load: async () => ({ held: [], epoch: null }), save: async () => {} };

/** What a message that waited says when the Mac came back as another run: its chats are named afresh, so where it was for is unknown. */
export const RESTARTED = "Your Mac restarted or this chat changed while it waited, so it wasn't sent. Copy it into the chat you meant.";

/** How long held messages wait for a new connection's chat list before they are checked against what is known. */
const CHATS_WAIT = 4000;

const defaultSchedule = (fn: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => fn()) : setTimeout(fn, 16));
let ids = 0;
const defaultId = () => `m-${Date.now().toString(36)}-${(++ids).toString(36)}`;

/** How long the Mac has to say where a Desk's message goes: its router may take half a minute, and an answer two minutes more. */
export const DESK_WAIT = 170_000;

/** How long the phone keeps what Claude suggested before it asks the Mac again. */
export const SUGGESTIONS_KEPT_MS = 10 * 60 * 1000;

/** How many closed chats keep their messages on the phone. */
export const KEEP_CLOSED = 4;

export class Sync {
  private suggested: { at: number; value: Suggestions } | null = null;
  private state: State = initialState;
  private listeners = new Set<() => void>();
  private queue: Action[] = [];
  private scheduled = false;
  private waitingRequest = 0;
  private session: Session | null = null;
  private followed = new Set<string>();
  /** The app is in the back: the chats open in it are let go of (see `setAway`), and taken up again when it comes back. */
  private away = false;
  /** Chats closed, the latest first (see `unfollow`). */
  private closed: string[] = [];
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
    this.store = d.outbox ?? NO_STORE;
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
      // Messages that waited for the Mac are checked against it: in the state before they are looked at.
      if (this.chatsCame) {
        this.apply({ type: "pushed", msg });
        this.flush();
        this.chatsCame();
        this.chatsCame = null;
        return;
      }
    }
    this.apply({ type: "pushed", msg });
    if (msg.type === "reset" && msg.done) void this.refreshWaiting();
  };

  /** Forgets everything (the phone was unpaired): the next Mac starts from nothing. */
  reset() {
    this.queue = [];
    this.outbox = [];
    this.lastEpoch = null;
    this.session = null;
    this.followed.clear();
    this.closed = [];
    this.state = initialState;
    for (const l of this.listeners) l();
  }

  /** A connection came up (Connection's onSession): follow the same chats from where they were, and send what waited for it. */
  onSession = (session: Session) => {
    this.session = session;
    this.apply({ type: "welcome", epoch: session.welcome.epoch });
    this.flush();
    // The chat list this connection starts with is what held messages are checked against.
    this.chatsCame?.();
    this.freshChats = new Promise((r) => (this.chatsCame = r));
    if (this.lastEpoch !== session.welcome.epoch) {
      this.lastEpoch = session.welcome.epoch;
      this.keep();
    }
    if (!this.away) for (const slot of this.followed) void this.subscribeTo(slot);
    void this.sendHeld();
    void this.refreshWaiting();
    void this.refreshDesk();
    void this.refreshWork();
    void this.refreshWebCards();
    this.onConnected?.();
  };

  private ask<T>(request: Request, wait?: number): Promise<T> {
    if (!this.session) return Promise.reject(new Error("Not connected to your Mac."));
    return this.session.ask<T>(request, wait);
  }

  private subscribeTo(slot: string) {
    this.apply({ type: "load_started", slot });
    this.flush();
    // A chat whose pages stopped coming part way (the link dropped between them) starts over: its first page already gave the
    // chat's latest number, and asking from there would skip the pages that never came (hours of a long chat went missing).
    const view = this.state.views[slot];
    const after = view && !view.resetting ? view.seq : 0;
    // A failure is the chat's to show (it has nothing else to show), not swallowed.
    return this.ask({ op: "subscribe", slot, after, epoch: this.state.epoch ?? 0 }).catch((e: Error) => this.apply({ type: "load_failed", slot, why: e.message || "Couldn't load this chat." }));
  }

  /** Asks again for a chat whose history didn't come. */
  retryLoad(slot: string) {
    if (this.followed.has(slot)) void this.subscribeTo(slot);
  }

  async refreshWaiting() {
    this.flush();
    const session = this.session;
    const request = ++this.waitingRequest;
    const observedPrompts = Object.fromEntries(Object.entries(this.state.views).map(([slot, view]) => [slot, view.items.filter((it) => it.kind === "prompt" && it.state === "open").map((it) => it.id)]));
    try {
      const list = await this.ask<Waiting[]>({ op: "list_waiting" });
      if (this.session === session && request === this.waitingRequest && Array.isArray(list)) this.apply({ type: "waiting", list, observedPrompts });
    } catch {
      // Not connected: it is asked again when a connection comes up. Connected but it failed: what was known stays, and Home
      // shows that rather than waiting for ever on an answer that isn't coming.
      if (this.session === session && request === this.waitingRequest && this.session) this.apply({ type: "waiting", list: this.state.waiting });
    }
  }

  /** Whether the Mac shares its One project (it pushes it as it changes, and takes one picked here). */
  followsSingle() {
    return this.has("single");
  }

  /**
   * Shows only `project` (a RemoteProject's id) on the Mac and here, or every project (null). Nothing changes here until the Mac
   * says back what it shows, so the two never disagree.
   */
  setSingle(project: string | null) {
    if (!this.has("single")) return Promise.reject(new Error("Update Lantern on your Mac to show one project."));
    return this.ask<null>({ op: "set_single", project });
  }

  /** Asks for the Desk, from a Mac that has one (it pushes it as it changes; this is for the first time). */
  async refreshDesk() {
    if (!this.has("desk")) return;
    try {
      const desk = await this.ask<RemoteDesk>({ op: "desk" });
      if (desk && Array.isArray(desk.desks) && Array.isArray(desk.cards)) this.apply({ type: "desk", desk });
    } catch {
      // What was known stays: the Mac pushes the Desk again when it changes.
    }
  }

  /** Asks for Your work, from a Mac that has it (it pushes it as it changes; this is for the first time). */
  async refreshWork() {
    if (!this.has("work")) return;
    try {
      const work = await this.ask<RemoteWork>({ op: "work" });
      if (work && Array.isArray(work.items)) this.apply({ type: "work", work });
    } catch {
      // What was known stays: the Mac pushes it again when it changes.
    }
  }

  /**
   * Asks the Mac to do the step of the item `key`, as it was shown (`sig`): the Mac sends a message it wrote to the chat on the item's
   * branch, or starts a chat on Ask. Nothing is typed here. Says what the Mac did; rejects with why it didn't.
   */
  workStep(key: string, sig: string) {
    if (!this.has("work")) return Promise.reject(new Error("Update Lantern on your Mac to do that from here."));
    return this.ask<RemoteWorkStep>({ op: "work_step", key, sig }, DESK_WAIT);
  }

  /** Asks for the work web Claude sent that waits for a Run, from a Mac that has it (it pushes them as they change). */
  async refreshWebCards() {
    if (!this.has("webclaude")) return;
    try {
      const cards = await this.ask<RemoteWebCard[]>({ op: "web_cards" });
      if (Array.isArray(cards)) this.apply({ type: "webCards", cards });
    } catch {
      // What was known stays: the Mac pushes them again when they change.
    }
  }

  /**
   * Runs (or declines) web Claude's card `id`, as its card on the Mac does: in `project` (one of projects()' ids) when the user picked
   * one, else the card's own. Rejects with why not (answered already, no project, too many lately).
   */
  webRun(id: string, run: boolean, project: string | null = null) {
    if (!this.has("webclaude")) return Promise.reject(new Error("Update Lantern on your Mac to do that from here."));
    return this.ask<null>({ op: "web_run", id, run, project }, DESK_WAIT);
  }

  /** Asks the Mac to look at git, GitHub and Linear again; what it finds comes as Your work changes. */
  workRefresh() {
    if (!this.has("work")) return Promise.resolve(null);
    return this.ask<null>({ op: "work_refresh" });
  }

  /**
   * Where a message typed on the Desk `desk` goes, decided on the Mac by a quick call to a small model (up to half a minute). Nothing
   * is sent: the caller sends it there.
   */
  deskRoute(desk: string, text: string) {
    if (!this.has("desk")) return Promise.reject(new Error("This Mac has no Desk yet. Update Lantern on it."));
    return this.ask<RemoteDeskRoute>({ op: "desk_route", desk, text }, DESK_WAIT);
  }

  /** Whether the Mac's Desk talks back and sums up what came back (Request::DeskTalk, Request::DeskReply). */
  deskTalks() {
    return this.has("desktalk");
  }

  /**
   * What the Desk says back to `text` typed on the Desk `desk`, given the last few exchanges there, and what it does with it (as
   * deskRoute does; null: it only replied). Nothing is sent: the caller sends it.
   */
  deskTalk(desk: string, text: string, history: RemoteDeskExchange[]) {
    if (!this.has("desktalk")) return Promise.reject(new Error("Update Lantern on your Mac for the Desk to talk."));
    return this.ask<RemoteDeskTalk>({ op: "desk_talk", desk, text, history }, DESK_WAIT);
  }

  /** What came back from chat `slot` to the Desk message `text`, sent there after its event `after`: summed up once its turn ended. */
  deskReply(desk: string, slot: string, text: string, after: number) {
    if (!this.has("desktalk")) return Promise.reject(new Error("Update Lantern on your Mac to see what came back."));
    return this.ask<RemoteDeskReply>({ op: "desk_reply", desk, slot, text, after }, DESK_WAIT);
  }

  /**
   * The app went to the back (true) or came to the front. The Mac doesn't push about a chat a phone follows, since it is being
   * looked at; a phone put away with a chat open could keep its link up a while and still count, and the push it needed (the chat
   * finished, or needs you) never came. So the chats are let go of while it is away, and followed again, from where they were,
   * when it is back.
   */
  setAway(away: boolean) {
    if (away === this.away) return;
    this.away = away;
    // Back in front, the link it had may have died meanwhile: the chats are followed again once it is known to work (`onStillUp`),
    // or by the connection dialled in its place (`onSession`), not asked for over a dead one and shown as failed to load.
    if (!away || !this.session) return;
    for (const slot of this.followed) void this.ask({ op: "unsubscribe", slot }).catch(() => {});
  }

  /** Back in front, the connection it had still works (Connection's onStillUp): follow the open chats again, from where they were. */
  onStillUp = (session: Session) => {
    if (this.away || session !== this.session) return;
    for (const slot of this.followed) void this.subscribeTo(slot);
  };

  /** Opens a chat: its events come from now on. */
  follow(slot: string) {
    if (this.followed.has(slot)) return;
    this.followed.add(slot);
    if (!this.away) void this.subscribeTo(slot);
  }

  unfollow(slot: string) {
    this.followed.delete(slot);
    void this.ask({ op: "unsubscribe", slot }).catch(() => {});
    // The last few chats closed keep their messages, so going back to one is instant; older ones are let go, or a long
    // session would hold every chat ever opened.
    this.closed = [slot, ...this.closed.filter((s) => s !== slot)];
    for (const old of this.closed.splice(KEEP_CLOSED)) if (!this.followed.has(old)) this.apply({ type: "forget", slot: old });
  }

  /**
   * Sends again a message that didn't go, in its own place and under its own id: when the Mac did get it after all, its copy
   * still takes the one place in the chat.
   */
  retry(slot: string, itemId: string) {
    const item = this.state.views[slot]?.items.find((it) => it.kind === "user" && it.id === itemId);
    if (item?.kind !== "user" || !item.failed || item.stale || !item.id.startsWith("local-")) return Promise.resolve();
    const clientId = item.id.slice("local-".length);
    return this.send(slot, item.text, this.photos.get(clientId) ?? [], clientId);
  }

  /** The photos of messages that didn't go, by their id, so Try again sends them too (kept while the app runs). */
  private photos = new Map<string, PickedImage[]>();

  /**
   * Messages written while the Mac couldn't be reached (see `hold`), in the order they were written. Only those: one that was
   * already on its way when the link went says it didn't go, since the Mac may have it, and sending it again could send it
   * twice.
   */
  private outbox: Held[] = [];
  private store: OutboxStore;
  private sendingHeld = false;
  /** The Mac run this phone last spoke to, kept between launches: a message written before any connection this launch is for it. */
  private lastEpoch: number | null = null;
  /** Done once what waited when the app last closed has been read back: nothing is saved or sent before it, or it would be lost. */
  private restored: Promise<void> = Promise.resolve();
  /** The chat list a new connection starts with (the Mac sends it first): what waited is checked against it before it goes. */
  private freshChats: Promise<void> = Promise.resolve();
  private chatsCame: (() => void) | null = null;
  private keep() {
    void this.restored.then(() => this.store.save({ held: this.outbox, epoch: this.lastEpoch }));
  }

  /** A message written while the Mac can't be reached: it shows as waiting, kept on the phone, and goes once a connection is up. */
  hold(slot: string, text: string) {
    // Its chat's project, to check it against once the Mac is back; unknown (not in the list) leaves that check out.
    const chat = this.state.chats.find((c) => c.slot === slot);
    const project = chat ? (chat.project ?? null) : undefined;
    const held: Held = { slot, text, clientId: this.newId(), epoch: this.state.epoch ?? this.lastEpoch, at: this.now(), project };
    this.apply({ type: "held", slot, clientId: held.clientId, text, at: held.at });
    this.outbox.push(held);
    this.keep();
  }

  /** At launch: what waited when the app last closed shows again, waiting as it was, before anything written since. */
  restoreHeld() {
    this.restored = (async () => {
      const kept = await this.store.load();
      this.lastEpoch ??= kept.epoch;
      const back = kept.held.filter((held) => !this.outbox.some((h) => h.clientId === held.clientId));
      for (const held of back) this.apply({ type: "held", slot: held.slot, clientId: held.clientId, text: held.text, at: held.at });
      this.outbox = [...back, ...this.outbox].sort((a, b) => a.at - b.at);
    })();
    // Connected before they were read back: they go now.
    void this.restored.then(() => {
      if (this.session && this.outbox.length > 0) void this.sendHeld();
    });
    return this.restored;
  }

  /**
   * Sends what waited for the Mac, one after another so they arrive in the order they were written, and only to the chat it
   * was written for. A chat's slot is only that Mac run's (they are named afresh each launch), and an empty chat's slot can
   * take another project's chat: one written for another run, or whose chat is now another project's (or gone), isn't sent,
   * and says why, with no Try again.
   */
  private async sendHeld() {
    if (this.sendingHeld) return;
    this.sendingHeld = true;
    try {
      await this.restored;
      if (this.outbox.length === 0) return;
      // The latest connection's list: one that came up meanwhile has its own (see onSession).
      let waited: Promise<void> | null = null;
      while (waited !== this.freshChats) {
        waited = this.freshChats;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([waited, new Promise((r) => (timer = setTimeout(r, CHATS_WAIT)))]);
        clearTimeout(timer);
      }
      for (const held of [...this.outbox]) {
        const chat = this.state.chats.find((c) => c.slot === held.slot);
        const same = held.epoch !== null && held.epoch === this.state.epoch && !!chat && (held.project === undefined || (chat.project ?? null) === held.project);
        if (same) await this.send(held.slot, held.text, [], held.clientId);
        else this.apply({ type: "send_failed", slot: held.slot, clientId: held.clientId, error: RESTARTED, stale: true });
        this.outbox = this.outbox.filter((h) => h !== held);
        this.keep();
      }
    } finally {
      this.sendingHeld = false;
    }
  }

  /**
   * Sends a message (with `images`, when it has some): it shows at once, and says why if it didn't go (its photos are kept for
   * Try again). In a chat whose first message is still going, it goes after that one. `wait`: how long the Mac has to answer.
   */
  async send(slot: string, text: string, images: PickedImage[] = [], clientId: string = this.newId(), wait?: number) {
    this.apply({ type: "sending", slot, clientId, text, at: this.now(), ...(images.length > 0 ? { thumbs: images.map((i) => i.uri) } : {}) });
    const first = this.firstGoing.get(slot);
    if (first) await first;
    await this.deliver(slot, text, images, clientId, wait);
  }

  /** Sends a message already shown as sending: whether it went (if not, it says why, and its photos are kept for Try again). */
  private async deliver(slot: string, text: string, images: PickedImage[], clientId: string, wait?: number): Promise<boolean> {
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
      await this.ask(request, wait ?? (images.length > 0 ? UPLOAD_WAIT : undefined));
      this.photos.delete(clientId);
      if (carded) this.onSent?.(clientId);
      return true;
    } catch (e) {
      if (images.length > 0) this.photos.set(clientId, images);
      if (carded) this.onFailed?.(clientId);
      this.apply({ type: "send_failed", slot, clientId, error: (e as Error).message });
      return false;
    }
  }

  /** Whether the Mac answers over this connection now (a round trip), which a connection that looks up may not. */
  alive() {
    return this.ask({ op: "list_waiting" }, 4000).then(
      () => true,
      () => false,
    );
  }

  /** Sends a message without showing it as sending (a notification's Reply, with no screen to show it on): rejects with why it didn't go. */
  sendQuiet(slot: string, text: string) {
    return this.ask({ op: "send", slot, text, client_id: this.newId() });
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
   * What Claude would do next in one chat (Cruise): drafts made on the Mac from the chat's last few turns. Nothing is kept
   * here: the Mac keeps them per chat and knows whether the chat has moved on since (a draft kept on this side would be
   * the last turn's); `refresh` asks for more ("Another"). Never sent by itself: the caller shows them as a card and sends
   * the one the user taps.
   */
  async cruise(slot: string, refresh = false): Promise<Suggestions> {
    if (!this.has("cruise")) throw new Error("This Mac can't suggest a next step yet. Update Lantern on it.");
    const value = await this.ask<Suggestions>({ op: "cruise", slot, refresh });
    // Whatever the Mac sends is checked before it is shown.
    if (!value || !Array.isArray(value.items)) throw new Error("Claude's next step didn't come through.");
    return value;
  }

  /**
   * Starts a chat in a project with a first message. It is kept here (see ChatStart), not on a page: it shows at once, starting,
   * and stays until its chat is in the Mac's list, or says why the Mac didn't make it, with Try again.
   *
   * A Mac that takes a named start (`newchatstart`) is asked for the chat by the start's id, with no message, and answers as soon
   * as the chat is made; asked again by the same id (Try again, or an answer that was lost), it answers with the same chat, never a
   * second one. The first message then goes into the chat as any message does, photos and all, and says there if it didn't go,
   * with Try again: the Mac holds it until the chat's agent is up, so it is given as long as that takes. An older Mac takes the
   * message with the chat.
   *
   * It is on Ask unless `permissions` is Auto (which the Mac allows only if its Settings let phones), with `preset` (one of
   * controls()' ids) or else the project's own. `provider` (one of controls()' providers) is where it runs, else the project's own.
   */
  startChat(start: { id: string; project: string; projectName: string; text: string; choice?: NewChatChoice; images?: PickedImage[] }) {
    const images = start.images ?? [];
    const kept: KeptStart = { id: start.id, project: start.project, text: start.text, choice: start.choice ?? {}, images, clientId: this.newId(), slot: null, queued: [], going: false };
    this.starting.set(start.id, kept);
    this.apply({ type: "start_added", start: { id: start.id, project: start.project, projectName: start.projectName, text: start.text, thumbs: images.map((i) => i.uri), at: this.now(), slot: null, problem: null, queued: [] } });
    void this.makeStart(kept);
  }

  /** Try again, for a start the Mac didn't make: asked by the same id, so a chat it made after all is the one opened. */
  retryStart(id: string) {
    const kept = this.starting.get(id);
    if (!kept || kept.going || kept.slot) return;
    this.apply({ type: "start_again", id });
    void this.makeStart(kept);
  }

  /** A message sent from a start's page: it goes after the first message, once the chat is there (at once, if it is). */
  queueStart(id: string, text: string) {
    const kept = this.starting.get(id);
    if (!kept) return;
    if (kept.slot) return void this.send(kept.slot, text);
    kept.queued.push(text);
    this.apply({ type: "start_queued", id, text });
  }

  /** A start let go (Edit message, or Discard): what it had is the caller's. */
  dropStart(id: string) {
    this.starting.delete(id);
    this.apply({ type: "start_gone", id });
  }

  /** What a start had: its words, and what was sent from its page after them. */
  startText(id: string) {
    const kept = this.starting.get(id);
    return kept ? [kept.text, ...kept.queued].join("\n\n") : null;
  }

  /** The starts this phone asked for, by id, with what isn't shown (the photos, the choices, the first message's id). */
  private starting = new Map<string, KeptStart>();
  /** A chat's first message while it goes: what is sent after it in the same chat waits for it, so they arrive in order. */
  private firstGoing = new Map<string, Promise<void>>();

  private async makeStart(kept: KeptStart) {
    kept.going = true;
    const named = this.has("newchatstart");
    let slot: string;
    try {
      const { images, choice } = kept;
      if (images.length > 0 && !named && !this.has("newchatimages")) throw new Error("This Mac can't take photos with a new chat yet. Update Lantern on it.");
      if ((choice.model || choice.effort) && !this.has("newchatmodel")) throw new Error("This Mac can't start a chat on a model you pick yet. Update Lantern on it.");
      if (choice.account && !this.has("accounts")) throw new Error("This Mac can't start a chat on another Claude account yet. Update Lantern on it.");
      // Only what was chosen is sent: a Mac that is older doesn't know the fields, and a chat on Ask asks for nothing more. The provider,
      // the model, the effort and the pictures are left out altogether, not sent empty, when there are none.
      const request: Request = { op: "new_chat", project: kept.project, text: named ? "" : kept.text, permissions: choice.permissions ?? null, preset: choice.preset ?? null, workflow: choice.workflow ?? null, ...(choice.provider ? { provider: choice.provider } : {}), ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}), ...(choice.account ? { account: choice.account } : {}), ...(named ? { start_id: kept.id } : images.length > 0 ? { images: images.map((i) => ({ media_type: i.mediaType, data: i.data })) } : {}) };
      slot = (await this.ask<StartedChat>(request, !named && images.length > 0 ? UPLOAD_WAIT : NEW_CHAT_WAIT)).slot;
    } catch (e) {
      kept.going = false;
      // Let go meanwhile: nothing is left to say it on.
      if (this.starting.get(kept.id) === kept) this.apply({ type: "start_failed", id: kept.id, problem: (e as Error)?.message || "Your Mac didn't start the chat." });
      return;
    }
    kept.going = false;
    kept.slot = slot;
    const queued = kept.queued.splice(0);
    this.apply({ type: "start_made", id: kept.id, slot });
    if (!named) {
      // An older Mac took the first message with the chat, and tells of it once the chat's agent has it: it shows going until then.
      this.apply({ type: "sending", slot, clientId: kept.clientId, text: kept.text, at: this.now(), opening: true, ...(kept.images.length > 0 ? { thumbs: kept.images.map((i) => i.uri) } : {}) });
    }
    // The first message, and then what was sent from its page, show now in that order, and go one after another; what is sent in
    // the chat meanwhile waits for them all. One that didn't go holds back the rest, which say so: they would arrive without it.
    const rest = queued.map((text) => ({ text, clientId: this.newId() }));
    if (named) this.apply({ type: "sending", slot, clientId: kept.clientId, text: kept.text, at: this.now(), ...(kept.images.length > 0 ? { thumbs: kept.images.map((i) => i.uri) } : {}) });
    for (const r of rest) this.apply({ type: "sending", slot, clientId: r.clientId, text: r.text, at: this.now() });
    const chain = (async () => {
      let ok = !named || (await this.deliver(slot, kept.text, kept.images, kept.clientId, FIRST_SEND_WAIT));
      for (const r of rest) {
        if (ok) ok = await this.deliver(slot, r.text, [], r.clientId);
        else this.apply({ type: "send_failed", slot, clientId: r.clientId, error: "Not sent: the message before it didn't go." });
      }
    })();
    this.firstGoing.set(slot, chain);
    await chain;
    if (this.firstGoing.get(slot) === chain) this.firstGoing.delete(slot);
    // Its chat is the start now (it is shown as that chat once the Mac lists it).
    this.starting.delete(kept.id);
  }

  /** Insights for a stretch of time, worked out on the Mac (it reads weeks of logs the first time: it may take a while). Only for a Mac that lists "insights". */
  insights(range: InsightsRange) {
    if (!this.has("insights")) return Promise.reject(new Error("This Mac can't show insights yet. Update Lantern on it."));
    return this.ask<Insights>({ op: "insights", range }, UPLOAD_WAIT);
  }

  /** The user's own to-do list for a project (one of projects()' ids, or the project a reminder named). Only for a Mac that lists "todos". */
  todos(project: string) {
    if (!this.has("todos")) return Promise.reject(new Error("This Mac can't show to-dos yet. Update Lantern on it."));
    return this.ask<RemoteUserTodos>({ op: "todos", project });
  }

  /** One change to a project's to-do list; the list after it. */
  todoEdit(project: string, edit: RemoteTodoEdit) {
    if (!this.has("todos")) return Promise.reject(new Error("This Mac can't show to-dos yet. Update Lantern on it."));
    return this.ask<RemoteUserTodos>({ op: "todo_edit", project, edit });
  }

  /** `when`, for a chat that is working (a Mac that lists "switchbusy"): stop it and change it now, or once it finishes. */
  conversationSettings(slot: string, change: { provider?: string; model?: string | null; effort?: string | null } | null = null, when?: RemoteWhen): Promise<ConversationSettings> {
    if (!this.has("conversation")) return Promise.reject(new Error("Update Lantern on your Mac to change providers."));
    return this.ask<ConversationSettings>({ op: "conversation_settings", slot, change, ...this.whenOf(when) });
  }

  /** `when` as it is sent: only to a Mac that knows it (an older one would refuse the chat as busy anyway). */
  private whenOf(when: RemoteWhen | undefined): { when?: RemoteWhen } {
    return when && this.has("switchbusy") ? { when } : {};
  }

  conversationAction(slot: string, action: "compact" | "clear") {
    if (!this.has("conversation")) return this.send(slot, `/${action}`);
    return this.ask({ op: "conversation_action", slot, action });
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

  /** Names a chat on the Mac, as its History menu's Rename does (the chat's title everywhere changes with it); rejects with why not (no conversation yet, no name). */
  async rename(slot: string, title: string): Promise<void> {
    await this.ask({ op: "rename", slot, title });
  }

  /** What may be chosen for a chat: whether Auto is allowed, and the presets. Null for a Mac that can't say. */
  async controls(): Promise<Controls | null> {
    if (!this.hasControls) return null;
    const c = await this.ask<Controls>({ op: "controls" });
    // Whatever the Mac sends is checked before it is shown.
    if (!c || typeof c.allow_auto !== "boolean" || !Array.isArray(c.presets)) throw new Error("What you can choose didn't come through.");
    // Where a chat may run is optional (an older Mac leaves it out, and a Mac with only Claude says none): kept only what is well formed.
    const providers = (Array.isArray(c.providers) ? c.providers : []).filter((p) => p && typeof p.id === "string" && p.id.length > 0 && typeof p.name === "string" && p.name.length > 0).map((p) => ({ id: p.id, name: p.name, auto: p.auto === true, presets: p.presets === true }));
    // Each provider's models, likewise (a Mac that can't take a model for a new chat leaves them out).
    const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
    const models = (Array.isArray(c.models) ? c.models : [])
      .filter((m) => m && text(m.provider) && Array.isArray(m.models))
      .map((m) => ({ provider: m.provider, models: m.models.filter((x) => x && text(x.value)).map((x) => ({ value: x.value, name: text(x.name) ? x.name : x.value, effort_levels: Array.isArray(x.effort_levels) ? x.effort_levels.filter(text) : [] })) }));
    // The Claude accounts, likewise (a Mac that doesn't list "accounts" leaves them out): only well-formed ones, each id once.
    const accounts: { id: string; name: string }[] = [];
    for (const a of Array.isArray(c.accounts) ? c.accounts : []) {
      if (a && text(a.id) && text(a.name) && !accounts.some((k) => k.id === a.id)) accounts.push({ id: a.id, name: a.name });
    }
    return { allow_auto: c.allow_auto, presets: c.presets.filter((p) => p && typeof p.id === "string" && typeof p.name === "string").map((p) => ({ id: p.id, name: p.name, summary: typeof p.summary === "string" ? p.summary : "" })), providers, models, ...(accounts.length > 0 ? { accounts } : {}) };
  }

  /** Moves a chat to one of controls()' accounts (null: the default login); it restarts on the same conversation. Rejects with why not (busy, a team…). Only for a Mac that lists "accounts". */
  setAccount(slot: string, account: string | null) {
    if (!this.has("accounts")) return Promise.reject(new Error("This Mac can't move a chat to another account yet. Update Lantern on it."));
    return this.ask({ op: "set_account", slot, account });
  }

  /** Puts a chat on Ask or Auto; rejects with why not (Auto is off on the Mac, Claude is busy…). `when`: see conversationSettings. */
  setPermissions(slot: string, permissions: RemotePermissions, when?: RemoteWhen) {
    return this.ask({ op: "set_permissions", slot, permissions, ...this.whenOf(when) });
  }

  /** Puts a chat on Chat or Step by step (a Mac that lists "workflow"); rejects with why not (a team, busy…). */
  setWorkflow(slot: string, workflow: Exclude<RemoteWorkflow, "team">, when?: RemoteWhen) {
    return this.ask({ op: "set_workflow", slot, workflow, ...this.whenOf(when) });
  }

  /** Puts a chat on one of controls()' presets; rejects with why not. */
  setPreset(slot: string, preset: string, when?: RemoteWhen) {
    return this.ask({ op: "set_preset", slot, preset, ...this.whenOf(when) });
  }

  /** A file's diff: the chat's change to it, or (`scope`, only for a Mac that lists "changescopes") what is uncommitted or the branch's change. */
  diff(slot: string, path: string, scope?: RemoteChangeScope) {
    return this.ask<string>(scope && scope !== "chat" ? { op: "diff", slot, path, scope } : { op: "diff", slot, path });
  }

  /** The files changed in one of the Changes pane's views. Only for a Mac that lists "changescopes". */
  async changes(slot: string, scope: RemoteChangeScope): Promise<RemoteChanges> {
    const c = await this.ask<RemoteChanges | null>({ op: "changes", slot, scope });
    if (!c || !Array.isArray(c.files)) throw new Error("The changes didn't come through.");
    const files = c.files.filter((f) => f && typeof f.path === "string" && f.path.length > 0).map((f) => ({ path: f.path, created: f.created === true, deleted: f.deleted === true, added: Number(f.added) || 0, removed: Number(f.removed) || 0 }));
    return { files, base: typeof c.base === "string" ? c.base : null };
  }

  /** A reviewed file's diff in what the chat reviews (or its own change, when it reviews nothing). Only for a Mac that lists "reviewdiff". */
  reviewDiff(slot: string, path: string) {
    return this.ask<string>({ op: "review_diff", slot, path });
  }

  /** The artifacts in the chat's folder, newest first (`.lantern/artifacts/` on the Mac). Only for a Mac that lists "artifacts". */
  async artifacts(slot: string): Promise<Artifact[]> {
    return artifactList(await this.ask<unknown>({ op: "artifacts", slot }));
  }

  /**
   * One artifact's text by the name `artifacts` gave: Markdown and Mermaid as written, HTML and SVG with what makes a page reach
   * a server on its own taken out by the Mac (the page is drawn with scripts off, see ArtifactPage). Only for a Mac that lists "artifacts".
   */
  async artifactRead(slot: string, name: string): Promise<string> {
    const text = await this.ask<unknown>({ op: "artifact_read", slot, name });
    if (typeof text !== "string") throw new Error("That artifact didn't come through.");
    return text;
  }

  /**
   * A new one-time pairing code to show another device (rejects with why not). Any code the Mac's window is showing stops
   * working. Only for a Mac that lists "pair": an older one ends the connection at a request it doesn't know. The answer is
   * secret until it is used or expires: it isn't kept here, and the screen that shows it lets go of it.
   */
  pairOffer() {
    return this.ask<PairOffer>({ op: "pair_offer" });
  }

  /** The Mac's disk and the items of it that are safe to clear. Only for a Mac that lists "storage". */
  storage() {
    return this.ask<RemoteStorage>({ op: "storage" });
  }

  /** Starts a scan of the Mac's storage (in the background there: `storage()` says how it goes); whether one started. */
  storageScan() {
    return this.ask<boolean>({ op: "storage_scan" });
  }

  /**
   * Starts clearing these items on the Mac, those it still finds safe (it never takes the phone's word for what is: it ignores
   * any id that isn't). How many it started and about how many bytes; rejects with why not (the scan is old, nothing is safe).
   */
  storageClear(ids: string[]) {
    return this.ask<{ started: number; bytes: number }>({ op: "storage_clear", ids });
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
    void this.refreshWaiting();
  }

  registerPushToken(token: string) {
    return this.ask({ op: "push_token", token });
  }

  /** Gives the Mac the key this phone made for its notifications' words (see pushKey.ts). Only to a Mac that lists "pushkey". */
  registerPushKey(key: string) {
    if (!this.has("pushkey")) return Promise.resolve();
    return this.ask({ op: "push_key", key });
  }

  /**
   * Tells the Mac which card this phone shows on its lock screen (null: none now), and its token for starting one by push
   * (the Mac keeps the last one it was given). Only to a Mac that keeps them.
   */
  liveActivity(state: { card: RemoteLiveCard | null; start_token?: string }) {
    if (!this.has("liveactivity")) return Promise.resolve();
    return this.ask({ op: "live_activity", ...(state.card ? { card: state.card } : {}), ...(state.start_token ? { start_token: state.start_token } : {}) });
  }
}

export type ConversationSettings = import("../protocol/generated/ConversationConfiguration").ConversationConfiguration;
