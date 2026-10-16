import { describe, expect, it } from "vitest";
import { PROJECT_NOTES_MAX, notedFolders, notesOf, withNotes } from "./projectNotes";

describe("project notes", () => {
  it("are read by folder, and empty for a project without", () => {
    expect(notesOf({ "/a": "x" }, "/a")).toBe("x");
    expect(notesOf({ "/a": "x" }, "/b")).toBe("");
    expect(notesOf({ "/a": "x" }, null)).toBe("");
  });

  it("are kept trimmed and cut to the limit, leaving the other projects' alone", () => {
    expect(withNotes({ "/b": "keep" }, "/a", "  use pnpm \n")).toEqual({ "/b": "keep", "/a": "use pnpm" });
    expect(withNotes({}, "/a", "x".repeat(PROJECT_NOTES_MAX + 10))["/a"]).toHaveLength(PROJECT_NOTES_MAX);
  });

  it("are taken away by saving nothing, and the folders that have some are listed", () => {
    expect(withNotes({ "/a": "x", "/b": "y" }, "/a", "  ")).toEqual({ "/b": "y" });
    expect(notedFolders({ "/a": "x", "/b": " " })).toEqual(["/a"]);
  });
});
