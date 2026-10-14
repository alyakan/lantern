import { beforeEach, describe, expect, it } from "vitest";
import { initialState, type State } from "../store";
import { chatsToSave, loadSaved, save, screenFirst, withOffered, type SavedChat } from "./restore";

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
      { sessionId: null, folder: "/p", title: "New session", draft: "never sent", active: false },
    ]);
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

  it("saves a worker as an ordinary chat when its main agent has no session to name", () => {
    const slots = { s1: { ...chat({ folder: "/p", sessionId: null, items: [] }), orchestrator: true }, w1: talked("worker-session", "/wt/login") };
    const saved = chatsToSave(slots, "w1", {}, {}, { w1: meta });
    expect(saved).toHaveLength(1);
    expect(saved[0].orchestra).toBeUndefined();
  });

  it("keeps the orchestra of chats that are still only offered", () => {
    const offered = [saved({ sessionId: "m", orchestra: { role: "main" } })];
    expect(withOffered([], offered)).toEqual(offered);
    expect(withOffered([saved({ sessionId: "x" })], offered).find((c) => c.sessionId === "m")?.orchestra).toEqual({ role: "main" });
  });
});
