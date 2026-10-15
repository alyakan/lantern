import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FolderMenu, type RelocateMenu } from "./FolderPill";

const OLD = "/Users/you/Documents/Github/web-dashboard";
const NEW = "/Users/you/projects/web-dashboard";

function menu(relocate?: Partial<RelocateMenu>, props: { onClose?: () => void; onBrowse?: () => void } = {}) {
  const onClose = props.onClose ?? vi.fn();
  const onRelocate = vi.fn();
  const onDismiss = vi.fn();
  const full: RelocateMenu | undefined = relocate ? { moved: [{ old: OLD, suggested: NEW }], onRelocate, onDismiss, ...relocate } : undefined;
  render(<FolderMenu folder={null} recent={[{ path: NEW, updated_ms: 1 }]} onPick={vi.fn()} onBrowse={props.onBrowse ?? vi.fn()} onClose={onClose} relocate={full} />);
  return { onClose, onRelocate, onDismiss };
}

describe("the folder menu's moved folders", () => {
  it("lists a moved folder with the place its chats go to, and moves them when asked", () => {
    const { onClose, onRelocate } = menu({});
    expect(screen.getByText("Folders that moved")).toBeInTheDocument();
    expect(screen.getByText(/These folders are gone/)).toBeInTheDocument();
    // The old path and the new one, each with the full path as its tooltip.
    expect(screen.getByTitle(OLD)).toBeInTheDocument();
    expect(screen.getAllByTitle(NEW).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("menuitem", { name: `Move chats from ${OLD} to ${NEW}` }));
    expect(onClose).toHaveBeenCalled();
    expect(onRelocate).toHaveBeenCalledWith({ old: OLD, suggested: NEW });
  });

  it("offers to choose a folder when nothing matches the moved one", () => {
    const { onRelocate } = menu({ moved: [{ old: OLD, suggested: null }] });
    expect(screen.getByText("Choose a folder…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: `Move chats from ${OLD}` }));
    expect(onRelocate).toHaveBeenCalledWith({ old: OLD, suggested: null });
  });

  it("hides a notice with Not moved, without bringing anything over or closing the menu", () => {
    const { onClose, onRelocate, onDismiss } = menu({});
    fireEvent.click(screen.getByRole("menuitem", { name: "Not moved: hide the notice for web-dashboard" }));
    expect(onDismiss).toHaveBeenCalledWith(OLD);
    expect(onRelocate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("lists three moved folders and the rest after Show all", () => {
    const moved = ["a", "b", "c", "d", "e"].map((n) => ({ old: `/gone/${n}`, suggested: null }));
    menu({ moved });
    expect(screen.getAllByRole("menuitem", { name: /^Move chats from/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all 5…" }));
    expect(screen.getAllByRole("menuitem", { name: /^Move chats from/ })).toHaveLength(5);
    fireEvent.click(screen.getByRole("menuitem", { name: "Show fewer" }));
    expect(screen.getAllByRole("menuitem", { name: /^Move chats from/ })).toHaveLength(3);
  });

  it("has no Show all for three or fewer", () => {
    menu({ moved: ["a", "b", "c"].map((n) => ({ old: `/gone/${n}`, suggested: null })) });
    expect(screen.queryByRole("menuitem", { name: /^Show all/ })).not.toBeInTheDocument();
  });

  it("opens the Bring old sessions dialog from the folder menu, for the open folder", () => {
    const { onClose, onRelocate } = menu({});
    fireEvent.click(screen.getByRole("menuitem", { name: "Bring old chats here…" }));
    expect(onClose).toHaveBeenCalled();
    expect(onRelocate).toHaveBeenCalledWith(null);
  });

  it("shows no moved section, and no bring item, without the moved parts", () => {
    menu(undefined);
    expect(screen.queryByText("Folders that moved")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Bring old chats here…" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open folder…" })).toBeInTheDocument();
  });

  it("shows no moved section when nothing is left to offer", () => {
    menu({ moved: [] });
    expect(screen.queryByText("Folders that moved")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Bring old chats here…" })).toBeInTheDocument();
  });
});
