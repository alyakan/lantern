import type { Request } from "../protocol/generated/Request";
import type { Pushed, Session } from "../net/session";
import { Sync } from "./sync";

/** A session that records what it was asked and answers from a table. */
function fakeSession(epoch: number, answers: Partial<Record<Request["op"], unknown>> = {}, fail: Partial<Record<Request["op"], string>> = {}) {
  const asked: Request[] = [];
  const session = {
    welcome: { type: "welcome", protocol: 1, app_version: "t", mac_name: "Mac", epoch },
    ask: async (r: Request) => {
      asked.push(r);
      if (fail[r.op]) throw new Error(fail[r.op]);
      return answers[r.op] ?? null;
    },
  } as unknown as Session;
  return { session, asked };
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

  it("refreshes what waits on you when the chat list moves on, and after answering", async () => {
    const { sync, frame } = rig();
    const waiting = [{ slot: "a", chat_title: null, request_id: "p1", tool_name: "Bash", input: {}, at: 1 }];
    const s = fakeSession(7, { list_waiting: waiting });
    sync.onSession(s.session);
    await settle();
    frame();
    expect(sync.getState().waiting).toEqual(waiting);
    const before = s.asked.filter((r) => r.op === "list_waiting").length;
    sync.onPushed({ type: "chats", chats: [{ slot: "a", title: null, project: null, status: "needs_you", last_seq: 1, active_at: 1 }] });
    await sync.answer("a", "p1", true, { "Which?": "Dark" });
    await settle();
    expect(s.asked).toContainEqual({ op: "answer", slot: "a", request_id: "p1", allow: true, message: null, answers: { "Which?": "Dark" } });
    expect(s.asked.filter((r) => r.op === "list_waiting").length).toBe(before + 2);
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
