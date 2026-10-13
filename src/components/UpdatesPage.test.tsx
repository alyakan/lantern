import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { UpdateState } from "../types";
import { UpdatesPage, type UpdatesPageProps } from "./UpdatesPage";
import { UpdatingOverlay } from "./UpdatingOverlay";

const show = (state: UpdateState, over: Partial<UpdatesPageProps> = {}) => render(<UpdatesPage version="0.1.9" state={state} onCheck={() => {}} ready={null} {...over} />);

describe("UpdatesPage", () => {
  it("shows the running version, and a button that looks for an update", () => {
    const onCheck = vi.fn();
    show({ kind: "idle" }, { onCheck });
    expect(screen.getByText("0.1.9")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(onCheck).toHaveBeenCalled();
  });

  it("says it's looking, and doesn't take a second request meanwhile", () => {
    show({ kind: "checking" });
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Looking for a newer version…");
  });

  it("shows a download's progress as a number and a bar, or a moving bar when the size isn't known", () => {
    const { rerender } = show({ kind: "downloading", version: "0.1.10", downloaded: 45, total: 100 });
    expect(screen.getByRole("status")).toHaveTextContent("Downloading Lantern 0.1.10 · 45%");
    expect(screen.getByRole("progressbar", { name: "Downloading Lantern 0.1.10" })).toHaveAttribute("aria-valuenow", "45");
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    rerender(<UpdatesPage version="0.1.9" state={{ kind: "downloading", version: "0.1.10", downloaded: 45, total: null }} onCheck={() => {}} ready={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Downloading Lantern 0.1.10…");
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });

  it("says when it's up to date, and why a check failed", () => {
    const { rerender } = show({ kind: "up_to_date" });
    expect(screen.getByRole("status")).toHaveTextContent("You're up to date.");
    rerender(<UpdatesPage version="0.1.9" state={{ kind: "failed", error: "Couldn't reach GitHub." }} onCheck={() => {}} ready={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't reach GitHub.");
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });

  it("offers the downloaded update with the same button as under the chat box, and says it installs on quit if it's left for then", () => {
    const onRestart = vi.fn();
    const { rerender } = show({ kind: "ready", version: "0.1.10" }, { ready: { version: "0.1.10", busy: 0, onRestart, onLater: () => {} } });
    expect(screen.getByText("Lantern 0.1.10 is downloaded and ready.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Update ready/ }));
    expect(onRestart).toHaveBeenCalled();
    rerender(<UpdatesPage version="0.1.9" state={{ kind: "ready", version: "0.1.10" }} onCheck={() => {}} ready={null} />);
    expect(screen.getByText("Lantern 0.1.10 is downloaded. It installs when you quit.")).toBeInTheDocument();
  });

  it("asks before restarting while chats are working, as the other button does", () => {
    const onRestart = vi.fn();
    show({ kind: "ready", version: "0.1.10" }, { ready: { version: "0.1.10", busy: 2, onRestart, onLater: () => {} } });
    fireEvent.click(screen.getByRole("button", { name: /Update ready/ }));
    expect(onRestart).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("2 chats are still working");
    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    expect(onRestart).toHaveBeenCalled();
  });
});

describe("UpdatingOverlay", () => {
  it("says which version it's updating to, then that it's restarting", () => {
    const { rerender } = render(<UpdatingOverlay state={{ kind: "installing", version: "0.1.10" }} version={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Updating to Lantern 0.1.10");
    expect(screen.getByRole("alert")).toHaveTextContent("Installing the update…");
    rerender(<UpdatingOverlay state={{ kind: "restarting" }} version="0.1.10" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Updating to Lantern 0.1.10");
    expect(screen.getByRole("alert")).toHaveTextContent("Closing your chats and restarting…");
  });

  it("offers What's new for the running version and the waiting one, when they have notes", () => {
    const onWhatsNew = vi.fn();
    show({ kind: "idle" }, { whatsNew: ["0.1.9", "0.1.10"], onWhatsNew });
    fireEvent.click(screen.getByRole("button", { name: "What's new in 0.1.10" }));
    expect(onWhatsNew).toHaveBeenCalledWith("0.1.10");
    expect(screen.getByRole("button", { name: "What's new in 0.1.9" })).toBeInTheDocument();
  });

  it("offers no What's new when no version has notes", () => {
    show({ kind: "idle" }, { whatsNew: [], onWhatsNew: () => {} });
    expect(screen.queryByRole("button", { name: /What's new/ })).toBeNull();
  });

  it("shows straight away, before the backend has said anything, and can't be dismissed", () => {
    render(<UpdatingOverlay state={{ kind: "idle" }} version="0.1.10" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Updating to Lantern 0.1.10");
    const dialog = document.querySelector("dialog.updating")!;
    const cancel = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
  });
});
