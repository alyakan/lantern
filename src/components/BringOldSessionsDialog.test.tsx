import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api";
import type { FolderSessions, OldLocation, RelocationPreview } from "../types";
import { BringOldSessionsDialog } from "./BringOldSessionsDialog";

vi.mock("../api", () => ({
  api: { oldLocations: vi.fn(), knownFolders: vi.fn(), relocationPreview: vi.fn(), relocateFolder: vi.fn() },
}));
const locations = vi.mocked(api.oldLocations);
const known = vi.mocked(api.knownFolders);
const preview = vi.mocked(api.relocationPreview);
const relocate = vi.mocked(api.relocateFolder);

const DAY = 24 * 3_600_000;
const DEST = "/Users/you/projects/acme-api";
const CODE: OldLocation = { path: "/Users/you/Documents/Github/acme-api", exists: true, sessions: 7, updated_ms: Date.now() - 2 * DAY, already: false };
const LAPTOP: OldLocation = { path: "/Users/you/old-laptop/acme-api", exists: false, sessions: 5, updated_ms: Date.now() - 9 * DAY, already: false };
const SRC: OldLocation = { path: "/Users/you/src/acme-api", exists: true, sessions: 4, updated_ms: Date.now() - 40 * DAY, already: true };
const WEB: FolderSessions = { path: "/Users/you/Documents/Github/web-dashboard", exists: false, sessions: 9, updated_ms: Date.now() - 12 * DAY };
const NOTES: FolderSessions = { path: "/Users/you/notes", exists: true, sessions: 3, updated_ms: Date.now() - 5 * DAY };
const FOUND: RelocationPreview = { sessions: 7, bytes: 4_300_000, project_entry: true, memory_files: 3, rules: 2, linked: 0 };
const OUTCOME = { project_keys: ["mcpServers"], memory_files: 3, rules: 2 };

beforeEach(() => {
  vi.resetAllMocks();
  locations.mockResolvedValue([CODE, LAPTOP, SRC]);
  known.mockResolvedValue([{ path: DEST, exists: true, sessions: 12, updated_ms: Date.now() }, NOTES, WEB]);
  preview.mockResolvedValue(FOUND);
  relocate.mockResolvedValue(OUTCOME);
});

function open(props: Partial<Parameters<typeof BringOldSessionsDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onRelocated = vi.fn();
  const onOpenHistory = vi.fn();
  const pickFolder = vi.fn(async () => null as string | null);
  const view = render(
    <BringOldSessionsDialog destination={DEST} pickFolder={pickFolder} onClose={onClose} onRelocated={onRelocated} onOpenHistory={onOpenHistory} {...props} />,
  );
  return { ...view, onClose, onRelocated, onOpenHistory, pickFolder };
}

/** The text a user can read in the dialog: its text, and the labels and tooltips on its controls. */
function readable(): string {
  const dialog = document.querySelector("dialog");
  if (!dialog) return "";
  const labels = [...dialog.querySelectorAll("[title], [aria-label], [placeholder]")].flatMap((el) => ["title", "aria-label", "placeholder"].map((a) => el.getAttribute(a) ?? ""));
  return [dialog.textContent ?? "", ...labels].join("\n");
}

describe("the places with sessions", () => {
  it("names the project and lists each place with its sessions, all checked but the one already brought over", async () => {
    open();
    expect(await screen.findByText(/Lantern found chats from earlier locations of "acme-api":/)).toBeInTheDocument();
    expect(screen.getByText("Bring old chats into acme-api")).toBeInTheDocument();
    expect(screen.getByText("acme-api")).toBeInTheDocument();
    expect(screen.getByTitle(DEST)).toHaveTextContent("~/projects/acme-api");
    expect(screen.getByRole("checkbox", { name: /acme-api.*7 chats/ })).toBeChecked();
    const gone = screen.getByRole("checkbox", { name: /old-laptop/ });
    expect(gone).toBeChecked();
    expect(within(gone.closest("label")!).getByText("folder no longer exists")).toBeInTheDocument();
    const done = screen.getByRole("checkbox", { name: /~\/src\/acme-api/ });
    expect(done).toBeDisabled();
    expect(done).not.toBeChecked();
    expect(within(done.closest("label")!).getByText(/already brought over/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bring 12 chats here" })).toBeEnabled();
    expect(screen.getByText("Your old chats stay where they are: Lantern copies what's needed.")).toBeInTheDocument();
  });

  it("counts only the checked places, and can't bring nothing", async () => {
    open();
    const first = await screen.findByRole("checkbox", { name: /~\/Documents\/Github\/acme-api/ });
    fireEvent.click(first);
    expect(screen.getByRole("button", { name: "Bring 5 chats here" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /old-laptop/ }));
    expect(screen.getByRole("button", { name: "Bring 0 chats here" })).toBeDisabled();
  });

  it("shows a long path cut in the middle, with the whole path as its tooltip", async () => {
    const deep = "/Users/you/Documents/Github/Personal/clients/acme/services/billing-api/acme-api";
    locations.mockResolvedValue([{ ...CODE, path: deep }]);
    open();
    const shown = (await screen.findByTitle(deep)).querySelector(".bring-row-path");
    expect(shown?.textContent).toContain("…");
    expect(shown!.textContent!.length).toBeLessThan(deep.length);
  });
});

describe("when nothing is found under the name", () => {
  beforeEach(() => locations.mockResolvedValue([]));

  it("says so and offers the folders with sessions to choose from, filtered as typed, one at a time", async () => {
    open();
    expect(await screen.findByText('No old chats found under the name "acme-api".')).toBeInTheDocument();
    // The project itself isn't offered.
    expect(screen.queryByRole("radio", { name: /~\/projects\/acme-api/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter folders" }), { target: { value: "dash" } });
    expect(screen.getByRole("radio", { name: /web-dashboard/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /notes/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /web-dashboard/ }));
    // The chosen folder is the place to bring from, with its sessions and that it's gone.
    expect(screen.getByRole("checkbox", { name: /web-dashboard/ })).toBeChecked();
    expect(screen.getAllByText("folder no longer exists").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Bring 9 chats here" })).toBeEnabled();
  });

  it("picks the first folder shown when Enter is pressed in the filter, without bringing anything", async () => {
    open();
    const filter = await screen.findByRole("textbox", { name: "Filter folders" });
    fireEvent.change(filter, { target: { value: "notes" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(await screen.findByRole("checkbox", { name: /notes.*3 chats/ })).toBeChecked();
    expect(relocate).not.toHaveBeenCalled();
  });

  it("starts from a moved folder whose new place wasn't found by name, so it's offered as a place", async () => {
    known.mockResolvedValue([{ path: DEST, exists: true, sessions: 12, updated_ms: Date.now() }, WEB]);
    open({ from: WEB.path });
    expect(await screen.findByRole("checkbox", { name: /web-dashboard/ })).toBeChecked();
    expect(screen.queryByText(/No old chats found/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bring 9 chats here" })).toBeEnabled();
  });
});

describe("without a project", () => {
  it("the only action is choosing the project folder, and then the places are looked for", async () => {
    const { pickFolder } = open({ destination: null });
    expect(screen.getByText("Bring old chats into a project")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Bring \d/ })).not.toBeInTheDocument();
    pickFolder.mockResolvedValueOnce(DEST);
    fireEvent.click(screen.getByRole("button", { name: "Choose the project folder…" }));
    await waitFor(() => expect(locations).toHaveBeenCalledWith(DEST));
    expect(await screen.findByRole("button", { name: "Bring 12 chats here" })).toBeEnabled();
  });

  it("a cancelled picker keeps the dialog as it was", async () => {
    const { pickFolder } = open({ destination: null });
    fireEvent.click(screen.getByRole("button", { name: "Choose the project folder…" }));
    await waitFor(() => expect(pickFolder).toHaveBeenCalled());
    expect(locations).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose the project folder…" })).toBeInTheDocument();
  });
});

describe("bringing the sessions", () => {
  it("brings each checked place in turn, says how many are in History, and offers to open it", async () => {
    const { onRelocated, onClose, onOpenHistory } = open();
    fireEvent.click(await screen.findByRole("button", { name: "Bring 12 chats here" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Done: 12 chats are in History now.");
    expect(relocate.mock.calls).toEqual([
      [CODE.path, DEST, { project_settings: true, memory: true }],
      [LAPTOP.path, DEST, { project_settings: true, memory: true }],
    ]);
    expect(onRelocated.mock.calls).toEqual([
      [CODE.path, DEST, OUTCOME],
      [LAPTOP.path, DEST, OUTCOME],
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Open History" }));
    expect(onOpenHistory).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("without the History button (another project is open), the success ends with Close", async () => {
    open({ onOpenHistory: undefined });
    fireEvent.click(await screen.findByRole("button", { name: "Bring 12 chats here" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Done: 12 chats are in History now.");
    expect(screen.queryByRole("button", { name: "Open History" })).not.toBeInTheDocument();
  });

  it("when a place fails, it's listed with why, the dialog stays, and the next press brings just that place", async () => {
    const { onRelocated } = open();
    // The first place (the one in the Documents folder) comes over; the second one fails.
    relocate.mockResolvedValueOnce(OUTCOME);
    relocate.mockRejectedValueOnce("~/.claude.json changed while Lantern was copying it, so nothing was written. Try again.");
    // After the attempt the places are looked up again: the one that came over is now already brought over.
    locations.mockResolvedValueOnce([{ ...CODE, already: true }, LAPTOP, { ...SRC }]);
    fireEvent.click(await screen.findByRole("button", { name: "Bring 12 chats here" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("changed while Lantern was copying it");
    expect(alert).toHaveTextContent("~/old-laptop/acme-api");
    expect(onRelocated).toHaveBeenCalledTimes(1);
    const retry = screen.getByRole("button", { name: "Bring 5 chats here" });
    expect(screen.getByRole("checkbox", { name: /~\/Documents\/Github\/acme-api/ })).toBeDisabled();
    fireEvent.click(retry);
    expect(await screen.findByRole("status")).toHaveTextContent("Done: 12 chats are in History now.");
    expect(relocate).toHaveBeenLastCalledWith(LAPTOP.path, DEST, { project_settings: true, memory: true });
    expect(relocate).toHaveBeenCalledTimes(3);
  });

  it("the Details choices go to the move, and say 'none found' when the preview has nothing", async () => {
    preview.mockImplementation(async (old) => (old === LAPTOP.path ? { ...FOUND, project_entry: false, memory_files: 0, rules: 0 } : FOUND));
    open();
    await screen.findByRole("button", { name: "Bring 12 chats here" });
    fireEvent.click(screen.getByRole("checkbox", { name: /~\/Documents\/Github\/acme-api/ }));
    await waitFor(() => expect(screen.getAllByText("none found")).toHaveLength(2));
    fireEvent.click(screen.getByText("Details"));
    fireEvent.click(screen.getByRole("checkbox", { name: /memory/ }));
    fireEvent.click(screen.getByRole("button", { name: "Bring 5 chats here" }));
    await waitFor(() => expect(relocate).toHaveBeenCalledWith(LAPTOP.path, DEST, { project_settings: true, memory: false }));
  });

  it("the Details checkboxes are on by default, with plain wording", async () => {
    open();
    await screen.findByRole("button", { name: "Bring 12 chats here" });
    expect(screen.getByRole("checkbox", { name: /MCP servers and permissions, including your "Always allow" choices \(Claude Code keeps these per folder\)/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /its memory \(notes Claude saved about this project\)/ })).toBeChecked();
  });
});

describe("keyboard access", () => {
  it("puts focus on the action once the places are in", async () => {
    open();
    const action = await screen.findByRole("button", { name: "Bring 12 chats here" });
    // The button is there a moment before focus moves to it.
    await waitFor(() => expect(action).toHaveFocus());
  });

  it("puts focus on the filter when nothing was found", async () => {
    locations.mockResolvedValue([]);
    open();
    const filter = await screen.findByRole("textbox", { name: "Filter folders" });
    // The box is there before the search ends: focus moves to it once nothing was found.
    await waitFor(() => expect(filter).toHaveFocus());
  });

  it("Escape closes the dialog, unless a move is running", async () => {
    const { onClose } = open();
    await screen.findByRole("button", { name: "Bring 12 chats here" });
    fireEvent(document.querySelector("dialog")!, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter on the action brings the sessions", async () => {
    open();
    const action = await screen.findByRole("button", { name: "Bring 12 chats here" });
    fireEvent.submit(action.closest("form")!);
    await waitFor(() => expect(relocate).toHaveBeenCalledTimes(2));
  });
});

describe("the words the dialog shows", () => {
  const BANNED = /alias|relocat|transcript|preview/i;

  it("are plain in every state", async () => {
    const seen: string[] = [];
    const first = open({ destination: null });
    seen.push(readable());
    first.unmount();

    const detected = open();
    await screen.findByRole("button", { name: "Bring 12 chats here" });
    seen.push(readable());
    fireEvent.click(screen.getByRole("checkbox", { name: /old-laptop/ }));
    seen.push(readable());
    detected.unmount();

    locations.mockResolvedValue([]);
    const none = open();
    await screen.findByRole("textbox", { name: "Filter folders" });
    seen.push(readable());
    none.unmount();

    locations.mockResolvedValue([CODE, LAPTOP, SRC]);
    relocate.mockRejectedValueOnce("~/.claude.json changed while Lantern was copying it.");
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Bring 12 chats here" }));
    await screen.findByRole("alert");
    seen.push(readable());

    for (const text of seen) expect(text).not.toMatch(BANNED);
  });
});
