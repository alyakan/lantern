import { describe, expect, it } from "vitest";
import type { ChatItem } from "../store";
import { flavourOf, readFlavourNote, savedMode, withFlavourNote } from "./flavour";

const u = (id: string, text: string, extra: Partial<Extract<ChatItem, { type: "user" }>> = {}): ChatItem => ({ type: "user", id, text, ...extra });
const a = (id: string, text: string): ChatItem => ({ type: "assistant", id, text });

describe("savedMode", () => {
  it("maps modes an older Lantern saved onto the three, keeping Step by step's flavour", () => {
    expect(savedMode("ask")).toEqual({ mode: "ask", flavour: null });
    expect(savedMode("auto")).toEqual({ mode: "auto", flavour: null });
    expect(savedMode("steps")).toEqual({ mode: "steps", flavour: null });
    expect(savedMode("plan")).toEqual({ mode: "ask", flavour: null });
    expect(savedMode("debug")).toEqual({ mode: "steps", flavour: "debug" });
    expect(savedMode("teach")).toEqual({ mode: "steps", flavour: "learn" });
    expect(savedMode("review")).toEqual({ mode: "steps", flavour: "review" });
    expect(savedMode(undefined)).toEqual({ mode: "ask", flavour: null });
  });
});

describe("the note a picked flavour goes with", () => {
  it("comes off the prompt as you wrote it, and says which flavour; older notes too", () => {
    expect(readFlavourNote(withFlavourNote("debug", "it crashes"))).toEqual({ text: "it crashes", flavour: "debug" });
    expect(readFlavourNote("[Lantern: this chat switched to Step-by-step Teach mode. From here on …, not the format used earlier in this chat.]\n\nNext")).toEqual({ text: "Next", flavour: "learn" });
    expect(readFlavourNote("[Lantern] something else")).toEqual({ text: "[Lantern] something else", flavour: null });
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
    expect(flavourOf([...suggestion, u("u2", "Start Learn.")])).toBe("learn");
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
    expect(flavourOf([u("u1", "Next")], "learn")).toBe("learn");
    expect(flavourOf([u("u1", "look at this"), a("a1", "# File 1 of 2 — a.ts (+1 −0)")])).toBe("review");
    expect(flavourOf([u("u1", "it crashes"), a("a1", "# Evidence 1 — logs")])).toBe("debug");
    expect(flavourOf([u("u1", "add x"), a("a1", "# Plan step 1 — x")])).toBe("build");
  });
});
