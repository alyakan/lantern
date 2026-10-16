import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatStoreContext, createChatStore, NodeActionsContext, type NodeActions } from "../lib/canvasContext";
import { MODEL_CHOICES } from "../lib/models";
import { RoleStoreProvider, useRoleStoreState } from "../lib/roleStore";
import { initialState } from "../store";
import { NewAgent } from "./NewAgent";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

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
    expect(within(form()).getByRole("alert").textContent).toBe("Say what the agent should do.");
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

/** The form on a team's canvas in a project, with the roles of that project kept as the app keeps them. */
function mountWithRoles(spawn: NodeActions["spawn"] = vi.fn(() => Promise.resolve())) {
  const chats = createChatStore();
  chats.set({ s1: { ...initialState, folder: "/p/acme", orchestrator: true } });
  function Roles({ children }: { children: React.ReactNode }) {
    return <RoleStoreProvider store={useRoleStoreState()}>{children}</RoleStoreProvider>;
  }
  render(
    <ChatStoreContext.Provider value={chats}>
      <NodeActionsContext.Provider value={{ spawn } as unknown as NodeActions}>
        <Roles>
          <NewAgent main="s1" />
        </Roles>
      </NodeActionsContext.Provider>
    </ChatStoreContext.Provider>,
  );
  return { spawn };
}
const roleSelect = () => within(form()).getByLabelText("Role") as HTMLSelectElement;
const brief = () => within(form()).getByLabelText(/^Brief/) as HTMLTextAreaElement;

describe("a role in the form to start an agent", () => {
  it("is offered as a list of the five built-in roles, with no role chosen", () => {
    mount();
    open();
    expect(roleSelect().value).toBe("");
    expect([...roleSelect().options].map((o) => o.textContent)).toEqual(["No role · a blank brief", "Builder", "Reviewer", "QA / tester", "Docs", "Security auditor"]);
    expect(within(form()).queryByLabelText(/^Brief/)).toBeNull();
    expect(within(form()).queryByText("What it may do")).toBeNull();
  });

  it("fills the brief, model, place and access, with the task in the brief, and names the agent from the role", () => {
    const { spawn } = mount();
    open();
    type(roleSelect(), "reviewer");
    expect((within(form()).getByLabelText("Shared folder") as HTMLInputElement).checked).toBe(true);
    expect((within(form()).getByLabelText("Model") as HTMLSelectElement).value).toBe("sonnet");
    expect((within(form()).getByLabelText("Read only") as HTMLInputElement).checked).toBe(true);
    expect(form().textContent).toContain("Reads files and a diff you give it and reports findings");
    expect(brief().value).toContain("You are a Reviewer. Review this: (your task)");
    type(task(), "the login form");
    expect(brief().value).toContain("You are a Reviewer. Review this: the login form");
    expect((within(form()).getByLabelText(/^Name/) as HTMLInputElement).placeholder).toBe("Reviewer: the login form");
    fireEvent.click(within(form()).getByRole("button", { name: "Start agent" }));
    expect(spawn).toHaveBeenCalledWith("s1", {
      task: expect.stringContaining("You are a Reviewer. Review this: the login form"),
      name: "Reviewer: the login form",
      isolation: "shared",
      model: "sonnet",
      role: { id: "reviewer", label: "Reviewer", read_only: true },
    });
  });

  it("can have all of it changed: the brief as written, the name, the model, where it works and what it may do", () => {
    const { spawn } = mount();
    open();
    type(roleSelect(), "builder");
    expect((within(form()).getByLabelText("Own worktree") as HTMLInputElement).checked).toBe(true);
    expect((within(form()).getByLabelText("Can edit") as HTMLInputElement).checked).toBe(true);
    type(task(), "dark mode");
    type(brief(), "Add dark mode, nothing else.");
    type(within(form()).getByLabelText(/^Name/), "Dark mode");
    type(within(form()).getByLabelText("Model"), "opus");
    fireEvent.click(within(form()).getByLabelText("Read only"));
    fireEvent.click(within(form()).getByRole("button", { name: "Start agent" }));
    expect(spawn).toHaveBeenCalledWith("s1", { task: "Add dark mode, nothing else.", name: "Dark mode", isolation: "worktree", model: "opus", role: { id: "builder", label: "Builder", read_only: true } });
  });

  it("makes a shared folder read only, since it holds no editing, and picking a role again starts the form over", () => {
    mount();
    open();
    type(roleSelect(), "builder");
    fireEvent.click(within(form()).getByLabelText("Shared folder"));
    expect((within(form()).getByLabelText("Read only") as HTMLInputElement).checked).toBe(true);
    expect((within(form()).getByLabelText("Can edit") as HTMLInputElement).disabled).toBe(true);
    type(roleSelect(), "builder");
    expect((within(form()).getByLabelText("Own worktree") as HTMLInputElement).checked).toBe(true);
    expect((within(form()).getByLabelText("Can edit") as HTMLInputElement).checked).toBe(true);
    type(roleSelect(), "");
    expect(within(form()).queryByLabelText(/^Brief/)).toBeNull();
    expect((within(form()).getByLabelText("Model") as HTMLSelectElement).value).toBe("");
  });

  it("still wants a task before it starts a role", () => {
    const { spawn } = mount();
    open();
    type(roleSelect(), "qa");
    fireEvent.click(within(form()).getByRole("button", { name: "Start agent" }));
    expect(within(form()).getByRole("alert").textContent).toBe("Say what the agent should do.");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("the project's own roles", () => {
  const saveAs = (name: string) => {
    fireEvent.click(within(form()).getByRole("button", { name: "Save as a role…" }));
    type(within(form()).getByLabelText("Role name"), name);
    fireEvent.click(within(form()).getByRole("button", { name: "Save role" }));
  };

  it("saves the form as a role, which is then chosen with its brief, place and access", () => {
    mountWithRoles();
    open();
    type(roleSelect(), "reviewer");
    type(task(), "the routes");
    type(brief(), "You are an API reviewer. Check every route in: the routes");
    type(within(form()).getByLabelText("Model"), "haiku");
    saveAs("API reviewer");
    expect(roleSelect().value).toBe("api-reviewer");
    expect([...roleSelect().options].map((o) => o.textContent)).toContain("API reviewer");
    expect(JSON.parse(localStorage.getItem("settings.rolesByFolder")!)).toEqual({
      "/p/acme": [{ id: "api-reviewer", label: "API reviewer", description: "", brief: "You are an API reviewer. Check every route in: {task}", model: "haiku", isolation: "shared", readOnly: true }],
    });
    // The task they typed is its place again in the brief.
    expect(brief().value).toBe("You are an API reviewer. Check every route in: the routes");
    expect((within(form()).getByLabelText("Model") as HTMLSelectElement).value).toBe("haiku");
  });

  it("saves what was written with no role as a role whose brief the task is appended to", () => {
    const { spawn } = mountWithRoles();
    open();
    type(task(), "Check every route for a missing auth check.");
    saveAs("Auth check");
    expect(task().value).toBe("");
    type(task(), "the admin routes");
    expect(brief().value).toBe("Check every route for a missing auth check.\n\nthe admin routes");
    fireEvent.click(within(form()).getByRole("button", { name: "Start agent" }));
    expect(spawn).toHaveBeenCalledWith("s1", expect.objectContaining({ name: "Auth check: the admin routes", role: { id: "auth-check", label: "Auth check", read_only: false } }));
  });

  it("asks for a name and a brief, and keeps nothing without them", () => {
    mountWithRoles();
    open();
    fireEvent.click(within(form()).getByRole("button", { name: "Save as a role…" }));
    fireEvent.click(within(form()).getByRole("button", { name: "Save role" }));
    expect(within(form()).getByRole("alert").textContent).toBe("Give the role a name.");
    type(within(form()).getByLabelText("Role name"), "Empty");
    fireEvent.click(within(form()).getByRole("button", { name: "Save role" }));
    expect(within(form()).getByRole("alert").textContent).toContain("Write the brief first");
    expect(localStorage.getItem("settings.rolesByFolder")).toBe("{}");
  });

  it("updates a role of its own when it is saved under the same name, and makes a new one under another", () => {
    mountWithRoles();
    open();
    type(task(), "Look for slow queries.");
    saveAs("DB reviewer");
    type(brief(), "Look for slow queries and missing indexes in: {task}");
    saveAs("DB reviewer");
    expect([...roleSelect().options].filter((o) => o.textContent === "DB reviewer")).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("settings.rolesByFolder")!)["/p/acme"][0].brief).toBe("Look for slow queries and missing indexes in: {task}");
    saveAs("DB reviewer 2");
    expect(JSON.parse(localStorage.getItem("settings.rolesByFolder")!)["/p/acme"].map((r: { id: string }) => r.id)).toEqual(["db-reviewer", "db-reviewer-2"]);
  });

  it("deletes a role after asking, and a built-in role can't be deleted", () => {
    mountWithRoles();
    open();
    type(roleSelect(), "reviewer");
    expect(within(form()).queryByRole("button", { name: "Delete this role" })).toBeNull();
    type(roleSelect(), "");
    type(task(), "Look for slow queries.");
    saveAs("DB reviewer");
    fireEvent.click(within(form()).getByRole("button", { name: "Delete this role" }));
    expect(within(form()).getByRole("group", { name: "Delete this role" }).textContent).toContain("Delete “DB reviewer”?");
    fireEvent.click(within(form()).getByRole("button", { name: "Keep it" }));
    expect(roleSelect().value).toBe("db-reviewer");
    fireEvent.click(within(form()).getByRole("button", { name: "Delete this role" }));
    fireEvent.click(within(form()).getByRole("button", { name: "Delete role" }));
    expect(roleSelect().value).toBe("");
    expect([...roleSelect().options].map((o) => o.textContent)).not.toContain("DB reviewer");
    expect(JSON.parse(localStorage.getItem("settings.rolesByFolder")!)["/p/acme"]).toEqual([]);
  });

  it("keeps the roles of one project to that project", () => {
    localStorage.setItem("settings.rolesByFolder", JSON.stringify({ "/p/other": [{ id: "x", label: "Other project's", description: "", brief: "{task}", model: "sonnet", isolation: "shared", readOnly: true }] }));
    mountWithRoles();
    open();
    expect([...roleSelect().options].map((o) => o.textContent)).not.toContain("Other project's");
  });

  it("closes only the name box on Escape, not the whole form", () => {
    mountWithRoles();
    open();
    fireEvent.click(within(form()).getByRole("button", { name: "Save as a role…" }));
    fireEvent.keyDown(within(form()).getByLabelText("Role name"), { key: "Escape" });
    expect(within(form()).queryByLabelText("Role name")).toBeNull();
    expect(form()).toBeTruthy();
  });
});
