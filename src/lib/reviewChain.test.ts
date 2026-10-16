import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES } from "./roles";
import { checkText, NO_REVIEW, readReview, reviewBusy, reviewFor, reviewHeadline, reviewStrip, type ReviewCheck, type ReviewInfo } from "./reviewChain";

const check = (over: Partial<ReviewCheck> = {}): ReviewCheck => ({ role: "reviewer", label: "Reviewer", slot: "w2", state: "running", findings: null, passed: null, ...over });
const info = (checks: ReviewCheck[], over: Partial<ReviewInfo> = {}): ReviewInfo => ({ builder: "w1", name: "Login", commit: "abc12345", checks, done: false, at: 10, ...over });

describe("a team's review setting", () => {
  it("is on for a team from a template that has a Reviewer or QA, with those as its checks", () => {
    expect(reviewFor(BUILTIN_TEMPLATES[0])).toEqual({ on: true, tidy: true, checks: ["reviewer"] });
    expect(reviewFor(BUILTIN_TEMPLATES[1])).toEqual({ on: true, tidy: true, checks: ["reviewer", "qa"] });
  });

  it("is off for a team that was not started from a template, or from one with nothing that checks", () => {
    expect(reviewFor(null)).toEqual(NO_REVIEW);
    expect(NO_REVIEW.on).toBe(false);
    expect(reviewFor({ id: "docs", label: "Docs", description: "", members: ["builder", "docs"] })).toEqual(NO_REVIEW);
    // A Security auditor alone isn't a Reviewer or QA: the team doesn't review by itself.
    expect(reviewFor({ id: "s", label: "S", description: "", members: ["builder", "security"] }).on).toBe(false);
  });

  it("tidies up reviewers after they report unless it was told not to", () => {
    expect(NO_REVIEW.tidy).toBe(true);
    expect(readReview({ on: true, tidy: false, checks: ["reviewer"] })).toEqual({ on: true, tidy: false, checks: ["reviewer"] });
    expect(readReview({ on: true, checks: ["qa"] })).toEqual({ on: true, tidy: true, checks: ["qa"] });
  });

  it("reads a saved setting back, and anything that isn't one is the default", () => {
    expect(readReview(null)).toEqual(NO_REVIEW);
    expect(readReview("on")).toEqual(NO_REVIEW);
    expect(readReview({ on: "yes" })).toEqual(NO_REVIEW);
    expect(readReview({ on: true, tidy: true, checks: [] }).checks).toEqual(["reviewer"]);
    expect(readReview({ on: true, tidy: true, checks: ["a", 3, "", "b", "c", "d", "e"] }).checks).toEqual(["a", "b", "c", "d"]);
  });
});

describe("what a builder's card says of its review and test", () => {
  it("says a review is going, waiting for a slot, in, or didn't finish", () => {
    expect(checkText(check({ state: "running" }))).toBe("In review");
    expect(checkText(check({ state: "waiting", slot: null }))).toBe("Review: waiting for a free slot");
    expect(checkText(check({ state: "failed" }))).toBe("Review: didn't finish");
    expect(checkText(check({ state: "skipped" }))).toBeNull();
  });

  it("counts findings when the report's last line gave a number, and says only done when it didn't", () => {
    expect(checkText(check({ state: "done", findings: 2, passed: false }))).toBe("Review: 2 findings");
    expect(checkText(check({ state: "done", findings: 1, passed: false }))).toBe("Review: 1 finding");
    expect(checkText(check({ state: "done", findings: 0, passed: true }))).toBe("Review: no findings");
    expect(checkText(check({ state: "done" }))).toBe("Review: done");
  });

  it("says a test is going, passed, failed, or done without a summary", () => {
    const qa = (over: Partial<ReviewCheck>) => check({ role: "qa", label: "QA / tester", ...over });
    expect(checkText(qa({ state: "running" }))).toBe("Testing");
    expect(checkText(qa({ state: "waiting", slot: null }))).toBe("Test: waiting for a free slot");
    expect(checkText(qa({ state: "done", findings: 0, passed: true }))).toBe("Tested: passed");
    expect(checkText(qa({ state: "done", findings: 3, passed: false }))).toBe("Tested: failed");
    expect(checkText(qa({ state: "done" }))).toBe("Tested: done");
    expect(checkText(qa({ state: "failed" }))).toBe("Tested: didn't finish");
  });

  it("joins the checks into one strip, and has none before there is anything to say", () => {
    expect(reviewStrip(undefined)).toBeNull();
    expect(reviewStrip(info([]))).toBeNull();
    expect(reviewStrip(info([check({ state: "done", findings: 2 }), check({ role: "qa", state: "done", passed: false, findings: 1 })], { done: true }))).toBe("Review: 2 findings · Tested: failed");
    expect(reviewStrip(info([check({ state: "running" }), check({ role: "qa", state: "waiting", slot: null })]))).toBe("In review · Test: waiting for a free slot");
    // A check dropped when the setting went off isn't mentioned.
    expect(reviewStrip(info([check({ state: "done", findings: 0 }), check({ role: "qa", state: "skipped", slot: null })], { done: true }))).toBe("Review: no findings");
  });

  it("is busy until every check has finished", () => {
    expect(reviewBusy(undefined)).toBe(false);
    expect(reviewBusy(info([check()]))).toBe(true);
    expect(reviewBusy(info([check({ state: "done" })], { done: true }))).toBe(false);
  });
});

describe("what the inbox says once the checks are in", () => {
  it("counts the things found by every check that gave a number", () => {
    const done = (checks: ReviewCheck[]) => reviewHeadline(info(checks, { done: true }));
    expect(done([check({ state: "done", findings: 2 })])).toBe("Review of Login found 2 things");
    expect(done([check({ state: "done", findings: 1 })])).toBe("Review of Login found 1 thing");
    expect(done([check({ state: "done", findings: 2 }), check({ role: "qa", state: "done", findings: 1 })])).toBe("Review of Login found 3 things");
    expect(done([check({ state: "done", findings: 0 }), check({ role: "qa", state: "done", findings: 0 })])).toBe("Review of Login found nothing to fix");
  });

  it("never guesses: no number means no summary, and one report without one is said", () => {
    const done = (checks: ReviewCheck[]) => reviewHeadline(info(checks, { done: true }));
    expect(done([check({ state: "done" })])).toBe("Review of Login is in (no summary)");
    expect(done([check({ state: "done", findings: 2 }), check({ role: "qa", state: "done" })])).toBe("Review of Login found 2 things (one report had no summary)");
    expect(done([check({ state: "failed" }), check({ role: "qa", state: "failed" })])).toBe("Review of Login didn't finish");
  });

  it("says nothing while the checks are still going, or when none ran", () => {
    expect(reviewHeadline(info([check()]))).toBeNull();
    expect(reviewHeadline(info([check({ state: "skipped" })], { done: true }))).toBeNull();
  });
});
