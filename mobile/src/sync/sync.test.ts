import type { Request } from "../protocol/generated/Request";
import { ANSWER_WAIT, UPLOAD_WAIT, type Pushed, type Session } from "../net/session";
import { Sync, SUGGESTIONS_KEPT_MS } from "./sync";

/** A session that records what it was asked and answers from a table. */
function fakeSession(epoch: number, answers: Partial<Record<Request["op"], unknown>> = {}, fail: Partial<Record<Request["op"], string>> = {}, features: string[] = []) {
  const asked: Request[] = [];
  /** How long each request said it would wait for its answer (undefined: the usual). */
  const waits: (number | undefined)[] = [];
  const session = {
    welcome: { type: "welcome", protocol: 1, app_version: "t", mac_name: "Mac", epoch, features },
    ask: async (r: Request, wait?: number) => {
      asked.push(r);
      waits.push(wait);
      if (fail[r.op]) throw new Error(fail[r.op]);
      return answers[r.op] ?? null;
    },
  } as unknown as Session;
  return { session, asked, waits };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function rig() {
  const frames: (() => void)[] = [];
  const sync = new Sync({ schedule: (fn) => frames.push(fn), now: () => 100, newId: () => "m-1" });
  const renders: number[] = [];
  sync.subscribe(() => renders.push(1));
  const frame = () => frames.splice(0).forEach((f) => f());
  return { sync, renders, frame };
}

const delta = (seq: number, text: string): Pushed => ({ type: "event", slot: "a", seq, event: { kind: "text_delta", block_id: "b", text } });

describe("the phone's sync", () => {
  it("applies streamed pieces once a frame, not one render each", () => {
    const { sync, renders, frame } = rig();
    for (let i = 1; i <= 50; i++) sync.onPushed(delta(i, "x"));
    expect(renders).toHaveLength(0);
    frame();
    expect(renders).toHaveLength(1);
    expect(sync.getState().views.a.items[0]).toMatchObject({ text: "x".repeat(50) });
  });

  it("follows a chat from where it was when a connection comes back, in the Mac's epoch", async () => {
    const { sync, frame } = rig();
    const first = fakeSession(7);
    sync.onSession(first.session);
    sync.follow("a");
    await settle();
    expect(first.asked).toContainEqual({ op: "subscribe", slot: "a", after: 0, epoch: 7 });
    sync.onPushed(delta(12, "hi"));
    frame();
    const second = fakeSession(7);
    sync.onSession(second.session);
    await settle();
    expect(second.asked).toContainEqual({ op: "subscribe", slot: "a", after: 12, epoch: 7 });
  });

  it("after the Mac restarted (another epoch) it follows from the start", async () => {
    const { sync, frame } = rig();
    sync.onSession(fakeSession(7).session);
    sync.follow("a");
    sync.onPushed(delta(40, "hi"));
    frame();
    const after = fakeSession(8);
    sync.onSession(after.session);
    await settle();
    expect(after.asked).toContainEqual({ op: "subscribe", slot: "a", after: 0, epoch: 8 });
  });

  it("shows a sent message at once, sends it with its id, and says why when it didn't go", async () => {
    const { sync, frame } = rig();
    const s = fakeSession(7, {}, { send: "That chat isn't open on your Mac." });
    sync.onSession(s.session);
    await sync.send("a", "ship it");
    expect(s.asked).toContainEqual({ op: "send", slot: "a", text: "ship it", client_id: "m-1" });
    frame();
    expect(sync.getState().views.a.items[0]).toMatchObject({ text: "ship it", failed: "That chat isn't open on your Mac." });
  });

  it("sends a message's photos only to a Mac that takes them, as the JPEGs they are, and shows them at once", async () => {
    const photo = (n: number) => ({ id: `i${n}`, uri: `file:///p${n}.jpg`, data: `DATA${n}`, mediaType: "image/jpeg" as const, width: 10, height: 10 });
    const { sync, frame } = rig();
    const takes = fakeSession(7, {}, {}, ["images"]);
    sync.onSession(takes.session);
    await sync.send("a", "what is this?", [photo(1), photo(2)]);
    expect(takes.asked).toContainEqual({ op: "send", slot: "a", text: "what is this?", client_id: "m-1", images: [{ media_type: "image/jpeg", data: "DATA1" }, { media_type: "image/jpeg", data: "DATA2" }] });
    frame();
    expect(sync.getState().views.a.items[0]).toMatchObject({ images: 2, thumbs: ["file:///p1.jpg", "file:///p2.jpg"], sending: true });
    // A message with none says nothing of them, so an older Mac reads it as it always did.
    await sync.send("a", "no photos");
    expect(takes.asked.at(-1)).toEqual({ op: "send", slot: "a", text: "no photos", client_id: "m-1" });
  });

  it("gives a send with photos long to be answered, since they are megabytes to get across, and words the usual wait", async () => {
    const { sync } = rig();
    const takes = fakeSession(7, {}, {}, ["images"]);
    sync.onSession(takes.session);
    const sends = () => takes.asked.flatMap((r, i) => (r.op === "send" ? [takes.waits[i]] : []));
    await sync.send("a", "words");
    await sync.send("a", "look", [{ id: "i1", uri: "file:///p1.jpg", data: "DATA1", mediaType: "image/jpeg", width: 10, height: 10 }]);
    expect(sends()).toEqual([undefined, UPLOAD_WAIT]);
    expect(UPLOAD_WAIT).toBeGreaterThan(ANSWER_WAIT * 4);
  });

  it("doesn't send photos to a Mac that can't take them: it says so instead of sending the words alone", async () => {
    const { sync, frame } = rig();
    const old = fakeSession(7);
    sync.onSession(old.session);
    await sync.send("a", "what is this?", [{ id: "i1", uri: "file:///p1.jpg", data: "DATA1", mediaType: "image/jpeg", width: 10, height: 10 }]);
    expect(old.asked.filter((r) => r.op === "send")).toEqual([]);
    frame();
    expect(sync.getState().views.a.items[0]).toMatchObject({ failed: expect.stringMatching(/can't take photos/) });
  });

  it("tells its card controller as a message goes out to a Mac that keeps cards, with the chat's project, and whether it was taken", async () => {
    const chats = [{ slot: "a", title: null, project: "lantern", status: "idle" as const, last_seq: 1, active_at: 1, permissions: null, preset: null, project_color: null, workflow: null }];
    const { sync, frame } = rig();
    const told: string[] = [];
    sync.onSending = (id, slot, project) => void told.push(`sending ${id} ${slot} ${project}`);
    sync.onSent = (id) => void told.push(`sent ${id}`);
    sync.onFailed = (id) => void told.push(`failed ${id}`);
    sync.onPushed({ type: "chats", chats });
    frame();
    // A Mac that doesn't keep cards: nothing to start.
    sync.onSession(fakeSession(7).session);
    await sync.send("a", "hi");
    expect(told).toEqual([]);
    // One that does: told as the message goes (before the Mac answers), then that it was taken.
    const keeps = fakeSession(7, {}, {}, ["liveactivity"]);
    sync.onSession(keeps.session);
    const sending = sync.send("a", "hi");
    expect(told).toEqual(["sending m-1 a lantern"]);
    await sending;
    expect(told).toEqual(["sending m-1 a lantern", "sent m-1"]);
    await sync.send("unlisted", "hi");
    expect(told.at(-2)).toBe("sending m-1 unlisted null");
    // A message the Mac didn't take: the card started for it is given back.
    told.length = 0;
    sync.onSession(fakeSession(7, {}, { send: "That chat isn't open on your Mac." }, ["liveactivity"]).session);
    await sync.send("a", "hi");
    expect(told).toEqual(["sending m-1 a lantern", "failed m-1"]);
    // A message that never went (photos to a Mac that can't take them) starts no card.
    told.length = 0;
    sync.onSession(fakeSession(7, {}, {}, ["liveactivity"]).session);
    await sync.send("a", "look", [{ id: "i1", uri: "file:///p.jpg", data: "D", mediaType: "image/jpeg", width: 1, height: 1 }]);
    expect(told).toEqual([]);
  });

  it("says what card it shows only to a Mac that keeps them, and clears it with no card", async () => {
    const { sync } = rig();
    const old = fakeSession(7);
    sync.onSession(old.session);
    await sync.liveActivity({ card: { slot: "a", token: "ab".repeat(32), project: "p", since: 1 } });
    expect(old.asked.filter((r) => r.op === "live_activity")).toEqual([]);
    const keeps = fakeSession(7, {}, {}, ["liveactivity"]);
    sync.onSession(keeps.session);
    await sync.liveActivity({ card: { slot: "a", token: "ab".repeat(32), project: "p", since: 1 } });
    await sync.liveActivity({ card: null });
    expect(keeps.asked.filter((r) => r.op === "live_activity")).toEqual([{ op: "live_activity", card: { slot: "a", token: "ab".repeat(32), project: "p", since: 1 } }, { op: "live_activity" }]);
  });

  it("says when a connection came up", () => {
    const { sync } = rig();
    let up = 0;
    sync.onConnected = () => void up++;
    sync.onSession(fakeSession(7).session);
    sync.onSession(fakeSession(7).session);
    expect(up).toBe(2);
  });

  it("refreshes what waits on you when the chat list moves on, and after answering", async () => {
    const { sync, frame } = rig();
    const waiting = [{ slot: "a", chat_title: null, request_id: "p1", tool_name: "Bash", input: {}, at: 1 }];
    const s = fakeSession(7, { list_waiting: waiting });
    sync.onSession(s.session);
    await settle();
    frame();
    expect(sync.getState().waiting).toEqual(waiting);
    const before = s.asked.filter((r) => r.op === "list_waiting").length;
    sync.onPushed({ type: "chats", chats: [{ slot: "a", title: null, project: null, status: "needs_you", last_seq: 1, active_at: 1, permissions: null, preset: null, project_color: null, workflow: null }] });
    await sync.answer("a", "p1", true, { "Which?": "Dark" });
    await settle();
    expect(s.asked).toContainEqual({ op: "answer", slot: "a", request_id: "p1", allow: true, message: null, answers: { "Which?": "Dark" } });
    expect(s.asked.filter((r) => r.op === "list_waiting").length).toBe(before + 2);
  });

  it("knows what waits on you once the Mac has answered, and still when it couldn't answer (not waiting for ever)", async () => {
    const answered = rig();
    answered.sync.onSession(fakeSession(7, { list_waiting: [] }).session);
    await settle();
    answered.frame();
    expect(answered.sync.getState().waitingLoaded).toBe(true);

    const failed = rig();
    failed.sync.onSession(fakeSession(7, {}, { list_waiting: "The Mac is busy." }).session);
    await settle();
    failed.frame();
    expect(failed.sync.getState().waitingLoaded).toBe(true);
    expect(failed.sync.getState().waiting).toEqual([]);
  });

  it("does not claim to know it while there is no connection to ask", async () => {
    const { sync, frame } = rig();
    await sync.refreshWaiting();
    frame();
    expect(sync.getState().waitingLoaded).toBe(false);
  });

  it("keeps what a question was answered with, once the Mac has taken it, joined for a multi-select", async () => {
    const { sync, frame } = rig();
    const s = fakeSession(7);
    sync.onSession(s.session);
    await settle();
    sync.onPushed({ type: "event", slot: "a", seq: 1, event: { kind: "permission_requested", request_id: "q1", tool_name: "AskUserQuestion", input: {} } });
    frame();
    await sync.answer("a", "q1", true, { "Which channel?": "Stable", "Which tests?": "Unit, Integration" });
    frame();
    expect(sync.getState().views.a.items[0]).toMatchObject({ kind: "prompt", answer: "Stable, Unit, Integration" });
  });

  it("doesn't keep an answer the Mac refused as something answered with", async () => {
    const { sync, frame } = rig();
    const s = fakeSession(7, {}, { answer: "That was answered already." });
    sync.onSession(s.session);
    await settle();
    sync.onPushed({ type: "event", slot: "a", seq: 1, event: { kind: "permission_requested", request_id: "q1", tool_name: "AskUserQuestion", input: {} } });
    frame();
    await expect(sync.answer("a", "q1", true, { "Which?": "Dark" })).rejects.toThrow("answered already");
    frame();
    expect(sync.getState().views.a.items[0]).not.toHaveProperty("answer");
  });

  it("doesn't call a declined question answered with anything", async () => {
    const { sync, frame } = rig();
    sync.onSession(fakeSession(7).session);
    await settle();
    sync.onPushed({ type: "event", slot: "a", seq: 1, event: { kind: "permission_requested", request_id: "q1", tool_name: "AskUserQuestion", input: {} } });
    frame();
    await sync.answer("a", "q1", false, { "Which?": "Dark" });
    frame();
    expect(sync.getState().views.a.items[0]).not.toHaveProperty("answer");
  });

  describe("what Claude suggests", () => {
    const suggestions = { items: [{ id: "s1", title: "Write the notes", why: "It is cut.", message: "Write the release notes.", target: { kind: "continue", slot: "a" } }], generated_at: 1 };
    const connected = async (t: { now: number }, answers = {}, fail = {}) => {
      const sync = new Sync({ schedule: (fn) => fn(), now: () => t.now });
      const s = fakeSession(7, answers, fail);
      sync.onSession(s.session);
      await settle();
      return { sync, asked: () => s.asked.filter((r) => r.op === "suggest") };
    };

    it("is asked of the Mac once and kept for a few minutes, and a refresh asks again", async () => {
      const t = { now: 1_000 };
      const { sync, asked } = await connected(t, { suggest: suggestions });
      expect(await sync.suggest()).toEqual(suggestions);
      await sync.suggest();
      expect(asked()).toEqual([{ op: "suggest", refresh: false }]);
      t.now += SUGGESTIONS_KEPT_MS - 1;
      await sync.suggest();
      expect(asked()).toHaveLength(1);
      t.now += 1;
      await sync.suggest();
      expect(asked()).toHaveLength(2);
      await sync.suggest(true);
      expect(asked()[2]).toEqual({ op: "suggest", refresh: true });
    });

    it("says why when the Mac couldn't make them, and doesn't keep that", async () => {
      const t = { now: 1_000 };
      const { sync, asked } = await connected(t, {}, { suggest: "Claude didn't answer in time." });
      await expect(sync.suggest()).rejects.toThrow("Claude didn't answer in time.");
      await expect(sync.suggest()).rejects.toThrow("Claude didn't answer in time.");
      expect(asked()).toHaveLength(2);
    });

    it("doesn't take or keep an answer that isn't a list of suggestions", async () => {
      const t = { now: 1_000 };
      for (const bad of [null, {}, { items: "none" }, "text"]) {
        const { sync, asked } = await connected(t, { suggest: bad });
        await expect(sync.suggest()).rejects.toThrow("didn't come through");
        await expect(sync.suggest()).rejects.toThrow("didn't come through");
        expect(asked()).toHaveLength(2);
      }
    });

    it("can't be asked while not connected", async () => {
      const sync = new Sync({ schedule: (fn) => fn() });
      await expect(sync.suggest()).rejects.toThrow("Not connected");
    });
  });

  it("loads earlier turns when there are some, and says so when not connected", async () => {
    const { sync, frame } = rig();
    await expect(sync.wake("a")).rejects.toThrow("Not connected");
    const s = fakeSession(7, { earlier: { events: [{ kind: "user_text", text: "first", at: 1, sent_by: null }], hidden: 0 } });
    sync.onSession(s.session);
    sync.onPushed({ type: "reset", slot: "a", seq: 3, page: 0, done: true, hidden: 2, events: [] });
    frame();
    await sync.loadEarlier("a");
    frame();
    expect(s.asked).toContainEqual({ op: "earlier", slot: "a", hidden: 2 });
    expect(sync.getState().views.a.items[0]).toMatchObject({ text: "first" });
    expect(sync.getState().views.a.hidden).toBe(0);
  });
});

describe("what a phone may choose for a chat", () => {
  it("asks a Mac that has Controls, and checks and keeps only what it makes sense of", async () => {
    const { sync } = rig();
    const { session, asked } = fakeSession(1, { controls: { allow_auto: true, presets: [{ id: "a", name: "A", summary: "x" }, { id: 5, name: "bad" }, { id: "b", name: "B" }] } }, {}, ["controls"]);
    sync.onSession(session);
    expect(sync.hasControls).toBe(true);
    // (A Mac that says nothing of providers is only Claude Code: none.)
    expect(await sync.controls()).toEqual({ allow_auto: true, presets: [{ id: "a", name: "A", summary: "x" }, { id: "b", name: "B", summary: "" }], providers: [] });
    expect(asked).toContainEqual({ op: "controls" });
  });

  it("keeps the providers a Mac lists that are well formed, and nothing else", async () => {
    const { sync } = rig();
    const listed = [
      { id: "claude", name: "Claude", auto: true, presets: true },
      { id: "gateway:ollama", name: "Ollama", auto: false, presets: false },
      { id: "", name: "No id", auto: true, presets: true },
      { id: "x", name: "", auto: true, presets: true },
      { id: 7, name: "Number", auto: true, presets: true },
      null,
      { id: "odd", name: "Odd", auto: "yes", presets: 1 },
    ];
    sync.onSession(fakeSession(1, { controls: { allow_auto: false, presets: [], providers: listed } }, {}, ["controls"]).session);
    // What isn't exactly true counts as not having it: a phone never offers more than the Mac said.
    expect((await sync.controls())?.providers).toEqual([
      { id: "claude", name: "Claude", auto: true, presets: true },
      { id: "gateway:ollama", name: "Ollama", auto: false, presets: false },
      { id: "odd", name: "Odd", auto: false, presets: false },
    ]);
  });

  it("reads a providers field that isn't a list as none, without refusing the rest", async () => {
    const { sync } = rig();
    sync.onSession(fakeSession(1, { controls: { allow_auto: true, presets: [], providers: "claude" } }, {}, ["controls"]).session);
    expect(await sync.controls()).toEqual({ allow_auto: true, presets: [], providers: [] });
  });

  it("never asks a Mac that can't say: it would end the connection at a request it doesn't know", async () => {
    const { sync } = rig();
    const { session, asked } = fakeSession(1);
    sync.onSession(session);
    expect(sync.hasControls).toBe(false);
    expect(await sync.controls()).toBeNull();
    expect(asked.some((r) => r.op === "controls")).toBe(false);
  });

  it("refuses an answer that isn't what it asked for", async () => {
    const { sync } = rig();
    sync.onSession(fakeSession(1, { controls: { allow_auto: "yes", presets: [] } }, {}, ["controls"]).session);
    await expect(sync.controls()).rejects.toThrow("didn't come through");
  });

  it("sends the mode or preset it is asked to switch to, and a new chat's choice", async () => {
    const { sync } = rig();
    const { session, asked } = fakeSession(1, { new_chat: { slot: "s9" } }, {}, ["controls"]);
    sync.onSession(session);
    await sync.setPermissions("a", "auto");
    await sync.setPreset("a", "max");
    await sync.newChat("/p", "hi", { permissions: "auto", preset: "max" });
    await sync.newChat("/p", "hi");
    await sync.newChat("/p", "hi", { permissions: "ask", provider: "gateway:ollama" });
    expect(asked.filter((r) => r.op !== "list_waiting")).toEqual([
      { op: "set_permissions", slot: "a", permissions: "auto" },
      { op: "set_preset", slot: "a", preset: "max" },
      { op: "new_chat", project: "/p", text: "hi", permissions: "auto", preset: "max", workflow: null },
      // No provider chosen: the field isn't there at all, so a Mac that doesn't know it is never sent it.
      { op: "new_chat", project: "/p", text: "hi", permissions: null, preset: null, workflow: null },
      { op: "new_chat", project: "/p", text: "hi", permissions: "ask", preset: null, workflow: null, provider: "gateway:ollama" },
    ]);
    expect("provider" in (asked.filter((r) => r.op === "new_chat")[1] as object)).toBe(false);
  });
});
