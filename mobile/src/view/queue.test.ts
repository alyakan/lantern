import type { Item } from "../sync/reducer";
import { queuedIds } from "./queue";

const user = (id: string): Item => ({ kind: "user", id, text: id, at: 1, sentBy: null });
const said: Item = { kind: "assistant", id: "a1", text: "ok", streaming: true };
const step: Item = { kind: "step", id: "s1", name: "Bash", summary: "ls", done: false, isError: false, edits: [], tests: null };
const turn: Item = { kind: "turn", id: "t1", isError: false, result: null, durationMs: 1 };

describe("queuedIds", () => {
  it("is empty when the chat is not working", () => {
    expect([...queuedIds([user("u1"), said, user("u2")], false)]).toEqual([]);
  });

  it("is empty for the message that began the turn, even with nothing after it yet", () => {
    expect([...queuedIds([user("u1")], true)]).toEqual([]);
  });

  it("holds a message that came while Claude was working and has nothing after it", () => {
    expect([...queuedIds([user("u1"), step, user("u2")], true)]).toEqual(["u2"]);
    expect([...queuedIds([user("u1"), said, user("u2"), user("u3")], true)]).toEqual(["u2", "u3"]);
  });

  it("holds two sent at once before Claude has said anything", () => {
    expect([...queuedIds([user("u1"), user("u2")], true)]).toEqual(["u2"]);
  });

  it("lets go of it once Claude goes on", () => {
    expect([...queuedIds([user("u1"), step, user("u2"), said], true)]).toEqual([]);
  });

  it("forgets a finished turn", () => {
    expect([...queuedIds([user("u1"), said, user("u2"), turn], true)]).toEqual([]);
    expect([...queuedIds([user("u1"), said, turn, user("u2")], true)]).toEqual([]);
  });
});
