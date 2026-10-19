import { describe, expect, it } from "vitest";
import { baseBranchOf, findingsOf, reviewTargetOf, isVerdictNext, parseReviewFile, prNumberOf, reviewHints, splitFileTitle, verdictMessage, verdictsFromNext, withoutCue } from "./review";

// As Claude wrote it for PostHog/posthog-ios#863 (trimmed).
const clean = `### What changed
- **Registration:** on iOS 15+ ports are registered with \`EXCEPTION_IDENTITY_PROTECTED\`.

### Findings
None.

### Notes
**Message format**
- **msgh_id is right.** The subsystem starts at 2405.

Say "Next" for file 2.`;

const withFindings = `One thing first: file 1's verdicts didn't match a finding.

### What changed
Adds a retry loop.

### Findings
⚠ line 42 (blocker): the loop never ends when attempts is 0, so the request hangs.
⚠ lines 50-52 (should-fix): the delay grows without a cap;
  a slow upstream stalls the UI for minutes.
- ⚠ line 60 (nit): typo in the comment.

### Notes
Checked the callers.`;

describe("review pages", () => {
  it("splits a file title into its path and counts", () => {
    expect(splitFileTitle("vendor/PLCrashMachExceptionServer.m (+96 −1)")).toEqual({ path: "vendor/PLCrashMachExceptionServer.m", added: 96, removed: 1 });
    expect(splitFileTitle("`README.md` (+5 -0)")).toEqual({ path: "README.md", added: 5, removed: 0 });
    expect(splitFileTitle("README.md")).toEqual({ path: "README.md", added: null, removed: null });
  });

  it("reads a clean file, and drops the closing cue", () => {
    const r = parseReviewFile("a.m (+96 −1)", clean)!;
    expect(r.clean).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.changed).toContain("Registration");
    expect(r.notes).toContain("msgh_id is right");
    expect(r.notes).not.toContain("Say");
  });

  it("reads findings with their line, severity and run-on text, and the preface", () => {
    const r = parseReviewFile("src/retry.ts (+9 −4)", withFindings)!;
    expect(r.preface).toBe("One thing first: file 1's verdicts didn't match a finding.");
    expect(r.findings.map((f) => [f.line, f.lineEnd, f.severity])).toEqual([
      [42, null, "blocker"],
      [50, 52, "should-fix"],
      [60, null, "nit"],
    ]);
    expect(r.findings[1].text).toBe("the delay grows without a cap;\na slow upstream stalls the UI for minutes.");
  });

  it("keeps the severity however Claude writes the finding's header", () => {
    // Every shape here is one a real review wrote.
    const read = (line: string) => {
      const { findings } = findingsOf(line);
      return findings.map((f) => [f.line, f.lineEnd, f.severity, f.text]);
    };
    expect(read("⚠ (should-fix): plain")).toEqual([[null, null, "should-fix", "plain"]]);
    // A tag after the severity: (should-fix, convention), (nit, test gap).
    expect(read("⚠ line 17–21 (should-fix, convention): touched test file")).toEqual([[17, 21, "should-fix", "touched test file"]]);
    expect(read("⚠ line 82–108 (nit, test gap): no edge test")).toEqual([[82, 108, "nit", "no edge test"]]);
    // More than one range or place before the severity: the first one is the finding's line.
    expect(read("⚠ line 210–212, 243–250, 262–265 (should-fix, convention): waits replaced asserts")).toEqual([[210, 212, "should-fix", "waits replaced asserts"]]);
    expect(read("⚠ line 271, 352 (should-fix): builds a display string")).toEqual([[271, null, "should-fix", "builds a display string"]]);
    expect(read("⚠ line 30 + 38–39 (should-fix): the glob lists merged branches")).toEqual([[30, null, "should-fix", "the glob lists merged branches"]]);
    expect(read('⚠ line 34–35, the "Run tests" step (should-fix): picks the first iPhone')).toEqual([[34, 35, "should-fix", "picks the first iPhone"]]);
    // The severity in bold, with or without a line.
    expect(read("⚠ **should-fix:** a non-Bool `error` still fails")).toEqual([[null, null, "should-fix", "a non-Bool `error` still fails"]]);
    expect(read("⚠ **nit:** in `Tests`, \"missing when\" and more")).toEqual([[null, null, "nit", "in `Tests`, \"missing when\" and more"]]);
    expect(read("⚠ line 9 **blocker:** crashes on nil")).toEqual([[9, null, "blocker", "crashes on nil"]]);
    // The whole marker in bold, with a label after the severity.
    expect(read("- **⚠ (nit), open/closed:** adding a type edits 9 sites")).toEqual([[null, null, "nit", "adding a type edits 9 sites"]]);
    // No severity: the text is left whole, colon and all.
    expect(read("⚠ Note: something odd")).toEqual([[null, null, null, "Note: something odd"]]);
    expect(read("⚠ line 7 network errors aren't retried.")).toEqual([[7, null, null, "network errors aren't retried."]]);
  });

  it("isn't a review file without the sections", () => {
    expect(parseReviewFile("a.ts", "Just some text.")).toBeNull();
  });

  it("builds the Next that carries the verdicts", () => {
    const r = parseReviewFile("src/retry.ts", withFindings)!;
    expect(verdictMessage(r.findings, { 0: "agree", 1: "reject", 2: "agree" })).toBe("Next. Agreed: line 42, line 60. Rejected: line 50-52.");
    expect(verdictMessage(r.findings, {})).toBe("Next.");
    expect(isVerdictNext("Next. Agreed: line 42.")).toBe(true);
    expect(isVerdictNext("Next, but rename it")).toBe(false);
  });

  it("reads the verdicts back from the Next that carried them, whatever the view remembers", () => {
    const r = parseReviewFile("src/retry.ts", withFindings)!;
    const sent = verdictMessage(r.findings, { 0: "agree", 1: "reject", 2: "agree" });
    expect(verdictsFromNext(sent, r.findings)).toEqual({ 0: "agree", 1: "reject", 2: "agree" });
    // A plain Next, or one that isn't about verdicts, carries none.
    expect(verdictsFromNext("Next", r.findings)).toBeUndefined();
    expect(verdictsFromNext("Next, but rename it", r.findings)).toBeUndefined();
    // Findings that share a label take the verdicts in the order they were listed.
    const twins = [{ index: 0, line: 7, lineEnd: null, severity: null, text: "a" }, { index: 1, line: 7, lineEnd: null, severity: null, text: "b" }];
    expect(verdictsFromNext("Next. Agreed: line 7, line 7.", twins)).toEqual({ 0: "agree", 1: "agree" });
    // A label no finding has (the page was rewritten since) is left out.
    expect(verdictsFromNext("Next. Agreed: line 99. Rejected: line 42.", r.findings)).toEqual({ 0: "reject" });
  });

  it("drops a closing cue from any message", () => {
    expect(withoutCue("All good.\n\nI'll stop here. Say \"Next\" to open file 1.")).toBe("All good.");
    expect(withoutCue("All good.\n\nSay next to open file 1")).toBe("All good.");
    expect(withoutCue("Say \"Next\" to continue.")).toBe("");
    // The lead-in after other words on the same line still counts as the cue.
    expect(withoutCue("All good. I'll stop here. Say next.")).toBe("All good.");
  });

  it("only drops a last line that is the cue, never the end of a line that mentions it", () => {
    for (const t of ["Looks fine.\nThen reply next if it looks fine", "I'd say next to the loop is fine, say next when ready"]) expect(withoutCue(t), t).toBe(t);
  });
});

describe("prNumberOf", () => {
  it("finds the reviewed PR in what was asked or the Frame heading, the latest mention winning", () => {
    expect(prNumberOf([{ type: "user", text: "Review PR 128" }])).toBe(128);
    expect(prNumberOf([{ type: "user", text: "look at https://github.com/PostHog/posthog-ios/pull/863" }])).toBe(863);
    expect(prNumberOf([{ type: "user", text: "Review my branch" }, { type: "assistant", text: "# Frame — Retries (#42)\n\nTwo files." }])).toBe(42);
    expect(prNumberOf([{ type: "user", text: "Review PR #1" }, { type: "user", text: "Next" }, { type: "user", text: "now PR 2" }])).toBe(2);
    // Issue numbers elsewhere in a reply aren't the PR.
    expect(prNumberOf([{ type: "user", text: "Review this diff" }, { type: "assistant", text: "This fixes (#77) from the tracker." }])).toBeNull();
  });
});

describe("reviewTargetOf", () => {
  const call = (summary: string, status: "done" | "error" = "done") => ({ type: "tool" as const, id: summary, name: "mcp__lantern__review_target", summary, status, output: null, edit: null, children: [] });
  it("is what Claude last set the Changes pane to, and nothing until it does", () => {
    expect(reviewTargetOf([])).toBeNull();
    expect(reviewTargetOf([call("pr=none base=feat/core")])).toEqual({ pr: null, base: "feat/core" });
    expect(reviewTargetOf([call("pr=none base=auto"), call("pr=512 base=auto")])).toEqual({ pr: 512, base: null });
    // A call Lantern refused doesn't count.
    expect(reviewTargetOf([call("pr=512 base=auto"), call("pr=0 base=auto", "error")])).toEqual({ pr: 512, base: null });
  });
});

describe("baseBranchOf", () => {
  const frame = (body: string) => ({ type: "assistant", text: `# Frame — Review lantern/ui\n\n${body}` });
  it("is the branch the review's Frame says it is stacked on, in the ways Claude writes it", () => {
    expect(baseBranchOf([frame("Base: feat/core\n\nTwo commits on top of it.")])).toBe("feat/core");
    expect(baseBranchOf([frame("**Base:** `origin/feat/core`")])).toBe("origin/feat/core");
    expect(baseBranchOf([frame("- Base: main")])).toBe("main");
  });

  it("is the latest Frame's, and only a Frame's", () => {
    expect(baseBranchOf([frame("Base: feat/core"), { type: "assistant", text: "# Frame — again\n\nBase: feat/api" }])).toBe("feat/api");
    expect(baseBranchOf([{ type: "assistant", text: "# File 1 of 2 — a.ts (+1 −0)\n\nBase: nope" }, { type: "user", text: "Base: nope" }])).toBeNull();
    expect(baseBranchOf([frame("Two commits.")])).toBeNull();
  });

  it("isn't fooled by something that isn't a branch name", () => {
    expect(baseBranchOf([frame("Base: the core branch, roughly")])).toBeNull();
  });
});

describe("reviewHints", () => {
  it("takes the reviewed files' paths and the folder's paths Claude used", () => {
    const hints = reviewHints(
      [
        { type: "user", id: "u1", text: "Review my branch" },
        { type: "tool", id: "t1", name: "Bash", summary: "git -C /ws/posthog-main log --oneline main..HEAD", status: "done", output: "", edit: null, children: [] },
        { type: "tool", id: "t2", name: "Bash", summary: "cat /etc/hosts", status: "done", output: "", edit: null, children: [] },
        { type: "assistant", id: "a1", text: "**nodejs/src/cdp/templates/index.ts** (+2 −0)\n\n### What changed\nx" },
      ],
      "/ws",
    );
    expect(hints).toEqual(["/ws/posthog-main", "nodejs/src/cdp/templates/index.ts"]);
  });
});
