import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { chatsReducer, initialChats, WAKE_LIMIT, type Chats } from "../sessions";
import { initialState, type State } from "../store";
import { ChatStoreContext, createChatStore, NodeActionsContext, type NodeActions } from "../lib/canvasContext";
import { needingYou, orchestraNodes } from "../lib/orchestraView";
import { GAP, MAIN_SIZE, overlaps, SUMMARY_ZOOM, WORKER_SIZE } from "../lib/canvas";
import { Canvas, newLayout, placeNodes, UPDATE_REQUEST } from "./Canvas";

// jsdom has no PointerEvent, so its clientX, button and pointerId would never reach a handler.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}

const main: State = { ...initialState, status: "idle", claudePath: "/bin/claude", folder: "/p", orchestrator: true, mode: "auto" };

function team(workers = 2): Chats {
  let c = initialChats(main);
  for (let i = 1; i <= workers; i++) {
    c = chatsReducer(c, { type: "in", slot: "s1", action: { type: "ui_event", event: { kind: "agent_spawned", worker: `w${i}`, name: `Worker ${i}`, brief: `Task ${i}`, folder: `/wt/w${i}`, branch: `lantern/w${i}`, base: "main", isolation: "worktree", mode: "auto" } } });
  }
  return c;
}

const actions = (over: Partial<NodeActions> = {}): NodeActions => ({ send: vi.fn(), clear: vi.fn(), stop: vi.fn(), queue: vi.fn(), decide: vi.fn(), openFile: vi.fn(), openTestRun: vi.fn(), stopShell: vi.fn(), answerSetup: vi.fn(() => Promise.resolve()), run: vi.fn(), stopRun: vi.fn(), closeRun: vi.fn(), shellInput: vi.fn(), restart: vi.fn(), approveMerge: vi.fn(), declineMerge: vi.fn(() => Promise.resolve()), reviewMerge: vi.fn(), removeWorktree: vi.fn(() => Promise.resolve()), spawn: vi.fn(() => Promise.resolve()), closeCheck: vi.fn(() => Promise.resolve({ worktree: true, branch: null, uncommitted: 0, unmerged_commits: 0 })), closeWorker: vi.fn(() => Promise.resolve()), hide: vi.fn(), show: vi.fn(), setPermissions: vi.fn(), setWorkflow: vi.fn(), setSubagents: vi.fn(), draft: vi.fn(() => ""), setDraft: vi.fn(), ...over });

function setup(chats: Chats, extra: { attention?: string[]; layout?: ReturnType<typeof newLayout>; actions?: Partial<NodeActions> } = {}) {
  const store = createChatStore();
  store.set(chats.slots);
  const layout = extra.layout ?? newLayout();
  const handlers = { onFocus: vi.fn(), onOpen: vi.fn() };
  const nodes = orchestraNodes(chats, () => "Lead");
  const acts = actions(extra.actions);
  const ui = (
    <ChatStoreContext.Provider value={store}>
      <NodeActionsContext.Provider value={acts}>
        <Canvas nodes={nodes} layout={layout} activeSlot="s1" attention={extra.attention ?? []} {...handlers} />
      </NodeActionsContext.Provider>
    </ChatStoreContext.Provider>
  );
  return { ...render(ui), layout, store, ...handlers, nodes, acts };
}

describe("placeNodes", () => {
  it("puts the main agent first and workers beside it without overlap, and gives every agent a front-to-back place", () => {
    const layout = newLayout();
    placeNodes(layout, orchestraNodes(team(3), () => "Lead"));
    expect(layout.boxes.s1).toEqual({ x: 0, y: 0, ...MAIN_SIZE });
    expect(layout.boxes.w1.x).toBe(MAIN_SIZE.w + GAP);
    const boxes = Object.values(layout.boxes);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false);
    expect(layout.order).toEqual(["s1", "w1", "w2", "w3"]);
    expect(layout.boxes.w2).toMatchObject(WORKER_SIZE);
  });

  it("leaves agents the user moved where they put them, and forgets agents that are gone", () => {
    const layout = newLayout();
    const chats = team(2);
    placeNodes(layout, orchestraNodes(chats, () => "Lead"));
    layout.boxes.w1 = { x: 5, y: 6, w: 400, h: 300 };
    placeNodes(layout, orchestraNodes(chats, () => "Lead"));
    expect(layout.boxes.w1).toEqual({ x: 5, y: 6, w: 400, h: 300 });
    const fewer = chatsReducer(chats, { type: "remove", slot: "w2" });
    placeNodes(layout, orchestraNodes(fewer, () => "Lead"));
    expect(Object.keys(layout.boxes)).toEqual(["s1", "w1"]);
    expect(layout.order).toEqual(["s1", "w1"]);
  });

  it("puts a second main agent below the first one's team", () => {
    const layout = newLayout();
    let chats = team(2);
    chats = chatsReducer(chats, { type: "add", slot: "s2" });
    chats = chatsReducer(chats, { type: "in", slot: "s2", action: { type: "orchestrator_set", on: true } });
    placeNodes(layout, orchestraNodes(chats, () => "Lead"));
    const team1 = [layout.boxes.s1, layout.boxes.w1, layout.boxes.w2];
    expect(team1.every((b) => b.y + b.h < layout.boxes.s2.y)).toBe(true);
  });
});

/** A team whose agents are all idle, so their settings can be changed. */
function idleTeam(workers: number): Chats {
  const c = team(workers);
  return { ...c, slots: Object.fromEntries(Object.entries(c.slots).map(([slot, s]) => [slot, { ...s, status: "idle" as const, thinking: false }])) };
}

describe("the canvas", () => {
  it("shows every agent with its name, role and what it is doing, and the worker's branch", () => {
    setup(team(2));
    const agents = screen.getAllByRole("region");
    expect(agents.map((a) => a.getAttribute("aria-label"))).toEqual(["Lead, Ready", "Agent Worker 1, Working", "Agent Worker 2, Working"]);
    const w1 = screen.getByLabelText(/Agent Worker 1/);
    expect(within(w1).getByText("w1")).toBeTruthy(); // its branch (lantern/w1 without the prefix)
    expect(within(w1).getByRole("button", { name: "Permissions: Auto" })).toBeTruthy();
    expect(within(screen.getByLabelText(/^Lead,/)).getByText("Runs the team")).toBeTruthy();
    expect(document.querySelectorAll("path.tether")).toHaveLength(2);
  });

  it("puts Permissions and Workflow on every window's title bar, and changes them for that window", () => {
    const { acts } = setup(idleTeam(1));
    const lead = screen.getByLabelText(/^Lead,/);
    const w1 = screen.getByLabelText(/Agent Worker 1/);
    expect(within(lead).getByRole("button", { name: "Workflow: Team" })).toBeTruthy();
    expect(within(w1).getByRole("button", { name: "Workflow: Chat" })).toBeTruthy();
    // A team's Permissions are changed from the canvas, on the Lead's window or an agent's.
    fireEvent.click(within(lead).getByRole("button", { name: "Permissions: Auto" }));
    fireEvent.click(within(lead).getByRole("menuitemradio", { name: /^Ask/ }));
    expect(acts.setPermissions).toHaveBeenCalledWith("s1", "ask");
    fireEvent.click(within(w1).getByRole("button", { name: "Permissions: Auto" }));
    fireEvent.click(within(w1).getByRole("menuitemradio", { name: /^Ask/ }));
    expect(acts.setPermissions).toHaveBeenCalledWith("w1", "ask");
  });

  it("keeps the Lead in Team while it has agents, and offers an agent no Team of its own", () => {
    const { acts } = setup(idleTeam(1));
    const lead = screen.getByLabelText(/^Lead,/);
    fireEvent.click(within(lead).getByRole("button", { name: "Workflow: Team" }));
    expect(within(lead).getByRole("menuitemradio", { name: /^Chat/ })).toBeDisabled();
    expect(within(lead).getByRole("menuitemradio", { name: /^Step by step/ })).toBeDisabled();
    fireEvent.keyDown(within(lead).getByRole("menu"), { key: "Escape" });
    const w1 = screen.getByLabelText(/Agent Worker 1/);
    fireEvent.click(within(w1).getByRole("button", { name: "Workflow: Chat" }));
    expect(within(w1).queryByRole("menuitemradio", { name: /^Team/ })).toBeNull();
    fireEvent.click(within(w1).getByRole("menuitemradio", { name: /^Step by step/ }));
    expect(acts.setWorkflow).toHaveBeenCalledWith("w1", "steps");
  });

  it("lets a Lead with no agents leave Team", () => {
    setup(team(0));
    const lead = screen.getByLabelText(/^Lead,/);
    fireEvent.click(within(lead).getByRole("button", { name: "Workflow: Team" }));
    expect(within(lead).getByRole("menuitemradio", { name: /^Chat/ })).toBeEnabled();
  });

  it("shows the team's Subagents setting in its controls, on the canvas by default, and changes it", () => {
    const { acts } = setup(team(1));
    fireEvent.click(screen.getByRole("button", { name: "Subagents: On the canvas" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Inline/ }));
    expect(acts.setSubagents).toHaveBeenCalledWith("s1", "inline");
  });

  it("hides the title bar's settings while an agent is folded, and while it works (a change restarts it)", () => {
    setup(team(1));
    const w1 = screen.getByLabelText(/Agent Worker 1/);
    // A worker that is working can't be switched: its claude would restart mid-turn.
    expect(within(w1).getByRole("button", { name: "Permissions: Auto" })).toBeDisabled();
    fireEvent.click(within(w1).getByRole("button", { name: "Collapse Worker 1" }));
    expect(within(screen.getByLabelText(/Agent Worker 1/)).queryByRole("button", { name: /^Permissions:/ })).toBeNull();
  });

  it("folds an agent to its title and back, and opens one full size", () => {
    const { onOpen, layout } = setup(team(1));
    const w1 = screen.getByLabelText(/Agent Worker 1/);
    expect(w1.querySelector(".node-body")).toBeTruthy();
    fireEvent.click(within(w1).getByRole("button", { name: "Collapse Worker 1" }));
    expect(screen.getByLabelText(/Agent Worker 1/).querySelector(".node-body")).toBeNull();
    expect(layout.collapsed.w1).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand Worker 1" }));
    expect(screen.getByLabelText(/Agent Worker 1/).querySelector(".node-body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Worker 1 full size" }));
    expect(onOpen).toHaveBeenCalledWith("w1");
  });

  it("tells the app which agent was pressed, and brings it to the front", () => {
    const { onFocus, layout } = setup(team(2));
    expect(layout.order).toEqual(["s1", "w1", "w2"]);
    fireEvent.pointerDown(within(screen.getByLabelText(/Agent Worker 1/)).getByText("Worker 1"));
    expect(onFocus).toHaveBeenCalledWith("w1");
    expect(layout.order).toEqual(["s1", "w2", "w1"]);
  });

  it("offers a way to the agents that need you, one after another", () => {
    const { onFocus } = setup(team(2), { attention: ["w1", "w2"] });
    const pill = screen.getByRole("button", { name: /2 agents need you/ });
    fireEvent.click(pill);
    expect(onFocus).toHaveBeenLastCalledWith("w1");
    fireEvent.click(pill);
    expect(onFocus).toHaveBeenLastCalledWith("w2");
    fireEvent.click(pill);
    expect(onFocus).toHaveBeenLastCalledWith("w1");
  });

  it("frames the agent that needs you at 100%, however far out the view was", () => {
    const { layout } = setup(team(2), { attention: ["w1"] });
    const canvas = screen.getByTestId("canvas");
    act(() => {
      fireEvent.wheel(canvas, { ctrlKey: true, deltaY: 600 });
    });
    expect(layout.view!.zoom).toBeLessThan(SUMMARY_ZOOM);
    fireEvent.click(screen.getByRole("button", { name: /1 agent needs you/ }));
    expect(layout.view!.zoom).toBe(1);
    expect(canvas.classList.contains("summary")).toBe(false);
  });

  it("has no pill when nobody needs you", () => {
    setup(team(1));
    expect(screen.queryByRole("button", { name: /need/ })).toBeNull();
  });

  it("turns agents into cards when zoomed out past where a chat can be read, and back", () => {
    setup(team(1));
    const canvas = screen.getByTestId("canvas");
    expect(canvas.classList.contains("summary")).toBe(false);
    expect(document.querySelector(".node-chat")).toBeTruthy();
    // Pinch out.
    act(() => {
      fireEvent.wheel(canvas, { ctrlKey: true, deltaY: 120 });
      fireEvent.wheel(canvas, { ctrlKey: true, deltaY: 120 });
    });
    expect(canvas.classList.contains("summary")).toBe(true);
    expect(document.querySelector(".node-chat")).toBeNull();
    expect(document.querySelector(".node-summary")).toBeTruthy();
    expect(Number(canvas.style.getPropertyValue("--zoom"))).toBeLessThan(SUMMARY_ZOOM);
    act(() => {
      fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -400 });
    });
    expect(canvas.classList.contains("summary")).toBe(false);
  });

  it("zooms in on a card when it is clicked", () => {
    const { layout } = setup(team(1));
    const canvas = screen.getByTestId("canvas");
    act(() => {
      fireEvent.wheel(canvas, { ctrlKey: true, deltaY: 300 });
    });
    expect(canvas.classList.contains("summary")).toBe(true);
    const card = screen.getByLabelText(/Agent Worker 1/).querySelector(".node-body")!;
    // A press that doesn't move is a click.
    act(() => {
      fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(card, { pointerId: 1, clientX: 101, clientY: 100 });
    });
    expect(layout.view!.zoom).toBeGreaterThanOrEqual(SUMMARY_ZOOM);
    expect(canvas.classList.contains("summary")).toBe(false);
  });

  it("pans when a card is dragged, instead of zooming in on it", () => {
    const { layout } = setup(team(1));
    const canvas = screen.getByTestId("canvas");
    act(() => {
      fireEvent.wheel(canvas, { ctrlKey: true, deltaY: 300 });
    });
    expect(canvas.classList.contains("summary")).toBe(true);
    const before = { ...layout.view! };
    const card = screen.getByLabelText(/Agent Worker 1/).querySelector(".node-body")!;
    act(() => {
      fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(card, { pointerId: 1, clientX: 160, clientY: 130 });
      fireEvent.pointerUp(card, { pointerId: 1, clientX: 160, clientY: 130 });
    });
    expect(layout.view!.zoom).toBe(before.zoom);
    expect(layout.view!.x).toBeCloseTo(before.x + 60);
    expect(layout.view!.y).toBeCloseTo(before.y + 30);
    expect(canvas.classList.contains("summary")).toBe(true);
  });

  it("does not treat a click on the background as framing the view itself", () => {
    const { layout } = setup(team(1));
    const canvas = screen.getByTestId("canvas");
    expect(layout.touched).toBe(false);
    act(() => {
      fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 50, clientY: 50 });
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 52, clientY: 51 });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 52, clientY: 51 });
    });
    // So an agent that arrives next still gets the view re-framed to show it.
    expect(layout.touched).toBe(false);
    act(() => {
      fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 50, clientY: 50 });
      fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 90, clientY: 80 });
      fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 90, clientY: 80 });
    });
    expect(layout.touched).toBe(true);
  });

  it("keeps an agent where the pointer is when the zoom changes in the middle of dragging it", () => {
    const { layout } = setup(team(1));
    const canvas = screen.getByTestId("canvas");
    const zoom = layout.view?.zoom ?? 1;
    const w1 = screen.getByLabelText(/Agent Worker 1/);
    const start = { ...layout.boxes.w1 };
    const head = w1.querySelector(".node-head")!;
    fireEvent.pointerDown(head, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    act(() => {
      fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -200 }); // zoomed in mid-drag
    });
    expect(layout.view!.zoom).not.toBe(zoom);
    fireEvent.pointerMove(head, { pointerId: 1, clientX: 150, clientY: 100 });
    fireEvent.pointerUp(head, { pointerId: 1 });
    expect(layout.boxes.w1.x).toBeCloseTo(start.x + 50 / zoom);
  });

  it("gives the world a layer of its own only while it pans or zooms, so the text is drawn sharp at rest", () => {
    vi.useFakeTimers();
    try {
      setup(team(1));
      const world = screen.getByTestId("canvas").querySelector(".canvas-world")!;
      expect(world).not.toHaveClass("moving");
      act(() => {
        fireEvent.wheel(screen.getByTestId("canvas"), { ctrlKey: true, deltaY: -200 });
      });
      expect(world).toHaveClass("moving");
      // Still moving while it keeps going, and let go a moment after it stops.
      act(() => vi.advanceTimersByTime(100));
      act(() => {
        fireEvent.wheel(screen.getByTestId("canvas"), { ctrlKey: true, deltaY: -50 });
      });
      act(() => vi.advanceTimersByTime(100));
      expect(world).toHaveClass("moving");
      act(() => vi.advanceTimersByTime(100));
      expect(world).not.toHaveClass("moving");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pans with the wheel on the background but lets a chat scroll under it", () => {
    const { layout } = setup(team(1));
    const canvas = screen.getByTestId("canvas");
    const x0 = layout.view?.x ?? 0;
    const y0 = layout.view?.y ?? 0;
    act(() => {
      fireEvent.wheel(canvas, { deltaX: 30, deltaY: 50 });
    });
    expect(layout.view).toMatchObject({ x: x0 - 30, y: y0 - 50 });
    const chat = screen.getByLabelText(/Agent Worker 1/).querySelector(".node-chat")!;
    const before = { ...layout.view! };
    act(() => {
      fireEvent.wheel(chat, { deltaX: 0, deltaY: 80 });
    });
    expect(layout.view).toEqual(before);
    // A title is not a chat: the wheel pans there.
    act(() => {
      fireEvent.wheel(screen.getByLabelText(/Agent Worker 1/).querySelector(".node-head")!, { deltaX: 0, deltaY: 20 });
    });
    expect(layout.view!.y).toBeCloseTo(before.y - 20);
  });

  it("meets a folded agent's tether at its title bar, not at the space its full height would have taken", () => {
    const { layout } = setup(team(1));
    const full = document.querySelector("path.tether")!.getAttribute("d")!;
    fireEvent.click(screen.getByRole("button", { name: "Collapse Worker 1" }));
    const folded = document.querySelector("path.tether")!.getAttribute("d")!;
    expect(layout.collapsed.w1).toBe(true);
    expect(folded).not.toBe(full);
    // The last point is on the agent's left edge, within its 52px title bar.
    const y = Number(folded.trim().split(" ").pop());
    const box = layout.boxes.w1;
    expect(y).toBeGreaterThanOrEqual(box.y);
    expect(y).toBeLessThanOrEqual(box.y + 52);
  });

  it("moves an agent by dragging its title and resizes it from its corner, at any zoom", () => {
    const { layout } = setup(team(1));
    const canvas = screen.getByTestId("canvas");
    act(() => {
      fireEvent.wheel(canvas, { ctrlKey: true, deltaY: 60 }); // zoom out a little
    });
    const zoom = layout.view!.zoom;
    expect(zoom).toBeLessThan(1);
    const w1 = screen.getByLabelText(/Agent Worker 1/);
    const start = { ...layout.boxes.w1 };
    const head = w1.querySelector(".node-head")!;
    fireEvent.pointerDown(head, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(head, { pointerId: 1, clientX: 160, clientY: 130 });
    fireEvent.pointerUp(head, { pointerId: 1 });
    expect(layout.boxes.w1.x).toBeCloseTo(start.x + 60 / zoom);
    expect(layout.boxes.w1.y).toBeCloseTo(start.y + 30 / zoom);
    expect(w1.style.transform).toContain(`translate(${layout.boxes.w1.x}px, ${layout.boxes.w1.y}px)`);

    const grip = w1.querySelector(".node-resize")!;
    const size = { w: layout.boxes.w1.w, h: layout.boxes.w1.h };
    fireEvent.pointerDown(grip, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(grip, { pointerId: 2, clientX: 40, clientY: 20 });
    fireEvent.pointerUp(grip, { pointerId: 2 });
    expect(layout.boxes.w1.w).toBeCloseTo(size.w + 40 / zoom);
    expect(layout.boxes.w1.h).toBeCloseTo(size.h + 20 / zoom);
    expect(w1.style.width).toBe(`${layout.boxes.w1.w}px`);
  });

  it("does not start a drag from the buttons in a title", () => {
    const { layout } = setup(team(1));
    const start = { ...layout.boxes.w1 };
    const button = screen.getByRole("button", { name: "Collapse Worker 1" });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(button.closest("header")!, { pointerId: 1, clientX: 90, clientY: 90 });
    expect(layout.boxes.w1).toEqual(start);
  });

  it("keeps where agents were when the canvas is shown again", () => {
    const first = setup(team(1));
    first.layout.boxes.w1 = { x: 900, y: 40, w: 410, h: 380 };
    first.unmount();
    setup(team(1), { layout: first.layout });
    expect(screen.getByLabelText(/Agent Worker 1/).style.transform).toContain("translate(900px, 40px)");
  });

  it("redraws only the agent whose chat changed", () => {
    const { store } = setup(team(2));
    const chats = team(2);
    const w2Body = screen.getByLabelText(/Agent Worker 2/).querySelector(".node-body")!;
    const w1Before = screen.getByLabelText(/Agent Worker 1/).querySelector(".node-chat");
    act(() => {
      store.set({ ...chats.slots, w2: { ...chats.slots.w2, items: [...chats.slots.w2.items, { type: "assistant", id: "a1", text: "Done for now" }] } });
    });
    expect(w2Body.textContent).toContain("Done for now");
    // The other agent's DOM was left alone.
    expect(screen.getByLabelText(/Agent Worker 1/).querySelector(".node-chat")).toBe(w1Before);
  });
});

describe("oversight", () => {
  const proposal = { worker: "w1", name: "Worker 1", branch: "lantern/w1", into: "main", summary: "Adds it", commits: 2, files: [{ path: "a.ts", added: 3, removed: 1 }], uncommitted: 0, loose: [], status: "open" as const, problem: null, attempts: 0 };
  const withProposal = (): Chats => {
    const c = team(2);
    return { ...c, slots: { ...c.slots, s1: { ...c.slots.s1, proposals: [proposal] } } };
  };

  it("shows the merge on the worker it is for, and on the main agent, and calls the worker ready to merge", () => {
    const chats = withProposal();
    chats.slots.w1 = { ...chats.slots.w1, status: "idle", thinking: false };
    setup(chats);
    const w1 = screen.getByLabelText(/Agent Worker 1/);
    expect(within(w1).getByText("Ready to merge")).toBeTruthy();
    expect(within(w1).getByRole("group", { name: "Merge lantern/w1" })).toBeTruthy();
    expect(within(screen.getByLabelText(/^Lead,/)).getByRole("group", { name: "Merge lantern/w1" })).toBeTruthy();
    // The other worker has nothing to show.
    expect(within(screen.getByLabelText(/Agent Worker 2/)).queryByRole("group", { name: /Merge/ })).toBeNull();
  });

  it("lists the team with what each is doing, takes you to one, and counts what the team has cost", () => {
    const chats = withProposal();
    chats.slots.s1 = { ...chats.slots.s1, costSeen: 0.5, sessionTokens: 2_000_000 };
    chats.slots.w1 = { ...chats.slots.w1, status: "idle", thinking: false, costBase: 0.1, costSeen: 0.25, tokenBase: 600_000, sessionTokens: 500_000, items: [{ type: "assistant", id: "a", text: "Finished the form" }] };
    const { onFocus } = setup(chats);
    const button = screen.getByRole("button", { name: "Team" });
    expect(button.textContent).toBe("Team · $0.85 · 3.1M tok");
    // Each agent's card says what it has used.
    expect(within(screen.getByLabelText(/Agent Worker 1/)).getByText(/\$0\.35 · 1\.1M tok/)).toBeTruthy();
    fireEvent.click(button);
    const list = screen.getByRole("dialog", { name: "Team" });
    expect(within(list).getByText("Ready to merge")).toBeTruthy();
    expect(within(list).getByText("Finished the form")).toBeTruthy();
    expect(within(list).getByText("$0.35 · 1.1M tok")).toBeTruthy();
    fireEvent.click(within(list).getByText("Worker 1"));
    expect(onFocus).toHaveBeenCalledWith("w1");
    expect(screen.queryByRole("dialog", { name: "Team" })).toBeNull();
  });

  it("closes the team list on Escape and on a click elsewhere", () => {
    setup(team(1));
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    expect(screen.getByRole("dialog", { name: "Team" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Team" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    fireEvent.pointerDown(screen.getByTestId("canvas"));
    expect(screen.queryByRole("dialog", { name: "Team" })).toBeNull();
  });

  it("shows how full the fullest agent's context is, whose it is when not the Lead's, and warns in words and colour", () => {
    const chats = team(2);
    chats.slots.s1 = { ...chats.slots.s1, contextUsed: 50_000, contextWindow: 200_000 };
    chats.slots.w1 = { ...chats.slots.w1, contextUsed: 100_000, contextWindow: 200_000 };
    chats.slots.w2 = { ...chats.slots.w2, contextUsed: 190_000, contextWindow: 200_000 };
    const { onFocus } = setup(chats);
    const chip = screen.getByRole("button", { name: /^Context:/ });
    // Wide: "Context 95% · Worker 2"; narrow (the stylesheet's container query swaps them): just "95%".
    expect(chip.querySelector(".canvas-ctl-long")?.textContent).toBe("Context 95% · Worker 2");
    expect(chip.querySelector(".canvas-ctl-short")?.textContent).toBe("95%");
    expect(chip).toHaveAccessibleName("Context: Worker 2 95% used, nearly full");
    expect(chip).toHaveClass("full");
    // The tooltip says what the number is and what to do about it.
    expect(chip.getAttribute("title")).toContain("share of Worker 2's context window in use now");
    expect(chip.getAttribute("title")).toContain("At 75% or more, open that agent and use Compact");
    // A click lists every agent, with its share as a bar and its tokens; a click on a name goes there.
    fireEvent.click(chip);
    const list = screen.getByRole("dialog", { name: "Context by agent" });
    expect(within(list).getAllByRole("meter").map((m) => [m.getAttribute("aria-label"), m.getAttribute("aria-valuenow")])).toEqual([
      ["Lead context used", "25"],
      ["Worker 1 context used", "50"],
      ["Worker 2 context used", "95"],
    ]);
    expect(within(list).getByTitle("100,000 of 200,000 tokens")).toHaveTextContent("100k of 200k");
    fireEvent.click(within(list).getByRole("button", { name: "Worker 2" }));
    expect(onFocus).toHaveBeenCalledWith("w2");
    expect(screen.queryByRole("dialog", { name: "Context by agent" })).toBeNull();
  });

  it("closes the context list on Escape and puts focus back on the chip", () => {
    const chats = team(1);
    chats.slots.s1 = { ...chats.slots.s1, contextUsed: 50_000, contextWindow: 200_000 };
    setup(chats);
    const chip = screen.getByRole("button", { name: /^Context:/ });
    expect(chip).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(chip);
    expect(screen.getByRole("button", { name: /Compact all above 60%/ })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Context by agent" })).toBeNull();
    expect(chip).toHaveFocus();
  });

  it("shows the Lead's context on its own while it is the fullest, and nothing before any agent has used any", () => {
    const quiet = setup(team(1));
    expect(screen.queryByRole("button", { name: /^Context:/ })).toBeNull();
    quiet.unmount();
    const chats = team(1);
    chats.slots.s1 = { ...chats.slots.s1, contextUsed: 156_000, contextWindow: 200_000 };
    chats.slots.w1 = { ...chats.slots.w1, contextUsed: 20_000 };
    setup(chats);
    const chip = screen.getByRole("button", { name: /^Context:/ });
    expect(chip.querySelector(".canvas-ctl-long")?.textContent).toBe("Context 78%");
    expect(chip).toHaveClass("warn");
    expect(chip).toHaveAccessibleName("Context: Lead 78% used, getting full");
  });

  it("shows no cost until something has cost anything", () => {
    setup(team(1));
    expect(screen.getByRole("button", { name: "Team" }).textContent).toBe("Team");
  });
});

describe("asking for an update", () => {
  const mount = (chats: Chats, a: NodeActions, onFocus = vi.fn()) => {
    const store = createChatStore();
    store.set(chats.slots);
    render(
      <ChatStoreContext.Provider value={store}>
        <NodeActionsContext.Provider value={a}>
          <Canvas nodes={orchestraNodes(chats, () => "Lead")} layout={newLayout()} activeSlot="s1" attention={[]} onFocus={onFocus} onOpen={vi.fn()} />
        </NodeActionsContext.Provider>
      </ChatStoreContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    return onFocus;
  };
  const ask = () => screen.getByRole("button", { name: "Ask the Lead for an update" });

  it("sends the main agent a request for a plain-language status report, and takes you to it", () => {
    const a = actions();
    const onFocus = mount(team(2), a);
    fireEvent.click(ask());
    expect(a.send).toHaveBeenCalledTimes(1);
    expect(a.send).toHaveBeenCalledWith("s1", UPDATE_REQUEST);
    expect(a.queue).not.toHaveBeenCalled();
    expect(UPDATE_REQUEST).toMatch(/plain language/);
    expect(onFocus).toHaveBeenCalledWith("s1");
    expect(screen.queryByRole("dialog", { name: "Team" })).toBeNull();
  });

  it("waits behind what the main agent is doing, after anything already queued, like anything typed to it", () => {
    const chats = team(1);
    chats.slots.s1 = { ...chats.slots.s1, status: "running", queued: ["earlier"] };
    const a = actions();
    mount(chats, a);
    fireEvent.click(ask());
    expect(a.queue).toHaveBeenCalledWith("s1", ["earlier", UPDATE_REQUEST]);
    expect(a.send).not.toHaveBeenCalled();
  });

  it("is not offered when there are no workers to report on, or the main agent can't take it", () => {
    mount(team(0), actions());
    expect(screen.queryByRole("button", { name: "Ask the Lead for an update" })).toBeNull();
    cleanup();
    const stopped = team(1);
    stopped.slots.s1 = { ...stopped.slots.s1, status: "ended" };
    mount(stopped, actions());
    expect(screen.queryByRole("button", { name: "Ask the Lead for an update" })).toBeNull();
  });
});

describe("what the loop guard holds back, and what is typed", () => {
  it("says when a main agent's updates are held back, counts it as needing you, and passes them on when asked", () => {
    const chats = team(1);
    chats.slots.s1 = { ...chats.slots.s1, wakes: ["a", "b"], autoStreak: WAKE_LIMIT };
    const a = actions();
    const store = createChatStore();
    store.set(chats.slots);
    const nodes = orchestraNodes(chats, () => "Lead");
    render(
      <ChatStoreContext.Provider value={store}>
        <NodeActionsContext.Provider value={a}>
          <Canvas nodes={nodes} layout={newLayout()} activeSlot="s1" attention={needingYou(nodes, chats.slots)} onFocus={vi.fn()} onOpen={vi.fn()} />
        </NodeActionsContext.Provider>
      </ChatStoreContext.Provider>,
    );
    const banner = within(screen.getByLabelText(/^Lead,/)).getByText(/2 updates from the agents are held back/);
    expect(banner.textContent).toContain(`${WAKE_LIMIT} replies in a row`);
    expect(screen.getByRole("button", { name: /1 agent needs you/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pass them on" }));
    // The user's own message is what lets the held notes go out after it.
    expect(a.send).toHaveBeenCalledWith("s1", expect.stringContaining("Carry on"));
  });

  it("says nothing when nothing is held", () => {
    setup(team(1));
    expect(screen.queryByText(/held back/)).toBeNull();
  });

  it("keeps what is typed in an agent's box in the app, and puts it back when the box is shown again", () => {
    const a = actions();
    (a.draft as ReturnType<typeof vi.fn>).mockImplementation((slot: string) => (slot === "w1" ? "half a thought" : ""));
    const chats = team(1);
    const store = createChatStore();
    store.set(chats.slots);
    render(
      <ChatStoreContext.Provider value={store}>
        <NodeActionsContext.Provider value={a}>
          <Canvas nodes={orchestraNodes(chats, () => "Lead")} layout={newLayout()} activeSlot="s1" attention={[]} onFocus={vi.fn()} onOpen={vi.fn()} />
        </NodeActionsContext.Provider>
      </ChatStoreContext.Provider>,
    );
    const box = within(screen.getByLabelText(/Agent Worker 1/)).getByLabelText("Message this agent") as HTMLTextAreaElement;
    expect(box.value).toBe("half a thought");
    fireEvent.change(box, { target: { value: "half a thought, and more" } });
    expect(a.setDraft).toHaveBeenLastCalledWith("w1", "half a thought, and more");
  });
});

/** The team with the given workers taken off the canvas, as the user's Hide leaves it. */
function hidden(chats: Chats, ...workers: string[]): Chats {
  return workers.reduce((c, slot) => chatsReducer(c, { type: "set_hidden", slot, hidden: true }), chats);
}

const head = (name: string) => screen.getByLabelText(new RegExp(`^Agent Worker ${name},`)).querySelector(".node-head")!;

describe("the menu of an agent's card", () => {
  it("opens on a right-click on a worker's title or body, on its first item, and is a menu", () => {
    setup(team(2));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(fireEvent.contextMenu(head("1"), { clientX: 40, clientY: 30 })).toBe(false); // the browser's own menu is held back
    const menu = screen.getByRole("menu", { name: "Worker 1 actions" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.querySelector(".menu-label")!.textContent)).toEqual(["Hide", "Clean up and close"]);
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: /Hide/ }));
    // From the body too, and for another agent: the menu is that agent's.
    fireEvent.contextMenu(screen.getByLabelText(/Agent Worker 2/).querySelector(".node-body")!, { clientX: 60, clientY: 60 });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "Worker 2 actions" })).toBeTruthy();
  });

  it("is not offered on the main agent", () => {
    setup(team(1));
    expect(fireEvent.contextMenu(screen.getByLabelText(/^Lead,/).querySelector(".node-head")!)).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("leaves the browser's menu to the box where you type and to text you have selected", () => {
    setup(team(1));
    const box = within(screen.getByLabelText(/Agent Worker 1/)).getByLabelText("Message this agent");
    expect(fireEvent.contextMenu(box)).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "picked words" } as Selection);
    expect(fireEvent.contextMenu(head("1"))).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    selection.mockRestore();
  });

  it("closes on Escape, on a press elsewhere, and on Tab, without doing anything", () => {
    const { acts } = setup(team(1));
    fireEvent.contextMenu(head("1"));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /Hide/ }), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(head("1"));
    fireEvent.pointerDown(screen.getByTestId("canvas"), { button: 0, pointerId: 1 });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(head("1"));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /Hide/ }), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(acts.hide).not.toHaveBeenCalled();
  });

  it("hides the worker it was opened on, and closes", () => {
    const { acts } = setup(team(2));
    fireEvent.contextMenu(head("2"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Hide/ }));
    expect(acts.hide).toHaveBeenCalledWith("w2");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not let a worker that needs you be hidden", () => {
    const { acts } = setup(team(1), { attention: ["w1"] });
    fireEvent.contextMenu(head("1"));
    const item = screen.getByRole("menuitem", { name: /Hide/ }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain("needs you");
    fireEvent.click(item);
    expect(acts.hide).not.toHaveBeenCalled();
  });

  it("does not pan, zoom or move anything: the right button is not a gesture", () => {
    const { layout } = setup(team(1));
    const canvas = screen.getByTestId("canvas");
    const view = layout.view;
    const box = { ...layout.boxes.w1 };
    act(() => {
      fireEvent.pointerDown(canvas, { button: 2, pointerId: 1, clientX: 50, clientY: 50 });
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 150, clientY: 90 });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 150, clientY: 90 });
      fireEvent.pointerDown(head("1"), { button: 2, pointerId: 2, clientX: 50, clientY: 50 });
      fireEvent.pointerMove(head("1"), { pointerId: 2, clientX: 150, clientY: 90 });
      fireEvent.pointerUp(head("1"), { pointerId: 2 });
      // A control-click is a right-click on a Mac, and must not start a pan either.
      fireEvent.pointerDown(canvas, { button: 0, ctrlKey: true, pointerId: 3, clientX: 50, clientY: 50 });
      fireEvent.pointerMove(canvas, { pointerId: 3, clientX: 150, clientY: 90 });
      fireEvent.pointerUp(canvas, { pointerId: 3, clientX: 150, clientY: 90 });
      fireEvent.pointerDown(head("1"), { button: 0, ctrlKey: true, pointerId: 4, clientX: 50, clientY: 50 });
      fireEvent.pointerMove(head("1"), { pointerId: 4, clientX: 150, clientY: 90 });
      fireEvent.pointerUp(head("1"), { pointerId: 4 });
    });
    expect(layout.view).toEqual(view);
    expect(layout.boxes.w1).toEqual(box);
    expect(layout.touched).toBe(false);
    // And the canvas still pans and zooms afterwards, with the menu open.
    fireEvent.contextMenu(head("1"));
    act(() => {
      fireEvent.wheel(canvas, { deltaX: 0, deltaY: 40 });
    });
    expect(layout.view!.y).toBeCloseTo((view?.y ?? 0) - 40);
  });
});

describe("agents taken off the canvas", () => {
  it("are not drawn or tethered, keep their place, and are counted in a Hidden control", () => {
    const { layout } = setup(hidden(team(2), "w1"));
    expect(screen.getAllByRole("region").map((a) => a.getAttribute("aria-label"))).toEqual(["Lead, Ready", "Agent Worker 2, Working"]);
    expect(document.querySelectorAll("path.tether")).toHaveLength(1);
    expect(layout.boxes.w1).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hidden (1)" })).toBeTruthy();
  });

  it("show no Hidden control when there are none", () => {
    setup(team(2));
    expect(screen.queryByRole("button", { name: /Hidden/ })).toBeNull();
  });

  it("are listed by name and status, and each can be shown again", () => {
    const { acts } = setup(hidden(team(2), "w1", "w2"));
    fireEvent.click(screen.getByRole("button", { name: "Hidden (2)" }));
    const list = screen.getByRole("dialog", { name: "Hidden agents" });
    expect(within(list).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Show Worker 1, Working", "Show Worker 2, Working"]);
    fireEvent.click(within(list).getByRole("button", { name: "Show Worker 2, Working" }));
    expect(acts.show).toHaveBeenCalledWith("w2");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Hidden agents" })).toBeNull();
  });

  it("come back by themselves when they need the user, and not before", () => {
    const quiet = setup(hidden(team(2), "w1", "w2"), { attention: ["w2"] });
    expect(quiet.acts.show).toHaveBeenCalledTimes(1);
    expect(quiet.acts.show).toHaveBeenCalledWith("w2");
    cleanup();
    const idle = setup(hidden(team(2), "w1"));
    expect(idle.acts.show).not.toHaveBeenCalled();
  });

  it("are shown again when the user goes to one from the team list", () => {
    const { acts } = setup(hidden(team(2), "w1"));
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Team" })).getByText("Worker 1"));
    expect(acts.show).toHaveBeenCalledWith("w1");
  });
});

describe("cleaning up and closing an agent", () => {
  const lost = { worktree: true, branch: "lantern/w1", uncommitted: 3, unmerged_commits: 2 };
  const none = { worktree: true, branch: "lantern/w1", uncommitted: 0, unmerged_commits: 0 };
  const chooseClose = (name = "1") => {
    fireEvent.contextMenu(head(name));
    fireEvent.click(screen.getByRole("menuitem", { name: /Clean up and close/ }));
  };

  it("closes at once when there is nothing to lose, after asking what there is", async () => {
    const { acts } = setup(team(1), { actions: { closeCheck: vi.fn(() => Promise.resolve(none)) } });
    chooseClose();
    await waitFor(() => expect(acts.closeWorker).toHaveBeenCalledWith("w1", undefined));
    expect(acts.closeCheck).toHaveBeenCalledWith("w1");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("says exactly what would be lost and stops nothing until the user agrees", async () => {
    const { acts } = setup(team(1), { actions: { closeCheck: vi.fn(() => Promise.resolve(lost)) } });
    chooseClose();
    const dialog = await screen.findByRole("alertdialog", { name: "Close Worker 1?" });
    expect(dialog.textContent).toContain("It has 3 uncommitted files and 2 commits that aren't merged.");
    expect(dialog.textContent).toContain("lantern/w1");
    // Cancel is the default: it has the focus, and a press of Enter there cancels.
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
    expect(acts.closeWorker).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(acts.closeWorker).not.toHaveBeenCalled();
  });

  it("cancels on Escape and on a press outside the box, and keeps Tab inside it", async () => {
    const { acts } = setup(team(1), { actions: { closeCheck: vi.fn(() => Promise.resolve(lost)) } });
    chooseClose();
    const dialog = await screen.findByRole("alertdialog");
    const [cancel, discard] = within(dialog).getAllByRole("button");
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(discard);
    fireEvent.keyDown(discard, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(discard);
    fireEvent.keyDown(discard, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    chooseClose();
    fireEvent.pointerDown(await screen.findByRole("alertdialog").then((d) => d.parentElement!), { button: 0, pointerId: 1 });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(acts.closeWorker).not.toHaveBeenCalled();
  });

  it("throws the work away only on the destructive button, and closes", async () => {
    const closeWorker = vi.fn(() => Promise.resolve());
    setup(team(2), { actions: { closeCheck: vi.fn(() => Promise.resolve(lost)), closeWorker } });
    chooseClose("2");
    const dialog = await screen.findByRole("alertdialog", { name: "Close Worker 2?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard work and close" }));
    expect(closeWorker).toHaveBeenCalledWith("w2", { uncommitted: 3, unmerged_commits: 2 });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("says why when it can't be closed, instead of closing", async () => {
    const { acts } = setup(team(1), { actions: { closeCheck: vi.fn(() => Promise.reject("That agent's branch is being merged right now.")) } });
    chooseClose();
    expect((await screen.findByRole("alert")).textContent).toContain("being merged right now");
    expect(acts.closeWorker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says why when closing failed after it was agreed", async () => {
    setup(team(1), { actions: { closeCheck: vi.fn(() => Promise.resolve(lost)), closeWorker: vi.fn(() => Promise.reject("git said no")) } });
    chooseClose();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard work and close" }));
    expect((await screen.findByRole("alert")).textContent).toContain("git said no");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("tells a worker in the shared folder that nothing is removed from it", () => {
    let chats = initialChats(main);
    chats = chatsReducer(chats, { type: "in", slot: "s1", action: { type: "ui_event", event: { kind: "agent_spawned", worker: "w1", name: "Reader", brief: "Read", folder: "/p", branch: null, base: null, isolation: "shared", mode: "auto" } } });
    setup(chats);
    fireEvent.contextMenu(screen.getByLabelText(/^Agent Reader,/).querySelector(".node-head")!);
    expect(screen.getByRole("menuitem", { name: /Clean up and close/ }).textContent).toContain("shares your folder, so no files are removed");
  });

  it("is offered with Hide, with the destructive one marked", () => {
    setup(team(1));
    fireEvent.contextMenu(head("1"));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.querySelector(".menu-label")!.textContent)).toEqual(["Hide", "Clean up and close"]);
    expect(items[1].className).toBe("danger");
    // The arrow keys move between them, and wrap.
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "End" });
    expect(document.activeElement).toBe(items[1]);
  });
});

describe("starting an agent from the canvas", () => {
  it("offers + Agent for the main agent's team, and starts the worker under that main agent", async () => {
    const { acts } = setup(team(1));
    fireEvent.click(screen.getByRole("button", { name: "+ Agent" }));
    fireEvent.change(within(screen.getByRole("dialog", { name: "New agent" })).getByLabelText("Task"), { target: { value: "Write the docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
    expect(acts.spawn).toHaveBeenCalledWith("s1", { task: "Write the docs", name: null, isolation: "worktree", model: null });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New agent" })).toBeNull());
  });

  it("is not offered where there is no main agent to start it for", () => {
    const chats = team(1);
    chats.slots.s1 = { ...chats.slots.s1, orchestrator: false };
    setup(chats);
    expect(screen.getAllByRole("region")).toHaveLength(1); // an orphaned worker
    expect(screen.queryByRole("button", { name: "+ Agent" })).toBeNull();
  });
});

/** The agents have finished their turns (a new worker starts out working), with these contexts used (of 200k). */
function withContext(used: Record<string, number>, busy: string[] = [], workers = 2): Chats {
  const chats = team(workers);
  for (const slot of Object.keys(chats.slots)) {
    chats.slots[slot] = { ...chats.slots[slot], status: busy.includes(slot) ? "running" : "idle", thinking: false, contextUsed: used[slot] ?? 10_000, contextWindow: 200_000 };
  }
  return chats;
}

describe("an agent's context on its title bar", () => {
  const chip = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name} context,`) });
  const menuOf = () => screen.getByRole("menu", { name: /context$/ });

  it("shows the share, amber from 75% and red from 90%, in words too", () => {
    setup(withContext({ s1: 40_000, w1: 150_000, w2: 190_000 }));
    expect(chip("Lead")).toHaveTextContent("20%");
    expect(chip("Lead")).not.toHaveClass("warn");
    expect(chip("Worker 1")).toHaveClass("warn");
    expect(chip("Worker 1")).toHaveAccessibleName("Worker 1 context, 75% used, getting full");
    expect(chip("Worker 2")).toHaveClass("full");
    expect(chip("Worker 2")).toHaveAccessibleName("Worker 2 context, 95% used, nearly full");
  });

  it("has no chip before the agent has said how much it has used", () => {
    const chats = team(1);
    setup(chats);
    expect(screen.queryByRole("button", { name: /Worker 1 context,/ })).toBeNull();
  });

  it("compacts the agent it belongs to", () => {
    const { acts } = setup(withContext({ w1: 150_000 }));
    fireEvent.click(chip("Worker 1"));
    const compact = within(menuOf()).getByRole("menuitem", { name: /Compact/ });
    expect(compact).toHaveTextContent("Summarise the conversation to free up context");
    expect(compact).toHaveFocus();
    fireEvent.click(compact);
    expect(acts.send).toHaveBeenCalledWith("w1", "/compact");
    expect(screen.queryByRole("menu", { name: /context$/ })).toBeNull();
  });

  it("asks before it clears, and clears only when told to", () => {
    const { acts } = setup(withContext({ w1: 150_000 }));
    fireEvent.click(chip("Worker 1"));
    fireEvent.click(within(menuOf()).getByRole("menuitem", { name: /Clear/ }));
    expect(acts.clear).not.toHaveBeenCalled();
    expect(menuOf()).toHaveTextContent("Worker 1 forgets this conversation. The files it changed stay as they are.");
    // Keep it: nothing is cleared, and the menu goes back to Compact and Clear.
    expect(within(menuOf()).getByRole("menuitem", { name: "Keep it" })).toHaveFocus();
    fireEvent.click(within(menuOf()).getByRole("menuitem", { name: "Keep it" }));
    expect(acts.clear).not.toHaveBeenCalled();
    fireEvent.click(within(menuOf()).getByRole("menuitem", { name: /Clear/ }));
    fireEvent.click(within(menuOf()).getByRole("menuitem", { name: "Clear it" }));
    expect(acts.clear).toHaveBeenCalledWith("w1");
    expect(acts.send).not.toHaveBeenCalled();
  });

  it("can't compact or clear an agent that is working or waiting on you, and says to wait", () => {
    const chats = withContext({ w1: 150_000, w2: 150_000 }, ["w1"]);
    chats.slots.w2 = { ...chats.slots.w2, status: "running", items: [{ type: "permission", id: "p", toolName: "Bash", input: {}, decision: null }] };
    const { acts } = setup(chats);
    for (const name of ["Worker 1", "Worker 2"]) {
      fireEvent.click(chip(name));
      const compact = within(menuOf()).getByRole("menuitem", { name: /Compact/ });
      expect(compact).toHaveAttribute("aria-disabled", "true");
      expect(compact).toHaveTextContent("Wait until it has finished its turn");
      fireEvent.click(compact);
      fireEvent.click(within(menuOf()).getByRole("menuitem", { name: /Clear/ }));
      expect(screen.queryByText(/forgets this conversation/)).toBeNull();
      fireEvent.click(chip(name));
    }
    expect(acts.send).not.toHaveBeenCalled();
    expect(acts.clear).not.toHaveBeenCalled();
  });

  it("closes on Escape and gives focus back to the chip", () => {
    setup(withContext({ w1: 150_000 }));
    fireEvent.click(chip("Worker 1"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: /context$/ })).toBeNull();
    expect(chip("Worker 1")).toHaveFocus();
  });
});

describe("the toolbar's list of every agent's context", () => {
  const open = () => {
    fireEvent.click(screen.getByRole("button", { name: /^Context:/ }));
    return screen.getByRole("dialog", { name: "Context by agent" });
  };

  it("compacts and clears from a row, with the same rules and a confirmation for Clear", () => {
    const { acts } = setup(withContext({ s1: 40_000, w1: 150_000, w2: 100_000 }, ["w2"]));
    const list = open();
    fireEvent.click(within(list).getByRole("button", { name: "Compact Worker 1" }));
    expect(acts.send).toHaveBeenCalledWith("w1", "/compact");
    // Working: both buttons are there but do nothing, and say why.
    const busy = within(list).getByRole("button", { name: "Compact Worker 2" });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toHaveAttribute("title", "Wait until it has finished its turn");
    fireEvent.click(busy);
    fireEvent.click(within(list).getByRole("button", { name: "Clear Worker 2" }));
    expect(within(list).queryByText("Clear it?")).toBeNull();
    expect(acts.send).toHaveBeenCalledTimes(1);
    // Clear asks first.
    fireEvent.click(within(list).getByRole("button", { name: "Clear Worker 1" }));
    expect(acts.clear).not.toHaveBeenCalled();
    fireEvent.click(within(list).getByRole("button", { name: "Keep Worker 1's conversation" }));
    expect(within(list).queryByText("Clear it?")).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: "Clear Worker 1" }));
    fireEvent.click(within(list).getByRole("button", { name: "Yes, clear Worker 1" }));
    expect(acts.clear).toHaveBeenCalledWith("w1");
  });

  it("compacts everyone above 60% that is free, and says how many it skipped because they were busy", () => {
    // Lead 70% (free), Worker 1 61% (free), Worker 2 90% (working), Worker 3 60% (free, but not above 60%), Worker 4 30%.
    const { acts } = setup(withContext({ s1: 140_000, w1: 122_000, w2: 180_000, w3: 120_000, w4: 60_000 }, ["w2"], 4));
    const list = open();
    fireEvent.click(within(list).getByRole("button", { name: "Compact all above 60%" }));
    expect((acts.send as ReturnType<typeof vi.fn>).mock.calls).toEqual([["s1", "/compact"], ["w1", "/compact"]]);
    expect(within(list).getByRole("status")).toHaveTextContent("Compacting 2 agents. Skipped 1 that is busy.");
  });

  it("says when everything above 60% is busy, and does nothing when nothing is above it", () => {
    const busy = setup(withContext({ w1: 180_000 }, ["w1"]));
    fireEvent.click(within(open()).getByRole("button", { name: "Compact all above 60%" }));
    expect(busy.acts.send).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog", { name: "Context by agent" })).getByRole("status")).toHaveTextContent("Skipped 1 that is busy.");
    busy.unmount();
    const low = setup(withContext({ w1: 20_000 }));
    const list = open();
    const all = within(list).getByRole("button", { name: "Compact all above 60%" });
    expect(all).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(all);
    expect(low.acts.send).not.toHaveBeenCalled();
  });
});

describe("an agent at work that has gone quiet", () => {
  const working = (quietMs: number) => {
    const chats = team(1);
    chats.slots.w1 = { ...chats.slots.w1, status: "running", activityAt: Date.now() - quietMs };
    return chats;
  };

  it("says how long it has been, and from three minutes on turns amber and says what to do", () => {
    setup(working(45_000));
    const card = screen.getByLabelText(/Agent Worker 1/);
    expect(card).toHaveTextContent("Working · 45s ago");
    expect(card).not.toHaveClass("stuck");
    cleanup();
    setup(working(200_000));
    const stuck = screen.getByLabelText(/Agent Worker 1, Quiet 3m/);
    expect(stuck).toHaveClass("stuck");
    expect(stuck.querySelector(".node-status")).toHaveTextContent("Quiet 3m");
    expect(stuck.querySelector(".node-status")?.getAttribute("title")).toMatch(/send it a message, or stop it/);
  });
});

describe("the toolbar when the canvas is narrow", () => {
  it("has a ⋯ menu with the folded controls: roles, arrow keys, Escape and focus back", async () => {
    const { acts } = setup(hidden(team(2), "w2"));
    const more = screen.getByRole("button", { name: "More canvas controls" });
    expect(more).toHaveAttribute("aria-haspopup", "menu");
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "More canvas controls" });
    expect(more).toHaveAttribute("aria-expanded", "true");
    // It opens on the checked radio (where the Lead's subagents run now), and the arrow keys move through the items.
    const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    expect(items.map((i) => i.getAttribute("role"))).toEqual(["menuitemradio", "menuitemradio", "menuitem", "menuitem"]);
    expect(within(menu).getByRole("menuitemradio", { name: /On the canvas/ })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(within(menu).getByRole("menuitem", { name: /Show Worker 2/ })).toHaveFocus();
    fireEvent.click(items[1]);
    expect(acts.setSubagents).toHaveBeenCalledWith("s1", "inline");
    // Escape closes it and puts focus back on the button.
    fireEvent.click(more);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "More canvas controls" })).toBeNull();
    expect(more).toHaveFocus();
  });

  it("starts an agent from the menu, and puts a hidden one back", async () => {
    const { acts } = setup(hidden(team(2), "w2"));
    const more = screen.getByRole("button", { name: "More canvas controls" });
    fireEvent.click(more);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Show Worker 2/ }));
    expect(acts.show).toHaveBeenCalledWith("w2");
    fireEvent.click(more);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /\+ Agent/ }));
    // Two forms can exist (the toolbar's own and this one's); only this one is open.
    const form = screen.getByRole("dialog", { name: "New agent" });
    fireEvent.change(within(form).getByLabelText("Task"), { target: { value: "Check the docs" } });
    fireEvent.click(within(form).getByRole("button", { name: "Start agent" }));
    expect(acts.spawn).toHaveBeenCalledWith("s1", { task: "Check the docs", name: null, isolation: "worktree", model: null });
    // Started, the form goes and focus returns to "⋯".
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New agent" })).toBeNull());
    await waitFor(() => expect(more).toHaveFocus());
  });
});

describe("scrolling inside the canvas", () => {
  it("leaves the wheel alone over the merge cards, the composer and the lists that float over it, and pans over the rest", () => {
    const { layout } = setup(team(1));
    const canvas = screen.getByTestId("canvas");
    act(() => void fireEvent.wheel(canvas, { ctrlKey: true, deltaY: 0 })); // frames the view, so there is one to compare
    const before = { ...layout.view! };
    const over = (el: Element) => act(() => void fireEvent.wheel(el, { deltaX: 0, deltaY: 60 }));
    const w1 = screen.getByLabelText(/Agent Worker 1/);
    over(w1.querySelector(".node-composer")!);
    for (const cls of ["node-merges", "canvas-team-list", "canvas-overlay"]) {
      const el = document.createElement("div");
      el.className = cls;
      canvas.append(el);
      over(el);
    }
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    over(screen.getByRole("dialog", { name: "Team" }));
    expect(layout.view).toEqual(before);
    over(w1.querySelector(".node-head")!);
    expect(layout.view!.y).toBeCloseTo(before.y - 60);
  });
});

describe("a folded card zoomed out into a card", () => {
  const zoomOut = () => act(() => void fireEvent.wheel(screen.getByTestId("canvas"), { ctrlKey: true, deltaY: 600 }));

  it("is as tall as its title bar is drawn, and its tether follows that as the zoom changes", () => {
    const { layout } = setup(team(1));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Worker 1" }));
    const tetherEnd = () => Number(document.querySelector("path.tether")!.getAttribute("d")!.trim().split(" ").pop());
    const full = tetherEnd();
    zoomOut();
    expect(layout.view!.zoom).toBeLessThan(SUMMARY_ZOOM);
    const w1 = screen.getByLabelText(/Agent Worker 1/);
    expect(w1.getAttribute("style")).toContain("calc(40px / var(--zoom))");
    // The tether meets the card's edge at 40px of screen height: more canvas units than the 52 it was folded to.
    const box = layout.boxes.w1;
    expect(tetherEnd()).toBeGreaterThanOrEqual(box.y);
    expect(tetherEnd()).toBeLessThanOrEqual(box.y + 40 / layout.view!.zoom);
    expect(tetherEnd()).not.toBe(full);
  });
});

describe("the agents' title bars", () => {
  it("has a more button on a worker's card (not the lead's) that opens the same menu, and puts focus back when it closes", () => {
    setup(team(1));
    expect(screen.queryByRole("button", { name: "More for Main agent" })).toBeNull();
    const more = screen.getByRole("button", { name: "More for Worker 1" });
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    more.focus();
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "Worker 1 actions" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([expect.stringContaining("Hide"), expect.stringContaining("Clean up and close")]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("can be focused, and Enter on one opens that agent full size", () => {
    const { onOpen } = setup(team(1));
    const head = screen.getByLabelText(/Agent Worker 1/).querySelector(".node-head") as HTMLElement;
    expect(head.tabIndex).toBe(0);
    fireEvent.keyDown(screen.getByRole("button", { name: "Open Worker 1 full size" }), { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(head, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("w1");
  });
});

describe("the model on each agent's card", () => {
  const withModels = () => {
    let chats = team(2);
    chats = chatsReducer(chats, { type: "in", slot: "s1", action: { type: "ui_event", event: { kind: "session_started", session_id: "x", model: "claude-sonnet-5-5", cwd: "/p", permission_mode: "default", claude_version: "2" } } });
    chats = chatsReducer(chats, { type: "in", slot: "w1", action: { type: "ui_event", event: { kind: "session_started", session_id: "y", model: "claude-haiku-5-5", cwd: "/p", permission_mode: "default", claude_version: "2" } } });
    return chatsReducer(chats, { type: "in", slot: "w2", action: { type: "ui_event", event: { kind: "session_started", session_id: "z", model: "claude-opus-5-5", cwd: "/p", permission_mode: "default", claude_version: "2" } } });
  };

  it("says the family on the Lead's and every worker's title bar, amber for Opus, with the full id as its tooltip", () => {
    setup(withModels());
    const chip = (card: HTMLElement) => card.querySelector(".node-head .model-chip") as HTMLElement;
    expect(chip(screen.getByLabelText(/^Lead,/)).textContent).toBe("Sonnet");
    const haiku = chip(screen.getByLabelText(/Agent Worker 1/));
    expect([haiku.textContent, haiku.title, haiku.classList.contains("opus")]).toEqual(["Haiku", "Runs on claude-haiku-5-5", false]);
    const opus = chip(screen.getByLabelText(/Agent Worker 2/));
    expect([opus.textContent, opus.title, opus.classList.contains("opus")]).toEqual(["Opus", "Runs on claude-opus-5-5", true]);
  });

  it("is in the Team list too, and shows nothing for an agent whose model isn't known yet", () => {
    setup(team(1));
    expect(document.querySelector(".model-chip")).toBeNull();
    cleanup();
    setup(withModels());
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    const list = screen.getByRole("dialog", { name: "Team" });
    expect([...list.querySelectorAll(".model-chip")].map((c) => c.textContent)).toEqual(["Sonnet", "Haiku", "Opus"]);
  });
});

describe("the Team and Hidden lists", () => {
  it("come after their button, take focus into the list, and give it back to the button on Escape", () => {
    setup(team(1));
    const button = screen.getByRole("button", { name: "Team" });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(button);
    const list = screen.getByRole("dialog", { name: "Team" });
    expect(button.getAttribute("aria-controls")).toBe(list.id);
    expect(button.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list.contains(document.activeElement) && document.activeElement?.tagName === "BUTTON").toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Team" })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("do the same for the hidden agents", () => {
    const chats = team(1);
    chats.agents.w1 = { ...chats.agents.w1, hidden: true };
    setup(chats);
    const button = screen.getByRole("button", { name: /Hidden \(1\)/ });
    fireEvent.click(button);
    const list = screen.getByRole("dialog", { name: "Hidden agents" });
    expect(button.getAttribute("aria-controls")).toBe(list.id);
    expect(list.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(button);
  });
});

describe("keys on the canvas", () => {
  const cmd = (key: string) => ({ key, metaKey: true });

  it("zoom and fit with ⌘= ⌘− ⌘0 while the canvas has focus, and not otherwise", () => {
    const { layout } = setup(team(1));
    const head = screen.getByLabelText(/Agent Worker 1/).querySelector(".node-head") as HTMLElement;
    act(() => void fireEvent.wheel(screen.getByTestId("canvas"), { ctrlKey: true, deltaY: 0 }));
    const zoom0 = layout.view!.zoom;
    fireEvent.keyDown(window, cmd("="));
    expect(layout.view!.zoom).toBe(zoom0);
    act(() => head.focus());
    fireEvent.keyDown(window, cmd("="));
    const zoomed = layout.view!.zoom;
    expect(zoomed).toBeGreaterThan(zoom0);
    fireEvent.keyDown(window, cmd("-"));
    expect(layout.view!.zoom).toBeLessThan(zoomed);
    layout.touched = true;
    fireEvent.keyDown(window, cmd("0"));
    expect(layout.touched).toBe(false);
  });

  it("go to the next and the previous agent with ⌘] and ⌘[", () => {
    const { onFocus } = setup(team(2));
    const head = screen.getByLabelText(/Agent Worker 1/).querySelector(".node-head") as HTMLElement;
    act(() => head.focus());
    fireEvent.keyDown(window, cmd("]"));
    expect(onFocus).toHaveBeenLastCalledWith("w1");
    fireEvent.keyDown(window, cmd("["));
    expect(onFocus).toHaveBeenLastCalledWith("w2");
  });
});

describe("what the canvas says aloud", () => {
  it("announces an agent that starts needing you, and a merge that arrives, but not what was already waiting", () => {
    const chats = team(2);
    const { store } = setup(chats);
    const said = () => document.querySelector('.canvas > [role="status"].sr-only')!.textContent;
    expect(said()).toBe("");
    const asking = { ...chats.slots.w1, status: "running" as const, items: [{ type: "permission" as const, id: "p", toolName: "Bash", input: {}, decision: null }] };
    act(() => store.set({ ...chats.slots, w1: asking }));
    expect(said()).toBe("Worker 1 needs you.");
    const proposal = { worker: "w2", name: "Worker 2", branch: "lantern/w2", into: "main", summary: "", commits: 1, files: [], uncommitted: 0, loose: [], status: "open" as const, problem: null, attempts: 0 };
    act(() => store.set({ ...chats.slots, w1: asking, s1: { ...chats.slots.s1, proposals: [proposal] } }));
    expect(said()).toBe("A merge of Worker 2 is ready for you.");
  });

  it("shows a lead whose updates are held as needing you, with its own label", () => {
    const chats = team(1);
    chats.slots.s1 = { ...chats.slots.s1, wakes: ["note"], autoStreak: WAKE_LIMIT };
    setup(chats);
    expect(screen.getByLabelText(/^Lead/).getAttribute("aria-label")).toBe("Lead, Needs you · updates held");
    expect(document.querySelector('[data-node="s1"]')!.className).toContain("held");
  });
});

describe("motion", () => {
  it("lets a new agent and its tether arrive once, and not again when the canvas is shown again", () => {
    const chats = team(1);
    const layout = newLayout();
    const first = setup(chats, { layout });
    expect(document.querySelector('[data-node="w1"]')!.className).toContain("enter");
    expect(document.querySelector(".tether-enter")).toBeTruthy();
    first.unmount();
    setup(chats, { layout });
    expect(document.querySelector('[data-node="w1"]')!.className).not.toContain("enter");
    expect(document.querySelector(".tether-enter")).toBeNull();
  });

  it("rings the attention pill when the count goes up, but not when the canvas opens with agents waiting", () => {
    const chats = team(2);
    const store = createChatStore();
    store.set(chats.slots);
    const layout = newLayout();
    const show = (attention: string[]) => (
      <ChatStoreContext.Provider value={store}>
        <NodeActionsContext.Provider value={actions()}>
          <Canvas nodes={orchestraNodes(chats, () => "Lead")} layout={layout} activeSlot="s1" attention={attention} onFocus={vi.fn()} onOpen={vi.fn()} />
        </NodeActionsContext.Provider>
      </ChatStoreContext.Provider>
    );
    const { rerender } = render(show(["w1"]));
    expect(document.querySelector(".canvas-attention-ring")).toBeNull();
    rerender(show(["w1", "w2"]));
    expect(document.querySelector(".canvas-attention-ring")).toBeTruthy();
  });

  it("stops easing a card's height while it is being resized", () => {
    setup(team(1));
    const canvas = screen.getByTestId("canvas");
    const grip = screen.getByLabelText(/Agent Worker 1/).querySelector(".node-resize")!;
    fireEvent.pointerDown(grip, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    expect(canvas.classList.contains("resizing")).toBe(true);
    fireEvent.pointerUp(grip, { pointerId: 2 });
    expect(canvas.classList.contains("resizing")).toBe(false);
  });

  it("keeps cards and chats from flickering around the threshold, swapping the body with a fade", () => {
    setup(team(1));
    const canvas = screen.getByTestId("canvas");
    const zoomTo = (target: number) => {
      const z = JSON.parse(canvas.style.getPropertyValue("--zoom") || "1");
      act(() => void fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -Math.log(target / z) / 0.01 }));
    };
    zoomTo(0.4);
    expect(canvas.classList.contains("summary")).toBe(true);
    zoomTo(0.5); // inside the band: still cards
    expect(canvas.classList.contains("summary")).toBe(true);
    zoomTo(0.55);
    expect(canvas.classList.contains("summary")).toBe(false);
    zoomTo(0.5); // and still chats on the way back down
    expect(canvas.classList.contains("summary")).toBe(false);
    zoomTo(0.45);
    expect(canvas.classList.contains("summary")).toBe(true);
  });
});
