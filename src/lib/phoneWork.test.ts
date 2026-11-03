import { describe, expect, it } from "vitest";
import type { LinearIssue, LinearWork, RepoStatus } from "../types";
import { phoneWork } from "./phoneWork";
import { withLinear, yourWork } from "./yourWork";

const NOW = new Date(2026, 10, 2, 18, 0).getTime();
const repo = (over: Partial<RepoStatus> = {}): RepoStatus => ({ repo: "/p/lantern", github: "aly/lantern", folders: [{ folder: "/p/lantern", branch: "main", changed: 0 }], worktrees: [], gh: "ready", prs: [], merged: [], release: null, drafts: [], viewer: "aly", branches: [], error: null, ...over });
const pr = (number: number, over: Partial<RepoStatus["prs"][number]> = {}): RepoStatus["prs"][number] => ({ number, title: `PR ${number}`, author: "aly", branch: `b${number}`, draft: false, checks: "pass", review: null, mergeable: "MERGEABLE", merge_state: "BLOCKED", review_requests: [], ...over });
const issue = (identifier: string, over: Partial<LinearIssue> = {}): LinearIssue => ({ identifier, title: `Issue ${identifier}`, url: `https://linear.app/a/issue/${identifier}`, priority: 1, due: null, state: "Todo", state_type: "unstarted", team: "ENG", project: "Sync", project_id: "p", branch: null, links: [], ...over });
const linearWork = (issues: LinearIssue[]): LinearWork => ({ connected: true, viewer: "Aly", org: "A", teams: [{ key: "ENG", name: "Eng" }], issues, error: null });

describe("Your work for a phone", () => {
  it("tells the names and states of each item, not the message a step sends", () => {
    const r = repo({ prs: [pr(7, { checks: "fail" })] });
    const told = phoneWork(yourWork([r], NOW), false, true, []);
    expect(told.issues).toBe(false);
    expect(told.items[0]).toMatchObject({ key: "/p/lantern:pr:7", repo: "lantern", title: "PR 7", stage: "checks", tone: "bad", word: "Checks failing", number: 7, url: "https://github.com/aly/lantern/pull/7", next: { what: "Fix failing checks on", yours: false, button: "Do it" } });
    expect(JSON.stringify(told)).not.toMatch(/request_approval|gh pr checks/);
  });

  it("leaves a time out of a line, to be filled in on the phone, so the line doesn't change every minute", () => {
    const at = new Date(2026, 10, 2, 16, 0);
    const r = repo({ merged: [{ number: 9, title: "m", author: "aly", branch: "m9", merged_at: at.toISOString() }], release: { tag: "v1", published_at: new Date(2026, 10, 1).toISOString() } });
    const now = phoneWork(yourWork([r], NOW), false, true, []).items.find((i) => i.number === 9)!;
    const later = phoneWork(yourWork([r], NOW + 3 * 60_000), false, true, []).items.find((i) => i.number === 9)!;
    expect(now.meta).toBe("lantern · merged {ago}");
    expect(later).toEqual(now);
    expect(now.at).toBe(at.getTime());
  });

  it("gives a link only to a pull request on GitHub or an issue on Linear, never what a title or an issue says", () => {
    const r = repo({ github: "not a repo/../x", prs: [pr(1)] });
    expect(phoneWork(yourWork([r], NOW), false, true, []).items[0].url).toBeNull();
    const ok = repo({ prs: [pr(2, { checks: "fail", branch: "aly/eng-1-a" })] });
    const items = withLinear(yourWork([ok], NOW), linearWork([issue("ENG-1"), issue("ENG-9", { url: "https://evil.example/x" }), issue("ENG-5")]), { "/p/lantern": "ENG" }, [ok], NOW);
    const told = phoneWork(items, true, true, []).items;
    expect(told.find((i) => i.number === 2)).toMatchObject({ issue: "ENG-1", feature: "Sync", url: "https://github.com/aly/lantern/pull/2" });
    expect(told.find((i) => i.key === "linear:ENG-5")).toMatchObject({ tone: "todo", url: "https://linear.app/a/issue/ENG-5", issue: "ENG-5" });
    expect(told.find((i) => i.key === "linear:ENG-9")!.url).toBeNull();
  });

  it("lists what stands first, blocked before the rest, then the steps with no row of their own", () => {
    const at = (d: number) => new Date(2026, 10, d, 12).toISOString();
    const r = repo({ prs: [pr(1), pr(2, { checks: "fail" })], merged: [{ number: 9, title: "m", author: "aly", branch: "m9", merged_at: at(2) }], release: { tag: "v1.2.0", published_at: new Date(2026, 10, 1, 18).toISOString() } });
    const told = phoneWork(yourWork([r], NOW), false, true, []).items;
    expect(told.map((i) => [i.key.split(":").slice(1).join(":"), i.step_only])).toEqual([
      ["pr:2", false],
      // Both are yours to do something about: the one that moved last comes first.
      ["merged:9", false],
      ["pr:1", false],
      ["release", true],
    ]);
  });
});
