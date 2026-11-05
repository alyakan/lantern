import { describe, expect, it } from "vitest";
import { insertPaths, quotePath } from "./drop";

describe("quotePath", () => {
  it("leaves a plain path as it is and quotes one a shell would split", () => {
    expect(quotePath("/Users/r/Desktop/plan.pdf")).toBe("/Users/r/Desktop/plan.pdf");
    expect(quotePath("/Users/r/Desktop/Screenshot 2026-11-05 at 11.01.39 AM.png")).toBe("'/Users/r/Desktop/Screenshot 2026-11-05 at 11.01.39 AM.png'");
    expect(quotePath("/tmp/it's.txt")).toBe(`'/tmp/it'\\''s.txt'`);
  });
});

describe("insertPaths", () => {
  it("puts the paths at the caret, a space apart from each other and the words around them", () => {
    expect(insertPaths("", 0, 0, ["/a.png", "/b.pdf"])).toEqual({ text: "/a.png /b.pdf ", caret: 14 });
    expect(insertPaths("look at this", 12, 12, ["/a.png"])).toEqual({ text: "look at this /a.png ", caret: 20 });
    expect(insertPaths("read  please", 5, 5, ["/a.png"])).toEqual({ text: "read /a.png please", caret: 11 });
  });

  it("replaces a selection", () => {
    expect(insertPaths("see FILE now", 4, 8, ["/a.png"]).text).toBe("see /a.png now");
  });
});
