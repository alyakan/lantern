import { describe, expect, it } from "vitest";
import type { ChatItem } from "../store";
import { attentionFor } from "./attention";

const describeInput = (input: unknown) => (input as { command?: string }).command ?? "";
const turn = (extra: Partial<Extract<ChatItem, { type: "turn" }>> = {}): ChatItem => ({ type: "turn", id: "t1", isError: false, stopped: false, result: null, durationMs: 5, denied: 0, ...extra });
const user: ChatItem = { type: "user", id: "u1", text: "fix it" };

describe("attentionFor", () => {
  it("announces a finished turn with the reply's first line as plain text", () => {
    const items: ChatItem[] = [user, { type: "assistant", id: "m1", text: "\n## Done: `fetchJson` now **retries** 429s\n\nDetails…" }, turn()];
    expect(attentionFor(items, "/Users/me/acme-api", describeInput)).toEqual({ key: "t1", kind: "finished", title: "Claude · acme-api", body: "Done: fetchJson now retries 429s" });
  });

  it("says when a turn was stopped or failed", () => {
    expect(attentionFor([user, turn({ stopped: true })], null, describeInput)?.body).toBe("Stopped");
    expect(attentionFor([user, turn({ isError: true, result: "Credit balance too low" })], null, describeInput)?.body).toBe("Ended with an error: Credit balance too low");
  });

  it("announces a permission prompt that is waiting, but not one already answered", () => {
    const ask = (decision: "allowed" | null): ChatItem => ({ type: "permission", id: "p1", toolName: "Bash", input: { command: "npm test" }, decision });
    expect(attentionFor([user, ask(null)], "/p", describeInput)).toEqual({ key: "p1", kind: "waiting", title: "Claude · p", body: "Wants to use Bash: npm test" });
    expect(attentionFor([user, ask("allowed")], "/p", describeInput)).toBeNull();
  });

  it("stays quiet mid-turn", () => {
    expect(attentionFor([user, { type: "assistant", id: "m1", text: "working" }], "/p", describeInput)).toBeNull();
    expect(attentionFor([], "/p", describeInput)).toBeNull();
  });

  it("trims long replies", () => {
    const body = attentionFor([user, { type: "assistant", id: "m1", text: "x".repeat(300) }, turn()], null, describeInput)!.body;
    expect(body).toHaveLength(140);
    expect(body.endsWith("…")).toBe(true);
  });
});
