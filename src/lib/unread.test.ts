import { describe, expect, it } from "vitest";
import { initialState, type State } from "../store";
import { fromKept, markRead, markUnread, toKeep, unreadBySlot } from "./unread";

const chat = (sessionId: string | null): State => ({ ...initialState, sessionId });

describe("unread chats", () => {
  it("are kept by session, so a later launch's slots find them again", () => {
    const before = { s1: chat("sess-a"), s2: chat(null) };
    let unread = markUnread({}, "s1", before.s1, 10);
    unread = markUnread(unread, "s2", before.s2, 20);
    expect(unreadBySlot(unread, before)).toEqual({ s1: 10, s2: 20 });
    // The next launch: the session is back under another slot, and the chat with no session is gone.
    const after = { s7: chat("sess-a"), s1: chat("sess-b") };
    expect(unreadBySlot(fromKept(JSON.parse(JSON.stringify(toKeep(unread)))), after)).toEqual({ s7: 10 });
  });

  it("go read by slot, and reading a read chat changes nothing", () => {
    const slots = { s1: chat("sess-a") };
    const unread = markUnread({}, "s1", slots.s1, 10);
    expect(markRead(unread, "s1", slots.s1)).toEqual({});
    expect(markRead({}, "s1", slots.s1)).toEqual({});
  });

  it("keep only the newest two hundred, and read back nothing that isn't a session's time", () => {
    const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`sess-${i}`, i]));
    const kept = toKeep(many);
    expect(Object.keys(kept)).toHaveLength(200);
    expect(kept["sess-249"]).toBe(249);
    expect(kept["sess-0"]).toBeUndefined();
    expect(fromKept({ a: 1, "slot:s1": 2, b: "3", c: null })).toEqual({ a: 1 });
    expect(fromKept([1, 2])).toEqual({});
    expect(fromKept("x")).toEqual({});
  });
});
