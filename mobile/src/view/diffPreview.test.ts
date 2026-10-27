import { countsOf, CUT, diffPreviewOf, editBlock, fitsInline, INLINE_LINES, MAX_EDITS, MAX_LINES, MAX_LINE_CHARS } from "./diffPreview";

describe("diffPreviewOf", () => {
  it("shows an edit as removed then added lines with context kept from the shared start and end", () => {
    const old = "a\nb\nc\nd\ne\nf";
    const next = "a\nb\nc\nX\nY\ne\nf";
    const p = diffPreviewOf("Edit", { file_path: "/x", old_string: old, new_string: next })!;
    expect(p.kind).toBe("change");
    expect(p.blocks).toHaveLength(1);
    expect(p.blocks[0].lines).toEqual([
      { sign: " ", text: "b" },
      { sign: " ", text: "c" },
      { sign: "-", text: "d" },
      { sign: "+", text: "X" },
      { sign: "+", text: "Y" },
      { sign: " ", text: "e" },
      { sign: " ", text: "f" },
    ]);
    expect(p.added).toBe(2);
    expect(p.removed).toBe(1);
    expect(countsOf(p)).toBe("+2 −1");
  });

  it("is null for something that is not a change", () => {
    expect(diffPreviewOf("Bash", { command: "ls" })).toBeNull();
    expect(diffPreviewOf("Edit", { old_string: "a", new_string: "a" })).toBeNull();
    expect(diffPreviewOf("Edit", { old_string: 4, new_string: "a" })).toBeNull();
    expect(diffPreviewOf("Edit", null)).toBeNull();
    expect(diffPreviewOf("Write", { content: "" })).toBeNull();
    expect(diffPreviewOf("MultiEdit", { edits: "no" })).toBeNull();
  });

  it("shows a write as all new lines", () => {
    const p = diffPreviewOf("Write", { file_path: "/x", content: "one\ntwo\n" })!;
    expect(p.kind).toBe("new");
    expect(p.blocks[0].lines).toEqual([
      { sign: "+", text: "one" },
      { sign: "+", text: "two" },
    ]);
    expect(p.added).toBe(2);
    expect(countsOf(p)).toBe("+2");
  });

  it("titles each edit of a multi-edit by its place in Claude's list, and skips malformed ones", () => {
    const p = diffPreviewOf("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { nope: 1 }, { old_string: "c", new_string: "d" }] })!;
    expect(p.blocks.map((b) => b.title)).toEqual(["Edit 1 of 3", "Edit 3 of 3"]);
    expect(p.added).toBe(2);
    expect(p.removed).toBe(2);
  });

  it("reads at most MAX_EDITS edits", () => {
    const edits = Array.from({ length: MAX_EDITS + 5 }, (_, n) => ({ old_string: `o${n}`, new_string: `n${n}` }));
    const p = diffPreviewOf("MultiEdit", { edits })!;
    expect(p.blocks).toHaveLength(MAX_EDITS);
  });

  it("keeps at most MAX_LINES lines but counts them all", () => {
    const content = Array.from({ length: MAX_LINES + 30 }, (_, n) => `line ${n}`).join("\n");
    const p = diffPreviewOf("Write", { content })!;
    expect(p.blocks[0].lines).toHaveLength(MAX_LINES);
    expect(p.hidden).toBe(30);
    expect(p.added).toBe(MAX_LINES + 30);
  });

  it("cuts a long line", () => {
    const p = diffPreviewOf("Write", { content: "x".repeat(MAX_LINE_CHARS + 50) })!;
    expect(p.blocks[0].lines[0].text).toBe(`${"x".repeat(MAX_LINE_CHARS)}…`);
  });

  it("shows characters that can't be seen by their code", () => {
    const p = diffPreviewOf("Write", { content: "if (a‮) {​}" })!;
    expect(p.blocks[0].lines[0].text).toBe("if (a⟦U+202E⟧) {⟦U+200B⟧}");
  });
});

describe("a change the Mac cut short", () => {
  it("is shown as partial, without the Mac's cut marker in the lines", () => {
    const old = `a\nb${CUT}`;
    const next = `a\nc${CUT}`;
    const p = diffPreviewOf("Edit", { old_string: old, new_string: next })!;
    expect(p.partial).toBe(true);
    expect(p.blocks[0].lines.map((l) => `${l.sign}${l.text}`)).toEqual([" a", "-b", "+c"]);
  });

  it("is still shown when both texts were cut to the same start", () => {
    const p = diffPreviewOf("Edit", { old_string: `same${CUT}`, new_string: `same${CUT}` })!;
    expect(p.partial).toBe(true);
    expect(p.added + p.removed).toBe(0);
  });

  it("marks a write cut short, a multi-edit with too many edits, and one with an unreadable edit", () => {
    expect(diffPreviewOf("Write", { content: `x${CUT}` })!.partial).toBe(true);
    expect(diffPreviewOf("Write", { content: "x" })!.partial).toBe(false);
    const many = Array.from({ length: MAX_EDITS + 1 }, (_, n) => ({ old_string: `o${n}`, new_string: `n${n}` }));
    expect(diffPreviewOf("MultiEdit", { edits: many })!.partial).toBe(true);
    expect(diffPreviewOf("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { bad: 1 }] })!.partial).toBe(true);
    expect(diffPreviewOf("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }] })!.partial).toBe(false);
  });
});

describe("an edit that replaces every place", () => {
  it("says so, for an edit and for one of a multi-edit", () => {
    expect(diffPreviewOf("Edit", { old_string: "a", new_string: "b", replace_all: true })!.replaceAll).toBe(true);
    expect(diffPreviewOf("Edit", { old_string: "a", new_string: "b" })!.replaceAll).toBe(false);
    expect(diffPreviewOf("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d", replace_all: true }] })!.replaceAll).toBe(true);
  });
});

describe("fitsInline", () => {
  const line = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
  it("is true for a short whole change", () => {
    expect(fitsInline(diffPreviewOf("Edit", { old_string: "a", new_string: "b" })!)).toBe(true);
  });
  it("is false for a long one, a cut one and a replace-all", () => {
    expect(fitsInline(diffPreviewOf("Write", { content: line(INLINE_LINES + 1) })!)).toBe(false);
    expect(fitsInline(diffPreviewOf("Write", { content: line(INLINE_LINES) })!)).toBe(true);
    expect(fitsInline(diffPreviewOf("Write", { content: `x${CUT}` })!)).toBe(false);
    expect(fitsInline(diffPreviewOf("Edit", { old_string: "a", new_string: "b", replace_all: true })!)).toBe(false);
  });
});

describe("editBlock", () => {
  it("handles a pure addition and a pure removal", () => {
    expect(editBlock("", "new").added).toBe(1);
    expect(editBlock("old", "").removed).toBe(1);
  });
});

describe("the cut marker", () => {
  it("is the one the Mac appends", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rust = require("fs").readFileSync(require("path").join(__dirname, "../../../src-tauri/src/remote/protocol.rs"), "utf8") as string;
    expect(rust).toContain(`pub const CUT: &str = ${JSON.stringify(CUT)};`);
  });
});
