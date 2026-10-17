import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NodeComposer } from "./NodeComposer";
import { NodeActionsContext, type NodeActions } from "../lib/canvasContext";

const setup = (draft = "") => {
  const actions = { draft: vi.fn(() => draft), setDraft: vi.fn(), send: vi.fn(), queue: vi.fn(), stop: vi.fn() } as unknown as NodeActions;
  render(
    <NodeActionsContext.Provider value={actions}>
      <NodeComposer slot="w1" status="idle" queued={[]} />
    </NodeActionsContext.Provider>,
  );
  const box = screen.getByLabelText("Message this agent") as HTMLTextAreaElement;
  return { box, actions };
};

describe("NodeComposer lists", () => {
  it("continues a list on Shift+Enter and keeps the draft", () => {
    const { box, actions } = setup("1. one");
    box.setSelectionRange(6, 6);
    expect(fireEvent.keyDown(box, { key: "Enter", shiftKey: true })).toBe(false);
    expect(box).toHaveValue("1. one\n2. ");
    expect(actions.setDraft).toHaveBeenLastCalledWith("w1", "1. one\n2. ");
    expect(actions.send).not.toHaveBeenCalled();
  });

  it("ends the list on an empty item and splits at the caret", () => {
    const { box } = setup("- ab");
    box.setSelectionRange(3, 3);
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(box).toHaveValue("- a\n- b");
    fireEvent.change(box, { target: { value: "- a\n- " } });
    box.setSelectionRange(6, 6);
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(box).toHaveValue("- a\n");
  });

  it("indents and outdents a list line with Tab and Shift+Tab, and leaves Tab alone elsewhere", () => {
    const { box } = setup("- a");
    box.setSelectionRange(3, 3);
    expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(false);
    expect(box).toHaveValue("  - a");
    expect(fireEvent.keyDown(box, { key: "Tab", shiftKey: true })).toBe(false);
    expect(box).toHaveValue("- a");
    fireEvent.change(box, { target: { value: "plain" } });
    expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(true);
    expect(box).toHaveValue("plain");
  });

  it("still sends on Enter, and not while composing", () => {
    const { box, actions } = setup("- a");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true, isComposing: true });
    expect(box).toHaveValue("- a");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(actions.send).toHaveBeenCalledWith("w1", "- a");
  });
});
