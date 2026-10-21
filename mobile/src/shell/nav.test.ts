import { atRoot, home, navigate, type Nav } from "./nav";

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
