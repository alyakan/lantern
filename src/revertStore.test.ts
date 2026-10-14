import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "./store";

const idle: State = { ...initialState, status: "idle", folder: "/p", claudePath: "/c" };
const turnItem = (text: string, turn: number) => ({ type: "user" as const, id: `u${turn}`, text, turn });

const outcomes = [
  { path: "/p/a.ts", status: "reverted" as const, before: "v1", after: "v0", reason: null },
  { path: "/p/new.ts", status: "trashed" as const, before: "fresh", after: null, reason: null },
  { path: "/p/b.ts", status: "conflict" as const, before: null, after: null, reason: "changed" },
];

describe("reverts in the chat's state", () => {
  it("records what Undo takes back, and the note Claude gets, once a revert is done", () => {
    const s = reducer(idle, { type: "revert_done", since: 'your message "fix login"', outcomes });
    expect(s.revertSeq).toBe(1);
    expect(s.revertUndo).toEqual({
      id: 1,
      files: [
        { path: "/p/a.ts", target: "v1", expected: "v0" },
        { path: "/p/new.ts", target: "fresh", expected: null },
      ],
      summary: "Reverted 1 file; 1 created file was moved to the Trash. 1 file changed since you saw it, so it was left as it is.",
    });
    expect(s.revertNotes).toEqual([
      { path: "/p/a.ts", trashed: false, since: 'your message "fix login"', revert: 1 },
      { path: "/p/new.ts", trashed: true, since: 'your message "fix login"', revert: 1 },
    ]);
    expect(s.banner).toBeNull();
  });

  it("a revert that only met conflicts can't be undone, and says so in the banner", () => {
    const s = reducer(idle, { type: "revert_done", since: "this chat began", outcomes: [outcomes[2]] });
    expect(s.revertUndo).toBeNull();
    expect(s.revertNotes).toEqual([]);
    expect(s.banner).toEqual({ kind: "info", text: "1 file changed since you saw it, so it was left as it is.", action: null });
  });

  it("a newer revert replaces the undo, and keeps the older revert's note for Claude", () => {
    const first = reducer(idle, { type: "revert_done", since: "this chat began", outcomes: [outcomes[0]] });
    const second = reducer(first, { type: "revert_done", since: "this chat began", outcomes: [outcomes[1]] });
    expect(second.revertUndo?.id).toBe(2);
    expect(second.revertNotes.map((n) => [n.path, n.revert])).toEqual([
      ["/p/a.ts", 1],
      ["/p/new.ts", 2],
    ]);
  });

  it("Undo takes the revert's note back and says what it did", () => {
    const done = reducer(idle, { type: "revert_done", since: "this chat began", outcomes });
    const undone = reducer(done, {
      type: "revert_undone",
      id: 1,
      outcomes: [
        { path: "/p/a.ts", status: "reverted", before: "v0", after: "v1", reason: null },
        { path: "/p/new.ts", status: "reverted", before: null, after: "fresh", reason: null },
      ],
    });
    expect(undone.revertUndo).toBeNull();
    expect(undone.revertNotes).toEqual([]);
    expect(undone.banner?.text).toBe("Undone.");
  });

  it("an Undo whose file changed since says what was left", () => {
    const done = reducer(idle, { type: "revert_done", since: "this chat began", outcomes: [outcomes[0]] });
    const undone = reducer(done, { type: "revert_undone", id: 1, outcomes: [{ path: "/p/a.ts", status: "conflict", before: null, after: null, reason: "x" }] });
    expect(undone.banner?.text).toBe("Undone, except one file that changed since the revert: it was left as it is.");
  });

  it("the next message takes the note and the Undo; a slash command takes neither", () => {
    const done = reducer(idle, { type: "revert_done", since: "this chat began", outcomes: [outcomes[0]] });
    const slash = reducer(done, { type: "user_sent", text: "/compact" });
    expect(slash.revertNotes).toHaveLength(1);
    expect(slash.revertUndo).toBeNull();
    const sent = reducer(done, { type: "user_sent", text: "why?" });
    expect(sent.revertNotes).toEqual([]);
  });

  it("a notice shows as an info banner", () => {
    expect(reducer(idle, { type: "notice", text: "hi" }).banner).toEqual({ kind: "info", text: "hi", action: null });
  });

  it("a new session forgets the undo and the notes", () => {
    const done = reducer({ ...idle, items: [turnItem("x", 0)] }, { type: "revert_done", since: "this chat began", outcomes: [outcomes[0]] });
    const fresh = reducer(done, { type: "folder_opened", folder: "/q" });
    expect(fresh.revertUndo).toBeNull();
    expect(fresh.revertNotes).toEqual([]);
  });
});
