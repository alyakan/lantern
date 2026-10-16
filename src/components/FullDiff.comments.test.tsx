import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { api } from "../api";
import type { FileDiff } from "../types";
import type { CommentControls, DiffComment } from "../lib/diffComments";
import FullDiff from "./FullDiff";

// Monaco and the comment layer reduced to nodes: what is checked here is what FullDiff hands the layer and does with the comments.
vi.mock("@monaco-editor/react", () => ({
  Editor: ({ onMount }: { onMount: (e: unknown, m: unknown) => void }) => (
    <div
      data-testid="whole"
      ref={(el) => {
        if (el && !el.dataset.mounted) {
          el.dataset.mounted = "1";
          onMount({ createDecorationsCollection: () => ({ set: () => {}, clear: () => {} }), revealLineInCenter: () => {}, setPosition: () => {}, getModel: () => null }, {});
        }
      }}
    />
  ),
  DiffEditor: () => null,
}));
vi.mock("../monaco", () => ({ LIGHT_THEME: "l", DARK_THEME: "d" }));
vi.mock("../lib/editorFind", () => ({ registerFindable: () => {} }));
vi.mock("./DiffCommentLayer", () => ({ DiffCommentLayer: ({ path, modified }: { path: string; modified: string }) => <div data-testid="layer" data-path={path} data-text={modified} /> }));
vi.mock("../api", () => ({ api: { getFileDiff: vi.fn() } }));

const created = (path: string, current: string): FileDiff => ({ path, original: "", current, deleted: false } as FileDiff);
const comment = (over: Partial<DiffComment> = {}): DiffComment => ({ id: "c1", path: "/p/new.ts", side: "new", line: 2, lineText: "b", kind: "added", text: "Hm", ...over });
const controls = (items: DiffComment[]): CommentControls => ({ items, update: vi.fn() });

describe("FullDiff with review comments", () => {
  beforeEach(() => vi.mocked(api.getFileDiff).mockReset());

  it("puts the comment layer over the file's editor, and nothing when there are no comments to take", async () => {
    vi.mocked(api.getFileDiff).mockResolvedValue(created("/p/new.ts", "a\nb\n"));
    const { unmount } = render(<FullDiff path="/p/new.ts" refreshKey={0} layout="inline" comments={controls([])} />);
    expect(await screen.findByTestId("layer")).toHaveAttribute("data-path", "/p/new.ts");
    unmount();
    render(<FullDiff path="/p/new.ts" refreshKey={0} layout="inline" />);
    await screen.findByTestId("whole");
    expect(screen.queryByTestId("layer")).toBeNull();
  });

  it("reads the file's comments against the text each time the diff is read: they follow their lines or go outdated", async () => {
    vi.mocked(api.getFileDiff).mockResolvedValue(created("/p/new.ts", "x\na\nb\n"));
    const comments = controls([comment({ line: 2, lineText: "b" }), comment({ id: "c2", line: 1, lineText: "gone" }), comment({ id: "c3", path: "/p/other.ts", lineText: "zzz" })]);
    render(<FullDiff path="/p/new.ts" refreshKey={0} layout="inline" comments={comments} />);
    await waitFor(() => expect(comments.update).toHaveBeenCalled());
    const next = vi.mocked(comments.update).mock.calls[0][0](comments.items);
    expect(next[0]).toMatchObject({ line: 3, outdated: false });
    expect(next[1]).toMatchObject({ line: 1, outdated: true });
    // Another file's comment is left as it is.
    expect(next[2]).toBe(comments.items[2]);
  });

  it("lists the comments whose line is gone above the diff, with the line they were on", async () => {
    vi.mocked(api.getFileDiff).mockResolvedValue(created("/p/new.ts", "a\n"));
    render(<FullDiff path="/p/new.ts" refreshKey={0} layout="inline" comments={controls([comment({ outdated: true, text: "Where did it go?" })])} />);
    const list = await screen.findByRole("region", { name: "Comments on lines that changed" });
    expect(list).toHaveTextContent("Where did it go?");
    expect(list).toHaveTextContent("b");
  });

  it("draws no layer for a file whose diff has not arrived yet", async () => {
    vi.mocked(api.getFileDiff).mockResolvedValueOnce(created("/p/new.ts", "a\n"));
    const comments = controls([]);
    const { rerender } = render(<FullDiff path="/p/new.ts" refreshKey={0} layout="inline" comments={comments} />);
    expect(await screen.findByTestId("layer")).toBeInTheDocument();
    let finish: (d: FileDiff) => void = () => {};
    vi.mocked(api.getFileDiff).mockReturnValueOnce(new Promise((r) => (finish = r)));
    rerender(<FullDiff path="/p/next.ts" refreshKey={0} layout="inline" comments={comments} />);
    // The diff on screen is still new.ts's: comments aren't taken for next.ts yet.
    expect(screen.queryByTestId("layer")).toBeNull();
    finish(created("/p/next.ts", "z\n"));
    await waitFor(() => expect(screen.getByTestId("layer")).toHaveAttribute("data-path", "/p/next.ts"));
  });
});
