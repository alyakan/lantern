import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { InboxItem } from "../lib/inbox";
import type { DeskCard } from "../lib/desk";
import { NO_DESKS } from "../lib/desks";
import { DeskView, type DeskViewProps } from "./DeskView";

const item = (slot: string, over: Partial<InboxItem> = {}): InboxItem => ({ key: slot, slot, kind: "permission", role: "chat", team: null, title: `Chat ${slot}`, where: "lantern", need: `Wants to use Bash in ${slot}`, since: Date.now() - 60_000, requestId: `r-${slot}`, canAllow: true, detail: `npm test ${slot}`, needsYou: true, ...over });
const card = (n: number, over: Partial<DeskCard> = {}): DeskCard => ({ key: `c${n}`, slot: `s${n}`, title: `Chat ${n}`, where: "lantern", at: n * 1000, asked: `ask ${n}`, auto: false, said: `Did thing ${n}. And more.`, outcome: "done", ...over });

function setup(over: Partial<DeskViewProps> = {}) {
  const props: DeskViewProps = {
    cards: [],
    live: [],
    needs: [],
    entries: [],
    targets: [],
    desks: { value: NO_DESKS, waiting: {}, projects: [], onChange: vi.fn(), onAdd: vi.fn() },
    canSend: true,
    onSend: vi.fn(),
    onSendTo: vi.fn(),
    onStartIn: vi.fn(),
    onOpenPast: vi.fn(),
    onOpen: vi.fn(),
    onGo: vi.fn(),
    onDecide: vi.fn(),
    ...over,
  };
  const view = render(<DeskView {...props} />);
  return { props, rerender: (more: Partial<DeskViewProps>) => view.rerender(<DeskView {...props} {...more} />) };
}

const arm = () => act(() => void vi.advanceTimersByTime(400));
const needs = () => screen.getByRole("region", { name: "Needs you" });

describe("the Desk", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows what needs you one thing at a time, with the whole command, and moves to the next on asking", () => {
    const { props } = setup({ needs: [item("a"), item("b")] });
    expect(within(needs()).getAllByRole("article")).toHaveLength(1);
    expect(within(needs()).getByText("Wants to use Bash in a")).toBeInTheDocument();
    expect(within(needs()).getByText("npm test a")).toBeInTheDocument();
    fireEvent.click(within(needs()).getByRole("button", { name: "1 more waiting" }));
    expect(within(needs()).getByText("Wants to use Bash in b")).toBeInTheDocument();
    arm();
    fireEvent.click(within(needs()).getByRole("button", { name: "Allow Chat b" }));
    expect(props.onDecide).toHaveBeenCalledWith(expect.objectContaining({ slot: "b" }), true);
  });

  it("arms Allow again for the next request, so a quick second click can't allow what just came into view", () => {
    const { props, rerender } = setup({ needs: [item("a"), item("b")] });
    arm();
    fireEvent.click(within(needs()).getByRole("button", { name: "Allow Chat a" }));
    // The first is answered: the next takes its place, and a click right away does nothing.
    rerender({ needs: [item("b")] });
    fireEvent.click(within(needs()).getByRole("button", { name: "Allow Chat b" }));
    expect(props.onDecide).toHaveBeenCalledTimes(1);
    arm();
    fireEvent.click(within(needs()).getByRole("button", { name: "Allow Chat b" }));
    expect(props.onDecide).toHaveBeenLastCalledWith(expect.objectContaining({ slot: "b" }), true);
  });

  it("says nothing needs you when nothing does, and lists finished answers newest first, three, then the rest on asking", () => {
    const { props } = setup({ cards: [1, 2, 3, 4, 5].map((n) => card(n)) });
    expect(screen.getByText("✓ Nothing needs you")).toBeInTheDocument();
    const finished = screen.getByRole("region", { name: "Just finished" });
    const lines = () => within(finished).getAllByRole("button", { name: /^Chat \d/ });
    expect(lines().map((b) => b.textContent)).toEqual([expect.stringContaining("Chat 5: Did thing 5."), expect.stringContaining("Chat 4"), expect.stringContaining("Chat 3")]);
    fireEvent.click(within(finished).getByRole("button", { name: "Show 2 more" }));
    expect(lines()).toHaveLength(5);
    fireEvent.click(lines()[0]);
    expect(props.onOpen).toHaveBeenCalledWith("s5");
  });

  it("says why an answer failed when Claude said, in its line", () => {
    setup({ cards: [card(1, { outcome: "failed", said: "The runner went offline. Retrying won't help." }), card(2, { outcome: "stopped", said: "" })] });
    const finished = screen.getByRole("region", { name: "Just finished" });
    expect(within(finished).getByText(/The runner went offline\./)).toBeInTheDocument();
    expect(within(finished).getByText(/Stopped/)).toBeInTheDocument();
  });
});
