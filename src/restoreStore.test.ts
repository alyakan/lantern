import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "./store";
import { restoreNoteId, withRevertNote } from "./lib/revert";

const idle: State = { ...initialState, status: "idle", folder: "/p", claudePath: "/c" };
const files = [
  { path: "/p/a.ts", trashed: false },
  { path: "/p/new.ts", trashed: true },
];

describe("a restore in the chat's state", () => {
  it("keeps what Undo needs, and the notes Claude gets with the next message", () => {
    const s = reducer(idle, { type: "restore_done", id: 4, since: 'your message "fix login"', summary: "2 files are back.", files });
    expect(s.restoreUndo).toEqual({ id: 4, summary: "2 files are back." });
    expect(s.revertNotes).toEqual(files.map((f) => ({ ...f, since: 'your message "fix login"', revert: restoreNoteId(4) })));
    expect(withRevertNote("go on", s.revertNotes)).toContain('- /p/new.ts: moved to the Trash (it didn\'t exist before your message "fix login").');
    expect(withRevertNote("go on", s.revertNotes)).toContain('- /p/a.ts: put back to how it was before your message "fix login".');
  });

  it("a restore that can't be undone is said in the banner instead", () => {
    const s = reducer(idle, { type: "restore_done", id: null, since: "that turn", summary: "1 file is back.", files });
    expect(s.restoreUndo).toBeNull();
    expect(s.banner).toEqual({ kind: "info", text: "1 file is back.", action: null });
    expect(s.revertNotes.every((n) => n.revert === 0)).toBe(true);
  });

  it("Undo takes back the bar and the notes, and the next message takes back the bar", () => {
    const done = reducer(idle, { type: "restore_done", id: 4, since: "that turn", summary: "back.", files });
    const undone = reducer(done, { type: "restore_undone", id: 4, text: "The restore is undone." });
    expect(undone.restoreUndo).toBeNull();
    expect(undone.revertNotes).toEqual([]);
    expect(undone.banner).toEqual({ kind: "info", text: "The restore is undone.", action: null });
    expect(reducer(done, { type: "user_sent", text: "next" }).restoreUndo).toBeNull();
    // An undo for an older restore leaves the newer one's bar.
    const newer = reducer(done, { type: "restore_done", id: 5, since: "that turn", summary: "again.", files });
    expect(reducer(newer, { type: "restore_undone", id: 4, text: "x" }).restoreUndo).toEqual({ id: 5, summary: "again." });
  });
});
