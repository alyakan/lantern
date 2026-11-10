import { filesUnder, parseReviewFile, parseReviewFrame, unitName } from "./review";

// The Mac's own fixture (src/lib/reviewFrame.test.ts): the two read a Frame the same way.
const frame = `Retries 429 and gateway errors with backoff, as the PR says.

### Units
1. \`src/client/retry.ts\` (+14 −3) — the retry loop and its delays
2. #548 Add the field, model and mapping (+40 −2) — threaded through three files
3. src/client/retry.test.ts — its tests

### Risks
- **Retrying a POST**: a repeated request can repeat its side effect (units 1, 3)
- Too many attempts: the delays add up to a minute (units 1–2 and 4)
- Unbounded jitter

### Skipped
- \`package-lock.json\`: only the version bumped.

Say "Next" to start.`;

describe("parseReviewFrame", () => {
  it("reads the planned units with their counts and why to look", () => {
    expect(parseReviewFrame(frame)!.units).toEqual([
      { n: 1, title: "src/client/retry.ts", added: 14, removed: 3, note: "the retry loop and its delays" },
      { n: 2, title: "#548 Add the field, model and mapping", added: 40, removed: 2, note: "threaded through three files" },
      { n: 3, title: "src/client/retry.test.ts", added: null, removed: null, note: "its tests" },
    ]);
  });

  it("reads each risk, its explanation and the units it is in", () => {
    expect(parseReviewFrame(frame)!.risks).toEqual([
      { title: "Retrying a POST", text: "a repeated request can repeat its side effect", units: [1, 3] },
      { title: "Too many attempts", text: "the delays add up to a minute", units: [1, 2, 4] },
      { title: "Unbounded jitter", text: "", units: [] },
    ]);
  });

  it("keeps what comes before the sections, and any other section as written, without the cue to say Next", () => {
    const f = parseReviewFrame(frame)!;
    expect(f.preface).toBe("Retries 429 and gateway errors with backoff, as the PR says.");
    expect(f.rest).toBe("### Skipped\n- `package-lock.json`: only the version bumped.");
  });

  it("reads Risks: None. as no risks", () => {
    expect(parseReviewFrame("Intro\n\n### Units\n1. a.ts (+1 −0) — x\n\n### Risks\nNone.")!.risks).toEqual([]);
  });

  it("is null for an older Frame without the sections", () => {
    expect(parseReviewFrame("**Files, in review order:**\n\n1. `src/a.ts` (+14 −3)\n\n### Skipped\nnothing")).toBeNull();
  });

  it("is not thrown by a unit range that runs away", () => {
    expect(parseReviewFrame("### Risks\n- big: all of them (units 1–99999)")!.risks[0].units).toHaveLength(100);
  });
});

describe("unitName", () => {
  it("is a file's name, or a group's whole title", () => {
    expect(unitName("src/client/retry.ts")).toBe("retry.ts");
    expect(unitName("README.md")).toBe("README.md");
    expect(unitName("#548 Add the field, model and mapping")).toBe("#548 Add the field, model and mapping");
  });
});

const sections = "### What changed\nThe new field.\n\n### Findings\nNone.\n";

describe("a group page", () => {
  it("takes its files from the Files: line the page opens with, and its title as the group's", () => {
    const r = parseReviewFile("#548 Add the field, model and mapping (+40 −2)", `Files: \`src/a.ts\`, **src/b.ts**, src/c.ts\n\n${sections}`)!;
    expect(r.path).toBeNull();
    expect(r.group).toBe("#548 Add the field, model and mapping");
    expect(r.files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect([r.added, r.removed]).toEqual([40, 2]);
    // The line is the page's file list now, not words above it.
    expect(r.preface).toBe("");
  });

  it("keeps what is said after the Files: line as the preface", () => {
    const r = parseReviewFile("#548 Group (+1 −0)", `**Files:** a.ts, b.ts\nThey go together.\n\n${sections}`)!;
    expect(r.files).toEqual(["a.ts", "b.ts"]);
    expect(r.preface).toBe("They go together.");
  });

  it("is a file's page without it, with its path", () => {
    const r = parseReviewFile("src/a.ts (+3 −1)", `Said before.\n\n${sections}`)!;
    expect([r.path, r.group, r.files, r.preface]).toEqual(["src/a.ts", null, [], "Said before."]);
  });

  it("reads the Files: line only at the top, not a mention further down", () => {
    expect(filesUnder("Intro\nFiles: a.ts")).toBeNull();
    expect(filesUnder("\n\nFiles: a.ts, b.ts")).toEqual(["a.ts", "b.ts"]);
  });
});
