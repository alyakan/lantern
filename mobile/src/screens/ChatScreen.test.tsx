import "@shopify/flash-list/jestSetup";
import { Keyboard, StyleSheet, TextInput, type ViewProps } from "react-native";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import type { RemoteEvent } from "../protocol/generated/RemoteEvent";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { attachSession } from "../test/fakeSession";
import { chat, connected, connectedWith, connectedWithControls, makeController, renderWith } from "../test/render";
import { ChatScreen } from "./ChatScreen";
import { PromptRow } from "./ChatParts";
import { renderHook } from "@testing-library/react-native";
import { resetSeen, useSeen } from "../seen";
import { COMPOSER_FILL } from "../ui/Glass";
import { control } from "../ui/theme";
import { barRoom, KEYBOARD_GAP } from "../ui/keyboard";
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
    // How long it took ends the row of chips, rather than a line of its own.
    expect(screen.getByLabelText("Finished in 3 s")).toBeTruthy();
    expect(screen.queryByText("Finished in 3 s")).toBeNull();
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

    // The search is the first of the tools: the circle opens them, and Search turns their row into the field.
    const openSearch = async () => {
      await fireEvent.press(screen.getByRole("button", { name: "Tools" }));
      await fireEvent.press(screen.getByRole("button", { name: "Search" }));
    };

    it("searches from the chat bar: the circle beside it makes the bar the search field, which steps through the matches, and Cancel puts it all back", async () => {
      await withSession(talk);
      expect(screen.getByLabelText("Message")).toBeTruthy();
      await openSearch();
      // The circle is gone and the bar is the search field: the message box is out of the way (and keeps what was in it).
      expect(screen.queryByRole("button", { name: "Tools" })).toBeNull();
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
      expect(screen.getByRole("button", { name: "Tools" })).toBeTruthy();
      expect(screen.getByLabelText("Message")).toBeTruthy();
      // Not searching, nothing is marked.
      expect(washed()).toHaveLength(0);
    });

    it("says so when nothing matches, and the arrows are off", async () => {
      await withSession(talk);
      await openSearch();
      await fireEvent.changeText(screen.getByLabelText("Search"), "zzzzzz");
      await waitFor(() => expect(screen.getByText(/Nothing says that/)).toBeTruthy());
      expect(screen.getByRole("button", { name: "Older match" }).props.accessibilityState).toMatchObject({ disabled: true });
    });

    it("keeps what was typed in the message box while searching", async () => {
      await withSession(talk);
      await fireEvent.changeText(screen.getByLabelText("Message"), "half a thought");
      await openSearch();
      await fireEvent.press(screen.getByRole("button", { name: "Cancel search" }));
      await waitFor(() => expect(screen.getByLabelText("Message").props.value).toBe("half a thought"));
    });

    it("gives the circle's room to the bar while words are being typed in it, and takes it back when they stop", async () => {
      await withSession(talk);
      expect(screen.getByRole("button", { name: "Tools" })).toBeTruthy();
      await fireEvent(screen.getByLabelText("Message"), "focus");
      expect(screen.queryByRole("button", { name: "Tools" })).toBeNull();
      await fireEvent(screen.getByLabelText("Message"), "blur");
      expect(screen.getByRole("button", { name: "Tools" })).toBeTruthy();
    });

    it("makes the circle as tall as the bar is at rest, and not taller when the bar grows with a long message", async () => {
      await withSession(talk);
      const lay = (height: number) => fireEvent(screen.getByTestId("chat-bar"), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 300, height } } });
      const circle = () => StyleSheet.flatten(screen.getByTestId("search-circle").props.style).height;
      await lay(52);
      expect(circle()).toBe(52);
      await lay(96);
      expect(circle()).toBe(52);
      // Text size changing it for the better: the least it has been.
      await lay(50);
      expect(circle()).toBe(50);
    });

    // Whether this node, or anything above it, takes no touches (by prop or by style).
    const blocked = (node: { props?: ViewProps; parent?: unknown } | null | undefined): boolean => {
      for (let n = node as { props?: ViewProps; parent?: unknown } | null | undefined; n; n = n.parent as typeof n) {
        if (n.props?.pointerEvents === "none" || StyleSheet.flatten(n.props?.style)?.pointerEvents === "none") return true;
      }
      return false;
    };

    it("leaves the message box exactly as touchable after a search as before it, however often it is shown and dismissed", async () => {
      await withSession(talk);
      expect(blocked(screen.getByLabelText("Message"))).toBe(false);
      for (let i = 0; i < 3; i++) {
        await openSearch();
        await fireEvent.changeText(screen.getByLabelText("Search"), "login");
        await fireEvent.press(screen.getByRole("button", { name: "Cancel search" }));
        await waitFor(() => expect(screen.queryByLabelText("Search")).toBeNull());
        // The box is there, reachable, and nothing over or around it takes its touches.
        expect(blocked(screen.getByLabelText("Message"))).toBe(false);
        expect(screen.getByLabelText("Message").props.editable).not.toBe(false);
        expect(screen.getByRole("button", { name: "Tools" })).toBeTruthy();
      }
      // And it takes what is typed in it.
      await fireEvent.changeText(screen.getByLabelText("Message"), "still works");
      expect(screen.getByLabelText("Message").props.value).toBe("still works");
    });

    // The phone's keyboard, for a test to bring up: every handler the screen gave Keyboard for each event.
    const keyboardEvents = () => {
      const handlers = new Map<string, ((e?: unknown) => void)[]>();
      const spy = jest.spyOn(Keyboard, "addListener").mockImplementation(((name: string, handler: (e?: unknown) => void) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        return { remove: () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler)) };
      }) as never);
      return { emit: (name: string) => act(async () => (handlers.get(name) ?? []).forEach((h) => h())), restore: () => spy.mockRestore() };
    };

    // The opacity the nearest drawn layer above this node says (the message box's row fades while a search is on).
    const opacityOf = (node: { props?: ViewProps; parent?: unknown } | null | undefined): number | undefined => {
      for (let n = node as { props?: ViewProps; parent?: unknown } | null | undefined; n; n = n.parent as typeof n) {
        const o = StyleSheet.flatten(n.props?.style)?.opacity;
        if (typeof o === "number") return o;
      }
      return undefined;
    };

    it("never fades the message box while words are typed in it: the bar only gives the circle's room away, it doesn't go blank", async () => {
      await withSession(talk);
      expect(opacityOf(screen.getByLabelText("Message"))).toBe(1);
      await fireEvent(screen.getByLabelText("Message"), "focus");
      expect(screen.queryByRole("button", { name: "Tools" })).toBeNull();
      expect(opacityOf(screen.getByLabelText("Message"))).toBe(1);
      await fireEvent.changeText(screen.getByLabelText("Message"), "typing a message");
      expect(opacityOf(screen.getByLabelText("Message"))).toBe(1);
      await fireEvent(screen.getByLabelText("Message"), "blur");
      expect(opacityOf(screen.getByLabelText("Message"))).toBe(1);
    });

    it("fades the message box out only while the search is on, and brings it back", async () => {
      const kb = keyboardEvents();
      await withSession(talk);
      await openSearch();
      await kb.emit("keyboardWillShow");
      kb.restore();
      expect(opacityOf(screen.getByLabelText("Message", { includeHiddenElements: true }))).toBe(0);
      await fireEvent.press(screen.getByRole("button", { name: "Cancel search" }));
      await waitFor(() => expect(opacityOf(screen.getByLabelText("Message"))).toBe(1));
    });

    // The first height (a number) a node or anything below it says.
    const heightWithin = (node: { props?: ViewProps; children?: unknown[] } | null | undefined): number | undefined => {
      if (!node || typeof node !== "object") return undefined;
      const h = StyleSheet.flatten(node.props?.style)?.height;
      if (typeof h === "number") return h;
      for (const c of node.children ?? []) {
        const found = heightWithin(c as { props?: ViewProps; children?: unknown[] });
        if (found !== undefined) return found;
      }
      return undefined;
    };

    it("grows the circle into the field while the bar shrinks away beside it (it doesn't slide over the bar), and back", async () => {
      await withSession(talk);
      await fireEvent(screen.getByTestId("chat-bar-row"), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 48 } } });
      const circle = () => StyleSheet.flatten(screen.getByTestId("search-circle").props.style);
      // (The bar is hidden from screen readers while searching, which is why it is asked for as hidden too.)
      const bar = () => StyleSheet.flatten(screen.getByTestId("chat-bar", { includeHiddenElements: true }).props.style);
      // At rest: a circle (as wide as it is tall), and the bar leaves room for it.
      expect(circle().width).toBe(circle().height);
      const room = bar().marginRight;
      expect(room).toBeGreaterThan(0);
      const kb = keyboardEvents();
      await openSearch();
      await kb.emit("keyboardWillShow");
      kb.restore();
      // Searching: the circle has grown to the whole row, and the bar has given all of it up (it is as wide as nothing), and faded.
      expect(circle().width).toBe(300);
      expect(bar().marginRight).toBeGreaterThanOrEqual(300);
      expect(bar().opacity).toBe(0);
      await fireEvent.press(screen.getByRole("button", { name: "Cancel search" }));
      await waitFor(() => expect(circle().width).toBe(circle().height));
      // And back: the bar has its width again, beside the circle.
      expect(bar().marginRight).toBe(room);
      expect(bar().opacity).toBe(1);
    });

    it("grows the tools' row at the press (it has no keyboard to wait for), and stays grown as Search turns it into the field", async () => {
      await withSession(talk);
      await fireEvent(screen.getByTestId("chat-bar-row"), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 48 } } });
      const circle = () => StyleSheet.flatten(screen.getByTestId("search-circle").props.style);
      await fireEvent.press(screen.getByRole("button", { name: "Tools" }));
      expect(circle().width).toBe(300);
      await fireEvent.press(screen.getByRole("button", { name: "Search" }));
      expect(screen.getByLabelText("Search")).toBeTruthy();
      expect(circle().width).toBe(300);
      await fireEvent.press(screen.getByRole("button", { name: "Cancel search" }));
      await waitFor(() => expect(circle().width).toBe(circle().height));
    });

    it("grows a plain search circle's field when the keyboard starts coming, not before, so the bar rides the keyboard up (or anyway, if it doesn't come)", async () => {
      const kb = keyboardEvents();
      // (The sleeping chat's bar has the search circle alone.)
      await withSession(talk, {}, {}, { status: "asleep" });
      await fireEvent(screen.getByTestId("chat-bar-row"), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 48 } } });
      const circle = () => StyleSheet.flatten(screen.getByTestId("search-circle").props.style);
      await fireEvent.press(screen.getByRole("button", { name: "Search this chat" }));
      // Pressed: the field is asking for the keyboard, and hasn't grown yet.
      expect(screen.getByLabelText("Search")).toBeTruthy();
      expect(circle().width).toBe(circle().height);
      await kb.emit("keyboardWillShow");
      expect(circle().width).toBe(300);
      await fireEvent.press(screen.getByRole("button", { name: "Cancel search" }));
      await waitFor(() => expect(circle().width).toBe(circle().height));
      // No keyboard says it is coming: it grows all the same, a moment later.
      await fireEvent.press(screen.getByRole("button", { name: "Search this chat" }));
      await waitFor(() => expect(circle().width).toBe(300), { timeout: 1000 });
      kb.restore();
    });

    it("asks for the keyboard the moment the search opens, so the bar rides it from the start", async () => {
      await withSession(talk);
      // (The test TextInput's focus is one shared mock.)
      const focus = (TextInput as unknown as { prototype: { focus: jest.Mock } }).prototype.focus;
      focus.mockClear();
      await openSearch();
      // At once: no wait for a timer (it used to come 80 ms later, after the keyboard had to catch up).
      expect(focus).toHaveBeenCalled();
    });

    it("keeps the bar's words at their width as the bar shrinks, so a typed draft doesn't wrap and make it taller", async () => {
      await withSession(talk);
      const content = (hidden = false) => screen.getByTestId("chat-bar-content", { includeHiddenElements: hidden });
      await fireEvent(content(), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 240, height: 36 } } });
      expect(StyleSheet.flatten(content().props.style).minWidth).toBeUndefined();
      await openSearch();
      expect(StyleSheet.flatten(content(true).props.style).minWidth).toBe(240);
      await fireEvent.press(screen.getByRole("button", { name: "Cancel search" }));
      await waitFor(() => expect(StyleSheet.flatten(content().props.style).minWidth).toBeUndefined());
    });

    it("lets the bar widen into the circle's room only while words are typed in it, not while it is searched", async () => {
      await withSession(talk);
      const bar = () => StyleSheet.flatten(screen.getByTestId("chat-bar").props.style);
      const room = bar().marginRight;
      expect(room).toBeGreaterThan(0);
      await fireEvent(screen.getByLabelText("Message"), "focus");
      expect(bar().marginRight).toBe(0);
      await fireEvent(screen.getByLabelText("Message"), "blur");
      expect(bar().marginRight).toBe(room);
    });

    it("moves the messages up with the keyboard by as much as the bar, instead of making the list shorter (that scrolled twice)", async () => {
      await withSession(talk);
      // (The library's views are plain ones in tests, so what they were told is on them.)
      type Node = { props: Record<string, unknown>; children?: unknown[] | null };
      const all: Node[] = [];
      const walk = (n: unknown) => {
        if (!n || typeof n !== "object") return;
        const node = n as Node;
        all.push(node);
        (node.children ?? []).forEach(walk);
      };
      walk(screen.toJSON());
      const lift = barRoom(0) - KEYBOARD_GAP;
      const list = all.find((n) => n.props.keyboardLiftBehavior !== undefined);
      expect(list?.props.keyboardLiftBehavior).toBe("always");
      expect(list?.props.offset).toBe(lift);
      // The bar rides the keyboard by the same: the room it has under it is not lifted twice.
      expect(all.some((n) => (n.props.offset as { opened?: number } | undefined)?.opened === lift)).toBe(true);
    });

    it("gives the back button, the title bar, the search circle and the chat bar one height", async () => {
      await withSession(talk);
      expect(heightWithin(screen.getByRole("button", { name: "Back" }))).toBe(control);
      // The title bar: the nearest box above the title that has a height.
      type Up = { props?: ViewProps; parent?: Up | null };
      let titleHeight: number | undefined;
      for (let n: Up | null = screen.getByRole("header") as unknown as Up; n && titleHeight === undefined; n = n.parent ?? null) {
        const h = StyleSheet.flatten(n.props?.style)?.height;
        if (typeof h === "number") titleHeight = h;
      }
      expect(titleHeight).toBe(control);
      expect(StyleSheet.flatten(screen.getByTestId("search-circle").props.style).height).toBe(control);
      // The message box at rest is the same height: its field's minimum is the shared height less the capsule's own padding.
      expect(StyleSheet.flatten(screen.getByLabelText("Message").props.style).minHeight).toBe(control - 12);
    });

    it("sizes the circle by the bar at rest, not by a layout in passing", async () => {
      await withSession(talk);
      const lay = (height: number) => fireEvent(screen.getByTestId("chat-bar"), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 300, height } } });
      const circle = () => StyleSheet.flatten(screen.getByTestId("search-circle").props.style).height;
      await lay(52);
      expect(circle()).toBe(52);
      // The bar with nothing in it yet (just its padding), and an absurd height: neither is the bar, so the circle keeps its size.
      await lay(12);
      await lay(0);
      await lay(400);
      expect(circle()).toBe(52);
    });

    it("keeps the room under the chat bar the same when the keyboard comes, so nothing changes size at that moment", async () => {
      const handlers = new Map<string, (e?: unknown) => void>();
      const spy = jest.spyOn(Keyboard, "addListener").mockImplementation(((name: string, handler: (e?: unknown) => void) => {
        handlers.set(name, handler);
        return { remove: () => {} };
      }) as never);
      await withSession(talk);
      // The bar's own box (the one with the room above and below it).
      const room = () => {
        for (let n = screen.getByLabelText("Message") as { props?: ViewProps; parent?: unknown } | null; n; n = n.parent as typeof n) {
          const style = StyleSheet.flatten(n.props?.style);
          if (style?.paddingTop === 8 && typeof style.paddingBottom === "number") return style.paddingBottom;
        }
        return null;
      };
      const down = room();
      expect(down).not.toBeNull();
      await act(async () => handlers.get("keyboardWillShow")?.());
      expect(room()).toBe(down);
      await act(async () => handlers.get("keyboardWillHide")?.());
      expect(room()).toBe(down);
      spy.mockRestore();
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
    // The line under it says what Claude is doing (here, between steps: working).
    expect(screen.getByText(/^Working/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(lastOf("interrupt")).toEqual({ op: "interrupt", slot: "a" }));
  });

  it("makes the tools circle Stop while Claude works: Send stays, and Stop is beside the bar, not in the header", async () => {
    const quiet = await withSession(turn);
    expect(screen.getByRole("button", { name: "Tools" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    await quiet.unmount();
    await withSession(turn, {}, {}, { status: "working" });
    // The circle is Stop now (a square, no words: the label is for a screen reader), and Send is still Send.
    expect(screen.queryByRole("button", { name: "Tools" })).toBeNull();
    expect(screen.queryByText("Stop")).toBeNull();
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    // It is the circle, beside the bar, and the title bar has nothing but the title.
    const above = (node: { parent?: unknown } | null | undefined) => {
      const chain: unknown[] = [];
      for (let n = node; n; n = n.parent as typeof n) chain.push(n);
      return chain;
    };
    expect(above(stop as never).includes(screen.getByTestId("search-circle"))).toBe(true);
    expect(above(stop as never).includes(screen.getByRole("header"))).toBe(false);
  });

  it("keeps Stop while a message is typed during a turn (the circle gives its room away only when it is the tools)", async () => {
    await withSession(turn, {}, {}, { status: "working" });
    await fireEvent(screen.getByLabelText("Message"), "focus");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("opens the tools when Stop is held, so the chat can still be searched while Claude works", async () => {
    await withSession(turn, {}, {}, { status: "working" });
    await fireEvent(screen.getByRole("button", { name: "Stop" }), "longPress");
    await fireEvent.press(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByLabelText("Search")).toBeTruthy();
  });

  it("queues what is typed while Claude works with Send", async () => {
    const { lastOf } = await withSession(turn, {}, {}, { status: "working" });
    await fireEvent.changeText(screen.getByLabelText("Message"), "and then run the tests");
    expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" }).props.accessibilityHint).toBe("Sends it once Claude has finished");
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(lastOf("send")).toMatchObject({ op: "send", slot: "a", text: "and then run the tests" }));
    await waitFor(() => expect(screen.getByLabelText("Message").props.value).toBe(""));
  });

  describe("the tools", () => {
    it("open from the circle as a row: Search, Compact, Clear, and a way out that closes it", async () => {
      await withSession(turn);
      await fireEvent.press(screen.getByRole("button", { name: "Tools" }));
      for (const name of ["Search", "Compact", "Clear", "Close tools"]) expect(screen.getByRole("button", { name })).toBeTruthy();
      // The message box is out of the way while the row is out.
      expect(screen.queryByLabelText("Message")).toBeNull();
      await fireEvent.press(screen.getByRole("button", { name: "Close tools" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Tools" })).toBeTruthy());
      expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
      expect(screen.getByLabelText("Message")).toBeTruthy();
    });

    it("compacts: Compact sends /compact and the row closes", async () => {
      const { lastOf } = await withSession(turn);
      await fireEvent.press(screen.getByRole("button", { name: "Tools" }));
      await fireEvent.press(screen.getByRole("button", { name: "Compact" }));
      await waitFor(() => expect(lastOf("send")).toMatchObject({ op: "send", slot: "a", text: "/compact" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Tools" })).toBeTruthy());
    });

    it("asks before Clear, as the Mac does, and sends /clear only when it is confirmed", async () => {
      const { Alert } = jest.requireActual<typeof import("react-native")>("react-native");
      const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
      const { lastOf } = await withSession(turn);
      await fireEvent.press(screen.getByRole("button", { name: "Tools" }));
      await fireEvent.press(screen.getByRole("button", { name: "Clear" }));
      expect(alert).toHaveBeenCalledTimes(1);
      expect(lastOf("send")).toBeUndefined();
      const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
      await act(async () => buttons.find((b) => b.text === "Clear")?.onPress?.());
      await waitFor(() => expect(lastOf("send")).toMatchObject({ op: "send", slot: "a", text: "/clear" }));
      alert.mockRestore();
    });

    it("has no Compact or Clear in Step by step, whose pages they would cut across: with nothing else, the circle is the search's alone", async () => {
      await withSession(turn, {}, {}, { workflow: "steps" });
      expect(screen.queryByRole("button", { name: "Tools" })).toBeNull();
      await fireEvent.press(screen.getByRole("button", { name: "Search this chat" }));
      expect(screen.getByLabelText("Search")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
    });

    it("searches straight away when Stop is held in a chat with no other tools", async () => {
      await withSession(turn, {}, {}, { workflow: "steps", status: "working" });
      await fireEvent(screen.getByRole("button", { name: "Stop" }), "longPress");
      expect(screen.getByLabelText("Search")).toBeTruthy();
    });

    it("waits for the turn to end before Compact or Clear, as the Mac does", async () => {
      const { lastOf } = await withSession(turn, {}, {}, { status: "working" });
      await fireEvent(screen.getByRole("button", { name: "Stop" }), "longPress");
      expect(screen.getByRole("button", { name: "Compact" }).props.accessibilityState).toMatchObject({ disabled: true });
      expect(screen.getByRole("button", { name: "Clear" }).props.accessibilityState).toMatchObject({ disabled: true });
      await fireEvent.press(screen.getByRole("button", { name: "Compact" }));
      expect(lastOf("send")).toBeUndefined();
    });

    it("offers To-dos only from a Mac that keeps them, and opens this chat's list", async () => {
      const quiet = await withSession(turn);
      await fireEvent.press(screen.getByRole("button", { name: "Tools" }));
      expect(screen.queryByRole("button", { name: "To-dos" })).toBeNull();
      await quiet.unmount();
      const { controller } = makeController();
      // ("another" comes first by name: the list opened is the chat's own project's, not the first.)
      const projects = [
        { id: "/Users/me/another", name: "another" },
        { id: "/Users/me/lantern", name: "lantern" },
      ];
      const { lastOf } = attachSession(controller, { projects, todos: { project: "/Users/me/lantern", name: "lantern", items: [] } }, ["todos"]);
      await renderWith(<ChatScreen {...handlers()} />, { chats: [chat()], events: { a: turn }, connection: connectedWith(["todos"]) }, controller);
      await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
      await fireEvent.press(screen.getByRole("button", { name: "Tools" }));
      await fireEvent.press(screen.getByRole("button", { name: "To-dos" }));
      await waitFor(() => expect(lastOf("todos")).toEqual({ op: "todos", project: "/Users/me/lantern" }));
      expect(await screen.findByText("To-dos: lantern")).toBeTruthy();
    });
  });

  it("has no queue link when Claude is not working: Send does that", async () => {
    await withSession(turn);
    await fireEvent.changeText(screen.getByLabelText("Message"), "hello");
    expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
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
    await waitFor(() => expect(screen.getByLabelText("Added, line 1: new")).toBeTruthy(), { timeout: 3000 });
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

  describe("the Done page", () => {
    const done: RemoteEvent[] = [{ kind: "assistant_text", block_id: "d", text: "# Done — built it" }];

    it("has no Next, but what to do next that the phone does itself: Start something new opens a new chat on the project, and sends nothing", async () => {
      const onStartNew = jest.fn();
      const { lastOf } = await withSession(done, { onStartNew });
      expect(screen.getByText("Done")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
      await fireEvent.press(screen.getByRole("button", { name: "Start something new" }));
      expect(onStartNew).toHaveBeenCalledWith("lantern");
      expect(lastOf("send")).toBeUndefined();
      // Not answered: it can be pressed again.
      expect(screen.getByRole("button", { name: "Start something new" })).toBeTruthy();
    });

    it("opens everything the chat changed from Review the changes", async () => {
      const more: RemoteEvent[] = [...turn, { kind: "assistant_text", block_id: "d", text: "# Done — built it" }];
      const { lastOf } = await withSession(more);
      await fireEvent.press(screen.getAllByRole("button", { name: "Review the changes" })[0]);
      expect(screen.getByText("1 file · +1 −1")).toBeTruthy();
      expect(lastOf("send")).toBeUndefined();
    });

    it("shows the Changes pane instead of a sheet where there is one", async () => {
      const onToggle = jest.fn();
      await withSession(done, { changesPane: { shown: false, onToggle } });
      await fireEvent.press(screen.getByRole("button", { name: "Review the changes" }));
      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it("is there in a Step by step chat on its own page, and stays when the post-hook has run after it", async () => {
      const onStartNew = jest.fn();
      await withSession([...done, { kind: "hook_turn", text: "Update the brain" }, { kind: "assistant_text", block_id: "h", text: "The brain is updated." }, { kind: "turn_done", is_error: false, result: "ok", duration_ms: 900, context_window: null }], { onStartNew }, {}, { workflow: "steps" });
      expect(screen.getByTestId("step-pager")).toBeTruthy();
      expect(screen.getByRole("header", { name: "Done, page 1 of 1" })).toBeTruthy();
      await fireEvent.press(screen.getByRole("button", { name: "Start something new" }));
      expect(onStartNew).toHaveBeenCalledWith("lantern");
    });

    it("waits while Claude is at work", async () => {
      await withSession(done, {}, {}, { workflow: "steps", status: "working" });
      expect(screen.queryByRole("button", { name: "Start something new" })).toBeNull();
    });
  });

  describe("in a Step by step chat, a page at a time", () => {
    const run: RemoteEvent[] = [
      { kind: "user_text", text: "Cut 0.1.53", at: 1, sent_by: "desktop" },
      { kind: "assistant_text", block_id: "p1", text: "# Step 1 of 2 — Bump the version\n\nTo 0.1.53." },
      { kind: "user_text", text: "Next. Commit this step first.", at: 2, sent_by: "desktop" },
      { kind: "assistant_text", block_id: "p2", text: "# Step 2 of 2 — Open the PR\n\nWith the changelog." },
    ];
    const steps = (events: RemoteEvent[] = run) => withSession(events, {}, {}, { workflow: "steps" });

    it("lays the pages side by side and opens on the newest, saying which it is", async () => {
      await steps();
      expect(screen.getByTestId("step-pager")).toBeTruthy();
      expect(screen.queryByTestId("chat-list")).toBeNull();
      expect(screen.getByRole("header", { name: "Step 2 of 2, page 3 of 3" })).toBeTruthy();
      // The newest page's buttons are there, on it.
      expect(screen.getByRole("button", { name: "Commit, next" })).toBeTruthy();
    });

    it("goes to the page before and after with its arrows", async () => {
      await steps();
      expect(screen.getByRole("button", { name: "Next page" }).props.accessibilityState).toMatchObject({ disabled: true });
      await fireEvent.press(screen.getByRole("button", { name: "Previous page" }));
      expect(screen.getByRole("header", { name: "Step 1 of 2, page 2 of 3" })).toBeTruthy();
      await fireEvent.press(screen.getByRole("button", { name: "Previous page" }));
      expect(screen.getByRole("header", { name: "Start, page 1 of 3" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Previous page" }).props.accessibilityState).toMatchObject({ disabled: true });
      await fireEvent.press(screen.getByRole("button", { name: "Next page" }));
      expect(screen.getByRole("header", { name: "Step 1 of 2, page 2 of 3" })).toBeTruthy();
    });

    it("follows a new page when on the newest, and says one came when reading an older one", async () => {
      const { controller } = await steps(run.slice(0, 2));
      expect(screen.getByRole("header", { name: "Step 1 of 2, page 2 of 2" })).toBeTruthy();
      await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "event", slot: "a", seq: 100, event: run[2] } }));
      await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "event", slot: "a", seq: 101, event: run[3] } }));
      await waitFor(() => expect(screen.getByRole("header", { name: "Step 2 of 2, page 3 of 3" })).toBeTruthy());
      await fireEvent.press(screen.getByRole("button", { name: "Previous page" }));
      await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "event", slot: "a", seq: 102, event: { kind: "assistant_text", block_id: "p3", text: "# Done — shipped" } } }));
      // Still on the page being read; the way to the new one says so.
      await waitFor(() => expect(screen.getByRole("button", { name: "New page" })).toBeTruthy());
      expect(screen.getByRole("header", { name: "Step 1 of 2, page 2 of 4" })).toBeTruthy();
      await fireEvent.press(screen.getByRole("button", { name: "New page" }));
      expect(screen.getByRole("header", { name: "Done, page 4 of 4" })).toBeTruthy();
    });

    it("can be read as one list, and back as pages, from the chat's settings (no button for it beside the pages)", async () => {
      const { controller } = makeController();
      attachSession(controller, { controls: { allow_auto: false, presets: [] } }, ["controls", "workflow"]);
      const c = chat({ workflow: "steps", permissions: "ask" });
      await renderWith(<ChatScreen {...handlers()} />, { chats: [c], events: { a: run }, connection: connectedWithControls }, controller);
      await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
      expect(screen.queryByRole("button", { name: /Show as/ })).toBeNull();
      const show = async (label: string) => {
        await fireEvent.press(screen.getByRole("button", { name: "Chat settings" }));
        await waitFor(() => expect(screen.getByText("Show")).toBeTruthy());
        await fireEvent.press(screen.getByRole("radio", { name: label }));
      };
      await show("One list");
      await waitFor(() => expect(screen.getByTestId("chat-list")).toBeTruthy());
      expect(screen.queryByTestId("step-pager")).toBeNull();
      await show("Pages");
      await waitFor(() => expect(screen.getByTestId("step-pager")).toBeTruthy());
    });

    it("shows a long page whole: it has the screen to itself", async () => {
      const long = `${"The tests cover the context menu fix and the release notes. ".repeat(8)}And the last line.`;
      await steps([{ kind: "assistant_text", block_id: "p1", text: `# Step 1 of 2 — Bump the version\n\n${long}` }]);
      expect(screen.getByText(/And the last line\./)).toBeTruthy();
      expect(screen.queryByText("Show the whole page")).toBeNull();
    });

    it("keeps the newest page's buttons at its end while the step is talked about", async () => {
      const { lastOf } = await steps([
        ...run,
        { kind: "user_text", text: "Why the changelog?", at: 3, sent_by: "desktop" },
        { kind: "assistant_text", block_id: "r", text: "So the release notes have it." },
        { kind: "turn_done", is_error: false, result: "ok", duration_ms: 900, context_window: null },
      ]);
      expect(screen.getByRole("header", { name: "Step 2 of 2, page 3 of 3" })).toBeTruthy();
      // Once on the page: at its end, not in its heading card as well.
      expect(screen.getAllByRole("button", { name: "Commit, next" })).toHaveLength(1);
      await fireEvent.press(screen.getByRole("button", { name: "Commit, next" }));
      await waitFor(() => expect(lastOf("send")).toMatchObject({ text: "Next. Commit this step first." }));
      expect(screen.queryByRole("button", { name: "Commit, next" })).toBeNull();
    });

    it("has no buttons while Claude is at work on the page", async () => {
      await withSession(run, {}, {}, { workflow: "steps", status: "working" });
      expect(screen.queryByRole("button", { name: "Commit, next" })).toBeNull();
    });

    it("links the files a step changed: named in its words, and listed under it", async () => {
      const built: RemoteEvent[] = [
        { kind: "user_text", text: "Next. Commit this step first.", at: 2, sent_by: "desktop" },
        { kind: "tool_started", tool_use_id: "e1", name: "Edit", summary: "TimeoutScheduler.swift" },
        { kind: "file_edited", tool_use_id: "e1", path: "/p/App/Sources/TimeoutScheduler.swift", created: false, added: 9, removed: 2 },
        { kind: "tool_finished", tool_use_id: "e1", is_error: false },
        { kind: "assistant_text", block_id: "s5", text: "# Step 5 of 14 — Move the timeout scheduler\n\nIt now lives in `Sources/TimeoutScheduler.swift`." },
        { kind: "turn_done", is_error: false, result: "ok", duration_ms: 900, context_window: null },
      ];
      const { lastOf } = await withSession(built, {}, { diff: "--- a\n+++ b\n+moved" }, { workflow: "steps" });
      await fireEvent.press(screen.getByText("Sources/TimeoutScheduler.swift"));
      await waitFor(() => expect(lastOf("diff")).toEqual({ op: "diff", slot: "a", path: "/p/App/Sources/TimeoutScheduler.swift" }));
      await fireEvent.press(screen.getByRole("button", { name: "Close" }));
      expect(screen.getByText("Changed in this step")).toBeTruthy();
      await fireEvent.press(screen.getByRole("link", { name: "TimeoutScheduler.swift" }));
      await waitFor(() => expect(screen.getByLabelText("Added: moved")).toBeTruthy());
    });

    it("moves a page up with the keyboard as the chat's list does, so the messages after the summary stay above the bar", async () => {
      await steps();
      const page = screen.getByTestId("step-page-2");
      expect(page.props.keyboardLiftBehavior).toBe("always");
      expect(page.props.offset).toBe(barRoom(0) - KEYBOARD_GAP);
    });

    it("is a plain chat in any other workflow", async () => {
      await withSession(run);
      expect(screen.getByTestId("chat-list")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Previous page" })).toBeNull();
    });
  });
});

describe("a Review, a file page at a time", () => {
  const filePage = (n: number, path: string) =>
    `# File ${n} of 2 — ${path} (+12 −3)\n\n### What changed\nThe token is checked before it is used.\n\n### Findings\n⚠ line 42 (blocker): The token is never refreshed.\n⚠ line 50 (nit): A typo in the message.\n\n### Notes\nChecked the tests too.`;
  const review = async (events: RemoteEvent[], features: string[] = ["reviewdiff"], answers = {}) => {
    const { controller } = makeController();
    const session = attachSession(controller, answers, features);
    await renderWith(<ChatScreen {...handlers()} />, { chats: [chat({ workflow: "steps" })], events: { a: events }, connection: connectedWith(features) }, controller);
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    return session;
  };
  const one: RemoteEvent[] = [{ kind: "assistant_text", block_id: "f1", text: filePage(1, "src/lib/auth.ts") }];

  it("lays a file page out with its file, what changed, its findings and notes", async () => {
    await review(one);
    expect(screen.getByRole("link", { name: "src/lib/auth.ts" })).toBeTruthy();
    expect(screen.getByText("The token is checked before it is used.")).toBeTruthy();
    expect(screen.getByText("Blocker")).toBeTruthy();
    expect(screen.getByText("Nit")).toBeTruthy();
    expect(screen.getByText("Checked the tests too.")).toBeTruthy();
  });

  it("sends your verdicts with Next, as the Mac does", async () => {
    const { lastOf } = await review(one);
    await fireEvent.press(within(screen.getByTestId("finding-0")).getByRole("button", { name: "Agree" }));
    await fireEvent.press(within(screen.getByTestId("finding-1")).getByRole("button", { name: "Reject" }));
    await fireEvent.press(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastOf("send")).toMatchObject({ text: "Next. Agreed: line 42. Rejected: line 50." }));
    // Sent: the verdicts can't be changed any more.
    expect(screen.queryByRole("button", { name: "Agree" })).toBeNull();
  });

  it("sends a plain Next with no verdict, and a verdict pressed twice is taken back", async () => {
    const { lastOf } = await review(one);
    const agree = () => within(screen.getByTestId("finding-0")).getByRole("button", { name: "Agree" });
    await fireEvent.press(agree());
    await fireEvent.press(agree());
    await fireEvent.press(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastOf("send")).toMatchObject({ text: "Next" }));
  });

  it("opens the change in the file from its name and from a finding's line, read from what is reviewed", async () => {
    const { lastOf } = await review(one, ["reviewdiff"], { review_diff: "--- a\n+++ b\n-old\n+new" });
    await fireEvent.press(screen.getByRole("link", { name: "src/lib/auth.ts" }));
    await waitFor(() => expect(lastOf("review_diff")).toEqual({ op: "review_diff", slot: "a", path: "src/lib/auth.ts" }));
    await waitFor(() => expect(screen.getByLabelText("Added: new")).toBeTruthy());
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    await fireEvent.press(screen.getByRole("link", { name: "line 42" }));
    await waitFor(() => expect(screen.getByLabelText("Added: new")).toBeTruthy());
  });

  it("asks an older Mac for the chat's own change instead, which it knows", async () => {
    const { lastOf, asked } = await review(one, [], { diff: "--- a\n+++ b\n+mine" });
    await fireEvent.press(screen.getByRole("link", { name: "src/lib/auth.ts" }));
    await waitFor(() => expect(lastOf("diff")).toEqual({ op: "diff", slot: "a", path: "src/lib/auth.ts" }));
    expect(asked.some((r) => r.op === "review_diff")).toBe(false);
  });

  it("shows an answered page's verdicts, read back from the Next that carried them", async () => {
    await review([...one, { kind: "user_text", text: "Next. Agreed: line 42.", at: 2, sent_by: "desktop" }, { kind: "assistant_text", block_id: "f2", text: filePage(2, "src/lib/api.ts") }]);
    await fireEvent.press(screen.getByRole("button", { name: "Previous page" }));
    expect(within(screen.getByTestId("step-page-0")).getByText("Agreed")).toBeTruthy();
    expect(within(screen.getByTestId("step-page-0")).queryByRole("button", { name: "Agree" })).toBeNull();
  });
});

describe("what a turn changed", () => {
  it("opens the diff of an edited file from its chip, with added and removed lines told apart", async () => {
    const { lastOf } = await withSession(turn, {}, { diff: "--- /p/Cargo.toml\n+++ /p/Cargo.toml\n@@ -3 +3 @@\n-version = \"0.1.52\"\n+version = \"0.1.53\"\n" });
    await fireEvent.press(screen.getByText("Edited 1 file +1 −1"));
    await waitFor(() => expect(screen.getByLabelText("Added, line 3: version = \"0.1.53\"")).toBeTruthy());
    expect(lastOf("diff")).toEqual({ op: "diff", slot: "a", path: "/p/Cargo.toml" });
    expect(screen.getByText("What changed")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("What changed")).toBeNull());
  });

  it("lists every file the chat changed from the title bar, each opening its diff", async () => {
    const more: RemoteEvent[] = [...turn, { kind: "tool_started", tool_use_id: "t9", name: "Write", summary: "notes.md" }, { kind: "file_edited", tool_use_id: "t9", path: "/p/docs/notes.md", created: true, added: 4, removed: 0 }];
    const { lastOf } = await withSession(more, {}, { diff: "--- /p/Cargo.toml\n+++ /p/Cargo.toml\n@@ -3 +3 @@\n-version = \"0.1.52\"\n+version = \"0.1.53\"\n" });
    await fireEvent.press(screen.getByRole("button", { name: "Changes" }));
    expect(screen.getByText("2 files · +5 −1")).toBeTruthy();
    // The sheet's heading is a menu of what it can show: only Changes for now.
    await fireEvent.press(screen.getByRole("button", { name: "Showing Changes" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.props.accessibilityState)).toEqual([{ selected: true }]);
    await fireEvent.press(screen.getByRole("menuitem"));
    // The newest first, and open on it.
    await waitFor(() => expect(lastOf("diff")).toEqual({ op: "diff", slot: "a", path: "/p/docs/notes.md" }));
    await fireEvent.press(screen.getByRole("button", { name: "Cargo.toml, 1 added, 1 removed" }));
    await waitFor(() => expect(lastOf("diff")).toEqual({ op: "diff", slot: "a", path: "/p/Cargo.toml" }));
    await waitFor(() => expect(screen.getByLabelText("Added, line 3: version = \"0.1.53\"")).toBeTruthy());
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("2 files · +5 −1")).toBeNull());
  });

  it("offers the folder's artifacts from the sheet's menu only on a Mac that lists them, and opens on the changes again", async () => {
    const { controller } = makeController();
    const features = ["artifacts"];
    const { lastOf } = attachSession(controller, { artifacts: [{ name: "map.md", kind: "markdown", modified: 5, size: 9 }], artifact_read: "# The map" }, features);
    await renderWith(<ChatScreen {...handlers()} />, { chats: [chat()], events: { a: turn }, connection: connectedWith(features) }, controller);
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    await fireEvent.press(screen.getByRole("button", { name: "Changes" }));
    await fireEvent.press(screen.getByRole("button", { name: "Showing Changes" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.props.accessibilityState)).toEqual([{ selected: true }, { selected: false }]);
    await fireEvent.press(screen.getByRole("menuitem", { name: /Artifacts/ }));
    expect(await screen.findByText("The map")).toBeTruthy();
    expect(lastOf("artifact_read")).toEqual({ op: "artifact_read", slot: "a", name: "map.md" });
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    await fireEvent.press(screen.getByRole("button", { name: "Changes" }));
    expect(screen.getByRole("button", { name: "Showing Changes" })).toBeTruthy();
  });

  it("has the Changes icon before anything changed, and says so in it", async () => {
    await withSession(turn.slice(0, 2));
    await fireEvent.press(screen.getByRole("button", { name: "Changes" }));
    expect(screen.getByText("Nothing changed in this chat yet.")).toBeTruthy();
  });

  it("shows and hides a pane beside the chat from the Changes button, instead of opening a sheet, where there is one", async () => {
    const onToggle = jest.fn();
    await withSession(turn, { changesPane: { shown: true, onToggle } });
    const button = screen.getByRole("button", { name: "Changes" });
    expect(button.props.accessibilityState).toMatchObject({ expanded: true });
    await fireEvent.press(button);
    expect(onToggle).toHaveBeenCalled();
    expect(screen.queryByText("2 files · +5 −1")).toBeNull();
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
