import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FilesTab } from "./FilesTab";
import { api } from "../api";
import type { FoundFile } from "../types";
import { SlotContext } from "../lib/slot";

// The editor, reduced to what FilesTab hears from it: a button that says there are unsaved edits.
vi.mock("./FilePreview", () => ({
  default: ({ path, line, onDirty }: { path: string; line: number | null; onDirty?: (dirty: boolean) => void }) => (
    <div>
      preview of {path}
      {line !== null && ` at ${line}`}
      <button onClick={() => onDirty?.(true)}>edit</button>
    </div>
  ),
}));
const ask = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: (...a: unknown[]) => ask(...a) }));
vi.mock("../api", () => ({ api: { listDir: vi.fn(), findFiles: vi.fn(), searchText: vi.fn() } }));

const TREE: Record<string, { name: string; path: string; dir: boolean }[]> = {
  "/p": [
    { name: "src", path: "/p/src", dir: true },
    { name: "README.md", path: "/p/README.md", dir: false },
  ],
  "/p/src": [{ name: "a.ts", path: "/p/src/a.ts", dir: false }],
};

const changed = [{ path: "/p/src/a.ts", created: true, added: 3, removed: 1 }];
const base = { folder: "/p", ready: true, changed, refreshKey: 0, onOpenChange: () => {} };

describe("FilesTab", () => {
  beforeEach(() => {
    vi.mocked(api.listDir).mockReset().mockImplementation(async (_slot: string, dir: string) => TREE[dir] ?? []);
    vi.mocked(api.findFiles).mockReset();
    vi.mocked(api.searchText).mockReset();
    ask.mockReset();
  });

  it("waits for the session before listing", () => {
    render(<FilesTab {...base} ready={false} />);
    expect(api.listDir).not.toHaveBeenCalled();
  });

  it("marks folders with changes and expands them lazily", async () => {
    render(<FilesTab {...base} />);
    const src = await screen.findByRole("button", { name: /src/ });
    expect(screen.getByLabelText("Contains changes")).toBeInTheDocument();
    expect(api.listDir).toHaveBeenCalledTimes(1);
    fireEvent.click(src);
    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
    expect(screen.queryByLabelText("Contains changes")).toBeNull();
  });

  it("opens every file in the editor, with a way to its diff for a changed one", async () => {
    const onOpenChange = vi.fn();
    render(<FilesTab {...base} onOpenChange={onOpenChange} />);
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));
    fireEvent.click(await screen.findByText("a.ts"));
    expect(await screen.findByText("preview of /p/src/a.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View diff" }));
    expect(onOpenChange).toHaveBeenCalledWith("/p/src/a.ts");
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));

    fireEvent.click(await screen.findByText("README.md"));
    expect(await screen.findByText("preview of /p/README.md")).toBeInTheDocument();
    // No diff to see for a file nobody changed.
    expect(screen.queryByRole("button", { name: "View diff" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks before leaving a file with unsaved edits, and stays if you keep editing", async () => {
    render(<FilesTab {...base} />);
    fireEvent.click(await screen.findByText("README.md"));
    fireEvent.click(await screen.findByRole("button", { name: "edit" }));
    expect(screen.getByText("● unsaved")).toBeInTheDocument();
    ask.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    await waitFor(() => expect(ask).toHaveBeenCalledWith("Discard your unsaved changes to README.md?", expect.objectContaining({ okLabel: "Discard", cancelLabel: "Keep editing" })));
    expect(screen.getByText("preview of /p/README.md")).toBeInTheDocument();
    // Discarding goes back.
    ask.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    expect(await screen.findByRole("tree")).toBeInTheDocument();
  });

  it("moves to another line of the open file without asking, but asks to open another file", async () => {
    const { rerender } = render(<FilesTab {...base} />);
    await screen.findByText("README.md");
    rerender(<FilesTab {...base} reveal={{ path: "/p/README.md", line: null, key: 1 }} />);
    await screen.findByText("preview of /p/README.md");
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    rerender(<FilesTab {...base} reveal={{ path: "/p/README.md", line: 12, key: 2 }} />);
    expect(await screen.findByText("preview of /p/README.md at 12")).toBeInTheDocument();
    expect(ask).not.toHaveBeenCalled();
    ask.mockResolvedValueOnce(false);
    rerender(<FilesTab {...base} reveal={{ path: "/p/src/a.ts", line: null, key: 3 }} />);
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/preview of \/p\/README.md/)).toBeInTheDocument();
  });

  it("searches the whole folder, opens a result with Enter, and goes back to the tree when cleared", async () => {
    vi.mocked(api.findFiles).mockResolvedValue([
      { path: "/p/src/a.ts", rel: "src/a.ts", hits: [4] },
      { path: "/p/README.md", rel: "README.md", hits: [2] },
    ]);
    render(<FilesTab {...base} />);
    const box = await screen.findByRole("searchbox", { name: "Search files" });
    fireEvent.change(box, { target: { value: "a" } });
    const results = await screen.findByRole("listbox", { name: "Matching files" });
    expect(results).toHaveTextContent("a.tssrc");
    expect(screen.queryByRole("tree")).toBeNull();
    // Enter opens the picked result in the editor.
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("preview of /p/src/a.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    fireEvent.keyDown(await screen.findByRole("searchbox", { name: "Search files" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search files" }), { key: "Enter" });
    expect(await screen.findByText("preview of /p/README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    fireEvent.keyDown(await screen.findByRole("searchbox", { name: "Search files" }), { key: "Escape" });
    expect(await screen.findByRole("tree")).toBeInTheDocument();
  });

  it("searches text in files with the chosen options, and opens a line's file", async () => {
    vi.mocked(api.searchText).mockResolvedValue({
      files: [{ path: "/p/src/a.ts", rel: "src/a.ts", lines: [{ line: 7, pieces: [{ text: "class ", hit: false }, { text: "User", hit: true }, { text: " {}", hit: false }] }], more: 2 }],
      truncated: false,
    });
    render(<FilesTab {...base} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Text" }));
    const box = screen.getByRole("searchbox", { name: "Search in files" });
    fireEvent.click(screen.getByRole("button", { name: "Whole word" }));
    fireEvent.change(box, { target: { value: "User" } });
    expect(await screen.findByText("3 matches in 1 file")).toBeInTheDocument();
    expect(api.searchText).toHaveBeenLastCalledWith(expect.anything(), { pattern: "User", case_sensitive: false, whole_word: true, regex: false });
    expect(screen.getByText("2 more in this file")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /class User/ }));
    expect(await screen.findByText("preview of /p/src/a.ts at 7")).toBeInTheDocument();
  });

  it("shows a file Claude made in a collapsed folder once the folder is expanded again", async () => {
    const { rerender } = render(<FilesTab {...base} />);
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));
    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /src/ }));
    TREE["/p/src"] = [...TREE["/p/src"], { name: "new.ts", path: "/p/src/new.ts", dir: false }];
    try {
      rerender(<FilesTab {...base} refreshKey={1} />);
      // The folder and the expanded-then-collapsed one are both read again.
      await waitFor(() => expect(api.listDir).toHaveBeenCalledTimes(4));
      fireEvent.click(screen.getByRole("button", { name: /src/ }));
      expect(await screen.findByText("new.ts")).toBeInTheDocument();
    } finally {
      TREE["/p/src"] = [{ name: "a.ts", path: "/p/src/a.ts", dir: false }];
    }
  });

  it("shows the folder again once a reload that failed succeeds", async () => {
    vi.mocked(api.listDir).mockRejectedValueOnce("Permission denied");
    const { rerender } = render(<FilesTab {...base} />);
    expect(await screen.findByText("Permission denied")).toBeInTheDocument();
    rerender(<FilesTab {...base} refreshKey={1} />);
    expect(await screen.findByRole("tree")).toBeInTheDocument();
    expect(screen.queryByText("Permission denied")).toBeNull();
  });

  it("doesn't keep the last file search's matches under a new query while it's still searching", async () => {
    vi.mocked(api.findFiles).mockResolvedValueOnce([{ path: "/p/src/a.ts", rel: "src/a.ts", hits: [4] }]);
    render(<FilesTab {...base} />);
    const box = await screen.findByRole("searchbox", { name: "Search files" });
    fireEvent.change(box, { target: { value: "a" } });
    await screen.findByRole("listbox", { name: "Matching files" });
    let finish: (f: FoundFile[]) => void = () => {};
    vi.mocked(api.findFiles).mockImplementationOnce(() => new Promise<FoundFile[]>((resolve) => (finish = resolve)));
    fireEvent.change(box, { target: { value: "ab" } });
    expect(await screen.findByText("Searching…")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).toBeNull();
    // The new query is asked after a short pause; its answer then ends the wait.
    await waitFor(() => expect(api.findFiles).toHaveBeenCalledTimes(2));
    await act(async () => finish([]));
    expect(await screen.findByText("No files match “ab”")).toBeInTheDocument();
  });

  it("asks before a new folder takes the open file away, and keeps the file if you keep editing", async () => {
    const { rerender } = render(<FilesTab {...base} />);
    fireEvent.click(await screen.findByText("README.md"));
    fireEvent.click(await screen.findByRole("button", { name: "edit" }));
    ask.mockResolvedValueOnce(false);
    rerender(<FilesTab {...base} folder="/q" />);
    await waitFor(() => expect(ask).toHaveBeenCalledWith("Discard your unsaved changes to /p/README.md?", expect.anything()));
    expect(screen.getByText("preview of /p/README.md")).toBeInTheDocument();
    expect(screen.getByText("● unsaved")).toBeInTheDocument();
  });

  it("keeps the open file's edits when switching chats, without asking", async () => {
    const chat = (slot: string) => (
      <SlotContext.Provider value={slot}>
        <FilesTab {...base} />
      </SlotContext.Provider>
    );
    const { rerender } = render(chat("s1"));
    fireEvent.click(await screen.findByText("README.md"));
    fireEvent.click(await screen.findByRole("button", { name: "edit" }));
    rerender(chat("s2"));
    expect(await screen.findByRole("tree")).toBeInTheDocument();
    expect(ask).not.toHaveBeenCalled();
  });
});
