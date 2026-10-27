import "@shopify/flash-list/jestSetup";
import { StyleSheet } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { RemoteEvent } from "../protocol/generated/RemoteEvent";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { attachSession } from "../test/fakeSession";
import { chat, connected, makeController, renderWith } from "../test/render";
import { ChatScreen } from "./ChatScreen";
import { PromptRow } from "./ChatParts";
import { renderHook } from "@testing-library/react-native";
import { resetSeen, useSeen } from "../seen";
import { COMPOSER_FILL } from "../ui/Glass";
import { motion } from "../ui/motion";
import { lightColors } from "../ui/theme";

// Where each chat was last shown: kept in memory here, not in the Keychain.
jest.mock("../prefs", () => ({
  ...jest.requireActual("../prefs"),
  loadSeen: jest.fn(async () => ({})),
  saveSeen: jest.fn(async () => {}),
}));
beforeEach(() => resetSeen());

const handlers = () => ({ slot: "a", onBack: jest.fn(), onReview: jest.fn() });

const turn: RemoteEvent[] = [
  { kind: "user_text", text: "Cut 0.1.53 with the context menu fix.", at: 1_000_000, sent_by: "desktop" },
  { kind: "assistant_text", block_id: "b1", text: "Bumping the version, then **running** the tests." },
  { kind: "tool_started", tool_use_id: "t1", name: "Read", summary: "package.json" },
  { kind: "tool_finished", tool_use_id: "t1", is_error: false },
  { kind: "tool_started", tool_use_id: "t2", name: "Edit", summary: "Cargo.toml" },
  { kind: "file_edited", tool_use_id: "t2", path: "/p/Cargo.toml", created: false, added: 1, removed: 1 },
  { kind: "tool_started", tool_use_id: "t3", name: "Bash", summary: "npm test" },
  { kind: "tests_ran", tool_use_id: "t3", command: "npm test", passed: 412, failed: 0, skipped: 0 },
  { kind: "turn_done", is_error: false, result: "ok", duration_ms: 3100, context_window: null },
];

const withSession = async (events: RemoteEvent[], over = {}, answers = {}, chatOver = {}) => {
  const { controller } = makeController();
  const session = attachSession(controller, answers);
  const h = handlers();
  const view = await renderWith(<ChatScreen {...h} {...over} />, { chats: [chat(chatOver)], events: { a: events } }, controller);
  // FlashList lays its rows out a tick after it mounts.
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  return { ...view, ...session, h, controller };
};

describe("a chat", () => {
  it("reads as a timeline: your message with its time, Claude's text, a row of chips, and how long it took", async () => {
    await withSession(turn);
    expect(screen.getByText("Release 0.1.53")).toBeTruthy();
    expect(screen.getByText("lantern")).toBeTruthy();
    expect(screen.getByText("Cut 0.1.53 with the context menu fix.")).toBeTruthy();
    expect(screen.getByText(new Date(1_000_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))).toBeTruthy();
    expect(screen.getByText("Bumping the version, then running the tests.")).toBeTruthy();
    expect(screen.getByText("Read 1 file")).toBeTruthy();
    expect(screen.getByText("Edited 1 file +1 −1")).toBeTruthy();
    expect(screen.getByText("412 tests passed")).toBeTruthy();
    expect(screen.getByText("Finished in 3 s")).toBeTruthy();
  });

  it("groups the commands into one chip that opens to each of them", async () => {
    const commands: RemoteEvent[] = [
      { kind: "user_text", text: "Check it.", at: 1_000_000, sent_by: "desktop" },
      { kind: "tool_started", tool_use_id: "c1", name: "Bash", summary: "git status" },
      { kind: "tool_finished", tool_use_id: "c1", is_error: false },
      { kind: "tool_started", tool_use_id: "c2", name: "Bash", summary: "cargo build" },
      { kind: "tool_finished", tool_use_id: "c2", is_error: true },
      { kind: "turn_done", is_error: false, result: "ok", duration_ms: 1000, context_window: null },
    ];
    await withSession(commands);
    expect(screen.queryByText("git status")).toBeNull();
    expect(screen.getByRole("button", { name: "Ran 2 commands" }).props.accessibilityState).toMatchObject({ expanded: false });
    await fireEvent.press(screen.getByText("Ran 2 commands"));
    expect(screen.getByText("git status")).toBeTruthy();
    expect(screen.getByText("cargo build")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ran 2 commands" }).props.accessibilityState).toMatchObject({ expanded: true });
    await fireEvent.press(screen.getByText("Ran 2 commands"));
    expect(screen.queryByText("git status")).toBeNull();
  });

  it("shows what a turn did as a card: the closing message, how long it took, and what it changed and ran", async () => {
    const work: RemoteEvent[] = [
      { kind: "user_text", text: "Ship it.", at: 1_000_000, sent_by: "desktop" },
      { kind: "tool_started", tool_use_id: "w1", name: "Read", summary: "a.ts" },
      { kind: "tool_started", tool_use_id: "w2", name: "Edit", summary: "a.ts" },
      { kind: "file_edited", tool_use_id: "w2", path: "/p/a.ts", created: false, added: 4, removed: 1 },
      { kind: "tool_started", tool_use_id: "w3", name: "Bash", summary: "npm test" },
      { kind: "tests_ran", tool_use_id: "w3", command: "npm test", passed: 9, failed: 0, skipped: 0 },
      { kind: "assistant_text", block_id: "f1", text: "All done. What changed:\n\n- the gateway checks Auto\n- the window checks again" },
      { kind: "turn_done", is_error: false, result: "ok", duration_ms: 192_000, context_window: null },
    ];
    await withSession(work);
    expect(screen.getByLabelText("Summary of the work")).toBeTruthy();
    expect(screen.getByText("Summary")).toBeTruthy();
    expect(screen.getByText("3 min 12 s")).toBeTruthy();
    expect(screen.getByText("the gateway checks Auto")).toBeTruthy();
    expect(screen.getAllByText("Edited 1 file +4 −1").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Copy summary" })).toBeTruthy();
  });

  describe("holding a message, searching, jumping and quick replies", () => {
    const talk: RemoteEvent[] = [
      { kind: "user_text", text: "First question here", at: 1_000_000, sent_by: "desktop" },
      { kind: "assistant_text", block_id: "r1", text: "First answer about the gateway." },
      { kind: "turn_done", is_error: false, result: "ok", duration_ms: 1000, context_window: null },
      { kind: "user_text", text: "Second one about the login", at: 1_100_000, sent_by: "desktop" },
      { kind: "assistant_text", block_id: "r2", text: "I changed the login flow.\n\nShould I push the branch?" },
      { kind: "turn_done", is_error: false, result: "ok", duration_ms: 1000, context_window: null },
    ];
    const hold = (text: string) => fireEvent(screen.getByLabelText(`You: ${text}`), "longPress");

    it("offers copy, quote and select on a message held down, and edit only on your last one", async () => {
      await withSession(talk);
      await hold("First question here");
      await waitFor(() => expect(screen.getByRole("button", { name: "Quote in a reply" })).toBeTruthy());
      expect(screen.queryByRole("button", { name: "Edit and send again" })).toBeNull();
      await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
      await hold("Second one about the login");
      await waitFor(() => expect(screen.getByRole("button", { name: "Edit and send again" })).toBeTruthy());
    });

    it("quotes a message into the box, under what is already typed", async () => {
      await withSession(talk);
      await fireEvent.changeText(screen.getByLabelText("Message"), "About this:");
      await hold("First question here");
      await waitFor(() => screen.getByRole("button", { name: "Quote in a reply" }));
      await fireEvent.press(screen.getByRole("button", { name: "Quote in a reply" }));
      await waitFor(() => expect(screen.getByLabelText("Message").props.value).toBe("About this:\n> First question here\n\n"));
    });

    it("puts your last message back in the box to edit and send again", async () => {
      await withSession(talk);
      await hold("Second one about the login");
      await waitFor(() => screen.getByRole("button", { name: "Edit and send again" }));
      await fireEvent.press(screen.getByRole("button", { name: "Edit and send again" }));
      await waitFor(() => expect(screen.getByLabelText("Message").props.value).toBe("Second one about the login"));
    });

    it("offers Yes and No under a yes-or-no question, sends the one pressed, and takes them away", async () => {
      const { lastOf } = await withSession(talk);
      expect(screen.getByLabelText("Quick replies")).toBeTruthy();
      await fireEvent.press(screen.getByRole("button", { name: "Reply: Yes" }));
      await waitFor(() => expect(lastOf("send")).toMatchObject({ op: "send", slot: "a", text: "Yes" }));
      expect(screen.queryByLabelText("Quick replies")).toBeNull();
    });

    it("offers the exact words Claude asks to be said, as buttons that send them", async () => {
      const asked = 'Both are ready.\n\n1. Say **"admin merge"** and I\'ll merge it.\n2. Say **"upload to TestFlight"** and I\'ll build it.';
      const { lastOf } = await withSession([...talk.slice(0, 4), { kind: "assistant_text", block_id: "r9", text: asked }, { kind: "turn_done", is_error: false, result: "ok", duration_ms: 1, context_window: null }]);
      expect(screen.getByRole("button", { name: "Reply: admin merge" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Reply: upload to TestFlight" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Reply: Yes" })).toBeNull();
      await fireEvent.press(screen.getByRole("button", { name: "Reply: upload to TestFlight" }));
      await waitFor(() => expect(lastOf("send")).toMatchObject({ op: "send", slot: "a", text: "upload to TestFlight" }));
      // One answer is the answer: they are all gone.
      expect(screen.queryByLabelText("Quick replies")).toBeNull();
    });

    it("offers no quick replies for a question that is not yes or no, or while Claude is working", async () => {
      await withSession([...talk.slice(0, 4), { kind: "assistant_text", block_id: "r3", text: "Which file should I start with?" }, { kind: "turn_done", is_error: false, result: "ok", duration_ms: 1, context_window: null }]);
      expect(screen.queryByLabelText("Quick replies")).toBeNull();
    });

    it("searches from the chat bar: the circle beside it makes the bar the search field, which steps through the matches, and Cancel puts it all back", async () => {
      await withSession(talk);
      expect(screen.getByLabelText("Message")).toBeTruthy();
      await fireEvent.press(screen.getByRole("button", { name: "Search this chat" }));
      // The circle is gone and the bar is the search field: the message box is out of the way (and keeps what was in it).
      expect(screen.queryByRole("button", { name: "Search this chat" })).toBeNull();
      expect(screen.queryByLabelText("Message")).toBeNull();
      expect(screen.getByLabelText("Search")).toBeTruthy();
      await fireEvent.changeText(screen.getByLabelText("Search"), "login");
      // It starts on the newest of the two messages that say it.
      await waitFor(() => expect(screen.getByText("2 of 2")).toBeTruthy());
      // The word is marked in the text of each message that says it.
      const washed = () => screen.queryAllByText("login").filter((n) => StyleSheet.flatten(n.props.style)?.backgroundColor === lightColors.hiSoft);
      expect(washed()).toHaveLength(2);
      // The one being looked at has the accent outline, the other a faint one.
      expect(screen.getAllByTestId("match-here")).toHaveLength(1);
      expect(screen.getAllByTestId("match-other")).toHaveLength(1);
      await fireEvent.press(screen.getByRole("button", { name: "Older match" }));
      await waitFor(() => expect(screen.getByText("1 of 2")).toBeTruthy());
      await fireEvent.press(screen.getByRole("button", { name: "Newer match" }));
      await waitFor(() => expect(screen.getByText("2 of 2")).toBeTruthy());
      // Return in the field steps to the next older, like the up arrow.
      await fireEvent(screen.getByLabelText("Search"), "submitEditing");
      await waitFor(() => expect(screen.getByText("1 of 2")).toBeTruthy());
      await fireEvent.press(screen.getByRole("button", { name: "Cancel search" }));
      await waitFor(() => expect(screen.queryByLabelText("Search")).toBeNull());
      expect(screen.getByRole("button", { name: "Search this chat" })).toBeTruthy();
      expect(screen.getByLabelText("Message")).toBeTruthy();
      // Not searching, nothing is marked.
      expect(washed()).toHaveLength(0);
    });

    it("says so when nothing matches, and the arrows are off", async () => {
      await withSession(talk);
      await fireEvent.press(screen.getByRole("button", { name: "Search this chat" }));
      await fireEvent.changeText(screen.getByLabelText("Search"), "zzzzzz");
      await waitFor(() => expect(screen.getByText(/Nothing says that/)).toBeTruthy());
      expect(screen.getByRole("button", { name: "Older match" }).props.accessibilityState).toMatchObject({ disabled: true });
    });

    it("keeps what was typed in the message box while searching", async () => {
      await withSession(talk);
      await fireEvent.changeText(screen.getByLabelText("Message"), "half a thought");
      await fireEvent.press(screen.getByRole("button", { name: "Search this chat" }));
      await fireEvent.press(screen.getByRole("button", { name: "Cancel search" }));
      await waitFor(() => expect(screen.getByLabelText("Message").props.value).toBe("half a thought"));
    });

    it("can still be searched while it sleeps: the circle is beside the Wake button, and the field replaces it while searching", async () => {
      await withSession(talk, {}, {}, { status: "asleep" });
      expect(screen.getByRole("button", { name: "Wake this chat" })).toBeTruthy();
      await fireEvent.press(screen.getByRole("button", { name: "Search this chat" }));
      expect(screen.queryByRole("button", { name: "Wake this chat" })).toBeNull();
      await fireEvent.changeText(screen.getByLabelText("Search"), "login");
      await waitFor(() => expect(screen.getByText("2 of 2")).toBeTruthy());
      await fireEvent.press(screen.getByRole("button", { name: "Cancel search" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Wake this chat" })).toBeTruthy());
    });

    it("offers a way back to the latest when scrolled away, with how many came since", async () => {
      const { controller } = await withSession(talk);
      const list = screen.getByTestId("chat-list");
      expect(screen.queryByRole("button", { name: /Jump to the latest/ })).toBeNull();
      await fireEvent.scroll(list, { nativeEvent: { contentOffset: { y: 0 }, contentSize: { height: 3000 }, layoutMeasurement: { height: 600 } } });
      await waitFor(() => expect(screen.getByRole("button", { name: "Jump to the latest" })).toBeTruthy());
      await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "event", slot: "a", seq: 99, event: { kind: "user_text", text: "A new one", at: 2_000_000, sent_by: "desktop" } } }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Jump to the latest, 1 new" })).toBeTruthy());
      await fireEvent.scroll(list, { nativeEvent: { contentOffset: { y: 2380 }, contentSize: { height: 3000 }, layoutMeasurement: { height: 600 } } });
      await waitFor(() => expect(screen.queryByRole("button", { name: /Jump to the latest/ })).toBeNull());
    });
  });

  it("follows the chat while it is open and lets go when it closes", async () => {
    const { asked, unmount } = await withSession(turn);
    expect(asked).toContainEqual({ op: "subscribe", slot: "a", after: 9, epoch: 1 });
    await unmount();
    expect(asked).toContainEqual({ op: "unsubscribe", slot: "a" });
  });

  it("continues a list as it is typed: Return after 1. starts 2., and Return on an empty item ends the list", async () => {
    await withSession(turn);
    const box = () => screen.getByLabelText("Message");
    await fireEvent.changeText(box(), "1. first");
    await fireEvent.changeText(box(), "1. first\n");
    expect(box().props.value).toBe("1. first\n2. ");
    await fireEvent.changeText(box(), "1. first\n2. second");
    await fireEvent.changeText(box(), "1. first\n2. second\n");
    expect(box().props.value).toBe("1. first\n2. second\n3. ");
    await fireEvent.changeText(box(), "1. first\n2. second\n3. \n");
    expect(box().props.value).toBe("1. first\n2. second\n\n");
  });

  it("shows what you wrote the way Claude's text is shown: a list as a list", async () => {
    const { controller } = makeController();
    attachSession(controller, {});
    await renderWith(<ChatScreen {...handlers()} />, { chats: [chat()], events: { a: [{ kind: "user_text", text: "Do these:\n\n1. the tests\n2. the build", at: 1_000_000, sent_by: "desktop" }] } }, controller);
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    expect(screen.getByText("1.")).toBeTruthy();
    expect(screen.getByText("the build")).toBeTruthy();
  });

  it("goes back", async () => {
    const { h } = await withSession(turn);
    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(h.onBack).toHaveBeenCalled();
  });

  it("sends what is typed, clears the box, and shows the message at once", async () => {
    const { lastOf } = await withSession(turn);
    await fireEvent.changeText(screen.getByLabelText("Message"), "  ship it  ");
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(lastOf("send")).toEqual({ op: "send", slot: "a", text: "ship it", client_id: "m-test" }));
    expect(screen.getByLabelText("Message").props.value).toBe("");
    expect(screen.getByText("ship it")).toBeTruthy();
  });

  it("doesn't send an empty message", async () => {
    const { lastOf } = await withSession(turn);
    expect(screen.getByRole("button", { name: "Send" }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(screen.getByLabelText("Message"), "   ");
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    expect(lastOf("send")).toBeUndefined();
  });

  it("says why a message didn't go", async () => {
    await withSession(turn, {}, { send: new Error("That chat isn't open on your Mac.") });
    await fireEvent.changeText(screen.getByLabelText("Message"), "hi");
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("Not sent. That chat isn't open on your Mac.")).toBeTruthy());
  });

  it("stops Claude while it works, and only then offers to", async () => {
    const quiet = await withSession(turn);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    await quiet.unmount();
    const { lastOf } = await withSession(turn, {}, {}, { status: "working" });
    expect(screen.getByText("Claude is working…")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(lastOf("interrupt")).toEqual({ op: "interrupt", slot: "a" }));
  });

  it("wakes a sleeping chat before it can be messaged", async () => {
    const { lastOf } = await withSession(turn, {}, {}, { status: "asleep" });
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.getByText(/asleep to save memory/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Wake this chat" }));
    await waitFor(() => expect(lastOf("wake")).toEqual({ op: "wake", slot: "a" }));
  });

  it("keeps saying Waking… after the Mac accepts the wake, until the chat is awake, and then offers the message box", async () => {
    const { controller } = await withSession(turn, {}, {}, { status: "asleep" });
    await fireEvent.press(screen.getByRole("button", { name: "Wake this chat" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(screen.getByRole("button", { name: "Waking…" })).toBeTruthy();
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: [chat({ status: "idle" })] } }));
    expect(screen.queryByRole("button", { name: "Waking…" })).toBeNull();
    expect(screen.getByLabelText("Message")).toBeTruthy();
  });

  it("brings the button back when the wake is refused", async () => {
    await withSession(turn, {}, { wake: new Error("That chat isn't asleep.") }, { status: "asleep" });
    await fireEvent.press(screen.getByRole("button", { name: "Wake this chat" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Wake this chat" })).toBeTruthy());
  });

  it("won't take a message when it isn't connected (the app's pill says why)", async () => {
    const { controller } = makeController();
    await renderWith(<ChatScreen {...handlers()} />, { chats: [chat()], events: { a: turn }, connection: { kind: "offline", reason: "x", retryInMs: 1000 } }, controller);
    expect(screen.queryByText(/Not connected to your Mac/)).toBeNull();
    expect(screen.getByLabelText("Message").props.editable).toBe(false);
  });

  it("says how much a catch-up covered, for a moment", async () => {
    // Set up with real timers (the screen settles on one), then take the clock over for the banner's four seconds.
    const { controller } = await withSession(turn);
    jest.useFakeTimers();
    try {
      await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "reset", slot: "a", seq: 24, page: 0, done: true, hidden: 0, events: turn } }));
      expect(screen.getByText("Caught up on 15 events from while you were away")).toBeTruthy();
      await act(async () => void jest.advanceTimersByTime(4500));
      expect(screen.queryByText(/Caught up on/)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("brings earlier turns when there are some", async () => {
    const { controller, lastOf } = await withSession(turn, {}, { earlier: { events: [{ kind: "user_text", text: "the very first thing", at: 1, sent_by: null }], hidden: 0 } });
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "reset", slot: "a", seq: 9, page: 0, done: true, hidden: 3, events: turn } }));
    await fireEvent.press(screen.getByRole("button", { name: "Show earlier messages (3 turns)" }));
    await waitFor(() => expect(lastOf("earlier")).toEqual({ op: "earlier", slot: "a", hidden: 3 }));
    await waitFor(() => expect(screen.getByText("the very first thing")).toBeTruthy());
  });
});

describe("while more of a chat is coming", () => {
  /** A session whose answers to `pending` ops wait until released. */
  const slow = async (ops: string[], events: RemoteEvent[]) => {
    const { controller } = makeController();
    const releases: Record<string, (v: unknown) => void> = {};
    controller.sync.onSession({
      welcome: { type: "welcome", protocol: 1, app_version: "t", mac_name: "Mac", epoch: 1 },
      ask: (r: { op: string }) => (ops.includes(r.op) ? new Promise((res) => (releases[r.op] = res)) : Promise.resolve(null)),
    } as never);
    await renderWith(<ChatScreen {...handlers()} />, { chats: [chat()] }, controller);
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "reset", slot: "a", seq: 9, page: 0, done: true, hidden: 3, events } }));
    return { controller, releases };
  };

  it("shows the shape of the earlier messages while they come, then they are there", async () => {
    const { releases } = await slow(["earlier"], turn);
    await fireEvent.press(screen.getByRole("button", { name: "Show earlier messages (3 turns)" }));
    expect(screen.getByLabelText("Loading earlier messages")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show earlier messages/ })).toBeNull();
    await act(async () => releases.earlier({ events: [{ kind: "user_text", text: "the very first thing", at: 1, sent_by: "desktop" }], hidden: 0 }));
    await waitFor(() => expect(screen.getByText("the very first thing")).toBeTruthy());
    expect(screen.queryByLabelText("Loading earlier messages")).toBeNull();
  });

  it("goes back to the button when the earlier messages couldn't be loaded", async () => {
    const { controller } = await slow([], turn);
    controller.sync.onSession({ welcome: { type: "welcome", protocol: 1, app_version: "t", mac_name: "Mac", epoch: 1 }, ask: () => Promise.reject(new Error("The Mac is busy.")) } as never);
    await fireEvent.press(screen.getByRole("button", { name: "Show earlier messages (3 turns)" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show earlier messages (3 turns)" })).toBeTruthy());
    expect(screen.getByText("The Mac is busy.")).toBeTruthy();
  });

  it("shows the shape of a diff while it comes, in the sheet", async () => {
    const { releases } = await slow(["diff"], turn);
    await waitFor(() => expect(screen.getByText("Edited 1 file +1 −1")).toBeTruthy(), { timeout: 3000 });
    await fireEvent.press(screen.getByText("Edited 1 file +1 −1"));
    await waitFor(() => expect(screen.getByLabelText("Loading the changes")).toBeTruthy(), { timeout: 3000 });
    await act(async () => releases.diff("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n"));
    await waitFor(() => expect(screen.getByText("+new")).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByLabelText("Loading the changes")).toBeNull();
  });
});

describe("a chat that has nothing to show yet", () => {
  const open = async (answers = {}) => {
    const { controller } = makeController();
    const session = attachSession(controller, answers);
    const view = await renderWith(<ChatScreen {...handlers()} />, { chats: [chat()] }, controller);
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    return { ...view, ...session, controller };
  };

  it("shows the shape of a chat, breathing, until the Mac sends the chat: no spinner, no bare words", async () => {
    await open();
    expect(screen.getByLabelText("Loading this chat")).toBeTruthy();
    expect(screen.queryByText("Nothing in this chat yet.")).toBeNull();
    expect(screen.queryByText("Loading this chat…")).toBeNull();
  });

  it("says nothing is there only once the Mac has sent a chat with nothing in it", async () => {
    const { controller } = await open();
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "reset", slot: "a", seq: 0, page: 0, done: true, hidden: 0, events: [] } }));
    expect(screen.getByText("Nothing in this chat yet.")).toBeTruthy();
    expect(screen.queryByLabelText("Loading this chat")).toBeNull();
  });

  it("says it is loading while the pages of a long chat are still coming", async () => {
    const { controller } = await open();
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "reset", slot: "a", seq: 0, page: 0, done: false, hidden: 0, events: [] } }));
    expect(screen.getByLabelText("Loading this chat")).toBeTruthy();
  });

  it("says why it couldn't be loaded, and asks again when told to", async () => {
    const { asked } = await open({ subscribe: new Error("That chat isn't open on your Mac any more.") });
    await waitFor(() => expect(screen.getByText("Couldn't load this chat")).toBeTruthy());
    expect(screen.getByText("That chat isn't open on your Mac any more.")).toBeTruthy();
    expect(screen.queryByLabelText("Loading this chat")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(asked.filter((r) => r.op === "subscribe")).toHaveLength(2));
  });

  it("goes from the error to the chat when a retry works", async () => {
    const { controller } = await open({ subscribe: new Error("Slow Mac.") });
    await waitFor(() => expect(screen.getByText("Couldn't load this chat")).toBeTruthy());
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "reset", slot: "a", seq: 2, page: 0, done: true, hidden: 0, events: [{ kind: "user_text", text: "Hello there", at: 1, sent_by: "desktop" }] } }));
    expect(screen.queryByText("Couldn't load this chat")).toBeNull();
    expect(screen.getByText("Hello there")).toBeTruthy();
  });

  it("says it is waiting for the Mac, not that it failed, while the phone is not connected", async () => {
    const { controller } = makeController();
    await renderWith(<ChatScreen {...handlers()} />, { chats: [chat()], connection: { kind: "offline", reason: "No route to the Mac", retryInMs: 2000 } }, controller);
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    expect(screen.queryByText("Couldn't load this chat")).toBeNull();
    expect(screen.getByLabelText("Waiting for your Mac")).toBeTruthy();
  });

  it("tells an asleep chat's emptiness from a loading one, and points at waking it", async () => {
    const { controller } = makeController();
    attachSession(controller);
    await renderWith(<ChatScreen {...handlers()} />, { chats: [chat({ status: "asleep" })] }, controller);
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "reset", slot: "a", seq: 0, page: 0, done: true, hidden: 0, events: [] } }));
    expect(screen.getByText("Nothing to show yet. Wake this chat to pick up where it left off.")).toBeTruthy();
  });
});

describe("what waits on you, in a chat", () => {
  const asked: RemoteEvent = { kind: "permission_requested", request_id: "p1", tool_name: "Bash", input: { command: "git push", description: "Push the branch" } };

  const swipeAction = (node = screen.getByLabelText("Swipe to allow")) => fireEvent(node, "accessibilityAction", { nativeEvent: { actionName: "activate" } });

  it("shows something to allow as a card with a swipe to allow it right there, and Expand for the whole screen", async () => {
    const { h } = await withSession([...turn.slice(0, 2), asked]);
    expect(screen.getByText("Push the branch")).toBeTruthy();
    expect(screen.getByLabelText("Swipe to allow")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Expand" }));
    expect(h.onReview).toHaveBeenCalledWith("p1");
  });

  it("allows it from the chat with the swipe, and the bar stays, closed in to the check, until the Mac says so", async () => {
    const { lastOf, h } = await withSession([...turn.slice(0, 2), asked]);
    await act(async () => swipeAction());
    await waitFor(() => expect(lastOf("answer")).toEqual({ op: "answer", slot: "a", request_id: "p1", allow: true, message: null, answers: null }));
    expect(screen.getByLabelText("Allowed")).toBeTruthy();
    expect(screen.queryByLabelText("Swipe to allow")).toBeNull();
    // It does not leave the chat.
    expect(h.onReview).not.toHaveBeenCalled();
  });

  it("allows once, however often it is activated", async () => {
    const { asked: sent } = await withSession([...turn.slice(0, 2), asked]);
    const bar = screen.getByLabelText("Swipe to allow");
    await swipeAction(bar);
    await swipeAction(bar);
    await waitFor(() => expect(sent.filter((r) => r.op === "answer")).toHaveLength(1));
  });

  it("says why when it couldn't be answered, and brings a fresh bar back to try again", async () => {
    const { lastOf } = await withSession([...turn.slice(0, 2), asked], {}, { answer: new Error("That was answered already, or Claude stopped asking.") });
    await act(async () => swipeAction());
    await waitFor(() => expect(screen.getByText("That was answered already, or Claude stopped asking.")).toBeTruthy());
    expect(screen.getByLabelText("Swipe to allow")).toBeTruthy();
    expect(screen.queryByLabelText("Allowed")).toBeNull();
    expect(lastOf("answer")).toMatchObject({ allow: true });
  });

  it("says it approves, for an approval", async () => {
    await withSession([{ kind: "permission_requested", request_id: "ap", tool_name: "mcp__lantern__request_approval", input: { action: "merge the PR", why: "It is green." } }]);
    expect(screen.getByLabelText("Swipe to approve")).toBeTruthy();
  });

  it("has no swipe for a question: that is answered on the full screen, from Review", async () => {
    const { h } = await withSession([{ kind: "permission_requested", request_id: "q1", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which channel?", header: "", options: [{ label: "Stable", description: "" }], multiSelect: false }] } }]);
    expect(screen.queryByLabelText("Swipe to allow")).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Review" }));
    expect(h.onReview).toHaveBeenCalledWith("q1");
  });

  it("says who answered it afterwards, on a small card: the Mac, this phone, or another", async () => {
    for (const [by, words] of [["desktop", "Allowed on your Mac"], ["phone-other", "Allowed on another phone"]] as const) {
      const { unmount } = await withSession([...turn.slice(0, 2), asked, { kind: "permission_resolved", request_id: "p1", allow: true, by }]);
      expect(screen.getByText("Push the branch")).toBeTruthy();
      expect(screen.getByText(words)).toBeTruthy();
      // Decided: nothing left to swipe or expand.
      expect(screen.queryByLabelText("Swipe to allow")).toBeNull();
      expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
      await unmount();
    }
  });

  it("closes the open card in to the small one once it is decided, keeping the open card while it does", async () => {
    const { controller } = await withSession([asked]);
    const withLayout = (text: string, height: number) => {
      let n = screen.getByText(text).parent;
      while (n && !n.props.onLayout) n = n.parent;
      return fireEvent(n!, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 300, height } } });
    };
    // Laid out as it was open: its height is what the card closes in from.
    await withLayout("Push the branch", 170);
    motion.instant = false;
    try {
      await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "event", slot: "a", seq: 50, event: { kind: "permission_resolved", request_id: "p1", allow: true, by: "desktop" } } }));
      // Mid-way: the open card is still there, and the small one is arriving beside it.
      expect(screen.getByLabelText("Swipe to allow")).toBeTruthy();
      expect(screen.getByText("Allowed on your Mac")).toBeTruthy();
      await withLayout("Allowed on your Mac", 52);
      // And then only the small card is left.
      await waitFor(() => expect(screen.queryByLabelText("Swipe to allow")).toBeNull(), { timeout: 3000 });
      expect(screen.getByText("Allowed on your Mac")).toBeTruthy();
    } finally {
      motion.instant = true;
    }
  });

  it("settles even if the small card is never laid out", async () => {
    const { controller } = await withSession([asked]);
    let n = screen.getByText("Push the branch").parent;
    while (n && !n.props.onLayout) n = n.parent;
    await fireEvent(n!, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 170 } } });
    motion.instant = false;
    try {
      await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "event", slot: "a", seq: 50, event: { kind: "permission_withdrawn", request_id: "p1" } } }));
      await waitFor(() => expect(screen.queryByLabelText("Swipe to allow")).toBeNull(), { timeout: 3000 });
      expect(screen.getByText("Claude stopped asking")).toBeTruthy();
    } finally {
      motion.instant = true;
    }
  });

  it("shows a denial as a small card too", async () => {
    await withSession([asked, { kind: "permission_resolved", request_id: "p1", allow: false, by: "desktop" }]);
    expect(screen.getByText("Push the branch")).toBeTruthy();
    expect(screen.getByText("Denied on your Mac")).toBeTruthy();
  });

  it("shows what this phone answered a question with, as the answer, not as JSON or only 'answered'", async () => {
    const item = { kind: "prompt" as const, id: "q1", toolName: "AskUserQuestion", input: { questions: [{ question: "Which channel?", header: "", options: [{ label: "Stable", description: "" }], multiSelect: false }] }, state: "allowed" as const, by: "phone-x", answer: "Stable" };
    await render(<PromptRow item={item} me="phone-x" onReview={() => {}} />);
    expect(screen.getByText("Which channel")).toBeTruthy();
    expect(screen.getByText("Stable")).toBeTruthy();
    expect(screen.queryByText(/Answered/)).toBeNull();
    expect(screen.queryByText(/[{}"]/)).toBeNull();
  });

  it("keeps a long answer inside the chat: the chip can't be wider than the screen, and its words wrap beside the check", async () => {
    const long = "Use the staged rollout with a ten percent first wave, watch the crash rate for a day, then widen it to everyone if it holds, and keep the old build on hand";
    const item = { kind: "prompt" as const, id: "q1", toolName: "AskUserQuestion", input: { questions: [{ question: "How should we roll it out?", header: "", options: [{ label: long, description: "" }], multiSelect: false }] }, state: "allowed" as const, by: "phone-x", answer: long };
    await render(<PromptRow item={item} me="phone-x" onReview={() => {}} />);
    const chip = screen.getByTestId("answer-chip");
    expect(StyleSheet.flatten(chip.props.style).maxWidth).toBe("100%");
    expect(StyleSheet.flatten(chip.parent!.props.style).maxWidth).toBe("100%");
    expect(StyleSheet.flatten(screen.getByText(long).props.style).flexShrink).toBe(1);
  });

  it("says Claude stopped asking when it withdraws", async () => {
    await withSession([asked, { kind: "permission_withdrawn", request_id: "p1" }]);
    expect(screen.getByText("Push the branch")).toBeTruthy();
    expect(screen.getByText("Claude stopped asking")).toBeTruthy();
  });

  it("says what only the Mac can answer, instead of hiding it", async () => {
    await withSession([{ kind: "needs_desktop", what: "Builder wants to merge its branch." }]);
    expect(screen.getByText("Answer this on your Mac")).toBeTruthy();
    expect(screen.getByText("Builder wants to merge its branch.")).toBeTruthy();
  });
});

describe("Step by step's pages", () => {
  const page: RemoteEvent[] = [{ kind: "assistant_text", block_id: "pg", text: "# Step 2 of 4 — Bump the version\n\npackage.json and Cargo.toml go from 0.1.52 to 0.1.53." }];

  it("shows a page as a card, with the Mac's own buttons while it is the live one", async () => {
    const { lastOf } = await withSession(page);
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    expect(screen.getByText("Bump the version")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Commit, next" }));
    await waitFor(() => expect(lastOf("send")).toMatchObject({ op: "send", text: "Next. Commit this step first." }));
    // Answered: its buttons are gone.
    expect(screen.queryByRole("button", { name: "Commit, next" })).toBeNull();
  });

  it("sends Don't commit as the Mac does", async () => {
    const { lastOf } = await withSession(page);
    await fireEvent.press(screen.getByRole("button", { name: "Don't commit" }));
    await waitFor(() => expect(lastOf("send")).toMatchObject({ text: "Next. Don't commit this step." }));
  });

  it("takes the buttons off a page that has been answered, in the history", async () => {
    await withSession([...page, { kind: "user_text", text: "Next", at: 5, sent_by: "desktop" }, { kind: "assistant_text", block_id: "pg2", text: "# Step 3 of 4 — Open the PR" }]);
    expect(screen.getAllByRole("button", { name: "Commit, next" })).toHaveLength(1);
  });

  it("has no buttons on a Done page", async () => {
    await withSession([{ kind: "assistant_text", block_id: "d", text: "# Done — built it" }]);
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });
});

describe("what a turn changed", () => {
  it("opens the diff of an edited file from its chip, with added and removed lines told apart", async () => {
    const { lastOf } = await withSession(turn, {}, { diff: "--- /p/Cargo.toml\n+++ /p/Cargo.toml\n@@ -3 +3 @@\n-version = \"0.1.52\"\n+version = \"0.1.53\"\n" });
    await fireEvent.press(screen.getByText("Edited 1 file +1 −1"));
    await waitFor(() => expect(screen.getByText("+version = \"0.1.53\"")).toBeTruthy());
    expect(lastOf("diff")).toEqual({ op: "diff", slot: "a", path: "/p/Cargo.toml" });
    expect(screen.getByText("What changed")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("What changed")).toBeNull());
  });

  it("says why a diff couldn't be read", async () => {
    await withSession(turn, {}, { diff: new Error("That file wasn't changed in this chat.") });
    await fireEvent.press(screen.getByText("Edited 1 file +1 −1"));
    await waitFor(() => expect(screen.getByText("That file wasn't changed in this chat.")).toBeTruthy());
  });
});

it("is a connected chat: the seeded connection is the one the screen reads", async () => {
  const { controller } = makeController();
  await renderWith(<ChatScreen {...handlers()} />, { chats: [chat()] }, controller);
  expect(controller.getConnection()).toEqual(connected);
});

describe("a chat on iOS 26, where its header and message box are glass over the list", () => {
  beforeEach(() => (isLiquidGlassAvailable as jest.Mock).mockReturnValue(true));
  afterEach(() => (isLiquidGlassAvailable as jest.Mock).mockReturnValue(false));

  it("still shows the rows, goes back, and sends what is typed", async () => {
    const { h, lastOf } = await withSession(turn);
    expect(screen.getByText("Release 0.1.53")).toBeTruthy();
    expect(screen.getByText("Bumping the version, then running the tests.")).toBeTruthy();
    // The list's room above and below is what the glass covers, taken from where those are laid out.
    const list = screen.getByTestId("chat-list");
    expect(list.props.contentContainerStyle).toMatchObject({ paddingTop: 0, paddingBottom: 0 });
    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(h.onBack).toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText("Message"), "ship it");
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(lastOf("send")).toMatchObject({ op: "send", text: "ship it" }));
  });

  it("has a message box with a surface of its own when the chat wakes, and a ground under the sleeping notice", async () => {
    const { controller } = await withSession(turn, {}, {}, { status: "asleep" });
    // Over a list that runs under it, the notice and its button would otherwise sit on bare words.
    expect(StyleSheet.flatten(screen.getByText(/asleep to save memory/).parent!.props.style).backgroundColor).toBe(lightColors.paper);
    await fireEvent.press(screen.getByRole("button", { name: "Wake this chat" }));
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: [chat({ status: "idle" })] } }));
    // The surface is the message box's nearest ancestor with its fill: enough of the card to type on, not the faint tint of the rest.
    let box = screen.getByLabelText("Message").parent;
    while (box && StyleSheet.flatten(box.props.style)?.backgroundColor !== `${lightColors.card}${COMPOSER_FILL}`) box = box.parent;
    expect(box).toBeTruthy();
    expect(StyleSheet.flatten(box!.props.style).borderColor).toBe(lightColors.rule);
  });
});

describe("a chat that is open", () => {
  it("is seen as far as it has gone, and again as it moves on, so Home doesn't call it unread", async () => {
    const { controller } = await withSession(turn, {}, {}, { active_at: 5_000 });
    const seen = await renderHook(() => useSeen());
    await waitFor(() => expect(seen.result.current).toEqual({ a: 5_000 }));
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: [chat({ active_at: 9_000 })] } }));
    await waitFor(() => expect(seen.result.current).toEqual({ a: 9_000 }));
  });

  it("is seen as far as it had gone when it was left", async () => {
    const { unmount, controller } = await withSession(turn, {}, {}, { active_at: 5_000 });
    const seen = await renderHook(() => useSeen());
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: [chat({ active_at: 7_000 })] } }));
    await unmount();
    await waitFor(() => expect(seen.result.current).toEqual({ a: 7_000 }));
  });
});
