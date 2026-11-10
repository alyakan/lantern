import { describe, expect, it } from "vitest";
import { parseReviewFrame } from "./review";

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
    const f = parseReviewFrame(frame)!;
    expect(f.units).toEqual([
      { n: 1, title: "src/client/retry.ts", added: 14, removed: 3, note: "the retry loop and its delays" },
      { n: 2, title: "#548 Add the field, model and mapping", added: 40, removed: 2, note: "threaded through three files" },
      { n: 3, title: "src/client/retry.test.ts", added: null, removed: null, note: "its tests" },
    ]);
  });

  it("reads each risk, its explanation and the units it is in", () => {
    const f = parseReviewFrame(frame)!;
    expect(f.risks).toEqual([
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
});
