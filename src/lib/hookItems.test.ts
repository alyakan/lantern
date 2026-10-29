import { describe, expect, it } from "vitest";
import type { ChatItem } from "../store";
import { outsideHooks } from "./hookItems";
import { sessionMarkdown } from "./sessionActions";
import { summaryLine } from "./orchestraView";
import { initialState } from "../store";

const say = (id: string, text: string): ChatItem => ({ type: "assistant", id, text });
const hook: ChatItem = { type: "hook", id: "h1", text: "Update the brain" };
const turn: ChatItem = { type: "turn", id: "t1", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 };
const user = (id: string, text: string): ChatItem => ({ type: "user", id, text });

describe("outsideHooks", () => {
  it("leaves out each post-hook and what Claude did for it, up to the turn's closing note", () => {
    const items = [user("u1", "go"), say("m1", "Done."), hook, say("m2", "Nothing to save."), turn, user("u2", "next"), say("m3", "Sure.")];
    expect(outsideHooks(items).map((i) => i.id)).toEqual(["u1", "m1", "t1", "u2", "m3"]);
  });

  it("a hook still running has nothing after it that counts", () => {
    expect(outsideHooks([user("u1", "go"), say("m1", "Done."), hook, say("m2", "saving…")]).map((i) => i.id)).toEqual(["u1", "m1"]);
  });

  it("keeps what follows a hook that came while the turn was still at work: it is the user's turn going on", () => {
    const allowed: ChatItem = { type: "permission", id: "p1", toolName: "Bash", input: {}, decision: "allowed" };
    const items = [user("u1", "go"), allowed, hook, say("m1", "The answer."), turn];
    expect(outsideHooks(items).map((i) => i.id)).toEqual(["u1", "p1", "m1", "t1"]);
  });

  it("changes nothing for a chat without hooks", () => {
    const items = [user("u1", "go"), say("m1", "Done."), turn];
    expect(outsideHooks(items)).toEqual(items);
  });
});

describe("what quotes the last reply", () => {
  const items = [user("u1", "go"), say("m1", "Fixed the retry."), hook, say("m2", "Nothing to save."), turn];

  it("an agent's card says the answer, not the hook's words", () => {
    expect(summaryLine({ ...initialState, items })).toBe("Fixed the retry.");
  });

  it("an exported chat leaves the post-hook out", () => {
    const md = sessionMarkdown("T", items, null);
    expect(md).toContain("Fixed the retry.");
    expect(md).not.toContain("Nothing to save.");
  });
});
