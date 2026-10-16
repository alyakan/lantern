import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatsReducer, initialChats, type Chats } from "../sessions";
import { initialState, type State } from "../store";
import { ChatStoreContext, createChatStore, NodeActionsContext, type NodeActions } from "../lib/canvasContext";
import { orchestraNodes } from "../lib/orchestraView";
import { ProjectSetupContext, type SetupByFolder } from "../lib/projectSetup";
import type { UiEvent } from "../types";
import { Canvas, newLayout } from "./Canvas";

afterEach(cleanup);

const main: State = { ...initialState, status: "idle", claudePath: "/bin/claude", folder: "/p", orchestrator: true, mode: "auto" };

function team(): Chats {
  return chatsReducer(initialChats(main), { type: "in", slot: "s1", action: { type: "ui_event", event: { kind: "agent_spawned", worker: "w1", name: "Worker 1", brief: "Task 1", folder: "/wt/w1", branch: "lantern/w1", base: "main", isolation: "worktree", mode: "auto" } } });
}

const to = (chats: Chats, slot: string, event: UiEvent) => chatsReducer(chats, { type: "in", slot, action: { type: "ui_event", event } });
const setupEvent = (phase: "running" | "failed" | "done", over: Partial<Extract<UiEvent, { kind: "agent_setup" }>> = {}): UiEvent => ({ kind: "agent_setup", phase, index: 0, total: 2, command: "", line: "", reason: "", tail: "", ...over });

const actions = (over: Partial<NodeActions> = {}): NodeActions => ({
  send: vi.fn(), clear: vi.fn(), stop: vi.fn(), queue: vi.fn(), decide: vi.fn(), openFile: vi.fn(), openTestRun: vi.fn(), stopShell: vi.fn(), answerSetup: vi.fn(() => Promise.resolve()), run: vi.fn(), stopRun: vi.fn(), closeRun: vi.fn(), shellInput: vi.fn(), restart: vi.fn(),
  approveMerge: vi.fn(), declineMerge: vi.fn(() => Promise.resolve()), reviewMerge: vi.fn(), removeWorktree: vi.fn(() => Promise.resolve()), spawn: vi.fn(() => Promise.resolve()), closeCheck: vi.fn(() => Promise.resolve({ worktree: true, branch: null, uncommitted: 0, unmerged_commits: 0 })), closeWorker: vi.fn(() => Promise.resolve()), hide: vi.fn(), show: vi.fn(), setPermissions: vi.fn(), setWorkflow: vi.fn(), setSubagents: vi.fn(), setReview: vi.fn(), draft: vi.fn(() => ""), setDraft: vi.fn(),
  ...over,
});

const RUN: SetupByFolder = { "/p": { commands: ["npm ci"], run: "npm run dev" } };

function show(chats: Chats, setups: SetupByFolder = RUN, over: Partial<NodeActions> = {}) {
  const store = createChatStore();
  store.set(chats.slots);
  const acts = actions(over);
  const ui = (c: Chats) => (
    <ProjectSetupContext.Provider value={setups}>
      <ChatStoreContext.Provider value={store}>
        <NodeActionsContext.Provider value={acts}>
          <Canvas nodes={orchestraNodes(c, () => "Lead")} layout={layout} activeSlot="s1" attention={[]} onFocus={vi.fn()} onOpen={vi.fn()} />
        </NodeActionsContext.Provider>
      </ChatStoreContext.Provider>
    </ProjectSetupContext.Provider>
  );
  const layout = newLayout();
  const r = render(ui(chats));
  return {
    acts,
    update: (c: Chats) => {
      store.set(c.slots);
      r.rerender(ui(c));
    },
  };
}

describe("the Run button on an agent's card", () => {
  it("is there when the project has a Run command, and starts it for that agent", () => {
    const { acts } = show(team());
    const button = screen.getByRole("button", { name: "Run Worker 1" });
    expect(button.getAttribute("title")).toBe("Run: npm run dev");
    fireEvent.click(button);
    expect(acts.run).toHaveBeenCalledWith("w1");
    // The lead is in the project's own folder, and has one too.
    expect(screen.getByRole("button", { name: "Run Lead" })).toBeTruthy();
  });

  it("is not there when the project has no Run command", () => {
    show(team(), { "/p": { commands: ["npm ci"], run: "" } });
    expect(screen.queryByRole("button", { name: /^Run / })).toBeNull();
    cleanup();
    show(team(), {});
    expect(screen.queryByRole("button", { name: /^Run / })).toBeNull();
  });

  it("isn't offered while the agent's worktree is being set up", () => {
    show(to(team(), "w1", setupEvent("running", { command: "npm ci" })));
    expect(screen.queryByRole("button", { name: "Run Worker 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run Lead" })).toBeTruthy();
  });

  it("is off while the command runs, and the panel under the card has Stop, Restart and close", () => {
    let chats = team();
    chats = chatsReducer(chats, { type: "in", slot: "w1", action: { type: "run_started", id: "run-a-1", command: "npm run dev" } });
    chats = to(chats, "w1", { kind: "shell_output", id: "run-a-1", text: "  Local: http://localhost:5173/\n" });
    const { acts } = show(chats);
    expect((screen.getByRole("button", { name: "Run Worker 1" }) as HTMLButtonElement).disabled).toBe(true);
    const panel = screen.getByRole("group", { name: "Run" });
    expect(within(panel).getByRole("status").textContent).toBe("Running");
    expect(within(panel).getByRole("link").textContent).toBe("http://localhost:5173/");
    fireEvent.click(within(panel).getByRole("button", { name: "Stop" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Restart" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Close the Run panel" }));
    expect(acts.stopRun).toHaveBeenCalledWith("w1");
    expect(acts.run).toHaveBeenCalledWith("w1");
    expect(acts.closeRun).toHaveBeenCalledWith("w1");
  });

  it("comes back when the run ends, and the panel says it stopped", () => {
    let chats = chatsReducer(team(), { type: "in", slot: "w1", action: { type: "run_started", id: "run-a-1", command: "npm run dev" } });
    const { update } = show(chats);
    chats = to(chats, "w1", { kind: "shell_done", id: "run-a-1", code: 1, stopped: false });
    update(chats);
    expect((screen.getByRole("button", { name: "Run Worker 1" }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(screen.getByRole("group", { name: "Run" })).getByRole("status").textContent).toBe("Failed (exit 1)");
  });
});

describe("an agent whose worktree is being set up", () => {
  it("says so on its card, with the line that runs", () => {
    show(to(to(team(), "w1", setupEvent("running", { command: "npm ci" })), "w1", setupEvent("running", { line: "added 412 packages" })));
    const card = screen.getByRole("region", { name: "Agent Worker 1, Setting up" });
    expect(within(card).getByRole("status", { name: "Setting up" }).textContent).toContain("Setting up: npm ci…");
    expect(within(card).getByText("added 412 packages")).toBeTruthy();
    expect(card.querySelector(".node-status")!.textContent).toBe("Setting up");
  });

  it("can have its setup stopped from the card", () => {
    const { acts } = show(to(team(), "w1", setupEvent("running", { command: "npm ci" })));
    fireEvent.click(within(screen.getByRole("status", { name: "Setting up" })).getByRole("button", { name: "Stop" }));
    expect(acts.answerSetup).toHaveBeenCalledWith("w1", "stop");
  });

  it("needs the user when a line failed: the card says which, and the three answers work", async () => {
    const { acts } = show(to(team(), "w1", setupEvent("failed", { index: 0, command: "npm ci", reason: "it exited with code 1", tail: "npm ERR! nope" })));
    const card = screen.getByRole("region", { name: "Agent Worker 1, Setup stopped" });
    expect(card.querySelector(".node-status")!.textContent).toBe("Setup stopped");
    expect(within(card).getByRole("group", { name: "Setup stopped" }).textContent).toContain("Setup stopped at npm ci");
    expect(within(card).getByRole("region", { name: "What it printed last" }).textContent).toBe("npm ERR! nope");
    fireEvent.click(within(card).getByRole("button", { name: "Start anyway" }));
    expect(acts.answerSetup).toHaveBeenLastCalledWith("w1", "start");
    await waitFor(() => expect((within(card).getByRole("button", { name: "Run setup again" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(card).getByRole("button", { name: "Run setup again" }));
    expect(acts.answerSetup).toHaveBeenLastCalledWith("w1", "again");
  });

  it("closes the agent the way its menu does: asked what would be lost, nothing to lose closes at once", async () => {
    const { acts } = show(to(team(), "w1", setupEvent("failed", { command: "npm ci", reason: "it exited with code 1" })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close agent" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Close agent" }));
    expect(acts.closeCheck).toHaveBeenCalledWith("w1");
    await waitFor(() => expect(acts.closeWorker).toHaveBeenCalledWith("w1", undefined));
  });

  it("asks before closing when setup left files behind", async () => {
    const { acts } = show(to(team(), "w1", setupEvent("failed", { command: "npm ci", reason: "it exited with code 1" })), RUN, { closeCheck: vi.fn(() => Promise.resolve({ worktree: true, branch: "lantern/w1", uncommitted: 2, unmerged_commits: 0 })) });
    fireEvent.click(screen.getByRole("button", { name: "Close agent" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("2 uncommitted files");
    expect(acts.closeWorker).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard work and close" }));
    await waitFor(() => expect(acts.closeWorker).toHaveBeenCalledWith("w1", { uncommitted: 2, unmerged_commits: 0 }));
  });
});
