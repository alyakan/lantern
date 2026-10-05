import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Hud } from "./Hud";

// jsdom has no AnimationEvent, so animationend would arrive without the animation's name.
if (!("AnimationEvent" in window)) {
  (window as unknown as { AnimationEvent: unknown }).AnimationEvent = class extends Event {
    animationName: string;
    constructor(type: string, init?: EventInit & { animationName?: string }) {
      super(type, init);
      this.animationName = init?.animationName ?? "";
    }
  };
}

describe("Hud", () => {
  // The window has focus unless a test blurs it.
  beforeEach(() => {
    window.dispatchEvent(new Event("focus"));
  });

  it("shows how the turn ended, then goes away once its animation ends", () => {
    const { rerender } = render(<Hud event={null} />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<Hud event={{ key: 1, kind: "finished", body: "The retry tests pass." }} />);
    expect(screen.getByRole("status")).toHaveTextContent("FinishedThe retry tests pass.");
    // The glow ending isn't the toast's time running out.
    fireEvent.animationEnd(screen.getByRole("status"), { animationName: "hud-glow" });
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.animationEnd(screen.getByRole("status"), { animationName: "toast" });
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<Hud event={{ key: 2, kind: "stopped" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Stopped");
  });

  it("waits until you're back in the window, so it isn't played to nobody", () => {
    window.dispatchEvent(new Event("blur"));
    render(<Hud event={{ key: 1, kind: "finished", detail: "in 2m" }} />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Finished");
  });

  it("keeps Needs you up until it's dealt with, and takes it down when the app does", () => {
    const waiting = { key: 1, kind: "waiting" as const, body: "Wants to use Bash: npm test", chat: { slot: "s2", title: "Add retries", project: null } };
    const { rerender } = render(<Hud event={waiting} />);
    fireEvent.animationEnd(screen.getByRole("status"), { animationName: "toast-in" });
    expect(screen.getByRole("status")).toHaveTextContent("Needs youAdd retriesWants to use Bash: npm test");
    rerender(<Hud event={null} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("turns its sound on and off without opening the chat", () => {
    localStorage.removeItem("toast.sound");
    const onOpenChat = vi.fn();
    render(<Hud event={{ key: 1, kind: "finished", chat: { slot: "s2", title: "Add retries", project: null } }} onOpenChat={onOpenChat} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn toast sounds on" }));
    expect(localStorage.getItem("toast.sound")).toBe("on");
    expect(screen.getByRole("button", { name: "Turn toast sounds off" })).toHaveAttribute("aria-pressed", "true");
    expect(onOpenChat).not.toHaveBeenCalled();
  });

  it("can be dismissed with its × or Esc, without opening the chat", () => {
    const onOpenChat = vi.fn();
    const waiting = { kind: "waiting" as const, chat: { slot: "s2", title: "Add retries", project: null } };
    const { rerender } = render(<Hud event={{ key: 1, ...waiting }} onOpenChat={onOpenChat} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(onOpenChat).not.toHaveBeenCalled();
    rerender(<Hud event={{ key: 2, ...waiting }} onOpenChat={onOpenChat} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("about another chat, names it and opens it when clicked", () => {
    const onOpenChat = vi.fn();
    render(<Hud event={{ key: 1, kind: "waiting", chat: { slot: "s2", title: "Add retries", project: "web" } }} onOpenChat={onOpenChat} />);
    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent("Needs you");
    expect(toast).toHaveTextContent("Add retries");
    expect(toast).toHaveTextContent("web");
    fireEvent.click(toast);
    expect(onOpenChat).toHaveBeenCalledWith("s2");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
