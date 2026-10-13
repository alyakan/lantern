import { beforeEach, describe, expect, it } from "vitest";
import { newVersionToShow, notesFor, releasePage, rememberNotes, versionsWithNotes, whatsNewBody } from "./whatsNew";

// The release body as release.yml writes it: the notes under "## What's new", then the install line.
const BODY = "## What's new\n\n- Pasting a lot of text shows a placeholder.\n- The question card names the question.\n\nDownload the dmg, open it and drag Lantern to Applications. Requires Claude Code installed and logged in.";

beforeEach(() => localStorage.clear());

describe("whatsNewBody", () => {
  it("keeps the changes and drops the heading and the install line", () => {
    expect(whatsNewBody(BODY)).toBe("- Pasting a lot of text shows a placeholder.\n- The question card names the question.");
  });

  it("is null when a release lists no changes", () => {
    expect(whatsNewBody("## What's new\n\nDownload the dmg, open it and drag Lantern to Applications.")).toBeNull();
    expect(whatsNewBody("  \n\n ")).toBeNull();
  });

  it("reads Windows line endings and keeps paragraphs apart", () => {
    expect(whatsNewBody("## What's new\r\n\r\nFirst paragraph.\r\n\r\nSecond paragraph.")).toBe("First paragraph.\n\nSecond paragraph.");
  });
});

describe("the notes kept for a waiting update", () => {
  it("is found again by its version, as the panel shows it", () => {
    rememberNotes(localStorage, { version: "0.1.16", notes: BODY });
    expect(notesFor(localStorage, "0.1.16")).toBe("- Pasting a lot of text shows a placeholder.\n- The question card names the question.");
    expect(notesFor(localStorage, "0.1.15")).toBeNull();
  });

  it("isn't kept for an update that came without notes", () => {
    rememberNotes(localStorage, { version: "0.1.16" });
    expect(localStorage.getItem("whatsNew.notes")).toBeNull();
  });

  it("keeps only the last few versions", () => {
    for (const v of ["0.1.11", "0.1.12", "0.1.13", "0.1.14", "0.1.15", "0.1.16"]) rememberNotes(localStorage, { version: v, notes: BODY });
    expect(notesFor(localStorage, "0.1.11")).toBeNull();
    expect(notesFor(localStorage, "0.1.16")).not.toBeNull();
  });

  it("treats damaged storage as nothing kept, and mends it on the next save", () => {
    localStorage.setItem("whatsNew.notes", "{not json");
    expect(notesFor(localStorage, "0.1.16")).toBeNull();
    rememberNotes(localStorage, { version: "0.1.16", notes: BODY });
    expect(notesFor(localStorage, "0.1.16")).not.toBeNull();
  });
});

describe("the launch check", () => {
  it("shows nothing on the very first launch, but records the version", () => {
    expect(newVersionToShow(localStorage, "0.1.16")).toBeNull();
    expect(localStorage.getItem("lastSeenVersion")).toBe("0.1.16");
  });

  it("shows the running version once when it's a new one, and not again", () => {
    newVersionToShow(localStorage, "0.1.15");
    expect(newVersionToShow(localStorage, "0.1.16")).toBe("0.1.16");
    expect(newVersionToShow(localStorage, "0.1.16")).toBeNull();
  });
});

describe("where the notes are", () => {
  it("links a version's release page on GitHub", () => {
    expect(releasePage("0.1.16")).toBe("https://github.com/alyakan/lantern/releases/tag/v0.1.16");
  });

  it("lists, once each, the versions among the given ones that have notes", () => {
    rememberNotes(localStorage, { version: "0.1.16", notes: BODY });
    expect(versionsWithNotes(localStorage, ["0.1.15", "0.1.16", undefined, "0.1.16", null])).toEqual(["0.1.16"]);
    expect(versionsWithNotes(localStorage, [null, undefined])).toEqual([]);
  });
});
