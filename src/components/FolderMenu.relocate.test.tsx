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
  it("offers a moved folder, with where it probably went, and relocates it when picked", () => {
    const { onClose, onRelocate } = menu({});
    expect(screen.getByText("Moved?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /web-dashboard moved\?/ }));
    expect(onClose).toHaveBeenCalled();
    expect(onRelocate).toHaveBeenCalledWith({ old: OLD, suggested: NEW });
  });

  it("says where it was when nothing matches it", () => {
    menu({ moved: [{ old: OLD, suggested: null }] });
    expect(screen.getByRole("menuitem", { name: /web-dashboard moved\?/ })).toHaveTextContent("Was /Users/you/Documents/Github");
  });

  it("dismisses a notice without relocating", () => {
    const { onRelocate, onDismiss } = menu({});
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the moved notice for web-dashboard" }));
    expect(onDismiss).toHaveBeenCalledWith(OLD);
    expect(onRelocate).not.toHaveBeenCalled();
  });

  it("opens the Relocate dialog from the folder menu, for any folder", () => {
    const { onClose, onRelocate } = menu({});
    fireEvent.click(screen.getByRole("menuitem", { name: "Relocate folder…" }));
    expect(onClose).toHaveBeenCalled();
    expect(onRelocate).toHaveBeenCalledWith(null);
  });

  it("shows no moved section, and no relocate item, without the relocation parts", () => {
    menu(undefined);
    expect(screen.queryByText("Moved?")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Relocate folder…" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open folder…" })).toBeInTheDocument();
  });

  it("shows no moved section when nothing is left to offer", () => {
    menu({ moved: [] });
    expect(screen.queryByText("Moved?")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Relocate folder…" })).toBeInTheDocument();
  });
});
