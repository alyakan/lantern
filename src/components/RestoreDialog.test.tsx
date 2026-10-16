import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type RestorePlan, type RestoreResult } from "../api";
import { RestoreDialog } from "./RestoreDialog";

vi.mock("../api", () => ({ api: { restorePreview: vi.fn(), restoreFiles: vi.fn() } }));
const restorePreview = vi.mocked(api.restorePreview);
const restoreFiles = vi.mocked(api.restoreFiles);

const plan: RestorePlan = { put_back: ["/p/src/a.ts", "/p/package.json"], removed: ["/p/src/new.ts"], skipped: [], lines: 12 };
const result: RestoreResult = { id: 3, put_back: plan.put_back, removed: plan.removed, skipped: [], kept: [] };

beforeEach(() => {
  vi.resetAllMocks();
  restorePreview.mockResolvedValue(plan);
  restoreFiles.mockResolvedValue(result);
});

function open(props: Partial<Parameters<typeof RestoreDialog>[0]> = {}) {
  const onCancel = vi.fn();
  const onDone = vi.fn();
  render(<RestoreDialog slot="s1" folder="/p" turn={2} since={'your message "fix login"'} blocked={null} onCancel={onCancel} onDone={onDone} {...props} />);
  return { onCancel, onDone };
}

describe("RestoreDialog", () => {
  it("says in plain words what comes back, what goes to the Trash and how much is lost", async () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "Restore files to here?" });
    expect(dialog).toHaveTextContent('just before your message "fix login"');
    await waitFor(() => expect(screen.getByRole("list", { name: "Files to restore" })).toBeInTheDocument());
    expect(restorePreview).toHaveBeenCalledWith("s1", 2);
    expect(dialog).toHaveTextContent("2 files are put back. 1 file made since is moved to the Trash. About 12 lines of changes made since will be lost.");
    const list = screen.getByRole("list", { name: "Files to restore" });
    expect(list).toHaveTextContent("a.ts");
    expect(list).toHaveTextContent("new.ts");
    expect(screen.getByText("to Trash")).toBeInTheDocument();
    // What it leaves alone, and the safety net.
    expect(dialog).toHaveTextContent("the conversation stays as it is");
    expect(dialog).toHaveTextContent("so you can undo this right after");
    expect(screen.getByRole("button", { name: "Restore 3 files" })).toBeEnabled();
  });

  it("restores on confirm and hands the result on", async () => {
    const { onDone } = open();
    const button = await screen.findByRole("button", { name: "Restore 3 files" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(result));
    expect(restoreFiles).toHaveBeenCalledWith("s1", 2);
  });

  it("cancels with the button and with Escape, and writes nothing", async () => {
    const { onCancel } = open();
    await screen.findByRole("list", { name: "Files to restore" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(restoreFiles).not.toHaveBeenCalled();
  });

  it("says there is nothing to restore when nothing changed since", async () => {
    restorePreview.mockResolvedValue({ put_back: [], removed: [], skipped: [], lines: 0 });
    open();
    expect(await screen.findByText("Nothing has changed since then, so there is nothing to restore.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("refuses while Claude is working, and says why", async () => {
    open({ blocked: "Wait for Claude to finish before restoring files." });
    await screen.findByRole("list", { name: "Files to restore" });
    expect(screen.getByRole("note")).toHaveTextContent("Wait for Claude to finish before restoring files.");
    expect(screen.getByRole("button", { name: "Restore 3 files" })).toBeDisabled();
  });

  it("names what is left alone, such as a link", async () => {
    restorePreview.mockResolvedValue({ ...plan, skipped: [{ path: "/p/docs", reason: "A link is in the way, so it isn't restored from here." }] });
    open();
    expect(await screen.findByRole("note")).toHaveTextContent("Left alone: docs: A link is in the way, so it isn't restored from here.");
  });

  it("shows what went wrong and stays open", async () => {
    restoreFiles.mockRejectedValue("Claude is still working in this chat. Wait for it to finish, then try again.");
    const { onDone } = open();
    const button = await screen.findByRole("button", { name: "Restore 3 files" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("still working");
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restore 3 files" })).toBeEnabled();
  });

  it("shows when a preview can't be made", async () => {
    restorePreview.mockRejectedValue("There is no restore point for that message.");
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("no restore point");
    expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
  });

  it("only lists the first hundred files and counts the rest", async () => {
    restorePreview.mockResolvedValue({ put_back: Array.from({ length: 130 }, (_, i) => `/p/f${i}.ts`), removed: [], skipped: [], lines: 0 });
    open();
    expect(await screen.findByText("…and 30 more")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore 130 files" })).toBeInTheDocument();
  });
});
