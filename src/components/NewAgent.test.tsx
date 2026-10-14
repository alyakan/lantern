import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeActionsContext, type NodeActions } from "../lib/canvasContext";
import { MODEL_CHOICES } from "../lib/models";
import { NewAgent } from "./NewAgent";

afterEach(cleanup);

function mount(spawn: NodeActions["spawn"] = vi.fn(() => Promise.resolve())) {
  const actions = { spawn } as unknown as NodeActions;
  render(
    <NodeActionsContext.Provider value={actions}>
      <NewAgent main="s1" />
    </NodeActionsContext.Provider>,
  );
  return { spawn };
}

const open = () => fireEvent.click(screen.getByRole("button", { name: "+ Agent" }));
const form = () => screen.getByRole("dialog", { name: "New agent" });
const task = () => within(form()).getByLabelText("Task") as HTMLTextAreaElement;
const type = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });

describe("the form to start an agent", () => {
  it("is closed until + Agent is pressed, then opens on the task", () => {
    mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    expect(document.activeElement).toBe(task());
    expect(screen.getByRole("button", { name: "+ Agent" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("starts with its own worktree and Claude's default model, and says what shared is for", () => {
    mount();
    open();
    expect((within(form()).getByLabelText("Own worktree") as HTMLInputElement).checked).toBe(true);
    expect((within(form()).getByLabelText("Shared folder") as HTMLInputElement).checked).toBe(false);
    expect(form().textContent).toContain("Shared is for work that writes nothing");
    const model = within(form()).getByLabelText("Model") as HTMLSelectElement;
    expect(model.value).toBe("");
    expect([...model.options].map((o) => o.value)).toEqual(MODEL_CHOICES.map((m) => m.value ?? ""));
  });

  it("asks for a task and doesn't start anything without one", () => {
    const { spawn } = mount();
    open();
    type(task(), "   ");
    fireEvent.click(within(form()).getByRole("button", { name: "Start agent" }));
    expect(within(form()).getByRole("alert").textContent).toBe("Say what the worker should do.");
    expect(task().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(task());
    expect(spawn).not.toHaveBeenCalled();
  });

  it("starts the worker as asked, for the main agent, and closes and clears itself", async () => {
    const { spawn } = mount();
    open();
    type(task(), "  Add dark mode to settings  ");
    type(within(form()).getByLabelText(/^Name/), " Dark mode ");
    fireEvent.click(within(form()).getByLabelText("Shared folder"));
    type(within(form()).getByLabelText("Model"), "sonnet");
    fireEvent.click(within(form()).getByRole("button", { name: "Start agent" }));
    expect(spawn).toHaveBeenCalledWith("s1", { task: "Add dark mode to settings", name: "Dark mode", isolation: "shared", model: "sonnet" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    open();
    expect(task().value).toBe("");
    expect((within(form()).getByLabelText("Own worktree") as HTMLInputElement).checked).toBe(true);
  });

  it("leaves the name to the backend when it is empty, and the model to Claude when it is Default", () => {
    const { spawn } = mount();
    open();
    type(task(), "Read the code");
    fireEvent.click(within(form()).getByRole("button", { name: "Start agent" }));
    expect(spawn).toHaveBeenCalledWith("s1", { task: "Read the code", name: null, isolation: "worktree", model: null });
  });

  it("starts on Command-Enter in the task, too", () => {
    const { spawn } = mount();
    open();
    type(task(), "Read the code");
    fireEvent.keyDown(task(), { key: "Enter", metaKey: true });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("shows what the backend said when it can't start, keeps what was typed, and tries again", async () => {
    const spawn = vi.fn().mockRejectedValueOnce("6 workers are already going (the most is 6). Wait for one to finish, or close one.").mockResolvedValueOnce(undefined);
    mount(spawn);
    open();
    type(task(), "One too many");
    fireEvent.click(within(form()).getByRole("button", { name: "Start agent" }));
    expect((await within(form()).findByRole("alert")).textContent).toContain("the most is 6");
    expect(task().value).toBe("One too many");
    expect((within(form()).getByRole("button", { name: "Start agent" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(form()).getByRole("button", { name: "Start agent" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("can't be started twice while it is starting", async () => {
    let finish: () => void = () => {};
    const spawn = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    mount(spawn);
    open();
    type(task(), "Slow one");
    fireEvent.click(within(form()).getByRole("button", { name: "Start agent" }));
    const busy = within(form()).getByRole("button", { name: "Starting…" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.keyDown(task(), { key: "Enter", metaKey: true });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
    finish();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes on Escape, on Cancel and on a press elsewhere, and keeps what was typed", () => {
    const { spawn } = mount();
    open();
    type(task(), "Half a brief");
    fireEvent.keyDown(task(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    expect(task().value).toBe("Half a brief");
    fireEvent.click(within(form()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });
});
