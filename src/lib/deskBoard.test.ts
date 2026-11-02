import { describe, expect, it } from "vitest";
import { initialState, type ChatItem, type State } from "../store";
import type { Chats } from "../sessions";
import { deskInbox, deskProjects } from "./deskBoard";
import { openOn, addDesk, moveProject, NO_DESKS } from "./desks";
import { openProjects } from "./sidebar";

const idle = (over: Partial<State> = {}): State => ({ ...initialState, status: "idle", claudePath: "/bin/claude", folder: "/work/lantern", ...over });
const said = (text: string, at?: number): ChatItem => ({ type: "user", id: `u-${text}`, text, at });
const answer = (text: string): ChatItem => ({ type: "assistant", id: `a-${text}`, text });
const turn = (id: string): ChatItem => ({ type: "turn", id, isError: false, stopped: false, result: null, durationMs: 1, denied: 0 });
const chats = (slots: Record<string, State>): Chats => ({ active: Object.keys(slots)[0], slots, agents: {} });
const open = (c: Chats, unread: Record<string, number> = {}) => openProjects(c, { titles: {}, drafts: {}, unread, pinned: {} });

describe("the Desk's inbox", () => {
  it("has a row per chat, the last active first, with Claude's last words, never the post-hook's", () => {
    const c = chats({
      s1: idle({ activityAt: 100, items: [said("Fix the build"), answer("Fixed: the **lockfile** was stale."), { type: "hook", id: "h", text: "Update the brain" }, answer("Nothing new to save."), turn("t1")] }),
      s2: idle({ activityAt: 200, folder: "/work/site", items: [said("Ship it")] }),
    });
    expect(deskInbox(c, open(c)).map((r) => [r.slot, r.where, r.line])).toEqual([
      ["s2", "site", "Ship it"],
      ["s1", "lantern", "Fixed: the lockfile was stale."],
    ]);
  });

  it("says what a working chat is doing, which one waits on you, and which are asleep or unread", () => {
    const c = chats({
      s1: idle({ status: "running", items: [said("Test it"), { type: "tool", id: "t", name: "Bash", summary: "npm test", status: "running" } as ChatItem] }),
      s2: idle({ status: "asleep", items: [said("Old")] }),
      s3: idle({ items: [said("Done?"), answer("Yes."), turn("t3")] }),
    });
    const rows = Object.fromEntries(deskInbox(c, open(c, { s3: 5 })).map((r) => [r.slot, r]));
    expect(rows.s1).toMatchObject({ state: "working", line: "Bash: npm test", unread: false });
    expect(rows.s2).toMatchObject({ state: "asleep" });
    expect(rows.s3).toMatchObject({ state: "done", unread: true, workflow: "Chat" });
  });

  it("lists only the chats on the Desk it is given", () => {
    const c = chats({ s1: idle(), s2: idle({ folder: "/work/site" }) });
    const desks = moveProject(addDesk(NO_DESKS, "Work", "w")!, "/work/site", "w");
    expect(deskInbox(c, openOn(desks, "w", open(c))).map((r) => r.slot)).toEqual(["s2"]);
  });
});

describe("the Desk's projects", () => {
  it("counts each project's chats, what waits on you there and its to-dos, and lists a project given to the Desk with nothing open", () => {
    const c = chats({
      s1: idle({ status: "running", activityAt: 50 }),
      s2: idle({ activityAt: 90 }),
      s3: idle({ folder: "/work/site", activityAt: 10 }),
    });
    const o = open(c);
    const rows = deskProjects(deskInbox(c, o), o, ["/work/nahar"], { "/work/lantern": { open: 3, overdue: 1 } }, { "/work/site": 1 });
    expect(rows.map((r) => [r.label, r.chats, r.working, r.needs, r.at, r.todos])).toEqual([
      ["site", 1, 0, 1, 10, null],
      ["lantern", 2, 1, 0, 90, { open: 3, overdue: 1 }],
      ["nahar", 0, 0, 0, null, null],
    ]);
  });

  it("counts a chat that finished unread as unread, not as needing you", () => {
    const c = chats({ s1: idle({ items: [said("Done?"), answer("Yes."), turn("t1")] }) });
    const o = open(c, { s1: 5 });
    const rows = deskInbox(c, o);
    expect(deskProjects(rows, o, [], {})[0]).toMatchObject({ unread: 1, needs: 0 });
  });
});
