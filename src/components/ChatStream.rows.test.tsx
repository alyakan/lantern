import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ChatItem, ToolItem } from "../store";
import { ChatStream } from "./ChatStream";

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
    expect(drawn.get("Streaming")).toBe(1);
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
});
