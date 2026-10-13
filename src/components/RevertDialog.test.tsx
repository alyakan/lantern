import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api";
import type { ChangedFile } from "../store";
import { RevertDialog } from "./RevertDialog";

vi.mock("../api", () => ({ api: { readFile: vi.fn(), revertFiles: vi.fn(), changeSummary: vi.fn() } }));
const readFile = vi.mocked(api.readFile);
const revertFiles = vi.mocked(api.revertFiles);
const changeSummary = vi.mocked(api.changeSummary);

const edited: ChangedFile = { path: "/p/src/a.ts", created: false, added: 2, removed: 1 };
const made: ChangedFile = { path: "/p/src/new.ts", created: true, added: 4, removed: 0 };
const gone: ChangedFile = { path: "/p/src/old.ts", created: false, added: 0, removed: 3, deleted: true };

beforeEach(() => {
  vi.resetAllMocks();
  readFile.mockImplementation(async (_slot, path) => `text of ${path}\n`);
  revertFiles.mockResolvedValue([]);
  changeSummary.mockResolvedValue([]);
});

function open(files: ChangedFile[], props: Partial<Parameters<typeof RevertDialog>[0]> = {}) {
  const onCancel = vi.fn();
  const onDone = vi.fn();
  render(
    <RevertDialog
      slot="s1"
      folder="/p"
      title="Revert 3 files?"
      files={files}
      request={{ scope: "session", turn: null, toTurn: null }}
      latestTurn={null}
      onCancel={onCancel}
      onDone={onDone}
      {...props}
    />,
  );
  return { onCancel, onDone };
}

describe("RevertDialog", () => {
  it("lists each file with its line counts and says created files go to the Trash", async () => {
    open([edited, made, gone]);
    const list = screen.getByRole("list", { name: "Files to revert" });
    expect(list).toHaveTextContent("a.ts");
    expect(list).toHaveTextContent("+2");
    expect(list).toHaveTextContent("−1");
    expect(screen.getByText("new")).toBeInTheDocument();
    expect(screen.getByText("deleted")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Revert 3 files?" })).toHaveTextContent("Files Claude created are moved to the Trash, not deleted.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert 3 files" })).toBeEnabled());
  });

  it("sends each file's text as the user was shown it, and null for one shown as deleted", async () => {
    revertFiles.mockResolvedValue([{ path: "/p/src/a.ts", status: "reverted", before: "x", after: "y", reason: null }]);
    const { onDone } = open([edited, gone], { request: { scope: "turn", turn: 2, toTurn: 4 } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert 2 files" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Revert 2 files" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(readFile).toHaveBeenCalledWith("s1", "/p/src/a.ts");
    expect(readFile).not.toHaveBeenCalledWith("s1", "/p/src/old.ts");
    expect(revertFiles).toHaveBeenCalledWith("s1", "turn", 2, 4, [
      { path: "/p/src/a.ts", expected: "text of /p/src/a.ts\n" },
      { path: "/p/src/old.ts", expected: null },
    ]);
    expect(onDone).toHaveBeenCalledWith([{ path: "/p/src/a.ts", status: "reverted", before: "x", after: "y", reason: null }]);
  });

  it("leaves out a file whose text can't be read, and says why", async () => {
    readFile.mockImplementation(async (_slot, path) => {
      if (path.endsWith("a.ts")) throw "This file is binary and can't be opened.";
      return "fine\n";
    });
    open([edited, made]);
    expect(await screen.findByText("It can't be read as text, so it can't be reverted from here.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert 1 file" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Revert 1 file" }));
    await waitFor(() => expect(revertFiles).toHaveBeenCalledWith("s1", "session", null, null, [{ path: "/p/src/new.ts", expected: "fine\n" }]));
  });

  it("can't confirm until the files are read, nor when none can be reverted", async () => {
    readFile.mockRejectedValue("nope");
    open([edited]);
    expect(screen.getByRole("button", { name: /Revert/ })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert 0 files" })).toBeDisabled());
  });

  it("a revert that fails stays open with the reason, and can be tried again", async () => {
    revertFiles.mockRejectedValueOnce("Couldn't write the file.");
    const { onDone } = open([edited]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert 1 file" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Revert 1 file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't write the file.");
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Revert 1 file" })).toBeEnabled();
  });

  it("is busy while the revert runs, so it can't be started twice", async () => {
    revertFiles.mockReturnValue(new Promise(() => {}));
    open([edited]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert 1 file" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Revert 1 file" }));
    expect(screen.getByRole("button", { name: "Reverting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("cancel closes without reverting", async () => {
    const { onCancel } = open([edited]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert 1 file" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(revertFiles).not.toHaveBeenCalled();
  });

  it("warns about later edits to the same files, when the range isn't the last", async () => {
    changeSummary.mockResolvedValue([{ path: "/p/src/a.ts", created: false, deleted: false, added: 1, removed: 0 }]);
    open([edited, made], { request: { scope: "turn", turn: 1, toTurn: 1 }, latestTurn: 3 });
    expect(await screen.findByRole("note")).toHaveTextContent("Later messages also edited a.ts. Reverting loses those later edits too.");
    expect(changeSummary).toHaveBeenCalledWith("s1", "turn", 2, 3);
  });

  it("no warning when nothing later changed the files", async () => {
    open([edited], { request: { scope: "turn", turn: 1, toTurn: 1 }, latestTurn: 3 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert 1 file" })).toBeEnabled());
    expect(changeSummary).toHaveBeenCalledWith("s1", "turn", 2, 3);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("the last turn and the whole chat have nothing after them to check", async () => {
    open([edited], { request: { scope: "turn", turn: null, toTurn: null }, latestTurn: 3 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert 1 file" })).toBeEnabled());
    expect(changeSummary).not.toHaveBeenCalled();
  });
});
