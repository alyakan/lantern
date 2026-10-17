import { describe, expect, it } from "vitest";
import type { ChatItem } from "../store";
import { canExplain, flavourName, flavourNote, flavourOf, flavourState, readFlavourNote, savedMode, withFlavourNote } from "./flavour";

const u = (id: string, text: string, extra: Partial<Extract<ChatItem, { type: "user" }>> = {}): ChatItem => ({ type: "user", id, text, ...extra });
const a = (id: string, text: string): ChatItem => ({ type: "assistant", id, text });

describe("savedMode", () => {
  it("maps modes an older Lantern saved onto the three, keeping Step by step's flavour", () => {
    expect(savedMode("ask")).toEqual({ mode: "ask", autoApprove: false, flavour: null, explain: false });
    expect(savedMode("auto")).toEqual({ mode: "auto", autoApprove: false, flavour: null, explain: false });
    // Step by step's Permissions are kept with it; an older save didn't say, which is null.
    expect(savedMode("steps")).toEqual({ mode: "steps", autoApprove: null, flavour: null, explain: false });
    expect(savedMode("steps:auto")).toEqual({ mode: "steps", autoApprove: true, flavour: null, explain: false });
    expect(savedMode("plan")).toEqual({ mode: "ask", autoApprove: false, flavour: null, explain: false });
    expect(savedMode("debug")).toEqual({ mode: "steps", autoApprove: null, flavour: "debug", explain: false });
    // Teach was Learn, which is now Build with Explain as you go.
    expect(savedMode("teach")).toEqual({ mode: "steps", autoApprove: null, flavour: "build", explain: true });
    expect(savedMode("review")).toEqual({ mode: "steps", autoApprove: null, flavour: "review", explain: false });
    expect(savedMode(undefined)).toEqual({ mode: "ask", autoApprove: false, flavour: null, explain: false });
  });
});

describe("the note a picked flavour goes with", () => {
  it("comes off the prompt as you wrote it, and says which flavour; older notes too", () => {
    expect(readFlavourNote(withFlavourNote("debug", "it crashes"))).toEqual({ text: "it crashes", flavour: "debug", explain: false });
    // A saved Teach (or Learn) chat is Build with Explain as you go on.
    expect(readFlavourNote("[Lantern: this chat switched to Step-by-step Teach mode. From here on …, not the format used earlier in this chat.]\n\nNext")).toEqual({ text: "Next", flavour: "build", explain: true });
    expect(readFlavourNote(withFlavourNote("build", "x", { guide: "Build: …" }).replace("switched to Build", "switched to Learn"))).toMatchObject({ text: "x", flavour: "build", explain: true });
    expect(readFlavourNote("[Lantern] something else")).toEqual({ text: "[Lantern] something else", flavour: null, explain: false });
    // A note without a guide ends at its own `]`, even when the message after it quotes a guided note's end mark.
    const later = "see (end of Lantern's note)] above";
    expect(readFlavourNote(withFlavourNote("debug", later))).toEqual({ text: later, flavour: "debug", explain: false });
  });
});

describe("Design", () => {
  it("is Architecture's new name, read from its note (old or new) and from its pages, and a Summary doesn't turn it into a Review", () => {
    expect(readFlavourNote(withFlavourNote("architecture", "map PR 12"))).toEqual({ text: "map PR 12", flavour: "architecture", explain: false });
    expect(flavourNote("architecture")).toMatch(/switched to Design\./);
    // A chat saved before the rename names it Architecture.
    expect(readFlavourNote("[Lantern: this chat switched to Architecture. The user picked it: work in it from here on.]\n\nmap PR 12")).toEqual({ text: "map PR 12", flavour: "architecture", explain: false });
    expect(flavourOf([u("u1", "map PR 12"), a("a1", "# Overview — x\n\n```mermaid\nflowchart LR\nA-->B\n```")])).toBe("architecture");
    const parts = [u("u1", "map it"), a("a1", "# Overview — x"), u("u2", "Next"), a("a2", "# Part 1 of 1 — y"), u("u3", "Next"), a("a3", "# Summary — 1 part")];
    expect(flavourOf(parts)).toBe("architecture");
    // A Summary after files stays a review's.
    expect(flavourOf([u("u1", "review"), a("a1", "# File 1 of 1 — a.ts (+1 −0)"), u("u2", "Next"), a("a2", "# Summary — done")])).toBe("review");
  });
});

describe("flavourOf", () => {
  const suggestion = [u("u1", "Review PR 12"), a("a1", "# Switch to Review — you asked for a review\n\nOne file at a time.")];

  it("is none until a suggestion is started", () => {
    expect(flavourOf([])).toBeNull();
    expect(flavourOf(suggestion)).toBeNull();
    expect(flavourOf([...suggestion, u("u2", "why review?"), a("a2", "Because you asked.")])).toBeNull();
  });

  it("is what you started: by its button, by a yes to it, or another flavour", () => {
    expect(flavourOf([...suggestion, u("u2", "Start Review.")])).toBe("review");
    expect(flavourOf([...suggestion, u("u2", "why review?"), a("a2", "Because you asked."), u("u3", "ok")])).toBe("review");
    expect(flavourOf([...suggestion, u("u2", "Start Design.")])).toBe("architecture");
    expect(flavourOf([...suggestion, u("u2", "Start Architecture.")])).toBe("architecture");
    // Learn is Build with Explain as you go.
    expect(flavourState([...suggestion, u("u2", "Start Learn.")])).toEqual({ flavour: "build", explain: true });
    expect(flavourState([...suggestion, u("u2", "Start Debug, explaining as you go.")])).toEqual({ flavour: "debug", explain: true });
  });

  it("stays when you stay, and a yes later on isn't to an old suggestion", () => {
    const building = [u("u1", "Start Build."), a("a1", "# Frame — x"), u("u2", "it crashes"), a("a2", "# Switch to Debug — a bug"), u("u3", "Stay in Build."), a("a3", "# Plan step 1 — x")];
    expect(flavourOf(building)).toBe("build");
    expect(flavourOf([...building, u("u4", "Next")])).toBe("build");
  });

  it("is the one you picked, which needs no suggestion", () => {
    expect(flavourOf([u("u1", "fix the parser", { switchedTo: "debug" })])).toBe("debug");
    expect(flavourOf([u("u1", "Start Build."), u("u2", "now this", { switchedTo: "review" })])).toBe("review");
  });

  it("starts from an older session's flavour, and falls back on the pages when nothing was started", () => {
    expect(flavourState([u("u1", "Next")], "build", true)).toEqual({ flavour: "build", explain: true });
    expect(flavourOf([u("u1", "look at this"), a("a1", "# File 1 of 2 — a.ts (+1 −0)")])).toBe("review");
    expect(flavourOf([u("u1", "it crashes"), a("a1", "# Evidence 1 — logs")])).toBe("debug");
    expect(flavourOf([u("u1", "add x"), a("a1", "# Plan step 1 — x")])).toBe("build");
  });
});

describe("Explain as you go", () => {
  it("is on for Build and Debug only, and named after the flavour", () => {
    expect([canExplain("build"), canExplain("debug"), canExplain("review"), canExplain("architecture"), canExplain(null)]).toEqual([true, true, false, false, false]);
    expect(flavourName("build", true)).toBe("Build, explaining as you go");
    expect(flavourName("review", true)).toBe("Review");
  });

  it("goes in the note with the option's own instructions, and comes back out of it", () => {
    const note = withFlavourNote("debug", "it crashes", { guide: "Debug: find the cause.", explain: true, explainGuide: "Explain as you go: explain the why." });
    expect(note).toContain("switched to Debug, explaining as you go.");
    expect(note).toContain("Debug: find the cause.");
    expect(note).toContain("How Explain as you go works");
    expect(readFlavourNote(note)).toEqual({ text: "it crashes", flavour: "debug", explain: true });
    // Without the option on, the instructions aren't repeated.
    expect(withFlavourNote("debug", "x", { guide: "Debug: g", explain: false, explainGuide: "E" })).not.toContain("E");
    expect(readFlavourNote(flavourNote("build", { explain: true }))).toMatchObject({ flavour: "build", explain: true });
  });

  it("is what the latest pick or start said, and a pick without it turns it off", () => {
    const on = [u("u1", "teach me", { switchedTo: "build", explained: true })];
    expect(flavourState(on)).toEqual({ flavour: "build", explain: true });
    expect(flavourState([...on, u("u2", "never mind", { switchedTo: "build" })])).toEqual({ flavour: "build", explain: false });
    expect(flavourState([...on, u("u2", "now this", { switchedTo: "review" })])).toEqual({ flavour: "review", explain: false });
  });

  it("is on when Claude suggests it and you say yes", () => {
    const suggestion = [u("u1", "I'm learning Swift"), a("a1", "# Switch to Build, explaining as you go — you want to learn")];
    expect(flavourState(suggestion)).toEqual({ flavour: null, explain: false });
    expect(flavourState([...suggestion, u("u2", "ok")])).toEqual({ flavour: "build", explain: true });
    expect(flavourState([...suggestion, u("u2", "Start Build.")])).toEqual({ flavour: "build", explain: false });
  });
});
