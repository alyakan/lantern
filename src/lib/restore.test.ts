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
