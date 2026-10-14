import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api";
import type { RelocationPreview } from "../types";
import { RelocateDialog, oldChoices } from "./RelocateDialog";

vi.mock("../api", () => ({
  api: { movedFolderCandidates: vi.fn(), recentFolders: vi.fn(), relocationPreview: vi.fn(), relocateFolder: vi.fn() },
}));
const moved = vi.mocked(api.movedFolderCandidates);
const recent = vi.mocked(api.recentFolders);
const preview = vi.mocked(api.relocationPreview);
const relocate = vi.mocked(api.relocateFolder);

const OLD = "/Users/you/Documents/Github/web-dashboard";
const NEW = "/Users/you/projects/web-dashboard";
const HERE = "/Users/you/src/acme-api";
const FOUND: RelocationPreview = { sessions: 12, bytes: 4_300_000, project_entry: true, memory_files: 3, rules: 2, linked: 0 };

beforeEach(() => {
  vi.resetAllMocks();
  moved.mockResolvedValue([{ old: OLD, suggested: NEW }]);
  recent.mockResolvedValue([{ path: HERE, updated_ms: 1 }, { path: NEW, updated_ms: 2 }]);
  preview.mockResolvedValue(FOUND);
  relocate.mockResolvedValue({ project_keys: ["allowedTools", "mcpServers"], memory_files: 3, rules: 2 });
});

function open(props: Partial<Parameters<typeof RelocateDialog>[0]> = {}) {
  const onCancel = vi.fn();
  const onDone = vi.fn();
  const pickFolder = vi.fn(async () => null as string | null);
  render(<RelocateDialog current={HERE} start={null} pickFolder={pickFolder} onCancel={onCancel} onDone={onDone} {...props} />);
  return { onCancel, onDone, pickFolder };
}

describe("oldChoices", () => {
  it("lists the gone folders first, then the other recent folders", () => {
    expect(oldChoices([{ old: OLD, suggested: NEW }], [{ path: NEW, updated_ms: 2 }, { path: HERE, updated_ms: 1 }])).toEqual([
      { path: OLD, gone: true, suggested: NEW },
      { path: NEW, gone: false, suggested: null },
      { path: HERE, gone: false, suggested: null },
    ]);
  });

  it("doesn't list a folder twice", () => {
    expect(oldChoices([{ old: OLD, suggested: null }], [{ path: OLD, updated_ms: 1 }])).toEqual([{ path: OLD, gone: true, suggested: null }]);
  });
});

describe("RelocateDialog", () => {
  it("lists where the folder may have been, the gone one first", async () => {
    open();
    // Both folders are named web-dashboard: the gone one is told apart by its path.
    expect(await screen.findByTitle(OLD)).toHaveTextContent("web-dashboard");
    expect(screen.getByText("Moved?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^acme-api/ })).toBeInTheDocument();
  });

  it("starts from a moved notice: its old place and suggested new one, with what the move would find", async () => {
    open({ start: { old: OLD, suggested: NEW } });
    expect(await screen.findByText(/12 past sessions \(4\.3 MB\) found for web-dashboard/)).toBeInTheDocument();
    expect(preview).toHaveBeenCalledWith(OLD, NEW);
    expect(screen.getByLabelText(/Carry over project settings/)).toBeChecked();
    expect(screen.getByLabelText(/Carry over its memory \(3 files\)/)).toBeChecked();
    expect(screen.getByText("Your old session files are copied, never moved or deleted.")).toBeInTheDocument();
  });

  it("says how many links were skipped, and that nothing was found when there's no entry", async () => {
    preview.mockResolvedValue({ ...FOUND, sessions: 1, bytes: 900, project_entry: false, memory_files: 0, linked: 2 });
    open({ start: { old: OLD, suggested: NEW } });
    expect(await screen.findByText(/2 linked items are skipped: a link isn't copied/)).toBeInTheDocument();
    expect(screen.getByText(/none found/)).toBeInTheDocument();
  });

  it("offers the folder that's open as the new place, and the native picker", async () => {
    const { pickFolder } = open({ start: { old: OLD, suggested: null } });
    fireEvent.click(await screen.findByRole("button", { name: "Use acme-api" }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(OLD, HERE));
    pickFolder.mockResolvedValueOnce(NEW);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(OLD, NEW));
    // A cancelled picker keeps the place it had.
    pickFolder.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(2));
    expect(screen.getByText(NEW)).toBeInTheDocument();
  });

  it("won't relocate a folder to where it was, and waits for the preview", async () => {
    open({ start: { old: OLD, suggested: OLD } });
    expect(await screen.findByText(/That's the folder it was/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Relocate" })).toBeDisabled();
  });

  it("relocates with the chosen options, and then says what was carried over", async () => {
    const { onDone } = open({ start: { old: OLD, suggested: NEW } });
    await screen.findByLabelText(/Carry over its memory/);
    fireEvent.click(screen.getByLabelText(/Carry over its memory/));
    fireEvent.click(screen.getByRole("button", { name: "Relocate" }));
    await waitFor(() => expect(relocate).toHaveBeenCalledWith(OLD, NEW, { project_settings: true, memory: false }));
    expect(await screen.findByText("Carried over: 2 project settings, 3 memory files, 2 permission rules.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledWith(OLD, NEW, { project_keys: ["allowedTools", "mcpServers"], memory_files: 3, rules: 2 });
  });

  it("shows what went wrong and leaves the move undone", async () => {
    relocate.mockRejectedValue("~/.claude.json changed while Lantern was copying it, so nothing was written. Try again.");
    const { onDone } = open({ start: { old: OLD, suggested: NEW } });
    fireEvent.click(await screen.findByRole("button", { name: "Relocate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed while Lantern was copying it");
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Relocate" })).toBeEnabled();
  });

  it("shows a preview that failed rather than relocating", async () => {
    preview.mockRejectedValue("That's the same folder.");
    open({ start: { old: OLD, suggested: NEW } });
    expect(await screen.findByText("That's the same folder.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Relocate" })).toBeDisabled();
  });
});
