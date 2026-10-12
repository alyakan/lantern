import { beforeEach, describe, expect, it, vi } from "vitest";
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
  DiffEditor: () => null,
}));
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
    // The same editor, and the same marks moved: nothing is made again, so its scroll place and undo history stay.
    expect(screen.getByTestId("whole")).toBe(node);
    expect(marks).toHaveLength(1);
    const set = marks[0].set;
    const ranges = set.mock.calls[set.mock.calls.length - 1][0] as { range: { endLineNumber: number }; options: { className: string } }[];
    expect(ranges[0].range.endLineNumber).toBe(3);
    expect(ranges[0].options.className).toBe("whole-added");
  });
});
