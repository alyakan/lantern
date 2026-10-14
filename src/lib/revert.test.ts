import { describe, expect, it } from "vitest";
import type { RevertOutcome } from "../api";
import type { ChatItem } from "../store";
import { latestTurnOf, revertFor, revertNote, revertSummary, sinceLabel, undoOf, undoSummary, withRevertNote, type RevertNote } from "./revert";

const outcome = (path: string, status: RevertOutcome["status"], extra: Partial<RevertOutcome> = {}): RevertOutcome => ({
  path,
  status,
  before: null,
  after: null,
  reason: null,
  ...extra,
});

const user = (text: string, turn?: number, auto = false): ChatItem => ({ type: "user", id: `u-${text}`, text, turn, auto });

describe("undoOf", () => {
  it("takes back what changed, each to the text it had before, and nothing that was only refused", () => {
    const undo = undoOf([
      outcome("a.ts", "reverted", { before: "v1", after: "v0" }),
      outcome("new.ts", "trashed", { before: "fresh", after: null }),
      outcome("b.ts", "conflict"),
      outcome("big.log", "not_revertible", { reason: "too large" }),
    ]);
    expect(undo).toEqual([
      { path: "a.ts", target: "v1", expected: "v0" },
      { path: "new.ts", target: "fresh", expected: null },
    ]);
  });
});

describe("revertSummary", () => {
  it("says what was reverted, trashed, left alone and refused", () => {
    expect(revertSummary([outcome("a", "reverted"), outcome("b", "reverted")])).toBe("Reverted 2 files.");
    expect(revertSummary([outcome("a", "reverted"), outcome("n", "trashed")])).toBe("Reverted 1 file; 1 created file was moved to the Trash.");
    expect(revertSummary([outcome("n", "trashed"), outcome("m", "trashed")])).toBe("2 created files were moved to the Trash.");
    expect(revertSummary([outcome("a", "conflict")])).toBe("1 file changed since you saw it, so it was left as it is.");
    expect(revertSummary([outcome("a", "conflict"), outcome("b", "conflict")])).toBe("2 files changed since you saw them, so they were left as they are.");
    expect(revertSummary([outcome("x", "not_revertible", { reason: "It's binary." })])).toBe("1 file couldn't be reverted: It's binary.");
    expect(revertSummary([])).toBe("Nothing was changed.");
  });
});

describe("undoSummary", () => {
  it("is plain when everything went back, and says what stayed when something changed since", () => {
    expect(undoSummary([outcome("a", "reverted")])).toBe("Undone.");
    expect(undoSummary([outcome("a", "reverted"), outcome("b", "conflict")])).toBe("Undone, except one file that changed since the revert: it was left as it is.");
  });
});

describe("sinceLabel and latestTurnOf", () => {
  const items: ChatItem[] = [user("fix the login", 0), { type: "assistant", id: "a", text: "ok" }, user("now the tests", 1), user("background reply", undefined, true)];

  it("names the message that began the range, or the chat", () => {
    expect(sinceLabel(items, "turn", 0)).toBe('your message "fix the login"');
    expect(sinceLabel(items, "turn", null)).toBe('your message "now the tests"');
    expect(sinceLabel(items, "session", null)).toBe("this chat began");
    expect(sinceLabel(items, "turn", 9)).toBe("that turn");
  });

  it("shortens a long message and squeezes its whitespace", () => {
    const long = user(`first line\n\n${"word ".repeat(30)}`, 2);
    const label = sinceLabel([long], "turn", 2);
    expect(label.startsWith('your message "first line word word')).toBe(true);
    expect(label.endsWith('…"')).toBe(true);
    expect(label).not.toContain("\n");
  });

  it("finds the latest numbered turn, or none", () => {
    expect(latestTurnOf(items)).toBe(1);
    expect(latestTurnOf([{ type: "assistant", id: "a", text: "hi" }])).toBeNull();
  });
});

describe("revertNote", () => {
  const notes: RevertNote[] = [
    { path: "src/a.ts", trashed: false, since: 'your message "fix the login"', revert: 1 },
    { path: "src/new.ts", trashed: true, since: 'your message "fix the login"', revert: 1 },
  ];

  it("names each file, what happened to it, and that it may not hold what Claude last wrote", () => {
    expect(revertNote(notes)).toBe(
      [
        "[Lantern note: since your last message the user reverted these files, so they may not hold what you last wrote. Read them before relying on them.]",
        '- src/a.ts: put back to how it was before your message "fix the login".',
        '- src/new.ts: moved to the Trash (it didn\'t exist before your message "fix the login").',
      ].join("\n"),
    );
    expect(revertNote([])).toBeNull();
  });

  it("goes in front of the message, and a slash command goes to Claude as it is", () => {
    expect(withRevertNote("why did it break?", notes)).toMatch(/^\[Lantern note: .*\n\nwhy did it break\?$/s);
    expect(withRevertNote("/compact", notes)).toBe("/compact");
    expect(withRevertNote("hi", [])).toBe("hi");
  });
});

describe("revertFor", () => {
  it("is the whole chat for Session, the last turn for Last turn, and a step's range for a step", () => {
    expect(revertFor("session", undefined)).toEqual({ scope: "session", turn: null, toTurn: null });
    expect(revertFor("session", { from: 2, to: 3 })).toEqual({ scope: "session", turn: null, toTurn: null });
    expect(revertFor("turn", undefined)).toEqual({ scope: "turn", turn: null, toTurn: null });
    expect(revertFor("turn", { from: 2, to: 3 })).toEqual({ scope: "turn", turn: 2, toTurn: 3 });
  });

  it("is unknown for a step whose turns aren't known, and absent for git, PR and branch views", () => {
    expect(revertFor("turn", null)).toBe("unknown");
    expect(revertFor("git", undefined)).toBeNull();
    expect(revertFor("pr", undefined)).toBeNull();
    expect(revertFor("branch", undefined)).toBeNull();
  });
});
