import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { DiffComment, LineChange } from "../lib/diffComments";
import { DiffCommentLayer, type Surface } from "./DiffCommentLayer";

// Monaco's editors, reduced to what the layer asks of them: events it can be handed, and the zones it asks for.
type Handler = (e: unknown) => void;
function fakeEditor() {
  const handlers: Record<string, Handler> = {};
  const zones: { afterLineNumber: number; ordinal?: number }[] = [];
  const dom = document.createElement("div");
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 500, width: 400, height: 500, x: 0, y: 0, toJSON: () => ({}) });
  const on = (name: string) => (fn: Handler) => {
    handlers[name] = fn;
    return { dispose: () => {} };
  };
  let line = 1;
  const editor = {
    handlers,
    zones,
    setCursor: (l: number) => (line = l),
    getDomNode: () => dom,
    onMouseMove: on("move"),
    onMouseLeave: on("leave"),
    onDidScrollChange: on("scroll"),
    onDidChangeCursorPosition: on("cursor"),
    onDidFocusEditorText: on("focus"),
    onDidLayoutChange: on("layout"),
    addCommand: vi.fn(),
    getScrolledVisiblePosition: ({ lineNumber }: { lineNumber: number }) => ({ top: (lineNumber - 1) * 19, left: 0, height: 19 }),
    changeViewZones: (change: (a: unknown) => void) =>
      change({
        addZone: (z: { afterLineNumber: number; ordinal?: number }) => {
          zones.push(z);
          return `z${zones.length}`;
        },
        layoutZone: () => {},
        removeZone: () => {},
      }),
    getLayoutInfo: () => ({ contentLeft: 40, contentWidth: 360 }),
    getPosition: () => ({ lineNumber: line, column: 1 }),
    focus: vi.fn(),
    getScrollTop: () => 0,
    getScrollLeft: () => 0,
    setScrollTop: () => {},
    setScrollLeft: () => {},
  };
  return editor;
}
type Fake = ReturnType<typeof fakeEditor>;

const monaco = { KeyCode: { KeyC: 33 } };
const move = (editor: Fake, line: number, type = 6) => act(() => editor.handlers.move({ target: { type, position: { lineNumber: line } }, event: { posy: 0 } }));

// What the app does: keeps the chat's comments and hands the pane a way to change them.
let latest: DiffComment[] = [];
function Harness({ surface, original, modified, start = [] }: { surface: Surface; original: string; modified: string; start?: DiffComment[] }) {
  const [items, setItems] = useState<DiffComment[]>(start);
  latest = items;
  return (
    <div className="diff-body">
      <DiffCommentLayer path="/p/src/a.ts" original={original} modified={modified} surface={surface} monaco={monaco as never} comments={{ items, update: (change) => setItems(change) }} />
    </div>
  );
}

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});

const addComment = (name: string, text: string) => {
  fireEvent.click(screen.getByRole("button", { name }));
  const box = screen.getByRole("textbox", { name });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
};

describe("comments on a file that was created", () => {
  const text = "one\ntwo\nthree\n";

  it("shows a button for the line the pointer is on, and a comment added there is an added line's", () => {
    const editor = fakeEditor();
    render(<Harness surface={{ kind: "whole", editor: editor as never, side: "new" }} original="" modified={text} />);
    expect(screen.queryByRole("button", { name: /^Comment on line/ })).toBeNull();
    move(editor, 2);
    addComment("Comment on line 2 of a.ts", "Why two?");
    expect(latest).toEqual([expect.objectContaining({ path: "/p/src/a.ts", side: "new", line: 2, lineText: "two", kind: "added", text: "Why two?" })]);
    // It is a note under the line now: a zone after line 2, and the comment is shown.
    expect(editor.zones.map((z) => z.afterLineNumber)).toContain(2);
    expect(screen.getByRole("group", { name: "Comment on line 2 of a.ts" })).toHaveTextContent("Why two?");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("the button goes when the pointer leaves, and Escape cancels a box", () => {
    vi.useFakeTimers();
    const editor = fakeEditor();
    render(<Harness surface={{ kind: "whole", editor: editor as never, side: "new" }} original="" modified={text} />);
    move(editor, 1);
    expect(screen.getByRole("button", { name: "Comment on line 1 of a.ts" })).toBeInTheDocument();
    act(() => editor.handlers.leave({}));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByRole("button", { name: /^Comment on line/ })).toBeNull();
    vi.useRealTimers();
    move(editor, 3);
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 3 of a.ts" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment on line 3 of a.ts" }), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(latest).toEqual([]);
  });

  it("C on the cursor's line starts a comment from the keyboard", () => {
    const editor = fakeEditor();
    render(<Harness surface={{ kind: "whole", editor: editor as never, side: "new" }} original="" modified={text} />);
    // Registered for the editor's text only, so typing in a comment box isn't taken.
    expect(editor.addCommand).toHaveBeenCalledWith(33, expect.any(Function), "editorTextFocus");
    editor.setCursor(3);
    act(() => editor.addCommand.mock.calls[0][1]());
    expect(screen.getByRole("textbox", { name: "Comment on line 3 of a.ts" })).toBeInTheDocument();
  });

  it("a created file's comments that are outdated aren't drawn under a line", () => {
    const editor = fakeEditor();
    const old: DiffComment = { id: "x", path: "/p/src/a.ts", side: "new", line: 2, lineText: "gone", kind: "added", text: "Old", outdated: true };
    render(<Harness surface={{ kind: "whole", editor: editor as never, side: "new" }} original="" modified={text} start={[old]} />);
    expect(screen.queryByRole("group")).toBeNull();
    expect(editor.zones).toEqual([]);
  });
});

describe("comments on a file that was deleted", () => {
  it("are on the old file's lines", () => {
    const editor = fakeEditor();
    render(<Harness surface={{ kind: "whole", editor: editor as never, side: "old" }} original={"a\nb\n"} modified="" />);
    move(editor, 2);
    addComment("Comment on line 2 before of a.ts", "Was b needed?");
    expect(latest).toEqual([expect.objectContaining({ side: "old", line: 2, lineText: "b", kind: "removed" })]);
  });
});

// Old: a, b, c, d, e. New: a, B, B2, c, e (b became B and B2; d was removed).
const original = "a\nb\nc\nd\ne\n";
const modified = "a\nB\nB2\nc\ne\n";
const changes: LineChange[] = [
  { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 3 },
  // A removal has no new lines: it names the line before.
  { originalStartLineNumber: 4, originalEndLineNumber: 4, modifiedStartLineNumber: 4, modifiedEndLineNumber: 0 },
];
function fakeDiff() {
  const mod = fakeEditor();
  const orig = fakeEditor();
  const diff = { getModifiedEditor: () => mod, getOriginalEditor: () => orig, getLineChanges: () => changes, onDidUpdateDiff: () => ({ dispose: () => {} }) };
  return { diff, mod, orig };
}

describe("comments on a diff, side by side", () => {
  it("added and unchanged lines are the new side's, and each kind is told apart", () => {
    const { diff, mod } = fakeDiff();
    render(<Harness surface={{ kind: "diff", diff: diff as never, split: true }} original={original} modified={modified} />);
    move(mod, 3);
    addComment("Comment on line 3 of a.ts", "On an added line");
    move(mod, 4);
    addComment("Comment on line 4 of a.ts", "On an unchanged line");
    expect(latest).toEqual([expect.objectContaining({ line: 3, lineText: "B2", kind: "added" }), expect.objectContaining({ line: 4, lineText: "c", kind: "context" })]);
  });

  it("removed lines are the old side's, drawn in the old editor; its unchanged lines offer nothing", () => {
    const { diff, orig } = fakeDiff();
    render(<Harness surface={{ kind: "diff", diff: diff as never, split: true }} original={original} modified={modified} />);
    move(orig, 3);
    expect(screen.queryByRole("button", { name: /^Comment on line/ })).toBeNull();
    move(orig, 4);
    addComment("Comment on line 4 before of a.ts", "Why drop d?");
    expect(latest).toEqual([expect.objectContaining({ side: "old", line: 4, lineText: "d", kind: "removed" })]);
    expect(orig.zones[orig.zones.length - 1].afterLineNumber).toBe(4);
  });

  it("C in the old editor on an unchanged line comments on the line it became", () => {
    const { diff, orig } = fakeDiff();
    render(<Harness surface={{ kind: "diff", diff: diff as never, split: true }} original={original} modified={modified} />);
    orig.setCursor(5);
    act(() => orig.addCommand.mock.calls[0][1]());
    // Old line 5 ("e") is new line 5 here: one line more from the first change, one fewer from the second.
    expect(screen.getByRole("textbox", { name: "Comment on line 5 of a.ts" })).toBeInTheDocument();
  });
});

describe("comments on a diff, unified", () => {
  // The removed lines are a block of Monaco's own inside the new editor; the pointer over one is a zone target.
  const overRemoved = (editor: Fake, after: number, row: number) => {
    const block = document.createElement("div");
    block.className = "view-lines line-delete";
    block.getBoundingClientRect = () => ({ left: 0, top: 100, right: 400, bottom: 138, width: 400, height: 38, x: 0, y: 100, toJSON: () => ({}) });
    const target = { type: 8, element: block, detail: { positionBefore: after ? { lineNumber: after } : null }, position: { lineNumber: after + 1 } };
    act(() => editor.handlers.move({ target, event: { posy: 100 + row * 19 + 5 } }));
  };

  it("a removed line is found by its place in the block, and its note goes under the block", () => {
    const { diff, mod } = fakeDiff();
    render(<Harness surface={{ kind: "diff", diff: diff as never, split: false }} original={original} modified={modified} />);
    // The change that removed line 4 has its block after new line 4 ("c").
    overRemoved(mod, 4, 0);
    addComment("Comment on line 4 before of a.ts", "Why drop d?");
    expect(latest).toEqual([expect.objectContaining({ side: "old", line: 4, lineText: "d", kind: "removed" })]);
    // After new line 4, after Monaco's own block (its ordinal is 10000).
    const last = mod.zones[mod.zones.length - 1];
    expect(last.afterLineNumber).toBe(4);
    expect(last.ordinal).toBeGreaterThan(10000);
    // The note says which line it is about, since it sits under the whole block.
    expect(screen.getByRole("group", { name: "Comment on line 4 before of a.ts" })).toHaveTextContent("d");
  });

  it("a comment on a new line goes before the block of removed lines that follows it", () => {
    const { diff, mod } = fakeDiff();
    render(<Harness surface={{ kind: "diff", diff: diff as never, split: false }} original={original} modified={modified} />);
    move(mod, 4);
    addComment("Comment on line 4 of a.ts", "On c");
    expect(mod.zones[mod.zones.length - 1].ordinal).toBeLessThan(10000);
  });

  it("the pointer over a block row past its lines offers nothing", () => {
    const { diff, mod } = fakeDiff();
    render(<Harness surface={{ kind: "diff", diff: diff as never, split: false }} original={original} modified={modified} />);
    overRemoved(mod, 4, 3);
    expect(screen.queryByRole("button", { name: /^Comment on line/ })).toBeNull();
  });
});

describe("comments that follow their lines", () => {
  it("one on a removed line shows under its copy in a view where the line isn't removed (unified)", () => {
    const { diff, mod } = fakeDiff();
    const c: DiffComment = { id: "x", path: "/p/src/a.ts", side: "old", line: 3, lineText: "c", kind: "removed", text: "From another view" };
    render(<Harness surface={{ kind: "diff", diff: diff as never, split: false }} original={original} modified={modified} start={[c]} />);
    // Old line 3 ("c") is new line 4.
    expect(mod.zones.map((z) => z.afterLineNumber)).toEqual([4]);
    expect(screen.getByRole("group", { name: "Comment on line 3 before of a.ts" })).toBeInTheDocument();
  });
});
