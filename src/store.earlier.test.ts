import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "./store";
import type { TestRun, UiEvent } from "./types";

const turn = (n: number): UiEvent[] => [
  { kind: "user_text", text: `question ${n}` },
  { kind: "tool_started", parent: null, tool_use_id: `tool-${n}`, name: "Read", summary: "a.ts" },
  { kind: "tool_finished", parent: null, tool_use_id: `tool-${n}`, is_error: false, output: "ok" },
  { kind: "assistant_text", parent: null, block_id: `a-${n}`, text: `answer ${n}` },
];

const opened = (earlier: number): State => reducer({ ...initialState, folder: "/p", claudePath: "/c" }, { type: "history_loaded", sessionId: "s1", events: [...turn(8), ...turn(9)], earlier });
const texts = (s: State) => s.items.flatMap((it) => (it.type === "user" || it.type === "assistant" ? [it.text] : []));
const unique = (s: State) => new Set(s.items.map((it) => it.id)).size === s.items.length;

describe("a long session that opens with its last turns", () => {
  it("knows how many turns it hasn't loaded", () => {
    expect(opened(7).earlierTurns).toBe(7);
    expect(reducer({ ...initialState, folder: "/p" }, { type: "history_loaded", sessionId: "s1", events: turn(0) }).earlierTurns).toBe(0);
  });

  it("puts the earlier turns above the ones it has, in order, with no id used twice", () => {
    const loaded = reducer(opened(7), { type: "earlier_loaded", sessionId: "s1", events: [...turn(6), ...turn(7)], expected: 7, hidden: 5 });
    expect(texts(loaded)).toEqual(["question 6", "answer 6", "question 7", "answer 7", "question 8", "answer 8", "question 9", "answer 9"]);
    expect(loaded.earlierTurns).toBe(5);
    expect(unique(loaded)).toBe(true);
  });

  it("goes back page by page to the first turn, where nothing is left to load", () => {
    const first = reducer(opened(4), { type: "earlier_loaded", sessionId: "s1", events: [...turn(4), ...turn(5), ...turn(6), ...turn(7)], expected: 4, hidden: 2 });
    const second = reducer(first, { type: "earlier_loaded", sessionId: "s1", events: [...turn(2), ...turn(3)], expected: 2, hidden: 0 });
    expect(second.earlierTurns).toBe(0);
    expect(texts(second).filter((t) => t.startsWith("question"))).toEqual([2, 3, 4, 5, 6, 7, 8, 9].map((n) => `question ${n}`));
    expect(unique(second)).toBe(true);
  });

  it("lets go of a page that is for another session or that was already loaded", () => {
    const s = opened(7);
    expect(reducer(s, { type: "earlier_loaded", sessionId: "other", events: turn(6), expected: 7, hidden: 6 })).toBe(s);
    expect(reducer(s, { type: "earlier_loaded", sessionId: "s1", events: turn(6), expected: 3, hidden: 2 })).toBe(s);
  });

  it("keeps what it has when the earlier turns can't be read, and says so", () => {
    const failed = reducer(opened(7), { type: "earlier_failed", text: "Couldn't load the earlier messages: no transcript" });
    expect(failed.banner).toEqual({ kind: "error", text: "Couldn't load the earlier messages: no transcript", action: null });
    expect(failed.earlierTurns).toBe(7);
    expect(failed.items).toEqual(opened(7).items);
  });

  it("brings the earlier test runs back with their turns", () => {
    const run = { passed: 1, failed: 0 } as unknown as TestRun;
    const loaded = reducer(opened(1), { type: "earlier_loaded", sessionId: "s1", events: [{ kind: "test_run", parent: null, tool_use_id: "old-run", command: "npm test", run }, ...turn(7)], expected: 1, hidden: 0 });
    expect(loaded.testRuns.map((r) => r.id)).toEqual(["old-run"]);
  });

  it("has nothing earlier to load once /clear began a new conversation", () => {
    const cleared = reducer(opened(7), { type: "ui_event", event: { kind: "conversation_reset" } });
    expect(cleared.earlierTurns).toBe(0);
    expect(cleared.items).toEqual([]);
  });

  it("has nothing left to load while it sleeps: waking reads its last turns again", () => {
    expect(reducer(opened(7), { type: "sleep", folder: "/p", sessionId: "s1", title: "t" }).earlierTurns).toBe(0);
  });
});
