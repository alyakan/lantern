import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { api } from "../api";
import type { FileDiff } from "../types";
import FullDiff from "./FullDiff";

// Monaco reduced to what FullDiff asks of it: a node that shows the text it's given, and the whole-file marks.
const marks: { set: ReturnType<typeof vi.fn> }[] = [];
vi.mock("@monaco-editor/react", () => ({
  Editor: ({ value, onMount }: { value: string; onMount: (e: unknown, m: unknown) => void }) => {
    const editor = {
      createDecorationsCollection: () => {
        const collection = { set: vi.fn(), clear: vi.fn() };
        marks.push(collection);
        return collection;
      },
      revealLineInCenter: () => {},
      setPosition: () => {},
      getModel: () => null,
    };
    return (
      <div
        data-testid="whole"
        data-value={value}
        ref={(el) => {
          if (el && !el.dataset.mounted) {
            el.dataset.mounted = "1";
            onMount(editor, {});
          }
        }}
      />
    );
  },
  // The diff editor is a node that counts how often one is made: the text it shows is its own, as in Monaco.
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => {
    const mounted = useRef(0);
    if (mounted.current === 0) mounted.current = ++diffEditorsMade;
    return <div data-testid="diff" data-editor={mounted.current} data-original={original} data-modified={modified} />;
  },
}));
let diffEditorsMade = 0;
vi.mock("../monaco", () => ({ LIGHT_THEME: "l", DARK_THEME: "d" }));
vi.mock("../lib/editorFind", () => ({ registerFindable: () => {} }));
vi.mock("../api", () => ({ api: { getFileDiff: vi.fn() } }));

const diff = (current: string): FileDiff => ({ path: "/p/new.ts", original: "", current, deleted: false } as FileDiff);

describe("FullDiff of a file that was created", () => {
  beforeEach(() => {
    marks.length = 0;
    vi.mocked(api.getFileDiff).mockReset();
  });

  it("updates the text in place as Claude writes it, and moves the whole-file mark to the new length", async () => {
    vi.mocked(api.getFileDiff).mockResolvedValueOnce(diff("a\n"));
    const { rerender } = render(<FullDiff path="/p/new.ts" refreshKey={0} layout="inline" />);
    const node = await screen.findByTestId("whole");
    expect(node).toHaveAttribute("data-value", "a\n");

    vi.mocked(api.getFileDiff).mockResolvedValueOnce(diff("a\nb\nc\n"));
    rerender(<FullDiff path="/p/new.ts" refreshKey={1} layout="inline" />);
    await waitFor(() => expect(screen.getByTestId("whole")).toHaveAttribute("data-value", "a\nb\nc\n"));
    // The same editor, and the same marks moved: the editor isn't remounted on each refresh.
    expect(screen.getByTestId("whole")).toBe(node);
    expect(marks).toHaveLength(1);
    const set = marks[0].set;
    // The marks are moved by an effect that runs after the text on screen has changed, so wait for them too.
    const latest = () => set.mock.calls[set.mock.calls.length - 1]?.[0] as { range: { endLineNumber: number }; options: { className: string } }[] | undefined;
    await waitFor(() => expect(latest()?.[0].range.endLineNumber).toBe(3));
    expect(latest()?.[0].options.className).toBe("whole-added");
  });
});

describe("FullDiff of a file that was changed", () => {
  const changed = (path: string, current: string): FileDiff => ({ path, original: "a\nb\nc\n", current, created: false, deleted: false } as FileDiff);
  const editorOf = () => screen.getByTestId("diff").getAttribute("data-editor");

  beforeEach(() => {
    vi.mocked(api.getFileDiff).mockReset();
  });

  it("gives each version of a file, and each file, a new diff editor, so its unchanged code is folded away again", async () => {
    // Monaco folds a diff's unchanged code away only when the editor first draws it: new text put in an editor that
    // already holds a diff shows the folded code again, for good.
    vi.mocked(api.getFileDiff).mockResolvedValueOnce(changed("/p/a.ts", "a\nB\nc\n"));
    const { rerender } = render(<FullDiff path="/p/a.ts" refreshKey={0} layout="inline" />);
    await screen.findByTestId("diff");
    const first = editorOf();

    // The file read again after Claude edited it.
    vi.mocked(api.getFileDiff).mockResolvedValueOnce(changed("/p/a.ts", "a\nB\nC\n"));
    rerender(<FullDiff path="/p/a.ts" refreshKey={1} layout="inline" />);
    await waitFor(() => expect(screen.getByTestId("diff")).toHaveAttribute("data-modified", "a\nB\nC\n"));
    const second = editorOf();
    expect(second).not.toBe(first);

    // Another file.
    vi.mocked(api.getFileDiff).mockResolvedValueOnce(changed("/p/b.ts", "a\nb\nz\n"));
    rerender(<FullDiff path="/p/b.ts" refreshKey={1} layout="inline" />);
    await waitFor(() => expect(screen.getByTestId("diff")).toHaveAttribute("data-modified", "a\nb\nz\n"));
    expect(editorOf()).not.toBe(second);
  });

  it("keeps the editor when the same text is read again, or only the layout changes", async () => {
    vi.mocked(api.getFileDiff).mockResolvedValue(changed("/p/a.ts", "a\nB\nc\n"));
    const { rerender } = render(<FullDiff path="/p/a.ts" refreshKey={0} layout="inline" />);
    await screen.findByTestId("diff");
    const first = editorOf();

    rerender(<FullDiff path="/p/a.ts" refreshKey={1} layout="inline" />);
    await waitFor(() => expect(api.getFileDiff).toHaveBeenCalledTimes(2));
    rerender(<FullDiff path="/p/a.ts" refreshKey={1} layout="split" />);
    expect(editorOf()).toBe(first);
  });
});
