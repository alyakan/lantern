import { describe, expect, it } from "vitest";
import type { Chats } from "../sessions";
import { initialState, type State } from "../store";
import { checkRemoteNewChat, windowChats } from "./remoteChats";
import type { ProjectOpen } from "./sidebar";

const chat = (over: Partial<State>): State => ({ ...initialState, folder: "/work/lantern", ...over });
const project = (items: { slot: string; title: string }[]): ProjectOpen => ({ items: items.map((i) => ({ kind: "chat" as const, ...i }) as ProjectOpen["items"][number]), sessionIds: [], needs: 0, target: null });

describe("windowChats", () => {
  it("tells the hub each open chat's title, and which are asleep with their session", () => {
    const chats: Chats = { active: "a", agents: {}, slots: { a: chat({ status: "running", sessionId: "s-a" }), b: chat({ status: "asleep", sessionId: "s-b" }) } };
    const open = { "/work/lantern": project([{ slot: "a", title: "Release 0.1.53" }, { slot: "b", title: "Network tab filters" }]) };
    expect(windowChats(chats, open)).toEqual([
      { slot: "a", folder: "/work/lantern", title: "Release 0.1.53", asleep: false, session_id: "s-a" },
      { slot: "b", folder: "/work/lantern", title: "Network tab filters", asleep: true, session_id: "s-b" },
    ]);
  });

  it("uses the project's folder for a chat the store doesn't have yet", () => {
    const chats: Chats = { active: "a", agents: {}, slots: {} };
    expect(windowChats(chats, { "/p": project([{ slot: "x", title: "New chat" }]) })).toEqual([{ slot: "x", folder: "/p", title: "New chat", asleep: false, session_id: null }]);
  });
});

describe("checkRemoteNewChat", () => {
  const ask = { id: "r", folder: "/p", text: "hi", permissions: "ask" };

  it("lets a written message in a known project, on Ask, through", () => {
    expect(checkRemoteNewChat(ask, true, true)).toBeNull();
  });

  it("refuses anything that would start on another Permissions, whatever else is right", () => {
    for (const permissions of ["auto", "steps", "", "Ask"]) expect(checkRemoteNewChat({ ...ask, permissions }, true, true)).toContain("Ask");
  });

  it("refuses a project the user doesn't work in, and a message that isn't one", () => {
    expect(checkRemoteNewChat(ask, false, true)).toBe("That isn't one of your projects.");
    expect(checkRemoteNewChat(ask, true, false)).toBe("Write what the chat should start with.");
  });
});
