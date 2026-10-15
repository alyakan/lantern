import { describe, expect, it } from "vitest";
import { PHASES, phasesOf } from "./phases";
import { pagesOf } from "./steps";
import type { ChatItem } from "../store";

/** A chat with a page per heading: Claude's message under each prompt. */
const chat = (...headings: (string | null)[]): ChatItem[] =>
  headings.flatMap((h, i): ChatItem[] => [
    { type: "user", id: `u${i}`, text: i === 0 ? "Do it" : "Next", turn: i },
    { type: "assistant", id: `a${i}`, text: h === null ? "Some words" : `# ${h}\n\nBody` },
  ]);
const phaseOf = (flavour: Parameters<typeof phasesOf>[0], ...headings: (string | null)[]) => phasesOf(flavour, pagesOf(chat(...headings)));

describe("the stages of a flavour", () => {
  it("names Build's Frame, Plan, Build and Done", () => {
    expect(PHASES.build.map((p) => p.name)).toEqual(["Frame", "Plan", "Build", "Done"]);
  });

  it("puts each Build page in its stage, with the plan being locked and updated in the stages they happen in", () => {
    expect(phaseOf("build", "Frame — x", "Plan step 1 — a", "Plan step 2 — b", "Plan complete — 2 steps", "Step 1 of 2 — a", "Plan update — c", "Step 2 of 2 — b", "Done — x")).toEqual([0, 1, 1, 1, 2, 2, 2, 3]);
  });

  it("keeps a page with no heading, and a suggestion, in the stage before it", () => {
    expect(phaseOf("build", "Frame — x", null, "Plan step 1 — a", "Switch to Debug — why", null)).toEqual([0, 0, 1, 1, 1]);
  });

  it("names Debug's, Review's and Design's own stages", () => {
    expect(PHASES.debug.map((p) => p.name)).toEqual(["Frame", "Evidence", "Fix", "Done"]);
    expect(PHASES.review.map((p) => p.name)).toEqual(["Frame", "Files", "Summary"]);
    expect(PHASES.architecture.map((p) => p.name)).toEqual(["Frame", "Overview", "Parts", "Summary"]);
    expect(phaseOf("debug", "Frame — x", "Evidence 1 — a", "Evidence 2 — b", "Fix — c", "Done — d")).toEqual([0, 1, 1, 2, 3]);
    expect(phaseOf("review", "Frame — x", "File 1 of 2 — a", "File 2 of 2 — b", "Summary — c")).toEqual([0, 1, 1, 2]);
    expect(phaseOf("architecture", "Frame — x", "Overview — y", "Part 1 of 2 — a", "Part 2 of 2 — b", "Summary — c")).toEqual([0, 1, 2, 2, 3]);
  });
});
