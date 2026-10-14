import { describe, expect, it } from "vitest";
import type { ChatItem } from "../store";
import { guidesByFlavour, pageNote, readPageNote, withPageNote } from "./pageNote";
import { flavourNote, readFlavourNote, withFlavourNote } from "./flavour";
import { pagesOf, pageLabel, parseHeading } from "./steps";

const u = (id: string, text: string): ChatItem => ({ type: "user", id, text });
const a = (id: string, text: string): ChatItem => ({ type: "assistant", id, text });
const guides = guidesByFlavour([{ flavour: "Review", text: "Review: one file per page.", headings: ["# Frame — <the PR's title>", "# File N of M — <path> (+added −removed)", "# Summary — <…>"] }]);

describe("headings the way Claude drifts into writing them", () => {
  it("reads a flavour's name in front, a bold heading, a lettered step and a step 'of' a ticket", () => {
    // All from a real chat, hours in.
    expect(parseHeading("## Review · File 2 of 11\n\n**Lumiform/Testo/TestoReading.swift** (+11 −3)")).toMatchObject({ kind: "file", n: 2, total: 11 });
    expect(parseHeading("## Step 6b of LUM-2614 · Running tests")).toMatchObject({ kind: "step", n: 6, sub: "b", total: null, title: "Running tests" });
    expect(parseHeading("## Step 24 of LUM-2614 · Approved")).toMatchObject({ kind: "step", n: 24, total: null, title: "Approved" });
    expect(parseHeading("**Plan step 1: the support decision type**")).toMatchObject({ kind: "plan", n: 1, title: "the support decision type" });
    expect(parseHeading("**Plan step 22b: Testo device information, parsed**")).toMatchObject({ kind: "plan", n: 22, sub: "b" });
    expect(parseHeading("# Frame — PR #512 · LUM-2614 Testo expected readings")).toMatchObject({ kind: "frame", title: "PR #512 · LUM-2614 Testo expected readings" });
    expect(pageLabel(parseHeading("## Step 6b of LUM-2614 · x"))).toBe("Step 6b");
    expect(pageLabel(parseHeading("# Step 2 of 5 — x"))).toBe("Step 2 of 5");
  });

  it("still isn't fooled by a line that only starts like one", () => {
    expect(parseHeading("**Step 2 is written but not committed, and I haven't compiled it yet.**")).toBeNull();
    expect(parseHeading("## Architecture · Struct for the listening window")).toBeNull();
    expect(parseHeading("Step 2 of 5 — not a heading, just a sentence")).toBeNull();
    expect(parseHeading("**Fixed** the crash")).toBeNull();
  });

  it("keeps lettered steps on pages of their own", () => {
    const pages = pagesOf([u("u1", "go"), a("a1", "## Step 6a of LUM-2614 · One"), u("u2", "Next"), a("a2", "## Step 6b of LUM-2614 · Two")]);
    expect(pages.map((p) => pageLabel(p.heading))).toEqual(["Step 6a", "Step 6b"]);
    // The bold heading line is the page's title, not part of its text.
    const plan = pagesOf([u("u1", "go"), a("a1", "**Plan step 1: the type**\n\nFile: a.swift")])[0];
    expect(plan.turns[0].items.map((it) => (it.type === "assistant" ? it.text : ""))).toEqual(["File: a.swift"]);
  });
});

describe("pageNote", () => {
  it("tells Claude when its last page had a heading Lantern couldn't read, with the flavour's headings", () => {
    const note = pageNote([u("u1", "Next"), a("a1", "## Review · Why the pane shows 54 files\n\n### Cause")], "review", guides)!;
    expect(note).toContain('began "## Review · Why the pane shows 54 files"');
    expect(note).toContain("# File N of M — <path> (+added −removed)");
    expect(note).toContain("If it answered a question, it needs no heading at all.");
  });

  it("says nothing after a page it read, an answer without a heading, or outside a flavour", () => {
    expect(pageNote([u("u1", "Next"), a("a1", "## Review · File 2 of 11\n\nok")], "review", guides)).toBeNull();
    expect(pageNote([u("u1", "why?"), a("a1", "Because the base is main.")], "review", guides)).toBeNull();
    expect(pageNote([u("u1", "Next"), a("a1", "## Something")], null, guides)).toBeNull();
    // A turn whose page came first and a remark after it: the page counts.
    expect(pageNote([u("u1", "Next"), a("a1", "# File 3 of 9 — a.ts (+1 −0)"), a("a2", "**Done for now**")], "review", guides)).toBeNull();
  });

  it("points at the guide when it has no headings to list", () => {
    expect(pageNote([u("u1", "Next"), a("a1", "## Overview of it")], "debug", guides)).toContain("mcp__lantern__steps_guide for Debug's headings");
  });

  it("comes off the message as the user wrote it", () => {
    const note = pageNote([u("u1", "Next"), a("a1", "## Review · Odd [thing]")], "review", guides);
    expect(readPageNote(withPageNote(note, "Next"))).toBe("Next");
    expect(readPageNote("Next")).toBe("Next");
  });
});

describe("the switch note", () => {
  it("carries the flavour's own instructions, brackets and all, and still reads back", () => {
    const guide = 'Architecture: … {"nodes": [{"id": "a"}], "edges": []} …';
    const note = flavourNote("architecture", guide);
    expect(note).toContain("How Architecture works, from Lantern's instructions:");
    expect(note).toContain(guide);
    expect(readFlavourNote(withFlavourNote("architecture", "map it", guide))).toEqual({ text: "map it", flavour: "architecture" });
    // Without a guide (and in older chats), the short note is as it was.
    expect(readFlavourNote(withFlavourNote("review", "go"))).toEqual({ text: "go", flavour: "review" });
  });
});
