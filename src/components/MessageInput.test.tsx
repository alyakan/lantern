import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessageInput } from "./MessageInput";

describe("MessageInput", () => {
  it("sends trimmed text on Enter and clears", () => {
    const onSend = vi.fn();
    render(<MessageInput status="idle" onSend={onSend} onStop={() => {}} />);
    const box = screen.getByPlaceholderText("Ask Claude…");
    fireEvent.change(box, { target: { value: "  fix it  " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("fix it");
    expect(box).toHaveValue("");
  });

  it("sends what you typed on Enter while a grey prediction shows, but lets an input method confirm", () => {
    const onSend = vi.fn();
    render(<MessageInput status="idle" onSend={onSend} onStop={() => {}} />);
    const box = screen.getByPlaceholderText("Ask Claude…");
    // A prediction: a composition with no input-method keys (keyCode 229) before it, its text marked in the box.
    fireEvent.keyDown(box, { key: "y", keyCode: 89 });
    fireEvent.change(box, { target: { value: "add a retry" } });
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "add a retry loop" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(onSend).toHaveBeenCalledWith("add a retry");
    fireEvent.compositionEnd(box);
    // Japanese input: its keys arrive as 229, and Enter confirms the characters instead of sending.
    fireEvent.keyDown(box, { key: "Process", keyCode: 229 });
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "にほん" } });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.compositionEnd(box);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenLastCalledWith("にほん");
  });

  const type = (box: HTMLElement, value: string) => {
    fireEvent.change(box, { target: { value } });
    fireEvent.keyDown(box, { key: "Enter" });
  };

  it("queues messages while running instead of sending them", () => {
    const onSend = vi.fn();
    render(<MessageInput status="running" onSend={onSend} onStop={() => {}} />);
    const box = screen.getByPlaceholderText("Queue a message…");
    type(box, " then add tests ");
    type(box, "and update the docs");
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue("");
    expect(screen.getByText("then add tests")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove queued message" })[1]);
    expect(screen.queryByText("and update the docs")).toBeNull();
  });

  it("uses the chat's queue when given one", () => {
    const set = vi.fn();
    render(<MessageInput status="running" onSend={() => {}} onStop={() => {}} queue={{ items: ["first"], set }} />);
    expect(screen.getByText("first")).toBeInTheDocument();
    type(screen.getByPlaceholderText("Queue a message…"), "second");
    expect(set).toHaveBeenCalledWith(["first", "second"]);
  });

  it("puts the queue back into the box on Stop instead of sending it", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(<MessageInput status="running" onSend={onSend} onStop={onStop} />);
    const box = screen.getByPlaceholderText("Queue a message…");
    type(box, "first");
    fireEvent.change(box, { target: { value: "half-typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalled();
    expect(box).toHaveValue("first\n\nhalf-typed");
    rerender(<MessageInput status="idle" onSend={onSend} onStop={onStop} />);
    expect(onSend).not.toHaveBeenCalled();
  });

  const commands = [
    { name: "compact", description: "Clear history but keep a summary", argument_hint: "<instructions>" },
    { name: "context", description: "Show context usage", argument_hint: "" },
    { name: "clear", description: "Clear conversation history", argument_hint: "" },
  ];

  it("offers slash commands as you type, and runs one with Enter", () => {
    const onSend = vi.fn();
    render(<MessageInput status="idle" onSend={onSend} onStop={() => {}} commands={commands} />);
    const box = screen.getByPlaceholderText("Ask Claude…");
    fireEvent.change(box, { target: { value: "/c" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "/clearClear conversation history",
      "/compact<instructions>Clear history but keep a summary",
      "/contextShow context usage",
    ]);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/context");
    expect(box).toHaveValue("");
  });

  it("completes a command that takes arguments instead of running it, and Escape hides the menu", () => {
    const onSend = vi.fn();
    render(<MessageInput status="idle" onSend={onSend} onStop={() => {}} commands={commands} />);
    const box = screen.getByPlaceholderText("Ask Claude…");
    fireEvent.change(box, { target: { value: "/comp" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue("/compact ");
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();

    fireEvent.change(box, { target: { value: "/" } });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    // With the menu hidden, Enter sends what's typed.
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/");
  });

  it("starts from the chat's unsent text and saves what's typed", () => {
    const save = vi.fn();
    render(<MessageInput status="idle" onSend={() => {}} onStop={() => {}} draft={{ initial: "half a thought", save }} />);
    const box = screen.getByPlaceholderText("Ask Claude…");
    expect(box).toHaveValue("half a thought");
    fireEvent.change(box, { target: { value: "half a thought, finished" } });
    expect(save).toHaveBeenLastCalledWith("half a thought, finished");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(save).toHaveBeenLastCalledWith("");
  });

  it("focuses on ⌘L and stops on ⌘. while running", () => {
    const onStop = vi.fn();
    const { rerender } = render(<MessageInput status="idle" onSend={() => {}} onStop={onStop} />);
    fireEvent.keyDown(window, { key: "l", metaKey: true });
    expect(screen.getByPlaceholderText("Ask Claude…")).toHaveFocus();
    fireEvent.keyDown(window, { key: ".", metaKey: true });
    expect(onStop).not.toHaveBeenCalled();
    rerender(<MessageInput status="running" onSend={() => {}} onStop={onStop} />);
    fireEvent.keyDown(window, { key: ".", metaKey: true });
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("is disabled while starting", () => {
    render(<MessageInput status="starting" onSend={() => {}} onStop={() => {}} />);
    expect(screen.getByPlaceholderText("Starting Claude…")).toBeDisabled();
  });

  it("on a Step-by-step page, Enter stays on the step and ⌘Enter sends and moves on", () => {
    const onSend = vi.fn();
    const sendAndNext = vi.fn();
    render(<MessageInput status="idle" onSend={onSend} onStop={() => {}} sendAndNext={sendAndNext} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "why a Set?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("why a Set?");
    fireEvent.change(box, { target: { value: "rename it" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(sendAndNext).toHaveBeenCalledWith("rename it");
    fireEvent.change(box, { target: { value: "and this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send & next" }));
    expect(sendAndNext).toHaveBeenLastCalledWith("and this");
  });
});
