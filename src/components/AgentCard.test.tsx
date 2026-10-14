import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PermissionCard, CANVAS_REFUSAL } from "./PermissionCard";
import { SlotContext } from "../lib/slot";

const setAgentChoice = vi.fn(() => Promise.resolve());
vi.mock("../api", () => ({ api: { setAgentChoice: (...args: unknown[]) => (setAgentChoice as (...a: unknown[]) => Promise<void>)(...args) } }));

const item = {
  type: "permission" as const,
  id: "perm-3",
  toolName: "Agent",
  input: { description: "Find the callers", prompt: "List every caller of fetchJson.", subagent_type: "Explore" },
  decision: null,
};
const show = (onDecide = vi.fn(), over = {}) => {
  render(
    <SlotContext.Provider value="s7">
      <PermissionCard item={{ ...item, ...over }} onDecide={onDecide} />
    </SlotContext.Provider>,
  );
  return onDecide;
};

beforeEach(() => setAgentChoice.mockClear());

describe("the card for a helper the main agent would run inline", () => {
  it("says what the helper is and offers the canvas first", () => {
    show();
    expect(screen.getByText("Run this helper on the canvas?")).toBeInTheDocument();
    expect(screen.getByText("Find the callers")).toBeInTheDocument();
    expect(screen.getByText("Explore")).toBeInTheDocument();
    expect(screen.getByText("List every caller of fetchJson.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run on canvas" })).toHaveClass("primary");
    expect(screen.getByRole("checkbox", { name: "Same for the rest of this chat" })).toBeChecked();
  });

  it("sends the helper to the canvas by refusing the inline call with how to start a worker, and remembers it for the chat", async () => {
    const onDecide = show();
    fireEvent.click(screen.getByRole("button", { name: "Run on canvas" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("perm-3", false, CANVAS_REFUSAL));
    expect(setAgentChoice).toHaveBeenCalledWith("s7", "canvas");
    expect(CANVAS_REFUSAL).toContain("spawn_agent");
  });

  it("runs it inline when asked, and remembers that instead", async () => {
    const onDecide = show();
    fireEvent.click(screen.getByRole("button", { name: "Run inline" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("perm-3", true, undefined));
    expect(setAgentChoice).toHaveBeenCalledWith("s7", "inline");
  });

  it("keeps asking when the box is unticked", () => {
    const onDecide = show();
    fireEvent.click(screen.getByRole("checkbox", { name: "Same for the rest of this chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Run on canvas" }));
    expect(onDecide).toHaveBeenCalledWith("perm-3", false, CANVAS_REFUSAL);
    expect(setAgentChoice).not.toHaveBeenCalled();
  });

  it("still answers when the choice can't be saved", async () => {
    setAgentChoice.mockRejectedValueOnce(new Error("no chat"));
    const onDecide = show();
    fireEvent.click(screen.getByRole("button", { name: "Run on canvas" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalled());
  });

  it("is also the card for the tool's older name, and folds to one line once answered", () => {
    show(vi.fn(), { toolName: "Task", decision: "denied" });
    expect(screen.getByText("→ Sent to the canvas")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run on canvas" })).toBeNull();
  });

  it("says when it ran inline", () => {
    show(vi.fn(), { decision: "allowed" });
    expect(screen.getByText("✓ Ran inline")).toBeInTheDocument();
  });
});
