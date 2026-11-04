import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Todo } from "../lib/todos";
import type { RepoStatus } from "../types";
import { DeskProjectLanding, IDEAS, type DeskProjectLandingProps } from "./DeskProjectLanding";

const here = (changed = 0): RepoStatus["folders"][number] => ({ folder: "/p/lantern", branch: "main", changed });
const todo = (id: string, over: Partial<Todo> = {}): Todo => ({ id, title: `Todo ${id}`, done: false, created_at: 1, ...over }) as Todo;
const repo = { repo: "/p/lantern" } as RepoStatus;

function setup(over: Partial<DeskProjectLandingProps> = {}) {
  const props: DeskProjectLandingProps = { label: "lantern", repo, here: here(), todos: [], onStartChat: vi.fn(), onStartTodo: vi.fn(), ...over };
  render(<DeskProjectLanding {...props} />);
  return props;
}

describe("a project's landing page", () => {
  it("is a clean slate with a way to start a chat when nothing is going on", () => {
    const props = setup();
    expect(screen.getByRole("heading", { name: "lantern is a clean slate" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Next up" })).toBeNull();
    const box = screen.getByRole("textbox", { name: "What do you want to work on in lantern?" });
    const send = screen.getByRole("button", { name: "Start chat" });
    expect(send).toBeDisabled();
    // Blank text starts nothing.
    fireEvent.change(box, { target: { value: "   " } });
    expect(send).toBeDisabled();
    fireEvent.change(box, { target: { value: " add a dark mode " } });
    fireEvent.click(send);
    expect(props.onStartChat).toHaveBeenCalledWith("add a dark mode");
    expect(box).toHaveValue("");
  });

  it("starts on Enter, and keeps a new line on Shift+Enter", () => {
    const props = setup();
    const box = screen.getByRole("textbox", { name: /What do you want to work on/ });
    fireEvent.change(box, { target: { value: "one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(props.onStartChat).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(props.onStartChat).toHaveBeenCalledWith("one");
  });

  it("starts an empty chat, or one from an idea, in a click", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Empty chat" }));
    expect(props.onStartChat).toHaveBeenLastCalledWith("");
    fireEvent.click(within(screen.getByRole("group", { name: "Ideas to start with" })).getByRole("button", { name: IDEAS[2].label }));
    expect(props.onStartChat).toHaveBeenLastCalledWith(IDEAS[2].prompt);
  });

  it("offers what is next: uncommitted changes and the first three to-dos, each started on a click", () => {
    const todos = ["a", "b", "c", "d"].map((id) => todo(id));
    const props = setup({ todos, here: here(2) });
    // Something is next, so it is no clean slate.
    expect(screen.getByRole("heading", { name: "Nothing in flight in lantern" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Next up" })).toBeInTheDocument();
    expect(screen.getByText("2 uncommitted changes on main")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review in a chat" }));
    expect(props.onStartChat).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes"));
    expect(screen.queryByText("Todo d")).toBeNull();
    expect(screen.getByText("and 1 more to-dos below")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start on Todo b" }));
    expect(props.onStartTodo).toHaveBeenCalledWith(todos[1]);
  });

  it("says one change in the singular, and a to-do's due date", () => {
    setup({ todos: [todo("a", { due: { date: "2026-11-09", time: null } } as Partial<Todo>)], here: here(1) });
    expect(screen.getByText("1 uncommitted change on main")).toBeInTheDocument();
    expect(screen.getByText("Due 2026-11-09")).toBeInTheDocument();
  });

  it("says why when the project isn't in a repository", () => {
    setup({ repo: null });
    expect(screen.getByRole("heading", { name: "lantern is a clean slate" })).toBeInTheDocument();
    expect(screen.getByText(/isn't in a git repository/)).toBeInTheDocument();
  });
});
