import { expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentPlanSheet } from "./AgentPlanSheet";
import { MessageInput } from "./MessageInput";
import type { AgentTodo } from "../types";

const todos: AgentTodo[] = [
  { content: "Read the code", status: "completed", active_form: "Reading the code" },
  { content: "Fix the input", status: "in_progress", active_form: "Fixing the input" },
  { content: "Check the result", status: "pending", active_form: "Checking the result" },
];

it("opens the current chat's checklist and collapses it with Escape", () => {
  render(<AgentPlanSheet todos={todos} />);
  const handle = screen.getByRole("button", { name: "Plan, 1 of 3 done, now: Fixing the input" });
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  fireEvent.click(handle);
  expect(handle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("listitem", { name: "Done: Read the code" })).toBeInTheDocument();
  expect(screen.getByRole("listitem", { name: "Doing: Fix the input" })).toBeInTheDocument();
  expect(screen.getByRole("listitem", { name: "To do: Check the result" })).toBeInTheDocument();
  fireEvent.keyDown(handle, { key: "Escape" });
  expect(handle).toHaveAttribute("aria-expanded", "false");
});

it("follows a drag up and down without toggling again on the following click", () => {
  const oldPointer = window.PointerEvent;
  window.PointerEvent = class extends MouseEvent {
    pointerId = 1;
    isPrimary = true;
  } as typeof PointerEvent;
  try {
    render(<AgentPlanSheet todos={todos} />);
    const handle = screen.getByRole("button");
    handle.setPointerCapture = () => {};
    fireEvent.pointerDown(handle, { clientY: 500, button: 0 });
    fireEvent.pointerMove(handle, { clientY: 200 });
    fireEvent.pointerUp(handle, { clientY: 200 });
    fireEvent.click(handle);
    expect(handle).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(handle, { clientY: 200, button: 0 });
    fireEvent.pointerMove(handle, { clientY: 500 });
    fireEvent.pointerUp(handle, { clientY: 500 });
    fireEvent.click(handle);
    expect(handle).toHaveAttribute("aria-expanded", "false");
  } finally {
    window.PointerEvent = oldPointer;
  }
});

it("shows nothing without steps or when they are all complete", () => {
  const view = render(<AgentPlanSheet todos={[]} />);
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  view.rerender(<AgentPlanSheet todos={todos.map((t) => ({ ...t, status: "completed" }))} />);
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
});

it("keeps the sheet outside the input's working border and resets it for another chat", () => {
  const props = { status: "running" as const, onSend: () => {}, onStop: () => {} };
  const view = render(<MessageInput key="a" {...props} todos={todos} />);
  const sheet = screen.getByRole("region", { name: "Agent checklist" });
  const box = view.container.querySelector(".composer-box.working")!;
  expect(box).toBeInTheDocument();
  expect(box.contains(sheet)).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /^Plan,/ }));
  view.rerender(<MessageInput key="b" {...props} todos={[{ content: "Other work", status: "pending", active_form: "Working" }]} />);
  expect(screen.getByRole("button", { name: /Plan,.*Other work/ })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("Fixing the input")).not.toBeInTheDocument();
});
