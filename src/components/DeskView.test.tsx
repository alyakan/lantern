import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { InboxItem } from "../lib/inbox";
import type { InboxRow, ProjectRow } from "../lib/deskBoard";
import { NO_DESKS } from "../lib/desks";
import { DeskView, type DeskViewProps } from "./DeskView";

const item = (slot: string, over: Partial<InboxItem> = {}): InboxItem => ({ key: slot, slot, kind: "permission", role: "chat", team: null, title: `Chat ${slot}`, where: "lantern", need: `Wants to use Bash in ${slot}`, since: Date.now() - 60_000, requestId: `r-${slot}`, canAllow: true, detail: `npm test ${slot}`, needsYou: true, ...over });
const row = (n: number, over: Partial<InboxRow> = {}): InboxRow => ({ slot: `s${n}`, title: `Chat ${n}`, folder: "/p/lantern", where: "lantern", workflow: "Chat", state: "done", unread: false, at: Date.now() - n * 60_000, line: `Did thing ${n}.`, ...over });
const project = (folder: string, over: Partial<ProjectRow> = {}): ProjectRow => ({ folder, label: folder.split("/").pop()!, chats: 1, working: 0, waiting: 0, asleep: 0, unread: 0, needs: 0, at: null, todos: { open: 0, overdue: 0 }, ...over });

function setup(over: Partial<DeskViewProps> = {}) {
  const props: DeskViewProps = {
    chats: [],
    projects: [],
    needs: [],
    desks: { value: NO_DESKS, waiting: {}, projects: [], onChange: vi.fn(), onAdd: vi.fn() },
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

  it("lists the projects with what Lantern knows of each", () => {
    setup({ projects: [project("/p/lantern", { chats: 3, working: 2, waiting: 1, needs: 1, todos: { open: 3, overdue: 1 } }), project("/p/rayak", { chats: 0, todos: null })] });
    expect(screen.getByText("✓ Nothing needs you")).toBeInTheDocument();
    const [lantern, rayak] = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(lantern).toHaveTextContent("2 working · 1 needs you");
    expect(lantern).toHaveTextContent("3 · 1 overdue");
    expect(rayak).toHaveTextContent("none open");
    expect(within(rayak).getByRole("button", { name: "rayak" })).toBeDisabled();
  });

  it("opens a project's row to list its chats, the unread ones marked, and opens a chat on a click", () => {
    const { props } = setup({
      chats: [row(1, { unread: true }), row(2, { state: "working", line: "Bash: npm test" }), row(3, { folder: "/p/rayak", where: "rayak" })],
      projects: [project("/p/lantern", { chats: 2 }), project("/p/rayak")],
    });
    const table = screen.getByRole("table");
    expect(within(table).queryByRole("button", { name: /^Chat 1/ })).toBeNull();
    fireEvent.click(within(table).getByRole("button", { name: /lantern/ }));
    const unread = within(table).getByRole("button", { name: "Chat 1, unread" });
    expect(unread).toHaveClass("unread");
    expect(unread).toHaveTextContent("Did thing 1.");
    expect(within(table).getByRole("button", { name: "Chat 2" })).toHaveTextContent(/working.*Bash: npm test/);
    expect(within(table).queryByRole("button", { name: "Chat 3" })).toBeNull();
    fireEvent.click(unread);
    expect(props.onOpen).toHaveBeenCalledWith("s1");
  });
});
