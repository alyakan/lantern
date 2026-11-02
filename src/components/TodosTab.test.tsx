import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TodosTab } from "./TodosTab";
import { api } from "../api";
import type { Todo, TodoListing } from "../lib/todos";

vi.mock("../api", () => {
  const fns: Record<string | symbol, unknown> = {};
  return { api: new Proxy(fns, { get: (all, name) => (all[name] ??= vi.fn(() => Promise.reject(new Error("not in Tauri")))) }) };
});

const todo = (id: string, extra: Partial<Todo> = {}): Todo => ({ id, title: `Item ${id}`, done: false, created_at: 0, created_by: "user", ...extra });
const listing = (...items: Todo[]): TodoListing => ({ key: "/p", items });

beforeEach(() => {
  vi.mocked(api.todosList).mockReset();
  vi.mocked(api.todosEdit).mockReset();
  vi.mocked(api.onTodosChanged).mockReset().mockResolvedValue(() => {});
});

describe("TodosTab", () => {
  it("explains itself when the project has no to-dos", async () => {
    vi.mocked(api.todosList).mockResolvedValue(listing());
    render(<TodosTab folder="/p" chats={{}} onOpenChat={() => {}} />);
    expect(await screen.findByText(/send \/todo and the text from the message box/)).toBeInTheDocument();
    expect(screen.getByText("All done")).toBeInTheDocument();
  });

  it("adds an item, with a due date when one is given", async () => {
    vi.mocked(api.todosList).mockResolvedValue(listing());
    vi.mocked(api.todosEdit).mockResolvedValue(listing(todo("n", { title: "Renew cert" })));
    render(<TodosTab folder="/p" chats={{}} onOpenChat={() => {}} />);
    fireEvent.change(await screen.findByLabelText("New to-do"), { target: { value: "Renew cert" } });
    fireEvent.click(screen.getByRole("button", { name: "Due date" }));
    fireEvent.change(screen.getByLabelText("Due day"), { target: { value: "2026-11-03" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.todosEdit).toHaveBeenCalledWith("/p", { op: "add", title: "Renew cert", due: { date: "2026-11-03", time: null } }));
    expect(await screen.findByRole("button", { name: "Renew cert" })).toBeInTheDocument();
    expect(screen.getByLabelText("New to-do")).toHaveValue("");
  });

  it("puts overdue items in their own section first, in red, with snooze in their menu", async () => {
    vi.mocked(api.todosList).mockResolvedValue(listing(todo("a"), todo("b", { due: { date: "2020-01-01" } })));
    vi.mocked(api.todosEdit).mockResolvedValue(listing(todo("a"), todo("b", { due: { date: "2020-01-01" } })));
    render(<TodosTab folder="/p" chats={{}} onOpenChat={() => {}} />);
    const sections = (await screen.findAllByRole("region")).map((s) => s.getAttribute("aria-label"));
    expect(sections).toEqual(["Overdue", "No date"]);
    const late = within(screen.getByRole("list", { name: "Overdue" })).getByRole("listitem");
    expect(late).toHaveClass("overdue");
    fireEvent.click(within(late).getByRole("button", { name: "More for “Item b”" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remind me in an hour" }));
    await waitFor(() => expect(api.todosEdit).toHaveBeenCalledWith("/p", expect.objectContaining({ op: "snooze", id: "b" })));
    // An item that isn't overdue has no snooze.
    fireEvent.click(screen.getByRole("button", { name: "More for “Item a”" }));
    expect(screen.queryByRole("menuitem", { name: "Remind me in an hour" })).toBeNull();
  });

  it("ticks an item off, and says who added or ticked one", async () => {
    vi.mocked(api.todosList).mockResolvedValue(listing(todo("a", { created_by: "claude" }), todo("d", { done: true, done_by: "claude" })));
    vi.mocked(api.todosEdit).mockResolvedValue(listing());
    render(<TodosTab folder="/p" chats={{}} onOpenChat={() => {}} />);
    expect(await screen.findByText("Added by Claude")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Tick off “Item a”"));
    await waitFor(() => expect(api.todosEdit).toHaveBeenCalledWith("/p", { op: "done", id: "a", done: true }));
  });

  it("folds the done items away, and shows who ticked them when opened", async () => {
    vi.mocked(api.todosList).mockResolvedValue(listing(todo("a"), todo("d", { done: true, done_by: "claude" })));
    render(<TodosTab folder="/p" chats={{}} onOpenChat={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show done (1)" }));
    expect(screen.getByText("Done by Claude")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear done" })).toBeInTheDocument();
  });

  it("starts a chat on an item, and links to the chat working on one while it is open", async () => {
    vi.mocked(api.todosList).mockResolvedValue(listing(todo("a"), todo("b", { chat: "s2" })));
    const onStart = vi.fn();
    const onOpenChat = vi.fn();
    render(<TodosTab folder="/p" chats={{ s2: { title: "Fix login", working: true } }} onStart={onStart} onOpenChat={onOpenChat} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start a chat on “Item a”" }));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    // One with a chat at work on it has no ▶ of its own.
    expect(screen.queryByRole("button", { name: "Start a chat on “Item b”" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Working: Fix login/ }));
    expect(onOpenChat).toHaveBeenCalledWith("s2");
  });

  it("edits an item's title, note and date, and deletes one", async () => {
    vi.mocked(api.todosList).mockResolvedValue(listing(todo("a")));
    vi.mocked(api.todosEdit).mockResolvedValue(listing(todo("a", { title: "New" })));
    render(<TodosTab folder="/p" chats={{}} onOpenChat={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Item a" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New" } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "why" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.todosEdit).toHaveBeenCalledWith("/p", { op: "update", id: "a", patch: { title: "New", note: "why", due: null } }));
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.todosEdit).toHaveBeenCalledWith("/p", { op: "delete", id: "a" }));
  });

  it("shows what the backend refused", async () => {
    vi.mocked(api.todosList).mockResolvedValue(listing());
    vi.mocked(api.todosEdit).mockRejectedValue("This project's list is full");
    render(<TodosTab folder="/p" chats={{}} onOpenChat={() => {}} />);
    fireEvent.change(await screen.findByLabelText("New to-do"), { target: { value: "x" } });
    fireEvent.keyDown(screen.getByLabelText("New to-do"), { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("list is full");
  });
});
