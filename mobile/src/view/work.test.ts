import type { RemoteWorkItem } from "../protocol/generated/RemoteWorkItem";
import { filterItems, foldRows, foldWord, groupingFor, groupItems, metaOf, metaUnder, nextSteps, pathOf, safeLink, standing, stateCounts, toneOf } from "./work";

const item = (key: string, over: Partial<RemoteWorkItem> = {}): RemoteWorkItem => ({ key, repo: "lantern", title: key, stage: "checks", tone: "bad", word: "Checks failing", meta: "lantern · b", at: null, number: null, feature: null, issue: null, url: null, sig: "s", step_only: false, fold: null, next: null, issue_url: null, branch: null, stack: null, ...over });
const step = { what: "Fix", yours: false, button: "Do it", warn: false };

describe("Your work on the phone", () => {
  it("folds two or more Ready items into one line at the place of the first, gathering them whatever the order, and leaves a lone one alone", () => {
    const items = [item("a"), item("r1", { fold: "ready" }), item("b"), item("d1", { fold: "done" }), item("r2", { fold: "ready" }), item("r3", { fold: "ready" })];
    const rows = foldRows(items);
    expect(rows.map((r) => (r.kind === "item" ? r.item.key : `${r.fold}:${r.items.map((i) => i.key).join(",")}`))).toEqual(["a", "ready:r1,r2,r3", "b", "d1"]);
    expect(foldWord("ready", 3)).toBe("3 Ready · merged, waiting for a release");
    expect(foldWord("done", 2)).toBe("2 Done");
  });

  it("doesn't count done work as being worked on in a feature", () => {
    const items = [item("a", { feature: "Sync", issue: "ENG-1", tone: "wait" }), item("b", { feature: "Sync", issue: "ENG-2", tone: "done", fold: "done" }), item("c", { feature: "Sync", issue: "ENG-3", tone: "done", fold: "done" })];
    const [g] = groupItems(items, "feature");
    expect([g.label, g.doing, g.todo]).toEqual(["Sync", 1, 0]);
  });

  it("treats a kind of fold it doesn't know, or none at all, as a plain item", () => {
    const items = [item("a", { fold: "loud" }), item("b", { fold: "loud" }), item("c", { fold: undefined as unknown as null })];
    expect(foldRows(items).map((r) => r.kind)).toEqual(["item", "item", "item"]);
  });

  it("lists what to do next with what is yours first, then what is blocked, then local work and issues to start", () => {
    const items = [item("wait", { tone: "wait", next: step }), item("todo", { tone: "todo", next: step }), item("bad", { next: step }), item("none"), item("you", { tone: "you", next: step }), item("local", { tone: "local", next: step })];
    expect(nextSteps(items).map((i) => i.key)).toEqual(["you", "bad", "local", "todo", "wait"]);
  });

  it("leaves a step with no row of its own out of where things stand", () => {
    expect(standing([item("a"), item("release", { step_only: true })]).map((i) => i.key)).toEqual(["a"]);
  });

  it("groups by feature, by project or not at all, the first item's group first and work in no feature last", () => {
    const items = [item("a", { repo: "web" }), item("b", { repo: "lantern", feature: "Sync", issue: "ENG-1" }), item("c", { repo: "web", feature: "Sync", tone: "todo", issue: "ENG-2" }), item("d", { repo: "lantern" })];
    expect(groupItems(items, "feature").map((g) => [g.label, g.plain, g.items.map((i) => i.key), g.doing, g.todo])).toEqual([
      ["Sync", false, ["b", "c"], 1, 1],
      ["No feature", true, ["a", "d"], 0, 0],
    ]);
    expect(groupItems(items, "project").map((g) => [g.label, g.items.map((i) => i.key)])).toEqual([
      ["web", ["a", "c"]],
      ["lantern", ["b", "d"]],
    ]);
    expect(groupItems(items, "none")).toHaveLength(1);
  });

  it("filters by state and counts each, and falls back to project grouping without Linear", () => {
    const items = [item("a"), item("b", { tone: "wait" }), item("c", { tone: "wait" })];
    expect(stateCounts(items)).toEqual({ bad: 1, wait: 2 });
    expect(filterItems(items, []).length).toBe(3);
    expect(filterItems(items, ["wait"]).map((i) => i.key)).toEqual(["b", "c"]);
    expect(groupingFor("auto", true)).toBe("feature");
    expect(groupingFor("auto", false)).toBe("project");
    expect(groupingFor("feature", false)).toBe("project");
    expect(groupingFor("none", false)).toBe("none");
  });

  it("treats a state it doesn't know as the quietest on its way, not as a crash", () => {
    expect(toneOf(item("x", { tone: "from-the-future" }))).toBe("wait");
  });

  it("draws the path to where an item is, from the issue only with Linear, with the issue skipped for work that has none", () => {
    const nodes = (i: RemoteWorkItem, issues: boolean) => pathOf(i, issues).map((n) => `${n.stage}:${n.state}`);
    expect(nodes(item("a"), false)).toEqual(["local:past", "pr:past", "checks:now", "review:ahead", "merge:ahead", "release:ahead"]);
    expect(nodes(item("a"), true)[0]).toBe("issue:skip");
    expect(nodes(item("a", { issue: "ENG-1" }), true)[0]).toBe("issue:past");
    // Done is behind it all, the release node included.
    expect(pathOf(item("d", { tone: "done", stage: "release" }), false).every((n) => n.state === "past")).toBe(true);
  });

  it("fills a time into a line from when it happened, and leaves out a part the heading above already says", () => {
    const now = 10 * 3_600_000;
    expect(metaOf(item("a", { meta: "lantern · merged {ago}", at: now - 2 * 3_600_000 }), now)).toBe("lantern · merged 2 h ago");
    expect(metaOf(item("a", { meta: "lantern · merged {ago}", at: now - 10_000 }), now)).toBe("lantern · merged just now");
    expect(metaOf(item("a", { meta: "lantern · b" }), now)).toBe("lantern · b");
    expect(metaUnder(item("a", { meta: "ENG-1 · Sync · lantern" }), now, "Sync")).toBe("ENG-1 · lantern");
    expect(metaUnder(item("a", { meta: "ENG-1 · Sync · lantern" }), now, null)).toBe("ENG-1 · Sync · lantern");
  });

  it("opens only an https page on GitHub or Linear", () => {
    for (const ok of ["https://github.com/aly/lantern/pull/7", "https://linear.app/team/issue/ENG-1"]) expect(safeLink(ok)).toBe(true);
    for (const bad of [null, "", "http://github.com/a/b", "https://github.com.evil.example/x", "https://github.com@evil.example/x", "https://github.com/", "javascript:alert(1)", "https://github.com/a b", "https://github.com/a\\b", "https://linear.app/\u0000x"]) expect(safeLink(bad)).toBe(false);
  });
});
