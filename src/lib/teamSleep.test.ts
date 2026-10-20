import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "../store";
import { chatTitle } from "../sessions";
import type { AgentMeta, Chats } from "../sessions";
import { chatsToSave, savedChatOf, startsNow, teamOf, type SavedChat } from "./restore";
import { canSleep, membersToSleep, teamSlots, teamsAtRest } from "./idleSleep";

const chat = (sessionId: string, over: Partial<State> = {}): State => ({
  ...initialState,
  status: "idle",
  folder: "/p",
  sessionId,
  claudePath: "/c",
  items: [{ type: "user", id: "u1", text: "go", at: 1 }],
  ...over,
});
const meta = (parent: string, name: string): AgentMeta => ({ parent, name, brief: "", folder: "/p/wt", branch: `b-${name}`, base: "main", isolation: "worktree" });

/** A team (a Lead and two agents), a chat of its own, and the one on screen. */
function world(over: Record<string, Partial<State>> = {}, active = "solo"): Chats {
  return {
    active,
    slots: {
      solo: chat("solo-1"),
      lead: chat("lead-1", { orchestrator: true, ...over.lead }),
      a1: chat("a1-1", { folder: "/p/wt", ...over.a1 }),
      a2: chat("a2-1", { folder: "/p/wt", ...over.a2 }),
    },
    agents: { a1: meta("lead", "Login"), a2: meta("lead", "Tests") },
  };
}
const notRoutine = () => false;

describe("which teams may go to sleep", () => {
  it("lets a team sleep once its Lead and every agent are resting and none is on screen", () => {
    expect(teamsAtRest(world(), notRoutine)).toEqual(["lead"]);
    expect(teamSlots(world(), "lead")).toEqual(["lead", "a1", "a2"]);
  });

  it("keeps a team awake while any member is working, or is the chat on screen", () => {
    expect(teamsAtRest(world({ a2: { status: "running", thinking: true } }), notRoutine)).toEqual([]);
    expect(teamsAtRest(world({ lead: { queued: ["next"] } }), notRoutine)).toEqual([]);
    expect(teamsAtRest(world({}, "a1"), notRoutine)).toEqual([]);
    expect(teamsAtRest(world({}, "lead"), notRoutine)).toEqual([]);
  });

  it("keeps a team awake while a merge card is waiting for the user, which would be gone when the Lead wakes", () => {
    const proposal = { worker: "a1", name: "Login", branch: "b", into: "main", summary: "", commits: 1, files: [], uncommitted: 0, loose: [], status: "open" as const, problem: null, attempts: 0 };
    expect(teamsAtRest(world({ lead: { proposals: [proposal] } }), notRoutine)).toEqual([]);
    expect(teamsAtRest(world({ lead: { proposals: [{ ...proposal, status: "merged" as const }] } }), notRoutine)).toEqual(["lead"]);
  });

  it("keeps a team awake while an agent is still starting and has no conversation to come back to", () => {
    expect(teamsAtRest(world({ a1: { sessionId: null, items: [] } }), notRoutine)).toEqual([]);
  });

  it("doesn't wait on an agent its Lead stopped, and leaves it as it is", () => {
    const chats = world({ a2: { status: "ended", leadStopped: true } });
    expect(teamsAtRest(chats, notRoutine)).toEqual(["lead"]);
    expect(membersToSleep(chats, "lead")).toEqual(["lead", "a1"]);
    // One that ended on its own does hold it up: it isn't resting.
    expect(teamsAtRest(world({ a2: { status: "ended" } }), notRoutine)).toEqual([]);
  });

  it("never lets an agent or a Lead sleep on its own", () => {
    const chats = world();
    expect(canSleep(chats.slots.a1, { active: false, agent: true, routine: false })).toBe(false);
    expect(canSleep(chats.slots.lead, { active: false, agent: false, routine: false })).toBe(false);
    expect(canSleep(chats.slots.a1, { active: false, agent: true, routine: false, team: true })).toBe(true);
  });
});

describe("a team that is asleep", () => {
  const slept = (s: State, saved = savedChatOf("x", { x: s }, "none", {}, {})) =>
    reducer(s, { type: "sleep", folder: s.folder!, sessionId: s.sessionId!, title: "t", ...(saved ? { saved } : {}) });

  it("is saved with the part each member had in it, whatever the Lead's and agents' state is now", () => {
    const chats = world({ lead: { review: { on: true } as State["review"] } });
    const saved = chatsToSave(chats.slots, "none", {}, {}, chats.agents);
    const asleep: Chats = {
      ...chats,
      slots: Object.fromEntries(Object.entries(chats.slots).map(([slot, s]) => [slot, slept(s, savedChatOf(slot, chats.slots, "none", {}, {}, chats.agents))])),
    };
    expect(chatsToSave(asleep.slots, "none", {}, {}, asleep.agents)).toEqual(saved.map((c) => ({ ...c, active: false })));
    // The agents are still tied to their Lead's session, and the Lead is still a main agent.
    const lead = saved.find((c) => c.sessionId === "lead-1");
    expect(lead?.orchestra?.role).toBe("main");
    expect(saved.filter((c) => c.orchestra?.role === "worker").map((c) => (c.orchestra as { parentSession: string }).parentSession)).toEqual(["lead-1", "lead-1"]);
  });

  it("keeps its unsent text and which chat was on screen", () => {
    const chats = world();
    const sleeper = slept(chats.slots.solo, savedChatOf("solo", chats.slots, "solo", { solo: "half a sentence" }, {}));
    const saved = savedChatOf("solo", { solo: sleeper }, "solo", { solo: "half a sentence" }, {});
    expect(saved).toMatchObject({ draft: "half a sentence", active: true, sessionId: "solo-1" });
  });

  it("forgets what it was saved as once its history is back", () => {
    const sleeper = slept(chat("s-1"));
    expect(sleeper.asleepSaved).not.toBeNull();
    const woken = reducer(reducer(sleeper, { type: "folder_opened", folder: "/p" }), { type: "history_loaded", sessionId: "s-1", events: [{ kind: "user_text", text: "go" }] });
    expect(woken.asleepSaved).toBeNull();
  });
});

describe("what Restore all starts now", () => {
  const plain = (id: string): SavedChat => ({ sessionId: id, folder: "/p", title: id, draft: "", active: false });
  const lead = (id: string): SavedChat => ({ ...plain(id), orchestra: { role: "main" } });
  const agent = (id: string, parent: string): SavedChat => ({ ...plain(id), folder: "/p/wt", orchestra: { role: "worker", name: id, parentSession: parent, branch: "b", base: "main", isolation: "worktree" } });
  const none = new Set<string>();

  it("starts the chat that was on screen, and the team it was in, Lead and agents", () => {
    const first = lead("L1");
    expect([first, agent("A1", "L1"), plain("P1"), lead("L2"), agent("A2", "L2")].map((c) => startsNow(c, first, none))).toEqual([true, true, false, false, false]);
  });

  it("starts the team of an agent that was on screen", () => {
    const first = agent("A1", "L1");
    expect([lead("L1"), first, agent("A9", "L1"), lead("L2")].map((c) => startsNow(c, first, none))).toEqual([true, true, true, false]);
  });

  it("leaves every team asleep when the chat on screen is an ordinary one", () => {
    const first = plain("P1");
    expect([first, plain("P2"), lead("L1"), agent("A1", "L1")].map((c) => startsNow(c, first, none))).toEqual([true, false, false, false]);
  });

  it("starts an agent now when its Lead is already open and awake, so it isn't left an ordinary chat", () => {
    const first = plain("P1");
    expect(startsNow(agent("A1", "L1"), first, new Set(["L1"]))).toBe(true);
    expect(startsNow(agent("A2", "L2"), first, new Set(["L1"]))).toBe(false);
  });

  it("starts a chat that has no conversation yet, which has nothing to put to sleep", () => {
    expect(startsNow({ ...plain("x"), sessionId: null, draft: "half a thought" }, plain("P1"), none)).toBe(true);
  });

  it("knows which team a saved chat is in", () => {
    expect([plain("P1"), lead("L1"), agent("A1", "L1")].map(teamOf)).toEqual([null, "L1", "L1"]);
  });
});

describe("a chat that is waking up", () => {
  const asleep = reducer(chat("w-1"), { type: "sleep", folder: "/p", sessionId: "w-1", title: "Fix the login redirect", saved: { sessionId: "w-1", folder: "/p", title: "Fix the login redirect", draft: "", active: false } });

  it("is still saved, found by its session and called what it was called while its history loads", () => {
    const waking = reducer(asleep, { type: "folder_opened", folder: "/p" });
    expect(waking.status).toBe("starting");
    expect(waking.sessionId).toBe("w-1");
    expect(chatTitle(waking)).toBe("Fix the login redirect");
    expect(chatsToSave({ s1: waking }, "none", {}, {})).toEqual([{ sessionId: "w-1", folder: "/p", title: "Fix the login redirect", draft: "", active: false }]);
  });

  it("is an ordinary chat once its history is in", () => {
    const woken = reducer(reducer(asleep, { type: "folder_opened", folder: "/p" }), { type: "history_loaded", sessionId: "w-1", events: [{ kind: "user_text", text: "fix the login redirect" }] });
    expect(woken.asleepSaved).toBeNull();
    expect(woken.asleepTitle).toBeNull();
    expect(woken.items).toHaveLength(1);
  });

  it("does not make a new chat in the same slot look like the one before it", () => {
    const fresh = reducer(chat("old-1"), { type: "folder_opened", folder: "/p" });
    expect(fresh.sessionId).toBeNull();
    expect(chatsToSave({ s1: fresh }, "none", {}, {})).toEqual([]);
  });
});
