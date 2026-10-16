import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api";
import { initialState, type ChatItem, type State } from "../store";
import { ChatView } from "./ChatView";

vi.mock("../api", () => ({ api: { restorePoints: vi.fn(), restorePreview: vi.fn(), restoreFiles: vi.fn(), undoRestore: vi.fn() } }));
const restorePoints = vi.mocked(api.restorePoints);
const restorePreview = vi.mocked(api.restorePreview);
const restoreFiles = vi.mocked(api.restoreFiles);
const undoRestore = vi.mocked(api.undoRestore);

const items: ChatItem[] = [
  { type: "user", id: "u1", text: "Add retries", turn: 0 },
  { type: "assistant", id: "a1", text: "Done." },
  { type: "user", id: "u2", text: "Now the queue", turn: 1 },
  { type: "assistant", id: "a2", text: "Queued." },
];
const idle: State = { ...initialState, status: "idle", folder: "/p", items };
const props = { onDecide: () => {}, onOpenFile: () => {} };
const plan = { put_back: ["/p/a.ts"], removed: ["/p/new.ts"], skipped: [], lines: 5 };
const result = { id: 4, put_back: ["/p/a.ts"], removed: ["/p/new.ts"], skipped: [], kept: [] };

beforeEach(() => {
  vi.resetAllMocks();
  restorePoints.mockResolvedValue([0, 1]);
  restorePreview.mockResolvedValue(plan);
  restoreFiles.mockResolvedValue(result);
});

describe("ChatView: Restore files to here", () => {
  it("is offered on the messages that have a restore point, and not at all without the feature", async () => {
    restorePoints.mockResolvedValue([1]);
    const { rerender } = render(<ChatView state={idle} {...props} restore={{ onRestored: vi.fn(), onUndone: vi.fn() }} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Restore files to here" })).toHaveLength(1));
    expect(restorePoints).toHaveBeenCalledWith("s1");
    rerender(<ChatView state={idle} {...props} />);
    expect(screen.queryByRole("button", { name: "Restore files to here" })).toBeNull();
  });

  it("asks first, restores, and tells the app with the words for the chat", async () => {
    const onRestored = vi.fn();
    render(<ChatView state={idle} {...props} restore={{ onRestored, onUndone: vi.fn() }} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Restore files to here" })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Restore files to here" })[0]);
    expect(restorePreview).toHaveBeenCalledWith("s1", 0);
    expect(restoreFiles).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("button", { name: "Restore 2 files" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(restoreFiles).toHaveBeenCalledWith("s1", 0);
    const [since, got, summary, files] = onRestored.mock.calls[0];
    expect(since).toBe('your message "Add retries"');
    expect(got).toEqual(result);
    expect(summary).toBe('1 file is back to how it stood before your message "Add retries". 1 file Claude created was moved to the Trash.');
    expect(files).toEqual([
      { path: "/p/a.ts", trashed: false },
      { path: "/p/new.ts", trashed: true },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is disabled, with the reason, while Claude is working", async () => {
    render(<ChatView state={{ ...idle, status: "running" }} {...props} restore={{ onRestored: vi.fn(), onUndone: vi.fn() }} />);
    const buttons = await screen.findAllByRole("button", { name: "Restore files to here" });
    expect(buttons[0]).toBeDisabled();
    expect(buttons[0]).toHaveAttribute("title", "Wait for Claude to finish before restoring files.");
  });

  it("offers Undo restore until the next message, and tells the app when it is done", async () => {
    undoRestore.mockResolvedValue({ id: null, put_back: ["/p/a.ts"], removed: [], skipped: [], kept: ["/p/b.ts"] });
    const onUndone = vi.fn();
    render(<ChatView state={{ ...idle, restoreUndo: { id: 4, summary: "1 file is back." } }} {...props} restore={{ onRestored: vi.fn(), onUndone }} />);
    expect(screen.getByRole("status")).toHaveTextContent("1 file is back.");
    fireEvent.click(screen.getByRole("button", { name: "Undo restore" }));
    await waitFor(() => expect(onUndone).toHaveBeenCalledWith(4, "The restore is undone, except one file you edited since: it was left as it is."));
    expect(undoRestore).toHaveBeenCalledWith("s1", 4);
  });

  it("says when an undo fails", async () => {
    undoRestore.mockRejectedValue("There is nothing to undo.");
    render(<ChatView state={{ ...idle, restoreUndo: { id: 4, summary: "1 file is back." } }} {...props} restore={{ onRestored: vi.fn(), onUndone: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo restore" }));
    expect(await screen.findByText("There is nothing to undo.")).toBeInTheDocument();
  });
});
