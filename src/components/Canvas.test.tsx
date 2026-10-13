import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { chatsReducer, initialChats, type Chats } from "../sessions";
import { initialState, type State } from "../store";
import { ChatStoreContext, createChatStore, NodeActionsContext, type NodeActions } from "../lib/canvasContext";
import { orchestraNodes } from "../lib/orchestraView";
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

const actions = (): NodeActions => ({ send: vi.fn(), stop: vi.fn(), queue: vi.fn(), decide: vi.fn(), openFile: vi.fn(), openTestRun: vi.fn(), stopShell: vi.fn(), shellInput: vi.fn(), restart: vi.fn(), approveMerge: vi.fn(), declineMerge: vi.fn(), removeWorktree: vi.fn(() => Promise.resolve()) });

function setup(chats: Chats, extra: { attention?: string[]; layout?: ReturnType<typeof newLayout> } = {}) {
  const store = createChatStore();
  store.set(chats.slots);
  const layout = extra.layout ?? newLayout();
  const handlers = { onFocus: vi.fn(), onOpen: vi.fn() };
  const nodes = orchestraNodes(chats, () => "Main agent");
  const ui = (
    <ChatStoreContext.Provider value={store}>
      <NodeActionsContext.Provider value={actions()}>
        <Canvas nodes={nodes} layout={layout} activeSlot="s1" attention={extra.attention ?? []} {...handlers} />
      </NodeActionsContext.Provider>
    </ChatStoreContext.Provider>
  );
  return { ...render(ui), layout, store, ...handlers, nodes };
}

describe("placeNodes", () => {
  it("puts the main agent first and workers beside it without overlap, and gives every agent a front-to-back place", () => {
    const layout = newLayout();
    placeNodes(layout, orchestraNodes(team(3), () => "Main agent"));
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
    placeNodes(layout, orchestraNodes(chats, () => "Main agent"));
    layout.boxes.w1 = { x: 5, y: 6, w: 400, h: 300 };
    placeNodes(layout, orchestraNodes(chats, () => "Main agent"));
    expect(layout.boxes.w1).toEqual({ x: 5, y: 6, w: 400, h: 300 });
    const fewer = chatsReducer(chats, { type: "remove", slot: "w2" });
    placeNodes(layout, orchestraNodes(fewer, () => "Main agent"));
    expect(Object.keys(layout.boxes)).toEqual(["s1", "w1"]);
    expect(layout.order).toEqual(["s1", "w1"]);
  });

  it("puts a second main agent below the first one's team", () => {
    const layout = newLayout();
    let chats = team(2);
    chats = chatsReducer(chats, { type: "add", slot: "s2" });
    chats = chatsReducer(chats, { type: "in", slot: "s2", action: { type: "orchestrator_set", on: true } });
    placeNodes(layout, orchestraNodes(chats, () => "Main agent"));
    const team1 = [layout.boxes.s1, layout.boxes.w1, layout.boxes.w2];
    expect(team1.every((b) => b.y + b.h < layout.boxes.s2.y)).toBe(true);
  });
});

describe("the canvas", () => {
  it("shows every agent with its name, role and what it is doing, and the worker's branch", () => {
    setup(team(2));
    const agents = screen.getAllByRole("region");
    expect(agents.map((a) => a.getAttribute("aria-label"))).toEqual(["Main agent Main agent, Idle", "Worker Worker 1, Working", "Worker Worker 2, Working"]);
    const w1 = screen.getByLabelText(/Worker Worker 1/);
    expect(within(w1).getByText("w1 · Auto")).toBeTruthy(); // its branch (lantern/w1 without the prefix) and its mode
    expect(within(screen.getByLabelText(/Main agent Main agent/)).getByText("Runs the team · Auto")).toBeTruthy();
    expect(document.querySelectorAll("path.tether")).toHaveLength(2);
  });

  it("folds an agent to its title and back, and opens one full size", () => {
    const { onOpen, layout } = setup(team(1));
    const w1 = screen.getByLabelText(/Worker Worker 1/);
    expect(w1.querySelector(".node-body")).toBeTruthy();
    fireEvent.click(within(w1).getByRole("button", { name: "Collapse Worker 1" }));
    expect(screen.getByLabelText(/Worker Worker 1/).querySelector(".node-body")).toBeNull();
    expect(layout.collapsed.w1).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand Worker 1" }));
    expect(screen.getByLabelText(/Worker Worker 1/).querySelector(".node-body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Worker 1 full size" }));
    expect(onOpen).toHaveBeenCalledWith("w1");
  });

  it("tells the app which agent was pressed, and brings it to the front", () => {
    const { onFocus, layout } = setup(team(2));
    expect(layout.order).toEqual(["s1", "w1", "w2"]);
    fireEvent.pointerDown(within(screen.getByLabelText(/Worker Worker 1/)).getByText("Worker 1"));
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
    const card = screen.getByLabelText(/Worker Worker 1/).querySelector(".node-body")!;
    act(() => {
      fireEvent.click(card);
    });
    expect(layout.view!.zoom).toBeGreaterThanOrEqual(SUMMARY_ZOOM);
    expect(canvas.classList.contains("summary")).toBe(false);
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
    const body = screen.getByLabelText(/Worker Worker 1/).querySelector(".node-body")!;
    const before = { ...layout.view! };
    act(() => {
      fireEvent.wheel(body, { deltaX: 0, deltaY: 80 });
    });
    expect(layout.view).toEqual(before);
  });

  it("moves an agent by dragging its title and resizes it from its corner, at any zoom", () => {
    const { layout } = setup(team(1));
    const canvas = screen.getByTestId("canvas");
    act(() => {
      fireEvent.wheel(canvas, { ctrlKey: true, deltaY: 60 }); // zoom out a little
    });
    const zoom = layout.view!.zoom;
    expect(zoom).toBeLessThan(1);
    const w1 = screen.getByLabelText(/Worker Worker 1/);
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
    expect(screen.getByLabelText(/Worker Worker 1/).style.transform).toContain("translate(900px, 40px)");
  });

  it("redraws only the agent whose chat changed", () => {
    const { store } = setup(team(2));
    const chats = team(2);
    const w2Body = screen.getByLabelText(/Worker Worker 2/).querySelector(".node-body")!;
    const w1Before = screen.getByLabelText(/Worker Worker 1/).querySelector(".node-chat");
    act(() => {
      store.set({ ...chats.slots, w2: { ...chats.slots.w2, items: [...chats.slots.w2.items, { type: "assistant", id: "a1", text: "Done for now" }] } });
    });
    expect(w2Body.textContent).toContain("Done for now");
    // The other agent's DOM was left alone.
    expect(screen.getByLabelText(/Worker Worker 1/).querySelector(".node-chat")).toBe(w1Before);
  });
});

describe("oversight", () => {
  const proposal = { worker: "w1", name: "Worker 1", branch: "lantern/w1", into: "main", summary: "Adds it", commits: 2, files: [{ path: "a.ts", added: 3, removed: 1 }], uncommitted: 0, status: "open" as const, problem: null, attempts: 0 };
  const withProposal = (): Chats => {
    const c = team(2);
    return { ...c, slots: { ...c.slots, s1: { ...c.slots.s1, proposals: [proposal] } } };
  };

  it("shows the merge on the worker it is for, and on the main agent, and calls the worker ready to merge", () => {
    const chats = withProposal();
    chats.slots.w1 = { ...chats.slots.w1, status: "idle", thinking: false };
    setup(chats);
    const w1 = screen.getByLabelText(/Worker Worker 1/);
    expect(within(w1).getByText("Ready to merge")).toBeTruthy();
    expect(within(w1).getByRole("group", { name: "Merge lantern/w1" })).toBeTruthy();
    expect(within(screen.getByLabelText(/Main agent Main agent/)).getByRole("group", { name: "Merge lantern/w1" })).toBeTruthy();
    // The other worker has nothing to show.
    expect(within(screen.getByLabelText(/Worker Worker 2/)).queryByRole("group", { name: /Merge/ })).toBeNull();
  });

  it("lists the team with what each is doing, takes you to one, and counts what the team has cost", () => {
    const chats = withProposal();
    chats.slots.s1 = { ...chats.slots.s1, costSeen: 0.5 };
    chats.slots.w1 = { ...chats.slots.w1, status: "idle", thinking: false, costBase: 0.1, costSeen: 0.25, items: [{ type: "assistant", id: "a", text: "Finished the form" }] };
    const { onFocus } = setup(chats);
    const button = screen.getByRole("button", { name: "Team" });
    expect(button.textContent).toBe("Team · $0.85");
    fireEvent.click(button);
    const list = screen.getByRole("dialog", { name: "Team" });
    expect(within(list).getByText("Ready to merge")).toBeTruthy();
    expect(within(list).getByText("Finished the form")).toBeTruthy();
    expect(within(list).getByText("$0.35")).toBeTruthy();
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
          <Canvas nodes={orchestraNodes(chats, () => "Main agent")} layout={newLayout()} activeSlot="s1" attention={[]} onFocus={onFocus} onOpen={vi.fn()} />
        </NodeActionsContext.Provider>
      </ChatStoreContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    return onFocus;
  };
  const ask = () => screen.getByRole("button", { name: "Ask the main agent for an update" });

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
    expect(screen.queryByRole("button", { name: "Ask the main agent for an update" })).toBeNull();
    cleanup();
    const stopped = team(1);
    stopped.slots.s1 = { ...stopped.slots.s1, status: "ended" };
    mount(stopped, actions());
    expect(screen.queryByRole("button", { name: "Ask the main agent for an update" })).toBeNull();
  });
});
