import { describe, expect, it } from "vitest";
import { initialState, type State } from "../store";
import { chatsReducer, initialChats, type Chats } from "../sessions";
import { money, needingYou, nodeStatus, orchestraNodes, readyToMerge, summaryLine, teamMain, teamNodes } from "./orchestraView";

const base: State = { ...initialState, status: "idle", claudePath: "/bin/claude", folder: "/p" };
const main: State = { ...base, orchestrator: true };
const spawn = (c: Chats, slot: string, name: string, parent = "s1"): Chats =>
  chatsReducer(c, { type: "in", slot: parent, action: { type: "ui_event", event: { kind: "agent_spawned", worker: slot, name, brief: "do it", folder: `/wt/${slot}`, branch: `lantern/${slot}`, base: "main", isolation: "worktree", mode: "auto" } } });
const name = (slot: string) => `Main ${slot}`;

describe("nodeStatus", () => {
  it("says what the chat is doing, with a waiting prompt coming first", () => {
    expect(nodeStatus({ ...base, status: "running" })).toBe("working");
    expect(nodeStatus({ ...base, status: "idle", thinking: true })).toBe("working");
    expect(nodeStatus({ ...base, status: "starting" })).toBe("starting");
    expect(nodeStatus(base)).toBe("idle");
    expect(nodeStatus({ ...base, status: "ended" })).toBe("ended");
    const asking: State = { ...base, status: "running", items: [{ type: "permission", id: "p", toolName: "Bash", input: {}, decision: null }] };
    expect(nodeStatus(asking)).toBe("waiting");
    expect(nodeStatus({ ...asking, items: [{ type: "permission", id: "p", toolName: "Bash", input: {}, decision: "allowed" }] })).toBe("working");
  });
});

describe("orchestraNodes", () => {
  it("lists each main agent followed by its workers in the order they started, and leaves other chats off", () => {
    let c = initialChats(main);
    c = chatsReducer(c, { type: "add", slot: "s2" });
    c = spawn(c, "w1", "Login");
    c = spawn(c, "w2", "Signup");
    expect(orchestraNodes(c, name)).toEqual([
      { slot: "s1", role: "main", parent: null, name: "Main s1", branch: null, isolation: null },
      { slot: "w1", role: "worker", parent: "s1", name: "Login", branch: "lantern/w1", isolation: "worktree" },
      { slot: "w2", role: "worker", parent: "s1", name: "Signup", branch: "lantern/w2", isolation: "worktree" },
    ]);
  });

  it("marks the workers the user hid, and only those", () => {
    let c = initialChats(main);
    c = spawn(c, "w1", "Login");
    c = spawn(c, "w2", "Signup");
    c = chatsReducer(c, { type: "set_hidden", slot: "w2", hidden: true });
    expect(orchestraNodes(c, name).map((n) => [n.slot, !!n.hidden])).toEqual([["s1", false], ["w1", false], ["w2", true]]);
  });

  it("is empty when nothing is an orchestra, and a lone main agent is one", () => {
    expect(orchestraNodes(initialChats(base), name)).toEqual([]);
    expect(orchestraNodes(initialChats(main), name)).toHaveLength(1);
  });

  it("groups workers under their own main agent when there are two", () => {
    let c = initialChats(main);
    c = chatsReducer(c, { type: "add", slot: "s2" });
    c = chatsReducer(c, { type: "in", slot: "s2", action: { type: "orchestrator_set", on: true } });
    c = spawn(c, "w1", "A", "s1");
    c = spawn(c, "w2", "B", "s2");
    c = spawn(c, "w3", "C", "s1");
    expect(orchestraNodes(c, name).map((n) => `${n.slot}${n.parent ? `>${n.parent}` : ""}`)).toEqual(["s1", "w1>s1", "w3>s1", "s2", "w2>s2"]);
  });

  it("keeps a worker whose main agent was closed, with no tether, and drops one whose chat is gone", () => {
    let c = spawn(initialChats(main), "w1", "Login");
    c = chatsReducer(c, { type: "in", slot: "s1", action: { type: "orchestrator_set", on: false } });
    expect(orchestraNodes(c, name)).toEqual([{ slot: "w1", role: "worker", parent: null, name: "Login", branch: "lantern/w1", isolation: "worktree" }]);
    const gone = { ...c, slots: { s1: c.slots.s1 } };
    expect(orchestraNodes(gone, name)).toEqual([]);
  });
});

describe("the team on screen", () => {
  // s1 is a main agent with a worker, s2 is another main agent with its own, and s3 is an ordinary chat.
  const world = (): Chats => {
    let c = initialChats(main);
    c = chatsReducer(c, { type: "add", slot: "s2" });
    c = chatsReducer(c, { type: "in", slot: "s2", action: { type: "orchestrator_set", on: true } });
    c = chatsReducer(c, { type: "add", slot: "s3" });
    c = spawn(c, "w1", "A", "s1");
    return spawn(c, "w2", "B", "s2");
  };

  it("is the main agent itself, or the one a worker reports to", () => {
    const c = world();
    expect(teamMain(c, "s1")).toBe("s1");
    expect(teamMain(c, "w1")).toBe("s1");
    expect(teamMain(c, "w2")).toBe("s2");
  });

  it("is none for an ordinary chat, a chat that isn't open, and a worker whose main agent was closed", () => {
    let c = world();
    expect(teamMain(c, "s3")).toBeNull();
    expect(teamMain(c, "nope")).toBeNull();
    c = chatsReducer(c, { type: "in", slot: "s1", action: { type: "orchestrator_set", on: false } });
    expect(teamMain(c, "w1")).toBeNull();
  });

  it("keeps one team's agents and leaves the other team's off the canvas", () => {
    const c = world();
    const all = orchestraNodes(c, name);
    expect(teamNodes(all, "s1").map((n) => n.slot)).toEqual(["s1", "w1"]);
    expect(teamNodes(all, "s2").map((n) => n.slot)).toEqual(["s2", "w2"]);
  });
});

describe("summaryLine", () => {
  const said = (text: string): State["items"][number] => ({ type: "assistant", id: "a", text });

  it("is the first real line of the last thing the agent said", () => {
    expect(summaryLine({ ...base, items: [said("first"), said("## Done\n\nAdded the form and its test.\n\nMore.")] })).toBe("Done");
    expect(summaryLine({ ...base, items: [said("\n\n- Added the form")] })).toBe("Added the form");
  });

  it("is shortened", () => {
    expect(summaryLine({ ...base, items: [said("x".repeat(400))] }, 50)).toBe(`${"x".repeat(50)}…`);
  });

  it("falls back to the step it is on, then to what it was asked", () => {
    const tool: State["items"][number] = { type: "tool", id: "t", name: "Bash", summary: "npm test", status: "running", output: null, edit: null, children: [] };
    const asked: State["items"][number] = { type: "user", id: "u", text: "Build the login form\nwith validation" };
    expect(summaryLine({ ...base, items: [asked, tool] })).toBe("Bash npm test");
    expect(summaryLine({ ...base, items: [asked] })).toBe("Build the login form");
    expect(summaryLine(base)).toBe("Waiting to start");
  });
});

describe("money", () => {
  it("writes dollars for a screen", () => {
    expect(money(0)).toBe("");
    expect(money(-1)).toBe("");
    expect(money(0.004)).toBe("<$0.01");
    expect(money(0.0137)).toBe("$0.01");
    expect(money(0.425)).toBe("$0.42");
    expect(money(9.994)).toBe("$9.99");
    expect(money(12.34)).toBe("$12.3");
    expect(money(250.6)).toBe("$251");
  });
});

describe("a merge waiting for you", () => {
  const proposal = (worker: string, status: "open" | "merged" | "declined" = "open") => ({ worker, name: worker, branch: `lantern/${worker}`, into: "main", summary: "", commits: 1, files: [], uncommitted: 0, status, problem: null, attempts: 0 });

  it("makes its worker one that needs you, even though the worker itself is idle", () => {
    let c = spawn(initialChats(main), "w1", "A");
    c = spawn(c, "w2", "B");
    const slots = { ...c.slots, s1: { ...c.slots.s1, proposals: [proposal("w2"), proposal("w1", "merged")] } };
    const nodes = orchestraNodes({ ...c, slots }, name);
    expect([...readyToMerge(nodes, slots)]).toEqual(["w2"]);
    expect(needingYou(nodes, slots)).toEqual(["w2"]);
    // Once answered it no longer does.
    const answered = { ...slots, s1: { ...slots.s1, proposals: [proposal("w2", "declined")] } };
    expect(needingYou(nodes, answered)).toEqual([]);
  });
});

describe("needingYou", () => {
  it("lists the agents with a prompt waiting, in canvas order", () => {
    const asking: State = { ...base, items: [{ type: "permission", id: "p", toolName: "Bash", input: {}, decision: null }] };
    let c = spawn(initialChats(main), "w1", "A");
    c = spawn(c, "w2", "B");
    const slots = { ...c.slots, w2: asking, s1: { ...asking, orchestrator: true } };
    expect(needingYou(orchestraNodes({ ...c, slots }, name), slots)).toEqual(["s1", "w2"]);
  });
});
