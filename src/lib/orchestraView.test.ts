import { describe, expect, it } from "vitest";
import { initialState, type State } from "../store";
import { chatsReducer, initialChats, type Chats } from "../sessions";
import { needingYou, nodeStatus, orchestraNodes, summaryLine } from "./orchestraView";

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

describe("needingYou", () => {
  it("lists the agents with a prompt waiting, in canvas order", () => {
    const asking: State = { ...base, items: [{ type: "permission", id: "p", toolName: "Bash", input: {}, decision: null }] };
    let c = spawn(initialChats(main), "w1", "A");
    c = spawn(c, "w2", "B");
    const slots = { ...c.slots, w2: asking, s1: { ...asking, orchestrator: true } };
    expect(needingYou(orchestraNodes({ ...c, slots }, name), slots)).toEqual(["s1", "w2"]);
  });
});
