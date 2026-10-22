import { beforeEach, describe, expect, it } from "vitest";
import { chatsReducer, initialChats } from "../sessions";
import { initialState, type State } from "../store";
import type { UiEvent } from "../types";
import { agentSessionsOf, chatsToSave, clearRestoreAfterUpdate, currentFolder, isAgentFolder, loadSaved, markRestoreAfterUpdate, restoreAfterUpdatePending, restorable, save, screenFirst, sessionModesToSave, toCurrentFolders, withOffered, withoutGone, type SavedChat } from "./restore";

const chat = (over: Partial<State>): State => ({ ...initialState, status: "idle", ...over });
const talked = (sessionId: string, folder = "/p"): State => chat({ folder, sessionId, items: [{ type: "user", id: "u1", text: `Fix ${sessionId}` }] });
const saved = (over: Partial<SavedChat>): SavedChat => ({ sessionId: "a", folder: "/p", title: "A", draft: "", active: false, ...over });

describe("chatsToSave", () => {
  it("keeps chats with a conversation or typed text, with their titles, drafts and which was on screen", () => {
    const slots = {
      s1: talked("a"),
      s2: talked("b", "/other"),
      s3: chat({ folder: "/p", sessionId: "fresh" }),
      s4: chat({ folder: "/p", sessionId: "typed" }),
      s5: chat({ folder: null }),
    };
    const drafts = { s2: "half a prompt", s3: "   ", s4: "never sent" };
    expect(chatsToSave(slots, "s2", drafts, { a: "Retry flaky uploads" })).toEqual([
      { sessionId: "a", folder: "/p", title: "Retry flaky uploads", draft: "", active: false },
      { sessionId: "b", folder: "/other", title: "Fix b", draft: "half a prompt", active: true },
      // Typed but never sent: no conversation to resume, just the folder and the text.
      { sessionId: null, folder: "/p", title: "New chat", draft: "never sent", active: false },
    ]);
  });
});

describe("chatsToSave, for a team", () => {
  const agent = { parent: "s1", name: "Login form", brief: "", folder: "/wt/login", branch: "lantern/login", base: "main", isolation: "worktree" as const };
  const team = (worker: Partial<State> = {}) => ({ s1: { ...talked("lead"), orchestrator: true }, s2: { ...talked("w1", "/wt/login"), ...worker } });

  it("saves an agent with the session of its main agent, so it comes back inside its team", () => {
    const saved = chatsToSave(team(), "s1", {}, {}, { s2: agent });
    expect(saved.map((c) => [c.sessionId, c.orchestra])).toEqual([["lead", { role: "main" }], ["w1", { role: "worker", name: "Login form", parentSession: "lead", branch: "lantern/login", base: "main", isolation: "worktree" }]]);
  });

  it("saves an agent's role, so it comes back with the access it had", () => {
    const role = { id: "reviewer", label: "Reviewer", read_only: true };
    const saved = chatsToSave(team(), "s1", {}, {}, { s2: { ...agent, role } });
    expect(saved[1].orchestra).toMatchObject({ role: "worker", agentRole: role });
    expect("agentRole" in (chatsToSave(team(), "s1", {}, {}, { s2: agent })[1].orchestra ?? {})).toBe(false);
  });

  it("saves the model an agent runs on, so it comes back on that and not on the project's own", () => {
    const saved = chatsToSave(team({ model: "claude-sonnet-5-5" }), "s1", {}, {}, { s2: agent });
    expect(saved.find((c) => c.sessionId === "w1")?.orchestra).toMatchObject({ role: "worker", model: "claude-sonnet-5-5" });
    // The Lead's own model isn't saved here: it follows the project.
    expect(saved.find((c) => c.sessionId === "lead")?.orchestra).toEqual({ role: "main" });
  });

  it("leaves out an agent its Lead stopped: it isn't brought back at launch", () => {
    expect(chatsToSave(team({ leadStopped: true }), "s1", {}, {}, { s2: agent }).map((c) => c.sessionId)).toEqual(["lead"]);
  });
});

describe("restorable", () => {
  const lead = saved({ sessionId: "lead", orchestra: { role: "main" } });
  const worker = (over: Partial<SavedChat> = {}) => saved({ sessionId: "w1", folder: "/wt/login", orchestra: { role: "worker", name: "W", parentSession: "lead", branch: null, base: null, isolation: "worktree" }, ...over });

  it("keeps a team together and the user's own chats", () => {
    const own = saved({ sessionId: "own" });
    expect(restorable([worker(), lead, own])).toEqual([worker(), lead, own]);
  });

  it("drops an agent whose main agent isn't saved", () => {
    expect(restorable([worker(), saved({ sessionId: "own" })]).map((c) => c.sessionId)).toEqual(["own"]);
    // A main agent that has no conversation yet can't be named by its agents either.
    expect(restorable([worker(), saved({ sessionId: null, draft: "x", orchestra: { role: "main" } })])).toHaveLength(1);
  });

  it("drops an ordinary chat that is an agent's: in an agent's worktree, or a conversation known to be one", () => {
    const old = saved({ sessionId: "old", folder: "/Users/me/Library/Application Support/io.github.alyakan.lantern/worktrees/app/login-w1" });
    const shared = saved({ sessionId: "shared" });
    expect(restorable([old, shared, lead], new Set(["shared"])).map((c) => c.sessionId)).toEqual(["lead"]);
  });
});

describe("agent folders and sessions", () => {
  it("tells an agent's worktree by its path, as history.rs does", () => {
    expect(isAgentFolder("/Users/me/Library/Application Support/io.github.alyakan.lantern/worktrees/app/login-w1")).toBe(true);
    expect(isAgentFolder("/Users/me/dev/app/.claude/worktrees/agent-1")).toBe(true);
    expect(isAgentFolder("/Users/me/dev/worktrees/app")).toBe(false);
    expect(isAgentFolder("/Users/me/dev/app")).toBe(false);
  });

  it("names the sessions of the saved agents, and of chats an older version saved from their worktrees", () => {
    const agents = [
      saved({ sessionId: "w1", orchestra: { role: "worker", name: "W", parentSession: "lead", branch: null, base: null, isolation: "shared" } }),
      saved({ sessionId: "old", folder: "/x/io.github.alyakan.lantern/worktrees/app/w2" }),
      saved({ sessionId: "own" }),
      saved({ sessionId: "lead", orchestra: { role: "main" } }),
    ];
    expect(agentSessionsOf(agents)).toEqual(["w1", "old"]);
  });

  it("leaves out workers whose folders are gone", () => {
    const w = (id: string, folder: string) => saved({ sessionId: id, folder, orchestra: { role: "worker", name: id, parentSession: "lead", branch: null, base: null, isolation: "worktree" } });
    expect(withoutGone([w("a", "/wt/a"), w("b", "/wt/b"), saved({ sessionId: "own", folder: "/wt/a" })], new Set(["/wt/a"])).map((c) => c.sessionId)).toEqual(["b", "own"]);
  });
});

describe("withOffered", () => {
  it("keeps the offered chats after the open ones until they're dealt with", () => {
    const offered = [saved({ sessionId: "a", active: true }), saved({ sessionId: "b" })];
    expect(withOffered([], offered)).toEqual(offered);
    // "a" was restored and is open again: it's saved once, as it is now.
    const open = [saved({ sessionId: "a", title: "A now" }), saved({ sessionId: "c", active: true })];
    expect(withOffered(open, offered)).toEqual([...open, saved({ sessionId: "b" })]);
  });
});

describe("screenFirst", () => {
  it("puts the chat that was on screen first", () => {
    const [a, b, c] = [saved({ sessionId: "a" }), saved({ sessionId: "b", active: true }), saved({ sessionId: "c" })];
    expect(screenFirst([a, b, c])).toEqual([b, a, c]);
    expect(screenFirst([a, c])).toEqual([a, c]);
    expect(screenFirst([])).toEqual([]);
  });
});

describe("toCurrentFolders", () => {
  const moves = [{ folder: "/dev/rayak", aliases: ["/Documents/rayak", "/older/rayak"] }];

  it("names a moved folder as it is now, and leaves the rest as they were", () => {
    const [a, b, c] = [saved({ sessionId: "a", folder: "/Documents/rayak" }), saved({ sessionId: "b", folder: "/older/rayak/" }), saved({ sessionId: "c", folder: "/elsewhere" })];
    expect(toCurrentFolders([a, b, c], moves)).toEqual([{ ...a, folder: "/dev/rayak" }, { ...b, folder: "/dev/rayak" }, c]);
    expect(currentFolder("/Documents/rayak", moves)).toBe("/dev/rayak");
    expect(currentFolder("/Documents/rayak-two", moves)).toBe("/Documents/rayak-two");
  });

  it("keeps a chat saved in both places once, under the new folder", () => {
    const now = saved({ sessionId: "a", folder: "/dev/rayak", active: true });
    const typed = [saved({ sessionId: null, folder: "/Documents/rayak", draft: "one" }), saved({ sessionId: null, folder: "/dev/rayak", draft: "two" })];
    expect(toCurrentFolders([saved({ sessionId: "a", folder: "/Documents/rayak" }), now, ...typed], moves)).toEqual([now, { ...typed[0], folder: "/dev/rayak" }, typed[1]]);
  });

  it("changes nothing when no folder has moved", () => {
    const chats = [saved({ folder: "/Documents/rayak" })];
    expect(toCurrentFolders(chats, [])).toBe(chats);
  });
});

describe("saving", () => {
  beforeEach(() => localStorage.clear());

  it("reads back what was saved, and nothing from a missing or broken save", () => {
    expect(loadSaved()).toEqual([]);
    save([saved({})]);
    expect(loadSaved()).toEqual([saved({})]);
    localStorage.setItem("session.openChats", "{nope");
    expect(loadSaved()).toEqual([]);
  });
});

describe("chatsToSave for an orchestra", () => {
  const meta = { parent: "s1", name: "Login form", brief: "x", folder: "/wt/login", branch: "lantern/login-form", base: "main", isolation: "worktree" as const };

  it("saves a main agent as one, and a worker with its name, branch and its main agent's session", () => {
    const slots = { s1: { ...talked("main-session"), orchestrator: true }, w1: talked("worker-session", "/wt/login"), s2: talked("plain") };
    const saved = chatsToSave(slots, "s1", {}, {}, { w1: meta });
    expect(saved.map((c) => [c.sessionId, c.orchestra])).toEqual([
      ["main-session", { role: "main" }],
      ["worker-session", { role: "worker", name: "Login form", parentSession: "main-session", branch: "lantern/login-form", base: "main", isolation: "worktree" }],
      ["plain", undefined],
    ]);
    // A worker is named by its name, not by the brief it was given.
    expect(saved[1].title).toBe("Login form");
    expect("orchestra" in saved[2]).toBe(false);
  });

  it("leaves out a worker whose main agent has no session to name, rather than saving it as an ordinary chat", () => {
    const slots = { s1: { ...chat({ folder: "/p", sessionId: null, items: [] }), orchestrator: true }, w1: talked("worker-session", "/wt/login") };
    expect(chatsToSave(slots, "w1", {}, {}, { w1: meta })).toEqual([]);
  });

  it("saves a worker the user hid as hidden, and one that is shown with nothing extra", () => {
    const slots = { s1: { ...talked("main-session"), orchestrator: true }, w1: talked("hidden-session", "/wt/login"), w2: talked("shown-session", "/wt/other") };
    const saved = chatsToSave(slots, "s1", {}, {}, { w1: { ...meta, hidden: true }, w2: meta });
    expect(saved[1].orchestra).toMatchObject({ role: "worker", hidden: true });
    expect(saved[2].orchestra).not.toHaveProperty("hidden");
  });

  it("loads what was saved before workers could be hidden: such a worker is shown", () => {
    const old = { sessionId: "w", folder: "/wt/login", title: "Login form", draft: "", active: false, orchestra: { role: "worker", name: "Login form", parentSession: "m", branch: "lantern/login-form", base: "main", isolation: "worktree" } };
    localStorage.setItem("session.openChats", JSON.stringify([old]));
    const [loaded] = loadSaved();
    expect(loaded.orchestra).toEqual(old.orchestra);
    expect(loaded.orchestra && "hidden" in loaded.orchestra && loaded.orchestra.hidden).toBeFalsy();
  });

  it("keeps the orchestra of chats that are still only offered", () => {
    const offered = [saved({ sessionId: "m", orchestra: { role: "main" } })];
    expect(withOffered([], offered)).toEqual(offered);
    expect(withOffered([saved({ sessionId: "x" })], offered).find((c) => c.sessionId === "m")?.orchestra).toEqual({ role: "main" });
  });
});

describe("sessionModesToSave", () => {
  const spawned: UiEvent = { kind: "agent_spawned", worker: "w1", name: "Login form", brief: "Build it", folder: "/wt/login", branch: "lantern/login", base: "main", isolation: "worktree", mode: "auto" };
  const started = (session_id: string): UiEvent => ({ kind: "session_started", session_id, model: "m", cwd: "/p", permission_mode: "auto", claude_version: "1" });
  // The main agent is on screen on Auto; its worker runs in the background, and the user never opens it.
  const team = () => {
    let c = initialChats({ ...talked("main-1"), mode: "auto", orchestrator: true });
    c = chatsReducer(c, { type: "in", slot: "s1", action: { type: "ui_event", event: spawned } });
    return chatsReducer(c, { type: "in", slot: "w1", action: { type: "ui_event", event: started("worker-1") } });
  };

  it("keeps the mode of every open chat with a session, not just the one on screen", () => {
    expect(sessionModesToSave(team().slots, {})).toEqual({ "main-1": "auto", "worker-1": "auto" });
  });

  it("keeps what was saved for other sessions, and follows a chat whose mode changed", () => {
    let c = team();
    c = chatsReducer(c, { type: "in", slot: "w1", action: { type: "ui_event", event: { kind: "agent_mode", mode: "ask" } } });
    expect(sessionModesToSave(c.slots, { old: "steps", "worker-1": "auto" })).toEqual({ old: "steps", "main-1": "auto", "worker-1": "ask" });
  });

  it("saves Step by step with Auto Permissions as its own mode, so reopening the session brings both settings back", () => {
    const slots = { s1: { ...talked("steps-1"), mode: "steps" as const, autoApprove: true }, s2: { ...talked("steps-2"), mode: "steps" as const } };
    expect(sessionModesToSave(slots, {})).toEqual({ "steps-1": "steps:auto", "steps-2": "steps" });
  });

  it("saves nothing new when every mode is already there, and skips chats with no session yet", () => {
    const slots = { ...team().slots, s2: chat({ folder: "/p", mode: "auto" }) };
    expect(sessionModesToSave(slots, { "main-1": "auto", "worker-1": "auto" })).toBeNull();
  });
});

describe("chatsToSave, a team's review setting", () => {
  const lead = (review: State["review"]) => ({ s1: { ...talked("lead"), orchestrator: true, review } });

  it("is kept with the team when it is on, so the team comes back reviewing", () => {
    const review = { on: true, tidy: false, checks: ["reviewer", "qa"] };
    expect(chatsToSave(lead(review), "s1", {}, {})[0].orchestra).toEqual({ role: "main", review });
  });

  it("is not saved when it is off: an older save and a team that never asked look the same", () => {
    expect(chatsToSave(lead({ on: false, tidy: true, checks: ["reviewer"] }), "s1", {}, {})[0].orchestra).toEqual({ role: "main" });
  });
});

describe("restoring after an update", () => {
  beforeEach(() => localStorage.clear());

  it("is not asked for until a restart to update marks it", () => {
    expect(restoreAfterUpdatePending()).toBe(false);
  });

  it("stays pending, however often it is looked at, until it is cleared", () => {
    markRestoreAfterUpdate();
    expect(restoreAfterUpdatePending()).toBe(true);
    expect(restoreAfterUpdatePending()).toBe(true);
    clearRestoreAfterUpdate();
    expect(restoreAfterUpdatePending()).toBe(false);
  });

  it("is forgotten when the restart it was for didn't happen (a mark from long ago)", () => {
    markRestoreAfterUpdate(1_000);
    expect(restoreAfterUpdatePending(1_000 + 5 * 60_000)).toBe(true);
    expect(restoreAfterUpdatePending(1_000 + 11 * 60_000)).toBe(false);
  });

  it("ignores what isn't a time", () => {
    localStorage.setItem("session.restoreAfterUpdate", "yes");
    expect(restoreAfterUpdatePending()).toBe(false);
  });
});
