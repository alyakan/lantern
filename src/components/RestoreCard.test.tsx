import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SavedChat } from "../lib/restore";
import { RestoreCard } from "./RestoreCard";

const chats: SavedChat[] = [
  { sessionId: "a", folder: "/work/app", title: "Retry flaky uploads", draft: "", active: true },
  { sessionId: "b", folder: "/work/site", title: "Fix the footer", draft: "and the header too", active: false },
];

describe("RestoreCard", () => {
  it("lists the chats from last time, naming another folder and unsent text", () => {
    render(<RestoreCard chats={chats} folder="/work/app" onRestoreAll={() => {}} onRestore={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText("2 chats were open when Lantern closed")).toBeTruthy();
    const footer = screen.getByRole("button", { name: /Fix the footer/ });
    expect(footer.textContent).toContain("site");
    expect(footer.textContent).toContain("Unsent text");
    expect(screen.getByRole("button", { name: /Retry flaky uploads/ }).textContent).not.toContain("app");
  });

  it("restores all, one, or none", () => {
    const [all, one, dismiss] = [vi.fn(), vi.fn(), vi.fn()];
    render(<RestoreCard chats={chats} folder="/work/app" onRestoreAll={all} onRestore={one} onDismiss={dismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    expect(all).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Fix the footer/ }));
    expect(one).toHaveBeenCalledWith(chats[1]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismiss).toHaveBeenCalled();
  });

  it("says Restore for a single chat", () => {
    render(<RestoreCard chats={[chats[0]]} folder="/work/app" onRestoreAll={() => {}} onRestore={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText("A chat was open when Lantern closed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
  });
});
