import { atRoot, decision, home, navigate, shownSlot, type Nav } from "./nav";

describe("navigation", () => {
  it("opens a chat over Home, then a decision over the chat, and backs out one at a time", () => {
    let s: Nav = home;
    s = navigate(s, { type: "open_chat", slot: "a" });
    s = navigate(s, { type: "review", slot: "a", requestId: "p1" });
    expect(s.map((r) => r.name)).toEqual(["home", "chat", "decide"]);
    s = navigate(s, { type: "back" });
    expect(s.map((r) => r.name)).toEqual(["home", "chat"]);
    s = navigate(s, { type: "back" });
    expect(s).toEqual(home);
    expect(atRoot(s)).toBe(true);
  });

  it("doesn't pile up the same screen when it is opened twice, and Home has no back", () => {
    const once = navigate(home, { type: "open_chat", slot: "a" });
    expect(navigate(once, { type: "open_chat", slot: "a" })).toBe(once);
    expect(navigate(home, { type: "back" })).toBe(home);
    expect(navigate(once, { type: "open_chat", slot: "b" })).toHaveLength(3);
  });

  it("a tapped notification lands in its chat with Home beneath, whatever was open", () => {
    const deep = navigate(navigate(home, { type: "open_chat", slot: "x" }), { type: "review", slot: "x", requestId: "q" });
    expect(navigate(deep, { type: "jump_to_chat", slot: "release" })).toEqual([{ name: "home" }, { name: "chat", slot: "release" }]);
    expect(navigate(deep, { type: "home" })).toEqual(home);
  });
});

describe("on a tablet", () => {
  it("shows the last chat the stack has been to, a decision's own included, and none from Home", () => {
    expect(shownSlot(home)).toBeNull();
    const chat = navigate(home, { type: "open_chat", slot: "a" });
    expect(shownSlot(chat)).toBe("a");
    expect(shownSlot(navigate(chat, { type: "review", slot: "a", requestId: "p" }))).toBe("a");
    // A decision opened from Home (a phone's) has no chat beneath it, and still says whose it is.
    expect(shownSlot(navigate(home, { type: "review", slot: "b", requestId: "p" }))).toBe("b");
  });

  it("opens a decision over its own chat, so closing it lands there", () => {
    const open = navigate(navigate(home, { type: "open_chat", slot: "a" }), { type: "jump_to_review", slot: "b", requestId: "p" });
    expect(open).toEqual([{ name: "home" }, { name: "chat", slot: "b" }, { name: "decide", slot: "b", requestId: "p" }]);
    expect(decision(open)).toEqual({ name: "decide", slot: "b", requestId: "p" });
    const closed = navigate(open, { type: "back" });
    expect(shownSlot(closed)).toBe("b");
    expect(decision(closed)).toBeNull();
  });

  it("keeps its place when the window changes shape: the stack is the same one", () => {
    const stack = navigate(home, { type: "jump_to_chat", slot: "a" });
    expect(shownSlot(stack)).toBe("a");
    expect(atRoot(stack)).toBe(false);
  });
});
