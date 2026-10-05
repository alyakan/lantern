import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FolderPill } from "./FolderPill";

const recent = [
  { path: "/Users/me/src/acme-api", updated_ms: 2 },
  { path: "/Users/me/src/web", updated_ms: 1 },
];

describe("FolderPill", () => {
  it("lists recent folders and switches to one", async () => {
    const onPick = vi.fn();
    render(<FolderPill folder="/Users/me/src/acme-api" loadRecent={async () => recent} onPick={onPick} onBrowse={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /acme-api/ }));
    expect(await screen.findByRole("menuitem", { name: /acme-api.*Current/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /web/ }));
    expect(onPick).toHaveBeenCalledWith("/Users/me/src/web");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not restart when the current folder is picked, and can browse for another", async () => {
    const onPick = vi.fn();
    const onBrowse = vi.fn();
    render(<FolderPill folder="/Users/me/src/acme-api" loadRecent={async () => recent} onPick={onPick} onBrowse={onBrowse} />);
    fireEvent.click(screen.getByRole("button", { name: /acme-api/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /acme-api/ }));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /acme-api/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open folder…" }));
    expect(onBrowse).toHaveBeenCalled();
  });

  it("says so when there are no recent folders", async () => {
    render(<FolderPill folder={null} loadRecent={async () => []} onPick={() => {}} onBrowse={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    expect(await screen.findByText("No recent folders")).toBeInTheDocument();
  });
});
