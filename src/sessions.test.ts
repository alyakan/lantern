import { describe, expect, it } from "vitest";
import { initialState, type State } from "./store";
import { chatsReducer, chatTitle, initialChats, isBusy, queuesToSend, type Chats } from "./sessions";

const ready: State = { ...initialState, status: "idle", claudePath: "/bin/claude", mode: "auto", folder: "/p", contextWindow: 200_000 };

describe("chatsReducer", () => {
  it("routes actions and events to their own chat, even in the background", () => {
    let c: Chats = initialChats(ready);
    c = chatsReducer(c, { type: "add", slot: "s2" });
    c = chatsReducer(c, { type: "activate", slot: "s2" });
    c = chatsReducer(c, { type: "in", slot: "s1", action: { type: "user_sent", text: "keep going" } });
    c = chatsReducer(c, { type: "in", slot: "s1", action: { type: "ui_event", event: { kind: "assistant_text", parent: null, block_id: "m:0", text: "on it" } } });
    expect(c.active).toBe("s2");
    expect(c.slots.s1.items.map((i) => i.type)).toEqual(["user", "assistant"]);
    expect(c.slots.s1.status).toBe("running");
    expect(c.slots.s2.items).toEqual([]);
  });

  it("gives a new chat the app-wide settings but nothing of the conversation", () => {
    let c = chatsReducer(initialChats({ ...ready, items: [{ type: "user", id: "u1", text: "hi" }], queued: ["x"] }), { type: "add", slot: "s2" });
    expect(c.slots.s2).toMatchObject({ claudePath: "/bin/claude", mode: "auto", contextWindow: 200_000, status: "no_folder", items: [], queued: [], folder: null });
    // A result for a chat that has been closed is dropped.
    c = chatsReducer(c, { type: "in", slot: "gone", action: { type: "session_ready" } });
    expect(Object.keys(c.slots)).toEqual(["s1", "s2"]);
  });

  it("never removes the chat on screen", () => {
    let c = chatsReducer(initialChats(ready), { type: "add", slot: "s2" });
    expect(chatsReducer(c, { type: "remove", slot: "s1" })).toBe(c);
    c = chatsReducer(chatsReducer(c, { type: "activate", slot: "s2" }), { type: "remove", slot: "s1" });
    expect(Object.keys(c.slots)).toEqual(["s2"]);
    expect(chatsReducer(c, { type: "activate", slot: "nope" }).active).toBe("s2");
  });
});

describe("queuesToSend", () => {
  it("sends a chat's queue, joined, when its turn ends normally, in the background too", () => {
    const slots = { s1: { ...ready, queued: ["add tests", "bump version"] }, s2: { ...ready, queued: ["x"] }, s3: { ...ready, queued: [] } };
    expect(queuesToSend({ s1: "running", s2: "idle", s3: "running" }, slots)).toEqual([{ slot: "s1", text: "add tests\n\nbump version" }]);
  });

  it("keeps the queue when claude ended unexpectedly or restarted", () => {
    expect(queuesToSend({ s1: "ended" }, { s1: { ...ready, queued: ["next"] } })).toEqual([]);
    expect(queuesToSend({ s1: "starting" }, { s1: { ...ready, queued: ["next"] } })).toEqual([]);
  });
});

describe("isBusy / chatTitle", () => {
  it("counts running, queued and waiting-for-permission chats as busy", () => {
    expect(isBusy(ready)).toBe(false);
    expect(isBusy({ ...ready, status: "running" })).toBe(true);
    expect(isBusy({ ...ready, queued: ["next"] })).toBe(true);
    expect(isBusy({ ...ready, items: [{ type: "permission", id: "p", toolName: "Bash", input: {}, decision: null }] })).toBe(true);
    expect(isBusy({ ...ready, items: [{ type: "permission", id: "p", toolName: "Bash", input: {}, decision: "allowed" }] })).toBe(false);
  });

  it("names a chat by its first prompt", () => {
    expect(chatTitle(ready)).toBe("New session");
    expect(chatTitle({ ...ready, items: [{ type: "user", id: "u1", text: "Fix the login\nredirect" }] })).toBe("Fix the login");
    // Once a title is made for its session, that's the name.
    const titled = { ...ready, sessionId: "abc", items: [{ type: "user" as const, id: "u1", text: "Fix the login redirect after the OAuth callback fails" }] };
    expect(chatTitle(titled, { abc: "Fix OAuth login redirect" })).toBe("Fix OAuth login redirect");
    expect(chatTitle(titled, { other: "Something else" })).toBe("Fix the login redirect after the OAuth callback fails");
  });
});
