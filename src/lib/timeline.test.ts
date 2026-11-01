import { describe, expect, it } from "vitest";
import { initialState, type ChatItem, type State } from "../store";
import type { Chats } from "../sessions";
import type { InboxItem } from "./inbox";
import { dayOf, timelineEvents } from "./timeline";
import { openProjects } from "./sidebar";

const idle = (over: Partial<State> = {}): State => ({ ...initialState, status: "idle", claudePath: "/bin/claude", folder: "/work/lantern", ...over });
const said = (text: string, at?: number): ChatItem => ({ type: "user", id: `u-${text}`, text, at });
const answer = (text: string): ChatItem => ({ type: "assistant", id: `a-${text}`, text });
const turn = (id: string, durationMs: number | null = 1000, over: { isError?: boolean } = {}): ChatItem => ({ type: "turn", id, isError: false, stopped: false, result: null, durationMs, denied: 0, ...over });
const chats = (slots: Record<string, State>): Chats => ({ active: Object.keys(slots)[0], slots, agents: {} });
const open = (c: Chats, unread: Record<string, number> = {}) => openProjects(c, { titles: {}, drafts: {}, unread, pinned: {} });

describe("the timeline", () => {
  it("has an entry per finished answer, at the time it finished, newest first, with Claude's words and never the post-hook's", () => {
    const c = chats({
      s1: idle({ items: [said("Fix it", 1000), answer("Fixed the **lockfile**."), { type: "hook", id: "h", text: "Update the brain" }, answer("Nothing new to save."), turn("t1", 60_000), said("Ship it", 100_000), answer("Shipped."), turn("t2", 5_000, { isError: true })] }),
      s2: idle({ folder: "/work/site", items: [said("Tidy", 50_000), answer("Tidied."), turn("t3", 1_000)] }),
    });
    expect(timelineEvents(c, open(c), []).map((e) => [e.title, e.where, e.at, e.kind, e.line])).toEqual([
      ["Fix it", "lantern", 105_000, "failed", "Shipped."],
      ["Fix it", "lantern", 61_000, "done", "Fixed the lockfile."],
      ["Tidy", "site", 51_000, "done", "Tidied."],
    ]);
  });

  it("puts what is going on now first: a chat waiting on you, with what it needs, and one working", () => {
    const need = { slot: "s2", needsYou: true, need: "Wants to use Bash", since: 5 } as InboxItem;
    const c = chats({
      s1: idle({ status: "running", activityAt: 9, items: [said("Test", 1), { type: "tool", id: "t", name: "Bash", summary: "npm test", status: "running" } as ChatItem] }),
      s2: idle({ items: [said("Run", 2)] }),
      s3: idle({ items: [said("Old", 3), answer("Done."), turn("t1")] }),
    });
    expect(timelineEvents(c, open(c), [need]).map((e) => [e.slot, e.kind, e.line])).toEqual([
      ["s1", "working", "Bash: npm test"],
      ["s2", "waiting", "Wants to use Bash"],
      ["s3", "done", "Done."],
    ]);
  });

  it("marks a chat's last answer unread while the chat is, and leaves out a turn whose start isn't known", () => {
    const c = chats({ s1: idle({ items: [said("Old"), answer("x"), turn("t0"), said("One", 1), answer("a"), turn("t1"), said("Two", 2), answer("b"), turn("t2")] }) });
    expect(timelineEvents(c, open(c, { s1: 3 }), []).map((e) => [e.line, e.unread])).toEqual([
      ["b", true],
      ["a", false],
    ]);
  });

  it("ends a reopened chat's turn, which has no end, when its post-hook was sent", () => {
    const c = chats({ s1: idle({ items: [said("Fix it", 1_000), answer("Fixed."), { type: "hook", id: "h", text: "Update the brain", at: 90_000 }, answer("Nothing new to save."), said("Next", 200_000), answer("Done.")] }) });
    expect(timelineEvents(c, open(c), []).map((e) => [e.at, e.line])).toEqual([
      [200_000, "Done."],
      [90_000, "Fixed."],
    ]);
  });

  it("puts each entry under Now, Today, Yesterday or its day", () => {
    const now = new Date(2026, 9, 31, 16, 0).getTime();
    const e = (kind: "done" | "working", at: number) => ({ key: "k", slot: "s", team: false, title: "t", folder: "f", where: "w", at, kind, line: "", unread: false });
    expect(dayOf(e("working", 0), now)).toBe("Now");
    expect(dayOf(e("done", new Date(2026, 9, 31, 9).getTime()), now)).toBe("Today");
    expect(dayOf(e("done", new Date(2026, 9, 30, 23).getTime()), now)).toBe("Yesterday");
    expect(dayOf(e("done", new Date(2026, 9, 28, 12).getTime()), now)).not.toMatch(/Today|Yesterday|Now/);
  });
});
