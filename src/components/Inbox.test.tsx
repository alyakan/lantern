import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { InboxItem } from "../lib/inbox";
import { resetActionsForTest, runAction } from "../lib/actions";
import type { PlanPause } from "../lib/planPause";
import { Inbox } from "./Inbox";

const item = (over: Partial<InboxItem> & { slot: string }): InboxItem => ({ key: over.slot, kind: "permission", role: "chat", team: null, title: `Chat ${over.slot}`, where: "lantern", need: "Wants to use Bash: npm test", since: Date.now() - 180_000, requestId: `r-${over.slot}`, canAllow: true, detail: null, needsYou: true, ...over });

function setup(items: InboxItem[], paused: PlanPause | null = null) {
  resetActionsForTest();
  const onGo = vi.fn();
  const onDecide = vi.fn();
  const onResume = vi.fn();
  render(<Inbox items={items} onGo={onGo} onDecide={onDecide} paused={paused} onResume={onResume} />);
  return { onGo, onDecide, onResume, toggle: () => screen.getByRole("button", { name: /What needs you/ }) };
}

describe("Inbox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("lists a quiet agent like anything else that waits, with Go", () => {
    const row = item({ slot: "a1", kind: "quiet", role: "agent", team: "lead", title: "security pass", need: "Quiet while working. It may be stuck", requestId: null, canAllow: false, since: Date.now() - 4 * 60_000 });
    const { toggle, onGo } = setup([row]);
    expect(toggle()).toHaveAccessibleName("What needs you, 1 waiting");
    fireEvent.click(toggle());
    expect(screen.getByText("Quiet while working. It may be stuck")).toBeInTheDocument();
    expect(screen.getByText("4m")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to security pass" }));
    expect(onGo).toHaveBeenCalledWith(row);
  });

  describe("when the teams' work was paused", () => {
    const pause = (): PlanPause => ({ percent: 95, resetsAt: Math.floor(Date.now() / 1000) + 72 * 60 + 30, since: Date.now() - 60_000, slots: ["s1", "w1"] });

    it("has a row of its own at the top, counted, with when the plan resets and Resume", () => {
      const { toggle, onResume } = setup([item({ slot: "s2" })], pause());
      expect(toggle()).toHaveAccessibleName("What needs you, 2 waiting");
      fireEvent.click(toggle());
      const [first] = screen.getAllByRole("listitem");
      expect(within(first).getByText("Paused: your plan is 95% used, it resets in 1h 12m")).toBeInTheDocument();
      expect(within(first).getByText(/2 agents stopped, none ended/)).toBeInTheDocument();
      expect(within(first).getByText(/Continue where you stopped\./)).toBeInTheDocument();
      // It opens on Resume, which is the row's Go.
      expect(within(first).getByRole("button", { name: "Resume the paused agents" })).toHaveFocus();
      fireEvent.click(within(first).getByRole("button", { name: "Resume the paused agents" }));
      expect(onResume).toHaveBeenCalledTimes(1);
    });

    it("is there even when nothing else waits", () => {
      const { toggle } = setup([], pause());
      fireEvent.click(toggle());
      expect(screen.queryByText("Nothing is waiting for you.")).toBeNull();
      expect(screen.getByRole("button", { name: "Resume the paused agents" })).toBeInTheDocument();
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a button with the count of what waits on you", () => {
    const { toggle } = setup([item({ slot: "s1" }), item({ slot: "s2" }), item({ slot: "s3", kind: "unread", needsYou: false, requestId: null })]);
    expect(toggle()).toHaveAccessibleName("What needs you, 2 waiting");
    expect(toggle()).toHaveTextContent("2");
  });

  it("says nothing is waiting when the list is empty", () => {
    const { toggle } = setup([]);
    expect(toggle()).toHaveAccessibleName("What needs you");
    fireEvent.click(toggle());
    expect(screen.getByText("Nothing is waiting for you.")).toBeInTheDocument();
  });

  it("shows each row's title, project, need and how long it has waited", () => {
    const { toggle } = setup([item({ slot: "s1", title: "Fix the build", where: "lantern · Ship it" })]);
    fireEvent.click(toggle());
    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Fix the build")).toBeInTheDocument();
    expect(within(row).getByText("lantern · Ship it")).toBeInTheDocument();
    expect(within(row).getByText("Wants to use Bash: npm test")).toBeInTheDocument();
    expect(within(row).getByText("3m")).toBeInTheDocument();
  });

  it("Go takes you there and closes it", () => {
    const row = item({ slot: "s1" });
    const { toggle, onGo } = setup([row]);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "Go to Chat s1" }));
    expect(onGo).toHaveBeenCalledWith(row);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("answers a plain permission in place, and only a plain one", () => {
    const plain = item({ slot: "s1", detail: "npm test" });
    const plan = item({ slot: "s2", kind: "plan", requestId: null, canAllow: false });
    const { toggle, onDecide } = setup([plain, plan]);
    fireEvent.click(toggle());
    expect(screen.getAllByRole("button", { name: /^Allow / })).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.click(screen.getByRole("button", { name: "Allow Chat s1" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny Chat s1" }));
    expect(onDecide.mock.calls).toEqual([[plain, true], [plain, false]]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps a new row's Allow dead for a moment, so a click aimed at the row before can't land on it", () => {
    resetActionsForTest();
    const onDecide = vi.fn();
    const first = item({ slot: "s1", requestId: "r1", detail: "npm test" });
    const { rerender } = render(<Inbox items={[first]} onGo={vi.fn()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: /What needs you/ }));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole("button", { name: "Allow Chat s1" })).toHaveAttribute("aria-disabled", "false");
    rerender(<Inbox items={[{ ...first, requestId: "r2", detail: "rm -rf build" }]} onGo={vi.fn()} onDecide={onDecide} />);
    const next = screen.getByRole("button", { name: "Allow Chat s1" });
    expect(next).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(next);
    expect(onDecide).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(next).toHaveAttribute("aria-disabled", "false");
  });

  it("keeps Allow dead on the row that moves up when the one above it is answered, so a double click can't approve it", () => {
    resetActionsForTest();
    const onDecide = vi.fn();
    const one = item({ slot: "s1", requestId: "r1", detail: "npm test" });
    const two = item({ slot: "s2", requestId: "r2", detail: "rm -rf build" });
    const { rerender } = render(<Inbox items={[one, two]} onGo={vi.fn()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: /What needs you/ }));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.click(screen.getByRole("button", { name: "Allow Chat s1" }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    // The first row is answered and gone: the second takes its place under the pointer.
    rerender(<Inbox items={[two]} onGo={vi.fn()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow Chat s2" }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.click(screen.getByRole("button", { name: "Allow Chat s2" }));
    expect(onDecide).toHaveBeenCalledTimes(2);
  });

  it("shows the whole command where Allow is offered, and leaves Deny and Go where it isn't", () => {
    const command = "npm run build -- --mode production --sourcemap --outDir dist/some/long/folder/name/that/would/never/fit/on/one/line";
    const whole = item({ slot: "s1", detail: command });
    const partial = item({ slot: "s2", need: "Wants to use Bash: npm test", canAllow: false });
    const { toggle } = setup([whole, partial]);
    fireEvent.click(toggle());
    expect(screen.getByText(command)).toHaveClass("inbox-full");
    expect(screen.getAllByRole("button", { name: /^Allow / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Allow Chat s1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny Chat s2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to Chat s2" })).toHaveAttribute("title", "Open it to see everything it will do");
    expect(screen.getByRole("button", { name: "Go to Chat s1" })).not.toHaveAttribute("title");
  });

  it("replaces a row's buttons when its request changes, so a focused Allow can't answer the next one", () => {
    resetActionsForTest();
    const first = item({ slot: "s1", requestId: "r1", detail: "npm test" });
    const { rerender } = render(<Inbox items={[first]} onGo={vi.fn()} onDecide={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /What needs you/ }));
    const allow = screen.getByRole("button", { name: "Allow Chat s1" });
    allow.focus();
    rerender(<Inbox items={[{ ...first, requestId: "r2", detail: "rm -rf build" }]} onGo={vi.fn()} onDecide={vi.fn()} />);
    expect(allow).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow Chat s1" })).not.toHaveFocus();
    expect(screen.getByText("rm -rf build")).toBeInTheDocument();
  });

  it("opens on the first Go, and the arrow keys move between rows", () => {
    const { toggle } = setup([item({ slot: "s1" }), item({ slot: "s2" }), item({ slot: "s3", requestId: null })]);
    fireEvent.click(toggle());
    const go = (n: number) => screen.getByRole("button", { name: `Go to Chat s${n}` });
    expect(go(1)).toHaveFocus();
    fireEvent.keyDown(go(1), { key: "ArrowDown" });
    expect(go(2)).toHaveFocus();
    fireEvent.keyDown(go(2), { key: "ArrowDown" });
    expect(go(3)).toHaveFocus();
    fireEvent.keyDown(go(3), { key: "ArrowDown" });
    expect(go(1)).toHaveFocus();
    fireEvent.keyDown(go(1), { key: "ArrowUp" });
    expect(go(3)).toHaveFocus();
    // Left and Right move between one row's buttons.
    fireEvent.keyDown(go(2), { key: "ArrowLeft" });
    expect(screen.getByRole("button", { name: "Deny Chat s2" })).toHaveFocus();
  });

  it("closes on Escape and gives focus back to its button", () => {
    const { toggle } = setup([item({ slot: "s1" })]);
    fireEvent.click(toggle());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toggle()).toHaveFocus();
  });

  it("opens from the What Needs You action", () => {
    setup([item({ slot: "s1" })]);
    act(() => {
      expect(runAction("show-inbox")).toBe(true);
    });
    expect(screen.getByRole("dialog", { name: "What needs you" })).toBeInTheDocument();
  });

  it("marks what only finished with a quiet dot and an age instead of a count", () => {
    const { toggle } = setup([item({ slot: "s1", kind: "unread", needsYou: false, requestId: null, need: "Finished" })]);
    expect(toggle()).toHaveAccessibleName("What needs you");
    fireEvent.click(toggle());
    expect(screen.getByText("3m ago")).toBeInTheDocument();
  });
});
