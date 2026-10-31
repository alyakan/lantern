import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type { RemoteDesk } from "../protocol/generated/RemoteDesk";
import type { RemoteDeskRoute } from "../protocol/generated/RemoteDeskRoute";
import { attachSession } from "../test/fakeSession";
import { chat, connectedWith, makeController, renderWith, waiting } from "../test/render";
import { toKeep, type DeskEntry } from "../view/desk";
import { HomeScreen } from "./HomeScreen";

let mockMode: "desk" | "chats" = "desk";
jest.mock("../prefs", () => ({
  ...jest.requireActual("../prefs"),
  loadHomeMode: jest.fn(async () => mockMode),
  saveHomeMode: jest.fn(async (m: "desk" | "chats") => {
    mockMode = m;
  }),
  loadGrouping: jest.fn(async () => "recent"),
  saveGrouping: jest.fn(async () => {}),
  loadFolded: jest.fn(async () => []),
  saveFolded: jest.fn(async () => {}),
  loadSeen: jest.fn(async () => ({})),
  saveSeen: jest.fn(async () => {}),
  loadSuggestionPrefs: jest.fn(async () => ({ collapsed: true, dismissed: [] as string[] })),
  saveSuggestionPrefs: jest.fn(async () => {}),
}));
// The Desk's messages are kept in memory here, not in the Keychain.
let mockLog: DeskEntry[] = [];
jest.mock("../deskLog", () => ({
  loadDeskLog: jest.fn(async () => [...mockLog]),
  saveDeskLog: jest.fn(async (e: DeskEntry[]) => {
    mockLog = [...e];
  }),
  forgetDeskLog: jest.fn(async () => {}),
}));

beforeEach(() => {
  mockMode = "desk";
  mockLog = [];
});

const desk: RemoteDesk = {
  desks: [
    { id: "home", name: "Desk", slots: ["a", "b"], projects: [{ id: "/w/lantern", name: "lantern" }] },
    { id: "work", name: "Work", slots: ["w"], projects: [{ id: "/w/job", name: "job" }] },
  ],
  cards: [
    { key: "a:t1", desk: "home", slot: "a", title: "Phone notifications", project: "lantern", at: 10, asked: "Fewer pushes", auto: false, said: "Only approvals buzz now.", outcome: "done" },
    { key: "w:t1", desk: "work", slot: "w", title: "Release", project: "job", at: 20, asked: "Ship it", auto: false, said: "Shipped 4.2.", outcome: "done" },
  ],
};
const chats = [chat({ slot: "a", title: "Phone notifications" }), chat({ slot: "b", title: "Native sheets", status: "working", preview: "Bash npm test" }), chat({ slot: "w", title: "Release", status: "needs_you" })];
const handlers = () => ({ onOpenChat: jest.fn(), onReview: jest.fn(), onOpenMac: jest.fn(), onCompose: jest.fn(), onNewChat: jest.fn(), onSupport: jest.fn() });

async function open(route: RemoteDeskRoute | Error, more: Record<string, unknown> = {}) {
  const { controller } = makeController();
  const session = attachSession(controller, { desk, desk_route: route, send: null, ...more }, ["desk"]);
  const h = handlers();
  await renderWith(<HomeScreen {...h} />, { connection: connectedWith(["desk"]), chats, waiting: [waiting({ slot: "w", request_id: "p1" })] }, controller);
  await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  return { h, session, controller };
}

const say = async (text: string) => {
  await fireEvent.changeText(screen.getByLabelText("Message the Desk"), text);
  await fireEvent.press(screen.getByRole("button", { name: "Send" }));
  await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
};

describe("the Desk on the phone", () => {
  it("is Home for a Mac that has one: what needs you on top, this Desk's finished answers as one line each, and a tab for each Desk", async () => {
    const { h } = await open({ kind: "chat", slot: "a" });
    expect(screen.getByLabelText("Just finished")).toBeTruthy();
    const line = screen.getByRole("button", { name: "Phone notifications: Only approvals buzz now." });
    expect(screen.queryByRole("button", { name: "Release: Shipped 4.2." })).toBeNull();
    // What the chats are doing now is the list's business, not the Desk's.
    expect(screen.queryByText("Bash npm test")).toBeNull();
    expect(screen.getByText("✓ Nothing needs you")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Work, 1 waiting" })).toBeTruthy();
    await fireEvent.press(line);
    expect(h.onOpenChat).toHaveBeenCalledWith("a");
    // The other Desk: its own answers, and what waits on you there, on top.
    await fireEvent.press(screen.getByRole("tab", { name: "Work, 1 waiting" }));
    expect(screen.getByRole("button", { name: "Release: Shipped 4.2." })).toBeTruthy();
    expect(screen.getByLabelText("Needs you")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  });

  it("sends what is typed to the chat the Mac picked, from this phone, as if typed there", async () => {
    const { session } = await open({ kind: "chat", slot: "a" });
    await say("the pushes still buzz for finished turns");
    expect(session.lastOf("desk_route")).toEqual({ op: "desk_route", desk: "home", text: "the pushes still buzz for finished turns" });
    expect(session.lastOf("send")).toMatchObject({ op: "send", slot: "a", text: "the pushes still buzz for finished turns" });
    expect(mockLog.map((e) => e.outcome)).toEqual([{ kind: "sent", slot: "a", title: "Phone notifications", started: false, queued: false }]);
  });

  it("asks which chat when the Mac can't tell, and sends it to the one picked, or starts one in a project", async () => {
    const { session } = await open({ kind: "ask", slots: ["a", "b"], unsure: true }, { new_chat: { slot: "n1" } });
    await say("make it faster");
    expect(screen.getByText("Which chat is it for?")).toBeTruthy();
    expect(session.lastOf("send")).toBeUndefined();
    await fireEvent.press(screen.getByText("+ New in lantern"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(session.lastOf("new_chat")).toMatchObject({ op: "new_chat", project: "/w/lantern", text: "make it faster", permissions: null });
    expect(screen.getByText("Started ", { exact: false })).toBeTruthy();
    expect(mockLog.map((e) => e.outcome)).toEqual([{ kind: "sent", slot: "n1", title: "make it faster", started: true, queued: false }]);
  });

  it("starts a Step by step chat where the Mac said, on Ask", async () => {
    const { session } = await open({ kind: "start", project: "/w/lantern", workflow: "steps" }, { new_chat: { slot: "n1" } });
    await say("go step by step through the release");
    expect(session.lastOf("new_chat")).toMatchObject({ project: "/w/lantern", workflow: "steps", permissions: null });
    expect(session.lastOf("send")).toBeUndefined();
  });

  it("lists the chats a search found, opening the ones that are open", async () => {
    const { h } = await open({ kind: "search", terms: "pricing", failed: false, hits: [{ title: "Pricing page", project: "lantern", updated_ms: 5, snippet: "the pricing page", slot: "a" }] });
    await say("which chat had the pricing page?");
    expect(screen.getByText('Chats that say "pricing"')).toBeTruthy();
    await fireEvent.press(screen.getByText("Pricing page"));
    expect(h.onOpenChat).toHaveBeenCalledWith("a");
  });

  it("shows the Desk's own answer to how something stands, with the chats it read, sending nothing", async () => {
    const { h, session } = await open({ kind: "answer", terms: "testo", text: "- The demo is ready [1]", error: null, sources: [{ title: "Testo demo prep", project: "ios-app", updated_ms: 5, snippet: "", slot: "a" }, { title: "Plan Testo", project: "ios-app", updated_ms: 4, snippet: "", slot: null }] });
    await say("how are we on testo?");
    expect(screen.getByText("The demo is ready [1]")).toBeTruthy();
    expect(screen.getByText("2 Plan Testo · on your Mac")).toBeTruthy();
    await fireEvent.press(screen.getByText("1 Testo demo prep"));
    expect(h.onOpenChat).toHaveBeenCalledWith("a");
    expect(session.lastOf("send")).toBeUndefined();
  });

  it("lays out an answer in the Mac's shape: the sentence that answers, then Done, Open and Blocked", async () => {
    await open({ kind: "answer", terms: "testo", text: "Almost done: one test is red.\n\n**Done**\n- Pairing [1]\n\n**Blocked**\n- UI test on CI [1]", error: null, sources: [{ title: "Testo", project: "ios-app", updated_ms: 5, snippet: "", slot: "a" }] });
    await say("how are we on testo?");
    expect(screen.getByText("Almost done: one test is red.")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("UI test on CI [1]")).toBeTruthy();
    expect(screen.queryByText("Open")).toBeNull();
  });

  it("says why when the Mac didn't answer, and doesn't send it anywhere", async () => {
    const { session } = await open(new Error("Your Mac didn't answer in time."));
    await say("hello");
    expect(screen.getByText("Your Mac didn't answer in time.")).toBeTruthy();
    expect(session.lastOf("send")).toBeUndefined();
  });

  it("goes back to the list of chats when asked, and stays there", async () => {
    await open({ kind: "chat", slot: "a" });
    await fireEvent.press(screen.getByRole("tab", { name: "Chats" }));
    await waitFor(() => expect(screen.getByText("All chats")).toBeTruthy());
    expect(mockMode).toBe("chats");
  });

  describe("with a Mac whose Desk talks", () => {
    async function talking(responses: Record<string, unknown>) {
      const { controller } = makeController();
      const session = attachSession(controller, { desk, send: null, ...responses }, ["desk", "desktalk"]);
      const h = handlers();
      await renderWith(<HomeScreen {...h} />, { connection: connectedWith(["desk", "desktalk"]), chats, waiting: [] }, controller);
      await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
      return { h, session, controller };
    }

    it("only replies when it is only talked to, sending nothing", async () => {
      const { session } = await talking({ desk_talk: { say: "Hi! Two chats are open.", route: null } });
      await say("hi");
      expect(screen.getByText("Hi! Two chats are open.")).toBeTruthy();
      expect(session.lastOf("desk_route")).toBeUndefined();
      expect(session.lastOf("send")).toBeUndefined();
    });

    it("tells the Mac the earlier exchanges, says what it understood, and sends it on, waiting for what comes back", async () => {
      mockLog = [{ id: "old", desk: "home", at: 1, text: "fewer pushes", say: "On it.", outcome: { kind: "sent", slot: "a", title: "Phone notifications", started: false, queued: false } }];
      const { session } = await talking({ desk_talk: { say: "Got it: quieter at night too.", route: { kind: "chat", slot: "a" } } });
      await say("and quieter at night");
      expect(session.lastOf("desk_talk")).toEqual({ op: "desk_talk", desk: "home", text: "and quieter at night", history: [{ you: "fewer pushes", desk: 'On it. (sent to "Phone notifications")' }] });
      expect(screen.getByText("Got it: quieter at night too.")).toBeTruthy();
      expect(session.lastOf("send")).toMatchObject({ slot: "a", text: "and quieter at night" });
      expect(mockLog[mockLog.length - 1].reply).toMatchObject({ status: "waiting", after: chats[0].last_seq });
    });

    it("asks the Mac what came back once the chat moved on and stopped working, once, and shows it summed up", async () => {
      const { session, controller } = await talking({
        desk_talk: { say: "On it.", route: { kind: "chat", slot: "a" } },
        desk_reply: { done: true, failed: false, off: false, summary: "Capped the delay at 8s and added a test.", full: "I capped it at **8s**.", error: null },
      });
      await say("cap the delay");
      const after = chats[0].last_seq;
      expect(session.lastOf("desk_reply")).toBeUndefined();
      // The chat works on it, then is done: only then is the Mac asked.
      await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: chats.map((c) => (c.slot === "a" ? { ...c, status: "working", last_seq: after + 3 } : c)) } }));
      expect(session.lastOf("desk_reply")).toBeUndefined();
      await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: chats.map((c) => (c.slot === "a" ? { ...c, status: "idle", last_seq: after + 6 } : c)) } }));
      await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
      expect(session.lastOf("desk_reply")).toEqual({ op: "desk_reply", desk: "home", slot: "a", text: "cap the delay", after });
      expect(screen.getByText("Capped the delay at 8s and added a test.")).toBeTruthy();
      await fireEvent.press(screen.getByText("Show full answer"));
      expect(screen.getByText("8s")).toBeTruthy();
      expect(session.asked.filter((r) => r.op === "desk_reply")).toHaveLength(1);
      // Kept on the phone without Claude's whole words.
      expect(toKeep(mockLog[mockLog.length - 1]).reply).toEqual({ status: "done", failed: false, summary: "Capped the delay at 8s and added a test." });
    });

    it("drops what it said when the chat it picked can't take it", async () => {
      await talking({ desk_talk: { say: "Sending it on.", route: { kind: "chat", slot: "gone" } } });
      await say("fix it");
      expect(screen.queryByText("Sending it on.")).toBeNull();
      expect(screen.getByText("That chat is closed.")).toBeTruthy();
    });
  });
});
