import type { Row } from "./timeline";
import { pageOfKey, stepPagesOf } from "./stepPages";
import { readPage } from "./pages";

const user = (id: string, text: string): Row => ({ key: `u-${id}`, kind: "user", item: { kind: "user", id, text, at: 1 } as never, showTime: false });
const said = (id: string, text: string): Row => ({ key: `a-${id}`, kind: "assistant", item: { kind: "assistant", id, text } as never, files: [] });
const page = (id: string, text: string, live = false): Row => ({ key: `a-${id}`, kind: "page", item: { kind: "assistant", id, text } as never, page: readPage(text)!, live });

describe("Step by step's pages, as the phone pages through them", () => {
  it("starts a page at each heading, with what came after it on that page", () => {
    const rows = [user("1", "Ship it"), page("p1", "# Step 1 of 2 — Bump"), user("2", "Why 0.1.53?"), said("s", "It is the next one."), page("p2", "# Step 2 of 2 — Tag", true)];
    const pages = stepPagesOf(rows);
    expect(pages.map((p) => [p.kicker, p.title, p.rows.map((r) => r.key)])).toEqual([
      ["Start", "Before the first page", ["u-1"]],
      ["Step 1 of 2", "Bump", ["a-p1", "u-2", "a-s"]],
      ["Step 2 of 2", "Tag", ["a-p2"]],
    ]);
  });

  it("has no Start page when the chat opens on a page", () => {
    expect(stepPagesOf([page("p1", "# Frame — The task")]).map((p) => p.kicker)).toEqual(["Frame"]);
  });

  it("is one Start page when Claude hasn't written a page yet", () => {
    const pages = stepPagesOf([user("1", "Ship it"), said("s", "Which flavour?")]);
    expect(pages).toHaveLength(1);
    expect(pages[0].rows).toHaveLength(2);
  });

  it("is nothing for an empty chat", () => {
    expect(stepPagesOf([])).toEqual([]);
  });

  it("keeps a step written again after a question on its own page, under its newest title", () => {
    const rows = [page("p1", "# Step 1 of 2 — Bump"), user("2", "Use 0.2.0"), page("p1b", "# Step 1 of 2 — Bump to 0.2.0")];
    const pages = stepPagesOf(rows);
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe("Bump to 0.2.0");
    expect(pages[0].key).toBe("a-p1");
  });

  it("starts a new page for a step of the same number in a later run", () => {
    const rows = [page("p1", "# Step 1 of 2 — Bump"), page("p2", "# Step 2 of 2 — Tag"), page("p3", "# Step 1 of 2 — Bump again")];
    expect(stepPagesOf(rows)).toHaveLength(3);
  });

  it("finds the page a row is on", () => {
    const pages = stepPagesOf([user("1", "Ship it"), page("p1", "# Step 1 of 2 — Bump"), said("s", "Done that.")]);
    expect(pageOfKey(pages, "a-s")).toBe(1);
    expect(pageOfKey(pages, "u-1")).toBe(0);
    expect(pageOfKey(pages, "nope")).toBe(-1);
  });
});
