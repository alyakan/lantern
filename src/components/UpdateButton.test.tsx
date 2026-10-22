import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UpdateButton } from "./UpdateButton";

describe("UpdateButton", () => {
  it("says an update is ready, and which version", () => {
    render(<UpdateButton version="0.1.2" busy={0} onRestart={() => {}} onLater={() => {}} />);
    expect(screen.getByRole("button", { name: /Update ready/ })).toHaveAttribute("title", "Lantern 0.1.2 is ready. Click to restart and update; your chats come back.");
  });

  it("restarts right away when no chat is working", () => {
    const onRestart = vi.fn();
    render(<UpdateButton version="0.1.2" busy={0} onRestart={onRestart} onLater={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Update ready/ }));
    expect(onRestart).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks first when chats are working, and restarts only if told to", () => {
    const onRestart = vi.fn();
    render(<UpdateButton version="0.1.2" busy={2} onRestart={onRestart} onLater={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Update ready/ }));
    expect(onRestart).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("2 chats are still working. Restarting interrupts them; your chats come back afterwards, ready for your next message.");
    fireEvent.click(screen.getByRole("button", { name: "Restart and restore chats" }));
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it("can leave the update for when you quit", () => {
    const onLater = vi.fn();
    render(<UpdateButton version="0.1.2" busy={1} onRestart={() => {}} onLater={onLater} />);
    fireEvent.click(screen.getByRole("button", { name: /Update ready/ }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("1 chat is still working. Restarting interrupts it;");
    fireEvent.click(screen.getByRole("button", { name: "Update when I quit" }));
    expect(onLater).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("closes the question on Escape", () => {
    render(<UpdateButton version="0.1.2" busy={1} onRestart={() => {}} onLater={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Update ready/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
