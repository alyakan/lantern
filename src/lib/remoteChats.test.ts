import { describe, expect, it } from "vitest";
import type { Chats } from "../sessions";
import { initialState, type State } from "../store";
import { BUILT_IN } from "./harness";
import { PROJECT_COLORS } from "./projectColors";
import { checkRemoteClose, checkRemoteNewChat, checkRemoteSwitch, windowChats, windowPresets, type RemoteContext, type SwitchTarget } from "./remoteChats";
import type { ProjectOpen } from "./sidebar";

const chat = (over: Partial<State>): State => ({ ...initialState, folder: "/work/lantern", ...over });
const project = (items: { slot: string; title: string }[]): ProjectOpen => ({ items: items.map((i) => ({ kind: "chat" as const, ...i }) as ProjectOpen["items"][number]), sessionIds: [], needs: 0, target: null });

describe("windowChats", () => {
  it("tells the hub each open chat's title, and which are asleep with their session", () => {
    const chats: Chats = { active: "a", agents: {}, slots: { a: chat({ status: "running", sessionId: "s-a" }), b: chat({ status: "asleep", sessionId: "s-b" }) } };
    const open = { "/work/lantern": project([{ slot: "a", title: "Release 0.1.53" }, { slot: "b", title: "Network tab filters" }]) };
    expect(windowChats(chats, open)).toEqual([
      { slot: "a", folder: "/work/lantern", title: "Release 0.1.53", asleep: false, session_id: "s-a", permissions: "ask", preset: null, color: null, workflow: "chat" },
      { slot: "b", folder: "/work/lantern", title: "Network tab filters", asleep: true, session_id: "s-b", permissions: "ask", preset: null, color: null, workflow: "chat" },
    ]);
  });

  it("tells the hub which mode each chat is on, and the preset it was started with", () => {
    const chats: Chats = { active: "a", agents: {}, slots: { a: chat({ status: "idle", mode: "auto" }), b: chat({ status: "idle" }) } };
    const open = { "/work/lantern": project([{ slot: "a", title: "A" }, { slot: "b", title: "B" }]) };
    const told = windowChats(chats, open, { a: "max" });
    expect(told.map((c) => [c.slot, c.permissions, c.preset])).toEqual([["a", "auto", "max"], ["b", "ask", null]]);
  });

  it("tells the hub the colour the sidebar gives each chat's project, so a phone shows the same", () => {
    const chats: Chats = { active: "a", agents: {}, slots: { a: chat({ status: "idle" }), b: chat({ status: "idle", folder: "/work/other" }) } };
    const open = { "/work/lantern": project([{ slot: "a", title: "A" }]), "/work/other": project([{ slot: "b", title: "B" }]), "/work/new": project([{ slot: "c", title: "C" }]) };
    const told = windowChats(chats, open, {}, { "/work/lantern": 0, "/work/other": 2 });
    expect(told.map((c) => [c.slot, c.color])).toEqual([["a", PROJECT_COLORS[0]], ["b", PROJECT_COLORS[2]], ["c", null]]);
    expect(PROJECT_COLORS[0]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("uses the project's folder for a chat the store doesn't have yet", () => {
    const chats: Chats = { active: "a", agents: {}, slots: {} };
    expect(windowChats(chats, { "/p": project([{ slot: "x", title: "New chat" }]) })).toEqual([{ slot: "x", folder: "/p", title: "New chat", asleep: false, session_id: null, permissions: null, preset: null, color: null, workflow: null }]);
  });
});

describe("checkRemoteNewChat", () => {
  const ask = { id: "r", folder: "/p", text: "hi", permissions: "ask" };

  it("lets a written message in a known project, on Ask, through", () => {
    expect(checkRemoteNewChat(ask, true, true)).toBeNull();
  });

  it("refuses anything that is not Ask or Auto, whatever else is right", () => {
    for (const permissions of ["steps", "", "Ask", "bypassPermissions"]) expect(checkRemoteNewChat({ ...ask, permissions }, true, true, { allowAuto: true, presetIds: [] })).toContain("Ask or Auto");
  });

  it("starts on Auto only when the Mac's own setting lets phones, however the request says it", () => {
    expect(checkRemoteNewChat({ ...ask, permissions: "auto" }, true, true)).toContain("Auto from a phone is off");
    expect(checkRemoteNewChat({ ...ask, permissions: "auto" }, true, true, { allowAuto: false, presetIds: [] })).toContain("Auto from a phone is off");
    expect(checkRemoteNewChat({ ...ask, permissions: "auto" }, true, true, { allowAuto: true, presetIds: [] })).toBeNull();
  });

  it("takes a preset only if it is one of the window's, not whatever name arrives", () => {
    const ctx: RemoteContext = { allowAuto: false, presetIds: ["default", "balanced"] };
    expect(checkRemoteNewChat({ ...ask, preset: "balanced" }, true, true, ctx)).toBeNull();
    expect(checkRemoteNewChat({ ...ask, preset: null }, true, true, ctx)).toBeNull();
    expect(checkRemoteNewChat({ ...ask, preset: "made-up" }, true, true, ctx)).toBe("That isn't one of your presets.");
    expect(checkRemoteNewChat({ ...ask, preset: "" }, true, true, ctx)).toBe("That isn't one of your presets.");
  });

  it("refuses a project the user doesn't work in, and a message that isn't one", () => {
    expect(checkRemoteNewChat(ask, false, true)).toBe("That isn't one of your projects.");
    expect(checkRemoteNewChat(ask, true, false)).toBe("Write what the chat should start with.");
  });
});

describe("checkRemoteSwitch", () => {
  const ctx: RemoteContext = { allowAuto: true, presetIds: ["default", "max"] };
  const target: SwitchTarget = { known: true, idle: true, asleep: false, background: 0 };

  it("lets an idle chat be put on Ask or Auto, or on one of the presets", () => {
    expect(checkRemoteSwitch({ permissions: "auto" }, target, ctx)).toBeNull();
    expect(checkRemoteSwitch({ permissions: "ask" }, target, ctx)).toBeNull();
    expect(checkRemoteSwitch({ preset: "max" }, target, ctx)).toBeNull();
  });

  it("refuses Auto while the Mac's setting is off, but never refuses Ask for that", () => {
    const off = { ...ctx, allowAuto: false };
    expect(checkRemoteSwitch({ permissions: "auto" }, target, off)).toContain("Auto from a phone is off");
    expect(checkRemoteSwitch({ permissions: "ask" }, target, off)).toBeNull();
  });

  it("refuses a mode that isn't one, and a preset that isn't listed", () => {
    expect(checkRemoteSwitch({ permissions: "bypassPermissions" }, target, ctx)).toContain("Ask or Auto");
    expect(checkRemoteSwitch({ preset: "nope" }, target, ctx)).toBe("That isn't one of your presets.");
  });

  it("refuses a chat that is unknown, asleep, busy, or has background tasks a restart would stop", () => {
    expect(checkRemoteSwitch({ preset: "max" }, { ...target, known: false }, ctx)).toContain("isn't open");
    expect(checkRemoteSwitch({ preset: "max" }, { ...target, asleep: true }, ctx)).toContain("asleep");
    expect(checkRemoteSwitch({ preset: "max" }, { ...target, idle: false }, ctx)).toContain("busy");
    expect(checkRemoteSwitch({ permissions: "ask" }, { ...target, background: 2 }, ctx)).toContain("background tasks");
  });
});

describe("windowPresets", () => {
  it("lists each preset by id, name and the line about what it does", () => {
    const told = windowPresets(BUILT_IN);
    expect(told[0]).toMatchObject({ id: "default", name: "Standard" });
    expect(told.find((p) => p.id === "balanced")?.summary).toBe("Sonnet · Opus advisor · Haiku subagents");
  });
});

describe("checkRemoteClose", () => {
  const target = { known: true, team: false, busy: false, background: 0 };

  it("lets a chat that is doing nothing be closed", () => {
    expect(checkRemoteClose(target)).toBeNull();
  });

  it("refuses a chat that is unknown, a team's, busy, or has background tasks closing would stop, and says why", () => {
    expect(checkRemoteClose({ ...target, known: false })).toContain("isn't open");
    expect(checkRemoteClose({ ...target, team: true })).toContain("team");
    expect(checkRemoteClose({ ...target, busy: true })).toContain("Stop it first");
    expect(checkRemoteClose({ ...target, background: 1 })).toContain("background tasks");
  });
});

describe("the workflow", () => {
  it("is told to the hub for each chat", () => {
    const chats: Chats = { active: "a", agents: {}, slots: { a: chat({ status: "idle", mode: "steps" }), b: chat({ status: "idle", orchestrator: true }), c: chat({ status: "idle" }) } };
    const open = { "/work/lantern": project([{ slot: "a", title: "A" }, { slot: "b", title: "B" }, { slot: "c", title: "C" }, { slot: "d", title: "D" }]) };
    expect(windowChats(chats, open).map((c) => [c.slot, c.workflow])).toEqual([["a", "steps"], ["b", "team"], ["c", "chat"], ["d", null]]);
  });

  it("is Chat or Step by step for a chat a phone starts, never a team, whatever else is right", () => {
    const base = { id: "r", folder: "/p", text: "hi", permissions: "ask" };
    expect(checkRemoteNewChat({ ...base, workflow: "steps" }, true, true)).toBeNull();
    expect(checkRemoteNewChat({ ...base, workflow: "chat" }, true, true)).toBeNull();
    expect(checkRemoteNewChat(base, true, true)).toBeNull();
    for (const workflow of ["team", "Steps", "", "orchestra"]) expect(checkRemoteNewChat({ ...base, workflow }, true, true)).toContain("only start a chat or Step by step");
  });

  it("is switched to Chat or Step by step, and never onto Team", () => {
    const ctx = { allowAuto: false, presetIds: [] };
    const target = { known: true, idle: true, asleep: false, background: 0 };
    expect(checkRemoteSwitch({ workflow: "steps" }, target, ctx)).toBeNull();
    expect(checkRemoteSwitch({ workflow: "chat" }, target, ctx)).toBeNull();
    expect(checkRemoteSwitch({ workflow: "team" }, target, ctx)).toContain("only start a chat or Step by step");
    expect(checkRemoteSwitch({ workflow: "steps" }, { ...target, idle: false }, ctx)).toContain("busy");
    expect(checkRemoteSwitch({ workflow: "steps" }, { ...target, known: false }, ctx)).toContain("isn't open");
  });
});

describe("a chat on another provider than Claude's", () => {
  it("is said so to the backend, and nothing is said of a chat on Claude", () => {
    const chats: Chats = { active: "a", agents: {}, slots: { a: chat({ status: "running", sessionId: "s-a" }), b: chat({ status: "asleep", sessionId: "s-b" }) } };
    const open = { "/work/lantern": project([{ slot: "a", title: "On Claude" }, { slot: "b", title: "On an endpoint" }]) };
    const told = windowChats(chats, open, {}, {}, (slot) => slot === "b");
    expect(told.find((c) => c.slot === "b")).toMatchObject({ off_claude: true });
    expect(told.filter((c) => c.slot !== "b").every((c) => !("off_claude" in c))).toBe(true);
  });
});
