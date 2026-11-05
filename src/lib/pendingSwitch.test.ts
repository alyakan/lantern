import { describe as group, expect, it } from "vitest";
import { initialState, type State } from "../store";
import { busy, changeOf, describe, nextStep, queue, ready, wasStopped, type Current } from "./pendingSwitch";

const now: Current = { permissions: "ask", workflow: "chat", preset: "default", conversation: { provider: "claude", model: "opus", effort: "high" } };
const chat = (over: Partial<State>): State => ({ ...initialState, folder: "/work/lantern", ...over });
const turn = (stopped: boolean) => ({ type: "turn", id: "t1", isError: false, stopped, result: null, durationMs: 1, denied: [], cost: null, tokens: null }) as unknown as State["items"][number];
const user = { type: "user", id: "u1", text: "go", at: 1 } as unknown as State["items"][number];

group("queue", () => {
  it("keeps the latest of each setting, and one wait for all of them", () => {
    const a = queue(undefined, { permissions: "auto" }, "finished", now);
    const b = queue(a!, { workflow: "steps" }, "finished", now);
    const c = queue(b!, { permissions: "ask" }, "finished", now);
    expect(c).toEqual({ change: { workflow: "steps" }, when: "finished", phase: "waiting" });
  });

  it("drops what the chat already runs, and is nothing when that is all", () => {
    expect(queue(undefined, { permissions: "ask", preset: "default" }, "now", now)).toBeNull();
    expect(queue(undefined, { conversation: { model: "opus", effort: "low" } }, "now", now)?.change).toEqual({ conversation: { effort: "low" } });
  });

  it("merges conversation changes, a later one over an earlier", () => {
    const a = queue(undefined, { conversation: { model: "sonnet" } }, "finished", now);
    expect(queue(a!, { conversation: { effort: "low" } }, "finished", now)?.change).toEqual({ conversation: { model: "sonnet", effort: "low" } });
  });

  it("stays on now once now is asked", () => {
    const a = queue(undefined, { permissions: "auto" }, "now", now);
    expect(queue(a!, { workflow: "steps" }, "finished", now)?.when).toBe("now");
  });

  it("adds nothing to a switch already under way", () => {
    expect(queue({ change: { permissions: "auto" }, when: "now", phase: "applying" }, { workflow: "steps" }, "now", now)).toBeNull();
  });
});

group("ready", () => {
  const waiting = { change: { permissions: "auto" as const }, when: "finished" as const, phase: "waiting" as const };

  it("waits while the chat works or asks the user something", () => {
    expect(ready(chat({ status: "running" }), waiting)).toBe(false);
    expect(ready(chat({ status: "idle", items: [{ type: "permission", id: "p", toolName: "Bash", input: {}, decision: null }] }), waiting)).toBe(false);
    expect(ready(chat({ status: "idle" }), waiting)).toBe(true);
  });

  it("waits for queued messages when it is to apply once the work is done, not when it is now", () => {
    expect(ready(chat({ status: "idle", queued: ["next"] }), waiting)).toBe(false);
    expect(ready(chat({ status: "idle", queued: ["next"] }), { ...waiting, when: "now" })).toBe(true);
  });

  it("applies over a claude the stop made exit, which is then restarted with the change", () => {
    expect(ready(chat({ status: "ended", stopRequested: true }), { ...waiting, when: "now" })).toBe(true);
  });

  it("isn't applied twice", () => {
    expect(ready(chat({ status: "idle" }), { ...waiting, phase: "applying" })).toBe(false);
  });
});

group("wasStopped", () => {
  it("is the last turn's being stopped, and nothing once the user wrote after it", () => {
    expect(wasStopped(chat({ items: [user, turn(true)] }))).toBe(true);
    expect(wasStopped(chat({ items: [user, turn(false)] }))).toBe(false);
    expect(wasStopped(chat({ items: [turn(true), user] }))).toBe(false);
    expect(wasStopped(chat({ items: [] }))).toBe(false);
  });
});

it("says what a chat works on busy", () => {
  expect(busy(chat({ status: "running" }))).toBe(true);
  expect(busy(chat({ status: "idle", queued: ["x"] }))).toBe(true);
  expect(busy(chat({ status: "idle" }))).toBe(false);
});

it("says a change in words", () => {
  expect(describe({ permissions: "auto", workflow: "steps", preset: "max" }, (id) => id.toUpperCase())).toBe("Auto, Step by step, MAX");
  expect(describe({ conversation: { model: null, effort: "low" } })).toBe("the default model, low effort");
});

group("nextStep", () => {
  it("applies Permissions and Workflow together first, then the preset, then the provider's settings", () => {
    const change = { permissions: "auto" as const, workflow: "steps" as const, preset: "max", conversation: { effort: "low" } };
    expect(nextStep(change)).toEqual({ step: "settings", rest: { preset: "max", conversation: { effort: "low" } } });
    expect(nextStep({ preset: "max", conversation: { effort: "low" } })).toEqual({ step: "preset", rest: { conversation: { effort: "low" } } });
    expect(nextStep({ conversation: { effort: "low" } })).toEqual({ step: "conversation", rest: {} });
    expect(nextStep({})).toBeNull();
  });
});

it("keeps a model or effort it can't compare with what runs: the backend may run another than the window last set", () => {
  const unknown: Current = { ...now, conversation: {} };
  expect(queue(undefined, { conversation: { model: null } }, "now", unknown)?.change).toEqual({ conversation: { model: null } });
});

it("takes a phone's change only as one setting or the provider's settings", () => {
  expect(changeOf({ permissions: "auto" })).toEqual({ permissions: "auto" });
  expect(changeOf({ workflow: "team" })).toBeNull();
  expect(changeOf({ conversation: { effort: null, shell: "rm" } })).toEqual({ conversation: { effort: null } });
  expect(changeOf({ conversation: { model: 3 } })).toBeNull();
  expect(changeOf("auto")).toBeNull();
});
