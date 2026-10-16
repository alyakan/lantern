import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "../store";
import type { UiEvent } from "../types";
import { answerOf, asideReducer, emptyAside, isWorking, stepLine, type AsideAction, type AsideState } from "./aside";

const ev = (event: UiEvent): AsideAction => ({ type: "event", event });
const done = (extra: Partial<Extract<UiEvent, { kind: "turn_done" }>> = {}): UiEvent => ({ kind: "turn_done", is_error: false, result: null, cost_usd: null, tokens: null, session_cost_usd: 0.02, session_tokens: 1200, duration_ms: 900, auth_hint: false, denied: 0, context_window: 200_000, ...extra });
const run = (actions: AsideAction[], from: AsideState = emptyAside) => actions.reduce(asideReducer, from);
const asked = (q = "what is x?"): AsideAction => ({ type: "asked", question: q });
const text = (id: string, t: string): AsideAction => ev({ kind: "assistant_text", parent: null, block_id: id, text: t });

describe("a side chat's answer", () => {
  it("streams in word by word, then settles on the final text", () => {
    let s = run([asked(), ev({ kind: "text_delta", parent: null, block_id: "b:0", text: "It does " }), ev({ kind: "text_delta", parent: null, block_id: "b:0", text: "X." })]);
    expect(answerOf(s.turns[0])).toBe("It does X.");
    expect(isWorking(s)).toBe(true);
    s = run([text("b:0", "It does X, nothing else."), ev(done())], s);
    expect(answerOf(s.turns[0])).toBe("It does X, nothing else.");
    expect(s.turns[0].status).toBe("done");
    expect(isWorking(s)).toBe(false);
  });

  it("keeps the text on either side of a file it looked at, in order", () => {
    const s = run([asked(), text("b:0", "Let me look."), ev({ kind: "tool_started", parent: null, tool_use_id: "t", name: "Read", summary: "/p/src/retry.ts" }), text("b:1", "It retries.")]);
    expect(answerOf(s.turns[0])).toBe("Let me look.\n\nIt retries.");
  });

  it("says what it is reading while it reads, and stops saying so once it writes", () => {
    let s = run([asked(), ev({ kind: "tool_started", parent: null, tool_use_id: "t", name: "Read", summary: "/p/src/retry.ts" })]);
    expect(s.turns[0].step).toBe("Reading retry.ts");
    s = run([ev({ kind: "tool_started", parent: null, tool_use_id: "u", name: "Grep", summary: "RETRYABLE" })], s);
    expect(s.turns[0].step).toBe("Searching the files");
    s = run([text("b:0", "Found it.")], s);
    expect(s.turns[0].step).toBeNull();
    expect(stepLine("Glob", "")).toBe("Looking for files");
  });

  it("counts what the side chat itself used, as its own total", () => {
    const s = run([asked(), text("b:0", "ok"), ev(done({ session_cost_usd: 0.031, session_tokens: 41_800 }))]);
    expect([s.cost, s.tokens]).toEqual([0.031, 41_800]);
    // A later turn that says nothing about cost keeps what was known.
    const t = run([asked("and y?"), ev(done({ session_cost_usd: null, session_tokens: undefined }))], s);
    expect([t.cost, t.tokens]).toEqual([0.031, 41_800]);
  });

  it("a follow-up is another turn in the same side chat", () => {
    const s = run([asked("one"), text("b:0", "first"), ev(done()), asked("two"), text("c:0", "second"), ev(done())]);
    expect(s.turns.map((t) => [t.question, answerOf(t)])).toEqual([["one", "first"], ["two", "second"]]);
  });
});

describe("a side chat that goes wrong or is stopped", () => {
  it("a failed question says why, and a failed answer keeps what it had written", () => {
    const failed = run([asked(), { type: "failed", text: "Too many side chats are open." }]);
    expect(failed.turns[0]).toMatchObject({ status: "failed", note: "Too many side chats are open." });
    const cut = run([asked(), text("b:0", "Partly"), ev(done({ is_error: true, result: "The model is overloaded." }))]);
    expect(cut.turns[0]).toMatchObject({ status: "failed", note: "The model is overloaded." });
    expect(answerOf(cut.turns[0])).toBe("Partly");
  });

  it("a note from Lantern ends the answer as stopped, and the turn's own end after it changes nothing", () => {
    const s = run([asked(), text("b:0", "Partly"), { type: "event", note: "Stopped: it was looking at too many files." }, ev(done({ is_error: true, result: "interrupted" }))]);
    expect(s.turns[0]).toMatchObject({ status: "stopped", note: "Stopped: it was looking at too many files." });
    expect(isWorking(s)).toBe(false);
    // What it used is still counted.
    expect(s.cost).toBe(0.02);
  });

  it("its claude going away ends the side chat for good", () => {
    const s = run([asked(), ev({ kind: "session_ended", code: 1, stderr_tail: "boom" })]);
    expect(s.ended).toBe(true);
    expect(s.turns[0].status).toBe("failed");
  });

  it("starts from the chat's conversation or says it started blank", () => {
    expect(run([{ type: "started", forked: false }]).forked).toBe(false);
    // Said once: a later answer doesn't change it.
    expect(run([{ type: "started", forked: true }, { type: "started", forked: false }]).forked).toBe(true);
  });
});

describe("isolation from the chat", () => {
  const every: UiEvent[] = [
    { kind: "text_delta", parent: null, block_id: "b:0", text: "hi" },
    { kind: "assistant_text", parent: null, block_id: "b:0", text: "hi" },
    { kind: "tool_started", parent: null, tool_use_id: "t", name: "Read", summary: "/p/a.ts" },
    { kind: "retrying", attempt: 1, max_retries: 3, error: "overloaded" },
    done(),
    { kind: "session_ended", code: 1, stderr_tail: "" },
  ];

  it("the chat's reducer is never given a side chat's events, and a chat's own events never reach the side chat's", () => {
    // The chat only changes on its own `ui_event` actions; a side chat's events are a different action type, handled by a
    // different reducer, so running every kind of event through one leaves the other as it was.
    const chat: State = reducer(initialState, { type: "claude_found", path: "/bin/claude" });
    const aside = run([asked(), ...every.map(ev)]);
    expect(aside.turns).toHaveLength(1);
    expect(chat).toEqual(reducer(initialState, { type: "claude_found", path: "/bin/claude" }));
  });

  it("nothing but the answer is taken in, whatever else arrives", () => {
    const others: UiEvent[] = [
      { kind: "context_used", tokens: 9000 },
      { kind: "permission_requested", request_id: "r", tool_name: "Bash", input: {} },
      { kind: "plan_usage", used: 0.9, resets_at: null, status: "allowed" },
      { kind: "model_usage", models: [] },
      { kind: "conversation_reset" },
      { kind: "edit_applied", parent: null, tool_use_id: "t", path: "/p/a.ts", created: false, hunks: [] },
      { kind: "assistant_text", parent: "sub", block_id: "b:0", text: "a subagent's words" },
    ];
    expect(run([asked(), ...others.map(ev)])).toEqual(run([asked()]));
  });

  it("the side chat's own totals are separate from the chat's", () => {
    const chat = reducer(initialState, { type: "ui_event", event: done({ session_cost_usd: 1.5, session_tokens: 500_000 }) });
    const aside = run([asked(), ev(done({ session_cost_usd: 0.02, session_tokens: 1200 }))]);
    expect([aside.cost, aside.tokens]).toEqual([0.02, 1200]);
    expect([chat.sessionCost, chat.sessionTokens]).toEqual([1.5, 500_000]);
  });
});
