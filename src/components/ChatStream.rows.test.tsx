import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { initialState, type ChatItem, type State, type ToolItem } from "../store";
import { useSteady } from "../lib/steady";
import { ChatStream } from "./ChatStream";
import { ChatView } from "./ChatView";

// Counts how often each message's row and each turn's work line are drawn.
const drawn = vi.hoisted(() => new Map<string, number>());
vi.mock("./MessageActions", () => ({
  MessageActions: ({ text }: { text: string }) => {
    drawn.set(text, (drawn.get(text) ?? 0) + 1);
    return null;
  },
}));
vi.mock("./ActivityGroup", () => ({
  ActivityGroup: ({ steps, live }: { steps: ToolItem[]; live: boolean }) => {
    const key = `work:${steps.map((s) => s.id).join(",")}`;
    drawn.set(key, (drawn.get(key) ?? 0) + 1);
    return <div>{`${steps.length} steps${live ? ", live" : ""}`}</div>;
  },
}));

const tool = (id: string, status: "running" | "done" = "done"): ToolItem => ({ type: "tool", id, name: "Read", summary: "/p/a.ts", status, output: null, edit: null, children: [] });
const handlers = { onDecide: () => {}, onOpenFile: () => {} };

describe("ChatStream rows", () => {
  it("says under a phone's message how many photos came with it, and nothing when none did", () => {
    const items: ChatItem[] = [
      { type: "user", id: "u1", text: "What is this?", images: 2 },
      { type: "user", id: "u2", text: "And this?", images: 1 },
      { type: "user", id: "u3", text: "Plain words" },
    ];
    render(<ChatStream items={items} folder={null} {...handlers} />);
    expect(screen.getByText("2 pictures sent with it")).toBeInTheDocument();
    expect(screen.getByText("1 picture sent with it")).toBeInTheDocument();
    expect(screen.getAllByRole("note")).toHaveLength(2);
  });

  it("draws again only the message that is streaming, not the ones before it or the turn's finished work", () => {
    drawn.clear();
    const before: ChatItem[] = [
      { type: "user", id: "u1", text: "First question" },
      { type: "assistant", id: "a1", text: "First answer" },
      { type: "user", id: "u2", text: "Second question" },
      tool("t1"),
      { type: "assistant", id: "a2", text: "Stream" },
    ];
    const { rerender } = render(<ChatStream items={before} folder={null} sections live {...handlers} />);
    // A word arrives: the store makes a new list, with a new object for the message that grew and the same ones for the rest.
    const after = [...before.slice(0, -1), { type: "assistant", id: "a2", text: "Streaming" } as ChatItem];
    rerender(<ChatStream items={after} folder={null} sections live {...handlers} />);
    expect(screen.getByText("Streaming")).toBeInTheDocument();
    expect(drawn.get("First question")).toBe(1);
    expect(drawn.get("First answer")).toBe(1);
    expect(drawn.get("work:t1")).toBe(1);
    // The reply still coming in has no Copy or Regenerate under it until it is whole.
    expect(drawn.get("Streaming")).toBeUndefined();
  });

  it("draws a turn's work line again when a step changes or the turn stops", () => {
    drawn.clear();
    const items: ChatItem[] = [{ type: "user", id: "u1", text: "Go" }, tool("t1", "running")];
    const { rerender } = render(<ChatStream items={items} folder={null} live {...handlers} />);
    rerender(<ChatStream items={[items[0], tool("t1")]} folder={null} live {...handlers} />);
    expect(drawn.get("work:t1")).toBe(2);
    rerender(<ChatStream items={[items[0], tool("t1")]} folder={null} live={false} {...handlers} />);
    expect(drawn.get("work:t1")).toBe(3);
    expect(screen.getByText("1 steps")).toBeInTheDocument();
  });

  it("draws the work lines again when what they are given changes (a test run that arrived)", () => {
    drawn.clear();
    const items: ChatItem[] = [{ type: "user", id: "u1", text: "Go" }, tool("t1")];
    const { rerender } = render(<ChatStream items={items} folder={null} {...handlers} testRunFor={() => undefined} />);
    rerender(<ChatStream items={items} folder={null} {...handlers} testRunFor={() => undefined} />);
    expect(drawn.get("work:t1")).toBe(2);
  });

  it("in a chat whose parent makes new handlers every render, as App does, only the message that grew is drawn again", () => {
    drawn.clear();
    // App's way: fresh closures each render, made steady, and Edit/Regenerate offered (an idle chat).
    function Chat({ state }: { state: State }) {
      const handlers = useSteady({ onDecide: () => {}, onOpenFile: () => {} });
      const resend = useSteady({ onEdit: () => {}, onResend: () => {} });
      return <ChatView state={state} {...handlers} resend={resend} />;
    }
    const before: ChatItem[] = [
      { type: "user", id: "u1", text: "Old question" },
      { type: "assistant", id: "a1", text: "Old answer" },
      { type: "user", id: "u2", text: "New question" },
      { type: "assistant", id: "a2", text: "Grow" },
    ];
    const state: State = { ...initialState, status: "idle", folder: "/p", items: before };
    const { rerender } = render(<Chat state={state} />);
    rerender(<Chat state={{ ...state, items: [...before.slice(0, -1), { type: "assistant", id: "a2", text: "Growing" }] }} />);
    expect(drawn.get("Old question")).toBe(1);
    expect(drawn.get("Old answer")).toBe(1);
    expect(drawn.get("New question")).toBe(1);
    expect(drawn.get("Growing")).toBe(1);
  });
});
