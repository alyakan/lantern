import type { Item } from "../sync/reducer";
import { changedFileOf, changedFiles, changesLine, fromMac, withLinked } from "./changes";

const step = (id: string, edits: Extract<Item, { kind: "step" }>["edits"]): Item => ({ kind: "step", id, name: "Edit", summary: "", done: true, isError: false, edits, tests: null });

describe("changedFiles", () => {
  it("makes one row per file, newest edit first, adding up a file edited twice", () => {
    const rows = changedFiles([
      step("a", [{ path: "/p/src/a.ts", created: false, added: 3, removed: 1 }]),
      step("b", [{ path: "/p/Cargo.toml", created: false, added: 1, removed: 1 }]),
      step("c", [{ path: "/p/src/a.ts", created: false, added: 2, removed: 0 }]),
    ]);
    expect(rows.map((r) => r.path)).toEqual(["/p/src/a.ts", "/p/Cargo.toml"]);
    expect(rows[0]).toMatchObject({ name: "a.ts", folder: "p/src", added: 5, removed: 1 });
    expect(rows[1]).toMatchObject({ name: "Cargo.toml", folder: "p" });
  });

  it("calls a file created if its first edit created it", () => {
    const rows = changedFiles([step("a", [{ path: "/p/new.ts", created: true, added: 10, removed: 0 }]), step("b", [{ path: "/p/new.ts", created: false, added: 1, removed: 0 }])]);
    expect(rows).toHaveLength(1);
    expect(rows[0].created).toBe(true);
    expect(rows[0].added).toBe(11);
  });

  it("ignores everything that is not a step with edits", () => {
    expect(changedFiles([{ kind: "user", id: "u", text: "hi", at: 1, sentBy: null }, step("a", [])])).toEqual([]);
  });
});

describe("changesLine", () => {
  it("sums them up, or is null", () => {
    expect(changesLine([])).toBeNull();
    const rows = changedFiles([step("a", [{ path: "/p/a", created: false, added: 3, removed: 1 }, { path: "/p/b", created: false, added: 2, removed: 4 }])]);
    expect(changesLine(rows)).toBe("2 files · +5 −5");
    expect(changesLine(rows.slice(0, 1))).toBe("1 file · +2 −4");
  });
});

describe("changedFileOf", () => {
  const files = changedFiles([step("a", [{ path: "/p/src/a.ts", created: false, added: 1, removed: 0 }])]);
  it("finds the changed file a link names, whole or from the project folder", () => {
    expect(changedFileOf(files, "/p/src/a.ts")).toBe("/p/src/a.ts");
    expect(changedFileOf(files, "src/a.ts")).toBe("/p/src/a.ts");
    expect(changedFileOf(files, "./src/a.ts")).toBe("/p/src/a.ts");
  });
  it("finds none for a file it did not change, or one that only ends the same way", () => {
    expect(changedFileOf(files, "src/b.ts")).toBeNull();
    expect(changedFileOf(files, "xa.ts")).toBeNull();
  });
});

describe("withLinked", () => {
  const files = changedFiles([{ kind: "step", id: "s", tool: "Edit", summary: "a", status: "done", edits: [{ path: "/p/src/a.ts", created: false, added: 1, removed: 0 }] } as never]);
  it("puts a file a link named first when it isn't listed, and leaves a listed one where it is", () => {
    expect(withLinked(files, "src/x.ts").map((f) => [f.path, f.linked ?? false])).toEqual([
      ["src/x.ts", true],
      ["/p/src/a.ts", false],
    ]);
    expect(withLinked(files, "src/a.ts")).toBe(files);
    expect(withLinked(files, null)).toBe(files);
  });

  it("takes the Mac's list as rows", () => {
    expect(fromMac([{ path: "/p/src/view/b.ts", created: true, deleted: false, added: 2, removed: 0 }])).toEqual([{ path: "/p/src/view/b.ts", name: "b.ts", folder: "src/view", added: 2, removed: 0, created: true }]);
  });
});
