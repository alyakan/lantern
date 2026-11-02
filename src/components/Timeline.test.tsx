import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TimelineEvent } from "../lib/timeline";
import { Timeline } from "./Timeline";

const ev = (key: string, over: Partial<TimelineEvent> = {}): TimelineEvent => ({ key, slot: `s-${key}`, team: false, title: `Chat ${key}`, folder: "/p/lantern", where: "lantern", at: Date.now() - 60_000, kind: "done", line: `Line ${key}`, unread: false, ...over });

describe("the timeline", () => {
  it("lists what is going on now, then what finished today, the unread ones marked, and opens one on a click", () => {
    const onOpen = vi.fn();
    render(<Timeline events={[ev("a", { kind: "waiting", line: "Wants to use Bash" }), ev("b", { unread: true }), ev("c", { kind: "failed" })]} onOpen={onOpen} />);
    const now = screen.getByRole("group", { name: "Now" });
    expect(within(now).getByRole("button", { name: "Chat a, needs you" })).toHaveTextContent("Wants to use Bash");
    const today = screen.getByRole("group", { name: "Today" });
    const unread = within(today).getByRole("button", { name: "Chat b, finished, unread" });
    expect(unread).toHaveClass("unread");
    expect(within(today).getByRole("button", { name: "Chat c, failed" })).toHaveTextContent("failed");
    fireEvent.click(unread);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ slot: "s-b" }));
  });

  it("says so when nothing has happened yet", () => {
    render(<Timeline events={[]} onOpen={vi.fn()} />);
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });
});
