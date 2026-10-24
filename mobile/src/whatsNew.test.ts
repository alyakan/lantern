import { hasNotes, NOTES_UNREADABLE, noteAction, normalize, notesId, type ReleaseNotes } from "./whatsNew";

const notes = (build: number, ...text: string[]): ReleaseNotes => ({ version: "0.1.0", build, notes: text });

describe("the notes a build carries", () => {
  it("keeps a version, a build number and its text, trimmed", () => {
    expect(normalize({ version: "0.1.0", build: 15, notes: ["  A pairing code for another device ", "Chats hold still"] })).toEqual(notes(15, "A pairing code for another device", "Chats hold still"));
  });

  it("makes nothing of a file that isn't notes", () => {
    for (const raw of [null, undefined, "x", 4, [], {}, { build: "15", notes: "x" }, { build: -1, notes: ["x"] }, { build: 1.5, notes: ["x"] }]) {
      expect(hasNotes(normalize(raw))).toBe(false);
    }
  });

  it("leaves out entries that aren't text", () => {
    expect(normalize({ version: "0.1.0", build: 3, notes: ["a", 7, null, "", "   ", "b"] })).toEqual(notes(3, "a", "b"));
  });

  it("has nothing to say for a development run (build 0) or a build with no changes", () => {
    expect(hasNotes(notes(0, "x"))).toBe(false);
    expect(hasNotes(notes(15))).toBe(false);
    expect(hasNotes(notes(15, "x"))).toBe(true);
  });

  it("is remembered by version and build, since a new version starts its builds over", () => {
    expect(notesId(notes(15, "x"))).toBe("0.1.0-15");
    expect(notesId({ ...notes(1, "x"), version: "0.2.0" })).toBe("0.2.0-1");
  });
});

describe("when the notes are shown", () => {
  it("shows a build's notes once the last shown is a different build", () => {
    expect(noteAction(notes(15, "x"), "0.1.0-14", false)).toBe("show");
  });

  it("shows nothing again for a build whose notes were shown", () => {
    expect(noteAction(notes(15, "x"), "0.1.0-15", false)).toBe("skip");
  });

  it("still shows the notes of build 1 of a new version, though build 15 of the old one was the last shown", () => {
    expect(noteAction({ ...notes(1, "x"), version: "0.2.0" }, "0.1.0-15", false)).toBe("show");
  });

  it("shows the first build that has notes to a phone updating from one that kept nothing", () => {
    expect(noteAction(notes(15, "x"), null, false)).toBe("show");
  });

  it("only marks them as shown on a new install, where nothing is new", () => {
    expect(noteAction(notes(15, "x"), null, true)).toBe("mark");
  });

  it("shows nothing when there is nothing to say, or when what was shown can't be read", () => {
    expect(noteAction(notes(0, "x"), null, false)).toBe("skip");
    expect(noteAction(notes(15), "0.1.0-3", false)).toBe("skip");
    expect(noteAction(notes(15, "x"), NOTES_UNREADABLE, false)).toBe("skip");
  });
});
