import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "./store";
import type { UiEvent } from "./types";
import { nodeStatus } from "./lib/orchestraView";

const ev = (state: State, event: UiEvent) => reducer(state, { type: "ui_event", event });
const setup = (phase: "running" | "failed" | "done", over: Partial<Extract<UiEvent, { kind: "agent_setup" }>> = {}): UiEvent => ({ kind: "agent_setup", phase, index: 0, total: 2, command: "", line: "", reason: "", tail: "", ...over });
const started = (state: State = initialState, id = "run-a-1") => reducer(state, { type: "run_started", id, command: "npm run dev" });

describe("a worker's setup, as its card tells it", () => {
  it("shows the line that is running and what it printed last, keeping the line's name between its updates", () => {
    let s = ev(initialState, setup("running", { index: 0, command: "npm ci" }));
    expect(s.setup).toMatchObject({ status: "running", index: 0, total: 2, command: "npm ci", line: "" });
    s = ev(s, setup("running", { index: 0, line: "added 412 packages" }));
    expect(s.setup).toMatchObject({ command: "npm ci", line: "added 412 packages" });
    s = ev(s, setup("running", { index: 1, command: "cp a b" }));
    expect(s.setup).toMatchObject({ index: 1, command: "cp a b", line: "" });
  });

  it("says where it stopped and why, and is gone once the agent starts", () => {
    let s = ev(initialState, setup("running", { command: "npm ci" }));
    s = ev(s, setup("failed", { index: 1, command: "cp a b", reason: "it exited with code 1", tail: "cp: no such file" }));
    expect(s.setup).toMatchObject({ status: "failed", index: 1, command: "cp a b", reason: "it exited with code 1", tail: "cp: no such file" });
    expect(ev(s, setup("done")).setup).toBeNull();
    // Running again after a failure starts a fresh card, with nothing of the failure left on it.
    expect(ev(s, setup("running", { command: "npm ci" })).setup).toMatchObject({ status: "running", reason: "", tail: "" });
  });

  it("isn't Claude doing something: the quiet timer is left alone", () => {
    const s = { ...initialState, activityAt: 1234 };
    expect(ev(s, setup("running", { command: "npm ci" })).activityAt).toBe(1234);
    expect(ev(s, { kind: "thinking", parent: null }).activityAt).not.toBe(1234);
  });

  it("makes its card starting, and a failed one waiting on the user", () => {
    const worker: State = { ...initialState, status: "running", thinking: true };
    expect(nodeStatus(ev(worker, setup("running", { command: "npm ci" })))).toBe("starting");
    expect(nodeStatus(ev(worker, setup("failed", { command: "npm ci" })))).toBe("waiting");
    expect(nodeStatus(ev(ev(worker, setup("failed", { command: "npm ci" })), setup("done")))).toBe("working");
  });
});

describe("the project's Run command in a chat", () => {
  it("starts as running with nothing printed", () => {
    expect(started().run).toMatchObject({ id: "run-a-1", command: "npm run dev", status: "running", code: null, output: "", url: null });
  });

  it("collects what it prints and keeps the first local address it printed", () => {
    let s = started();
    s = ev(s, { kind: "shell_output", id: "run-a-1", text: "> vite\n  Local:   \x1b[36mhttp://localhost:5173/\x1b[39m\n" });
    s = ev(s, { kind: "shell_output", id: "run-a-1", text: "  Network: http://127.0.0.1:5174/\n" });
    expect(s.run?.output).toContain("> vite");
    expect(s.run?.url).toBe("http://localhost:5173/");
  });

  it("doesn't take an address that isn't this computer's", () => {
    const s = ev(started(), { kind: "shell_output", id: "run-a-1", text: "docs at https://example.com/ and http://localhost.evil.com/\n" });
    expect(s.run?.url).toBeNull();
  });

  it("finds an address split between two chunks of output", () => {
    let s = started();
    s = ev(s, { kind: "shell_output", id: "run-a-1", text: "ready on http://localhost:30" });
    expect(s.run?.url).toBeNull();
    s = ev(s, { kind: "shell_output", id: "run-a-1", text: "00/\n" });
    expect(s.run?.url).toBe("http://localhost:3000/");
  });

  it("ends as stopped (it exited cleanly, or was stopped) or failed (an exit code)", () => {
    expect(ev(started(), { kind: "shell_done", id: "run-a-1", code: 0, stopped: false }).run).toMatchObject({ status: "stopped", code: 0 });
    expect(ev(started(), { kind: "shell_done", id: "run-a-1", code: null, stopped: true }).run).toMatchObject({ status: "stopped" });
    expect(ev(started(), { kind: "shell_done", id: "run-a-1", code: 2, stopped: false }).run).toMatchObject({ status: "failed", code: 2 });
  });

  it("ignores what an earlier run says once another has started", () => {
    let s = started(initialState, "run-a-1");
    s = started(s, "run-a-2");
    s = ev(s, { kind: "shell_output", id: "run-a-1", text: "old output http://localhost:1/\n" });
    s = ev(s, { kind: "shell_done", id: "run-a-1", code: null, stopped: true });
    expect(s.run).toMatchObject({ id: "run-a-2", status: "running", output: "", url: null });
  });

  it("is not a command in the conversation, and doesn't count as Claude working", () => {
    let s: State = { ...initialState, activityAt: 99 };
    s = started(s);
    s = ev(s, { kind: "shell_output", id: "run-a-1", text: "hello\n" });
    s = ev(s, { kind: "shell_secret", id: "run-a-1", secret: true });
    s = ev(s, { kind: "shell_done", id: "run-a-1", code: 0, stopped: false });
    expect(s.items).toEqual([]);
    expect(s.activityAt).toBe(99);
  });

  it("leaves a command from the chat box as it was", () => {
    let s = reducer(initialState, { type: "shell_started", id: "sh-1", command: "ls" });
    s = ev(s, { kind: "shell_output", id: "sh-1", text: "a\n" });
    expect(s.items[0]).toMatchObject({ type: "shell", output: "a\n" });
    expect(s.run).toBeNull();
  });

  it("can be closed", () => {
    expect(reducer(started(), { type: "run_closed" }).run).toBeNull();
  });

  it("keeps only the end of a long output", () => {
    const s = ev(started(), { kind: "shell_output", id: "run-a-1", text: "x".repeat(300_000) });
    expect(s.run!.output.length).toBe(256_000);
  });
});
