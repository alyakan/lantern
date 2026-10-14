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
  it("offers a moved folder, with the place its sessions go to, and brings them over when picked", () => {
    const { onClose, onRelocate } = menu({});
    expect(screen.getByText("Moved?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /web-dashboard was moved\? Bring its sessions to web-dashboard/ }));
    expect(onClose).toHaveBeenCalled();
    expect(onRelocate).toHaveBeenCalledWith({ old: OLD, suggested: NEW });
  });

  it("says where it was, and that its sessions go to a folder to choose, when nothing matches it", () => {
    menu({ moved: [{ old: OLD, suggested: null }] });
    expect(screen.getByRole("menuitem", { name: /web-dashboard was moved\? Bring its sessions to a folder/ })).toHaveTextContent("Was in /Users/you/Documents/Github");
  });

  it("dismisses a notice without bringing anything over", () => {
    const { onRelocate, onDismiss } = menu({});
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the moved notice for web-dashboard" }));
    expect(onDismiss).toHaveBeenCalledWith(OLD);
    expect(onRelocate).not.toHaveBeenCalled();
  });

  it("opens the Bring old sessions dialog from the folder menu, for the open folder", () => {
    const { onClose, onRelocate } = menu({});
    fireEvent.click(screen.getByRole("menuitem", { name: "Bring old sessions here…" }));
    expect(onClose).toHaveBeenCalled();
    expect(onRelocate).toHaveBeenCalledWith(null);
  });

  it("shows no moved section, and no bring item, without the moved parts", () => {
    menu(undefined);
    expect(screen.queryByText("Moved?")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Bring old sessions here…" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open folder…" })).toBeInTheDocument();
  });

  it("shows no moved section when nothing is left to offer", () => {
    menu({ moved: [] });
    expect(screen.queryByText("Moved?")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Bring old sessions here…" })).toBeInTheDocument();
  });
});
