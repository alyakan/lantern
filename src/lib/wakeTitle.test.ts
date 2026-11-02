import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "../store";
import { chatTitle } from "../sessions";
import { chatsToSave } from "./restore";
import { POST_PREFIX } from "./chatHooks";

// A Codex chat has no title in titles.json (those are made with Claude Code), so what it is called after a wake comes from
// the history it is given: that must never turn a named chat into "New chat".
const resting: State = {
  ...initialState,
  status: "idle",
  folder: "/p",
  sessionId: "sess-1",
  claudePath: "/c",
  items: [{ type: "user", id: "u1", text: "fix the login redirect", at: 1 }],
};
const asleep = reducer(resting, { type: "sleep", folder: "/p", sessionId: "sess-1", title: "Fix the login redirect" });
const wake = (events: unknown[], earlier = 0) =>
  reducer(reducer(asleep, { type: "folder_opened", folder: "/p" }), { type: "history_loaded", sessionId: "sess-1", events: events as never, earlier });

describe("a chat that wakes with history that has no prompt of its own", () => {
  it("keeps its name when the history has no message from the user", () => {
    const woken = wake([{ kind: "session_started", session_id: "sess-1", model: "gpt" }]);
    expect(chatTitle(woken, {})).toBe("Fix the login redirect");
  });

  it("keeps its name, in memory and as saved for the next launch, when its page of turns starts at a post-hook", () => {
    const woken = wake([{ kind: "user_text", text: `${POST_PREFIX}Update the brain if needed` }], 3);
    expect(chatTitle(woken, {})).toBe("Fix the login redirect");
    expect(chatsToSave({ s2: woken }, "s1", {}, {})[0]?.title).toBe("Fix the login redirect");
  });

  it("keeps the name it had over the first prompt of a page that is not the chat's first", () => {
    const woken = wake([{ kind: "user_text", text: "and then the logout" }], 4);
    expect(chatTitle(woken, {})).toBe("Fix the login redirect");
  });

  it("is named by its own first prompt once nothing earlier is left to load", () => {
    const woken = wake([{ kind: "user_text", text: "fix the login redirect" }], 0);
    expect(woken.asleepTitle).toBeNull();
  });

  it("is called what it was saved as while it loads, when brought back at launch", () => {
    const opened = reducer({ ...initialState, status: "starting" }, { type: "folder_opened", folder: "/p", title: "Saved name" });
    expect(chatTitle(opened, {})).toBe("Saved name");
  });

  it("is named by its first prompt when the history has it", () => {
    const woken = wake([{ kind: "user_text", text: "fix the login redirect" }]);
    expect(chatTitle(woken, {})).toBe("fix the login redirect");
  });
});
