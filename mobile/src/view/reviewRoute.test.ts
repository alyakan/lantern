import type { PageKind } from "./pages";
import { parseReviewFile, parseReviewFrame } from "./review";
import { fileNumbers, reviewRoute, type RoutePage } from "./reviewRoute";

const file = (n: number, total: number, path: string, findings = 0, decided = 0): RoutePage => {
  const body = `### What changed\nx\n\n### Findings\n${findings ? Array.from({ length: findings }, (_, i) => `⚠ ${path}:${i + 1} (nit): y`).join("\n") : "None."}\n`;
  return { kind: "file", kicker: `File ${n} of ${total}`, file: parseReviewFile(`${path} (+1 −0)`, body), decided };
};
const other = (kind: PageKind, kicker: string): RoutePage => ({ kind, kicker, file: null, decided: 0 });

const frame = parseReviewFrame("Intro\n\n### Units\n1. src/a.ts (+1 −0) — x\n2. #9 The group (+2 −0) — y\n3. src/c.ts — z\n\n### Risks\nNone.")!;

describe("fileNumbers", () => {
  it("reads a File page's place", () => {
    expect(fileNumbers("File 3 of 20")).toEqual({ n: 3, total: 20 });
    expect(fileNumbers("Step 3 of 20")).toBeNull();
  });
});

describe("a Review's route", () => {
  it("is null for a chat that isn't a Review", () => {
    expect(reviewRoute([other("step", "Step 1 of 3"), other("frame", "Frame")], null)).toBeNull();
    expect(reviewRoute([], null)).toBeNull();
  });

  it("has the Frame, every unit the Frame planned and the Summary, the unreached ones with no page", () => {
    const stops = reviewRoute([other("frame", "Frame"), file(1, 3, "src/a.ts", 2, 1)], frame)!;
    expect(stops.map((s) => [s.key, s.page, s.label])).toEqual([
      ["frame", 0, "Frame"],
      ["unit-1", 1, "a.ts"],
      ["unit-2", null, "#9 The group"],
      ["unit-3", null, "c.ts"],
      ["summary", null, "Summary"],
    ]);
    // Counts only once a unit's page is written; the open ones are those with no verdict yet.
    expect(stops[1]).toMatchObject({ findings: 2, open: 1 });
    expect(stops[2].findings).toBeUndefined();
  });

  it("reads a Frame with no Units from the pages' own File N of M, and a unit with no name as Unit N", () => {
    const stops = reviewRoute([other("frame", "Frame"), file(2, 3, "src/b.ts")], parseReviewFrame("### Risks\nNone.")!)!;
    expect(stops.map((s) => s.label)).toEqual(["Frame", "Unit 1", "b.ts", "Unit 3", "Summary"]);
  });

  it("is a Review as soon as it has a File page, with or without a Frame that the phone can read", () => {
    const stops = reviewRoute([null, file(1, 2, "src/a.ts")], null)!;
    expect(stops.map((s) => s.kind)).toEqual(["frame", "unit", "unit", "summary"]);
    expect(stops[0].page).toBeNull();
  });

  it("goes to the newest page of a unit written again, and finds the Summary", () => {
    const stops = reviewRoute([other("frame", "Frame"), file(1, 1, "src/a.ts"), other("summary", "Summary"), file(1, 1, "src/a.ts", 1)], frame)!;
    expect(stops.find((s) => s.key === "unit-1")!.page).toBe(3);
    expect(stops.find((s) => s.key === "summary")!.page).toBe(2);
  });

  it("says a unit before the earliest the phone holds is on an earlier page, not just ahead", () => {
    const stops = reviewRoute([file(3, 4, "src/c.ts")], null)!;
    expect(stops.filter((s) => s.kind === "unit").map((s) => [s.n, s.page, !!s.earlier])).toEqual([
      [1, null, true],
      [2, null, true],
      [3, 0, false],
      [4, null, false],
    ]);
  });

  it("names a group's unit by its title, from its page when the Frame is silent", () => {
    const group = { kind: "file" as const, kicker: "File 1 of 1", file: parseReviewFile("#9 The group (+2 −0)", "Files: a.ts, b.ts\n\n### What changed\nx\n\n### Findings\nNone.\n"), decided: 0 };
    expect(reviewRoute([group], null)!.find((s) => s.kind === "unit")).toMatchObject({ label: "#9 The group", title: "#9 The group" });
  });
});
