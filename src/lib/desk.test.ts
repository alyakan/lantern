import { describe, expect, it } from "vitest";
import { initialState, type ChatItem, type State } from "../store";
import type { Chats } from "../sessions";
import { clip, deskFeed, deskLive, MAX_CARDS, plain, SAID_CHARS } from "./desk";
import { openProjects } from "./sidebar";

const idle = (over: Partial<State> = {}): State => ({ ...initialState, status: "idle", claudePath: "/bin/claude", folder: "/work/lantern", ...over });
const said = (text: string, at?: number, auto = false): ChatItem => ({ type: "user", id: `u-${text}`, text, at, ...(auto ? { auto } : {}) });
const answer = (text: string, id = text): ChatItem => ({ type: "assistant", id: `a-${id}`, text });
const turn = (id: string, over: { isError?: boolean; stopped?: boolean } = {}): ChatItem => ({ type: "turn", id, isError: false, stopped: false, result: null, durationMs: 1, denied: 0, ...over });
const chats = (slots: Record<string, State>): Chats => ({ active: Object.keys(slots)[0], slots, agents: {} });
const open = (c: Chats) => openProjects(c, { titles: {}, drafts: {}, unread: {}, pinned: {} });
const feed = (c: Chats) => deskFeed(c, open(c));

describe("the Desk's feed", () => {
  it("has a card for each finished answer: which chat, what you said, and the start of Claude's last words", () => {
    const c = chats({ s1: idle({ items: [said("Fix the build", 100), answer("Looking."), answer("Fixed: the **lockfile** was stale."), turn("t1")] }) });
    expect(feed(c)).toEqual([{ key: "s1:t1", slot: "s1", title: "Fix the build", where: "lantern", at: 100, asked: "Fix the build", auto: false, said: "Fixed: the lockfile was stale.", outcome: "done" }]);
  });

  it("leaves out a turn still going, and says when one failed or was stopped", () => {
    const c = chats({ s1: idle({ items: [said("one", 1), answer("x"), turn("t1", { isError: true }), said("two", 2), turn("t2", { stopped: true }), said("three", 3), answer("going")] }) });
    expect(feed(c).map((k) => [k.asked, k.outcome])).toEqual([
      ["one", "failed"],
      ["two", "stopped"],
    ]);
  });

  it("puts every chat's cards in the order they were asked, and says when Claude went on by itself", () => {
    const c = chats({
      s1: idle({ items: [said("first", 10), answer("a"), turn("t1"), said("A background task ended", 30, true), answer("c"), turn("t3")] }),
      s2: idle({ folder: "/work/site", items: [said("second", 20), answer("b"), turn("t2")] }),
    });
    expect(feed(c).map((k) => [k.asked, k.where, k.auto])).toEqual([
      ["first", "lantern", false],
      ["second", "site", false],
      ["A background task ended", "lantern", true],
    ]);
  });

  it("doesn't take what the post-hook's run said as the answer", () => {
    const c = chats({ s1: idle({ items: [said("Ship it", 1), answer("Shipped."), { type: "hook", id: "h", text: "Update the brain" }, turn("t1")] }) });
    expect(feed(c)[0].said).toBe("");
  });

  it("keeps only the newest cards", () => {
    const items = Array.from({ length: MAX_CARDS + 5 }, (_, i) => [said(`m${i}`, i), answer("ok", `${i}`), turn(`t${i}`)]).flat();
    const cards = feed(chats({ s1: idle({ items }) }));
    expect(cards).toHaveLength(MAX_CARDS);
    expect(cards[0].asked).toBe("m5");
  });

  it("cuts a long answer at a word, on one line", () => {
    const long = `${"word ".repeat(100)}end`;
    const card = feed(chats({ s1: idle({ items: [said("q", 1), answer(long), turn("t1")] }) }))[0];
    expect(card.said.length).toBeLessThanOrEqual(SAID_CHARS);
    expect(card.said.endsWith("word…")).toBe(true);
  });
});

describe("the Desk's live line", () => {
  it("lists the chats working and waiting, the waiting first, with what each is doing", () => {
    const running: State = idle({ status: "running", items: [said("Run the tests", 1), { type: "tool", id: "x", name: "Bash", summary: "npm test", status: "running", output: null, edit: null, children: [] }] });
    const waiting: State = idle({ folder: "/work/site", items: [said("Deploy", 2), { type: "permission", id: "p", toolName: "Bash", input: { command: "ls" }, decision: null }] });
    const done: State = idle({ items: [said("Done one", 3), answer("ok"), turn("t")] });
    const c = chats({ s1: running, s2: waiting, s3: done });
    expect(deskLive(c, open(c)).map((l) => [l.slot, l.waiting, l.line])).toEqual([
      ["s2", true, "Needs you"],
      ["s1", false, "Bash: npm test"],
    ]);
  });
});

describe("a card's text", () => {
  it("drops markdown's marks", () => {
    expect(plain("# Done\n\n- **bold** and `code`, a [link](http://x)\n```\nhidden\n```")).toBe("Done\n\nbold and code, a link\n ");
  });

  it("is left whole when it fits", () => {
    expect(clip("  short\n text ", 20)).toBe("short text");
  });
});
