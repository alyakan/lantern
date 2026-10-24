import { chat } from "../test/render";
import { home, navigate } from "../shell/nav";
import { statusMap, toastIsRedundant, toastNotes } from "./toasts";

describe("which chat changes get a toast", () => {
  const before = statusMap([chat({ slot: "a", status: "working" }), chat({ slot: "b", status: "idle" }), chat({ slot: "c", status: "needs_you" })]);

  it("says nothing for the first list it sees", () => {
    expect(toastNotes(null, [chat({ slot: "a", status: "needs_you" })])).toEqual([]);
  });

  it("notes a chat that was working and is now idle as finished", () => {
    expect(toastNotes(before, [chat({ slot: "a", status: "idle" })])).toEqual([{ slot: "a", kind: "done" }]);
  });

  it("notes a chat that now needs you, whatever it was doing", () => {
    expect(toastNotes(before, [chat({ slot: "a", status: "needs_you" }), chat({ slot: "b", status: "needs_you" })])).toEqual([
      { slot: "a", kind: "needs" },
      { slot: "b", kind: "needs" },
    ]);
  });

  it("leaves alone a chat that already needed you, one that is new, and the other ways a chat changes", () => {
    const next = [chat({ slot: "c", status: "needs_you" }), chat({ slot: "n", status: "needs_you" }), chat({ slot: "a", status: "asleep" }), chat({ slot: "b", status: "working" })];
    expect(toastNotes(before, next)).toEqual([]);
  });
});

describe("when a toast would only repeat the screen", () => {
  const atChat = navigate(home, { type: "open_chat", slot: "a" });

  it("is when the chat itself is the one open", () => {
    expect(toastIsRedundant("a", atChat, false, false)).toBe(true);
    expect(toastIsRedundant("a", atChat, true, false)).toBe(true);
  });

  it("is when a phone is at Home, where the chat's row says it", () => {
    expect(toastIsRedundant("b", home, false, false)).toBe(true);
    expect(toastIsRedundant("b", atChat, false, false)).toBe(false);
  });

  it("is on a tablet only while the chats' column is showing", () => {
    expect(toastIsRedundant("b", atChat, true, true)).toBe(true);
    expect(toastIsRedundant("b", atChat, true, false)).toBe(false);
    // A tablet with nothing picked has Home as its stack, but that is no reason to hold back while the column is away.
    expect(toastIsRedundant("b", home, true, false)).toBe(false);
  });
});
