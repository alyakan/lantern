import { Platform, StyleSheet } from "react-native";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { chat, connected, connectedWithControls, makeController, NOW, renderWith, waiting } from "../test/render";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ControllerContext } from "../shell/hooks";
import { noMemory, noPlatform, TipJar } from "../tips";
import { resetSeen } from "../seen";
import { resetPins } from "../pins";
import { HomeScreen } from "./HomeScreen";

// What Home remembers about how it lists the chats: kept in memory here, not in the Keychain.
let mockRemembered: "recent" | "project" = "recent";
let mockFolded: string[] = [];
let mockSeen: Record<string, number> | null = null;
beforeEach(() => {
  mockRemembered = "recent";
  mockFolded = [];
  mockSeen = null;
  resetSeen();
});
jest.mock("../prefs", () => ({
  // Home as the Desk or the chats: the Desk, as on a phone that never chose (only a Mac that has one shows it).
  loadHomeMode: jest.fn(async () => "desk"),
  saveHomeMode: jest.fn(async () => {}),
  loadGrouping: jest.fn(async () => mockRemembered),
  saveGrouping: jest.fn(async (g: "recent" | "project") => {
    mockRemembered = g;
  }),
  // The project cards folded away, and where each chat stood when it was last shown (null: the first launch).
  loadFolded: jest.fn(async () => [...mockFolded]),
  saveFolded: jest.fn(async (f: string[]) => {
    mockFolded = [...f];
  }),
  loadSeen: jest.fn(async () => (mockSeen ? { ...mockSeen } : null)),
  saveSeen: jest.fn(async (m: Record<string, number>) => {
    mockSeen = { ...m };
  }),
  // The suggestions' own memory: nothing folded away or dismissed.
  loadSuggestionPrefs: jest.fn(async () => ({ collapsed: false, dismissed: [] as string[] })),
  saveSuggestionPrefs: jest.fn(async () => {}),
}));

const handlers = () => ({ onOpenChat: jest.fn(), onReview: jest.fn(), onOpenMac: jest.fn(), onCompose: jest.fn(), onNewChat: jest.fn(), onSupport: jest.fn() });

describe("the way in to the tip jar on Home", () => {
  const jarWith = (last: number | null, pledger: boolean | null = null) => new TipJar(noPlatform, { ...noMemory, load: async () => last, loadPledger: async () => pledger }, () => NOW);

  it("is a quiet card under the chats, saying everything stays free, that opens the tips", async () => {
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, { chats: [chat()] });
    expect(screen.getByText("Support development")).toBeTruthy();
    expect(screen.getByText("Everything stays free either way")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Support development" }));
    expect(h.onSupport).toHaveBeenCalledTimes(1);
  });

  it("says thanks instead, once there has been a tip this month, and still opens the tips", async () => {
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, { chats: [chat()], tips: jarWith(NOW - 3 * 86_400_000) });
    await waitFor(() => expect(screen.getByText("Thank you for supporting Lantern")).toBeTruthy());
    await fireEvent.press(screen.getByRole("button", { name: "Support development" }));
    expect(h.onSupport).toHaveBeenCalled();
  });

  it("says Ember glows for a regular, whenever the last tip was, and still opens the tips", async () => {
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, { chats: [chat()], tips: jarWith(null, true) });
    await waitFor(() => expect(screen.getByText("Ember glows for you")).toBeTruthy());
    expect(screen.getByText("Thank you for supporting Lantern")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Support development" }));
    expect(h.onSupport).toHaveBeenCalled();
  });

  it("is the usual card again when the last tip was in an earlier month", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat()], tips: jarWith(NOW - 70 * 86_400_000) });
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(screen.getByText("Everything stays free either way")).toBeTruthy();
    expect(screen.queryByText("Thank you for supporting Lantern")).toBeNull();
  });

  it("is not there while Home is still a skeleton", async () => {
    await renderWith(<HomeScreen {...handlers()} />, {});
    expect(screen.queryByRole("button", { name: "Support development" })).toBeNull();
  });
});

describe("Home before the Mac has sent anything", () => {
  it("shows the shape of Home, not 'nothing waiting' or 'no chats', which would be a guess", async () => {
    const { controller } = makeController();
    const { asked } = attachSession(controller, { suggest: { items: [], generated_at: 1 } });
    await renderWith(<HomeScreen {...handlers()} />, {}, controller);
    expect(screen.getByLabelText("Loading your chats")).toBeTruthy();
    expect(screen.queryByText("Nothing")).toBeNull();
    expect(screen.queryByText(/No chats are open/)).toBeNull();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    // And Claude isn't asked for suggestions on a guess either.
    expect(asked.filter((r) => r.op === "suggest")).toEqual([]);
  });

  it("is still the skeleton when only the chats have come: what waits on you is not known yet", async () => {
    const { controller } = makeController();
    await renderWith(<HomeScreen {...handlers()} />, {}, controller);
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: [chat()] } }));
    expect(screen.getByLabelText("Loading your chats")).toBeTruthy();
    await act(async () => controller.sync.apply({ type: "waiting", list: [] }));
    expect(screen.queryByLabelText("Loading your chats")).toBeNull();
    expect(screen.getByText("Nothing")).toBeTruthy();
  });

  it("settles into Home, with an empty list said to be empty, once both have come", async () => {
    const { controller } = makeController();
    await renderWith(<HomeScreen {...handlers()} />, {}, controller);
    await act(async () => {
      controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: [] } });
      controller.sync.apply({ type: "waiting", list: [] });
    });
    expect(screen.getByText(/No chats are open on your Mac/)).toBeTruthy();
  });
});

describe("Home", () => {
  it("has a way to start a chat, with nothing written yet", async () => {
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, { chats: [chat()] });
    await fireEvent.press(screen.getByRole("button", { name: "New chat" }));
    expect(h.onNewChat).toHaveBeenCalledWith();
  });

  it("leads with how many things wait on you, and the oldest as a card to review", async () => {
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, { chats: [chat()], waiting: [waiting({ request_id: "late", at: 9, input: { command: "npm publish" } }), waiting({ request_id: "early", at: 2 })] });
    expect(screen.getByText("2 things")).toBeTruthy();
    expect(screen.getByText("waiting on you")).toBeTruthy();
    expect(screen.getByText("Run a command")).toBeTruthy();
    expect(screen.getByText("Push the release branch")).toBeTruthy();
    expect(screen.getByText("git push origin release/0.1.53")).toBeTruthy();
    expect(screen.getByText("Release 0.1.53, in lantern")).toBeTruthy();
    expect(screen.getByText("1 more after this one")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Review" }));
    expect(h.onReview).toHaveBeenCalledWith("a", "early");
    await fireEvent.press(screen.getByRole("button", { name: "Open chat" }));
    expect(h.onOpenChat).toHaveBeenCalledWith("a");
  });

  it("suggests what to do next when nothing waits on you, with one way to start a chat of your own: New chat", async () => {
    const { controller } = makeController();
    const { asked } = attachSession(controller, { suggest: { items: [], generated_at: 1 } });
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, { chats: [chat()], waiting: [] }, controller);
    await waitFor(() => expect(screen.getByText("Claude suggests")).toBeTruthy());
    expect(asked.some((r) => r.op === "suggest")).toBe(true);
    expect(screen.queryByRole("button", { name: "Start something new" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "New chat" })).toHaveLength(1);
  });

  it("doesn't suggest anything, or ask Claude, while something waits on you: that leads", async () => {
    const { controller } = makeController();
    const { asked } = attachSession(controller, { suggest: { items: [], generated_at: 1 } });
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat()], waiting: [waiting()] }, controller);
    expect(screen.queryByText("Claude suggests")).toBeNull();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(asked.filter((r) => r.op === "suggest")).toEqual([]);
  });

  it("says nothing waits, and shows no stack", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat()], waiting: [] });
    expect(screen.getByText("Nothing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(screen.queryByText(/more after this one/)).toBeNull();
  });

  it("lists the chats with what needs you first, with their state, and opens one", async () => {
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, {
      chats: [chat({ slot: "old", title: "Network tab filters", project: "network-monitor", status: "asleep", active_at: 1 }), chat({ slot: "w", title: "Mobile gateway design", status: "working" }), chat({ slot: "n", title: "Storage audit", status: "needs_you", active_at: 5 })],
    });
    expect(screen.getByText("Asleep")).toBeTruthy();
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByLabelText("Working")).toBeTruthy();
    const names = screen.getAllByRole("button").map((b) => b.props.accessibilityLabel as string).filter((l) => /lantern|network-monitor/.test(l));
    expect(names[0]).toContain("Storage audit");
    expect(names[1]).toContain("Mobile gateway design");
    expect(names[names.length - 1]).toContain("Network tab filters");
    await fireEvent.press(screen.getByRole("button", { name: /Network tab filters/ }));
    expect(h.onOpenChat).toHaveBeenCalledWith("old");
  });

  it("says what to do when no chats are open", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [] });
    expect(screen.getByText(/No chats are open on your Mac/)).toBeTruthy();
  });

  it("names the Mac, and opens its sheet", async () => {
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, { chats: [] });
    await fireEvent.press(screen.getByRole("button", { name: "Aly's MacBook Pro, connected" }));
    expect(h.onOpenMac).toHaveBeenCalled();
  });

  it("offers Message a chat on Android, and only there", async () => {
    const h = handlers();
    const original = Platform.OS;
    Platform.OS = "android";
    const view = await renderWith(<HomeScreen {...h} />, { chats: [chat()] });
    await fireEvent.press(screen.getByRole("button", { name: "Message a chat" }));
    expect(h.onCompose).toHaveBeenCalled();
    await view.unmount();
    Platform.OS = "ios";
    await renderWith(<HomeScreen {...h} />, { chats: [chat()] });
    expect(screen.queryByRole("button", { name: "Message a chat" })).toBeNull();
    Platform.OS = original;
  });

  it("shows a question as a question, to review", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat()], waiting: [waiting({ tool_name: "AskUserQuestion", input: { questions: [{ question: "Which channel?", header: "Channel", options: [{ label: "Stable" }] }] } })] });
    expect(screen.getByText("A question")).toBeTruthy();
    expect(screen.getByText("Which channel?")).toBeTruthy();
  });
});

describe("Home's chats by project", () => {
  const chats = [
    chat({ slot: "a", title: "Release", project: "lantern", active_at: NOW - 60_000 }),
    chat({ slot: "b", title: "Prayers widget", project: "prayers", active_at: NOW - 30_000 }),
    chat({ slot: "c", title: "Fix sync", project: "lantern", active_at: NOW - 120_000, status: "needs_you" }),
  ];

  beforeEach(() => {
    mockRemembered = "recent";
  });

  it("lists the chats most recent first until Projects is chosen, then under each project with its count", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats });
    expect(screen.getByRole("button", { name: "Recent, selected" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^lantern, 2 chats/ })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getByRole("button", { name: "Projects, selected" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "prayers, 1 chat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "lantern, 2 chats, 1 need you" })).toBeTruthy();
    // The project is in the heading, not repeated under every chat.
    expect(screen.getByRole("button", { name: "Release" })).toBeTruthy();
  });

  it("puts each project and its chats in a card of their own, its header tinted in the project's colour", async () => {
    await renderWith(<HomeScreen {...handlers()} />, {
      chats: [chat({ slot: "a", title: "Release", project: "lantern", project_color: "#5b5bd6" }), chat({ slot: "b", title: "Prayers widget", project: "prayers", project_color: "#0f8a7e" }), chat({ slot: "c", title: "Fix sync", project: "lantern", project_color: "#5b5bd6" })],
    });
    await fireEvent.press(screen.getByRole("button", { name: "Projects" }));
    const lantern = within(screen.getByTestId("project-card-lantern"));
    const prayers = within(screen.getByTestId("project-card-prayers"));
    // Each card holds its project's header and its chats, and nobody else's.
    expect(lantern.getByRole("button", { name: "lantern, 2 chats" })).toBeTruthy();
    expect(lantern.getByRole("button", { name: "Release" })).toBeTruthy();
    expect(lantern.getByRole("button", { name: "Fix sync" })).toBeTruthy();
    expect(lantern.queryByRole("button", { name: "Prayers widget" })).toBeNull();
    expect(prayers.getByRole("button", { name: "Prayers widget" })).toBeTruthy();
    // The header is a band of the project's colour at about 15%.
    expect(StyleSheet.flatten(lantern.getByRole("button", { name: "lantern, 2 chats" }).props.style).backgroundColor).toBe("#5b5bd626");
    expect(StyleSheet.flatten(prayers.getByRole("button", { name: "prayers, 1 chat" }).props.style).backgroundColor).toBe("#0f8a7e26");
  });

  it("keeps a folded project's header in its card, with the chats gone from it", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats });
    await fireEvent.press(screen.getByRole("button", { name: "Projects" }));
    await fireEvent.press(screen.getByRole("button", { name: "lantern, 2 chats, 1 need you" }));
    const lantern = within(screen.getByTestId("project-card-lantern"));
    expect(lantern.getByRole("button", { name: "lantern, 2 chats, 1 need you" })).toBeTruthy();
    expect(lantern.queryByRole("button", { name: "Release" })).toBeNull();
  });

  it("holds every chat in a card in from the card's edges, with no lines between them", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat({ slot: "a", title: "First", project: "lantern", active_at: NOW - 1_000 }), chat({ slot: "b", title: "Second", project: "lantern", active_at: NOW - 2_000 }), chat({ slot: "c", title: "Third", project: "lantern", active_at: NOW - 3_000 })] });
    await fireEvent.press(screen.getByRole("button", { name: "Projects" }));
    const rowStyle = (slot: string) => StyleSheet.flatten(screen.getByTestId(`card-row-${slot}`).props.style);
    // In from the card's edge by 8, and 8 more inside the row (room around the open chat's wash): 16, as the header is.
    for (const [slot, title] of [["a", "First"], ["b", "Second"], ["c", "Third"]]) {
      expect(rowStyle(slot).marginHorizontal).toBe(8);
      expect(rowStyle(slot).borderTopWidth).toBeUndefined();
      expect(StyleSheet.flatten(screen.getByRole("button", { name: title }).props.style).paddingHorizontal).toBe(8);
    }
    expect(StyleSheet.flatten(screen.getByRole("button", { name: "lantern, 3 chats" }).props.style).paddingHorizontal).toBe(16);
  });

  it("marks the chat that is open with a bar of the accent down its left, and no background, in the list and in a card", async () => {
    const chats = [chat({ slot: "a", title: "First", project: "lantern", active_at: NOW - 1_000 }), chat({ slot: "b", title: "Second", project: "lantern", active_at: NOW - 2_000 })];
    const view = await renderWith(<HomeScreen {...handlers()} selectedSlot="a" />, { chats });
    const style = (el: { props: { style?: unknown } }) => StyleSheet.flatten(el.props.style as never) as Record<string, unknown>;
    const first = () => screen.getByRole("button", { name: /^First/ });
    // Only the open one has the bar, down the left edge of its row.
    expect(screen.getAllByTestId("selected-bar", { hidden: true })).toHaveLength(1);
    expect(style(within(first()).getByTestId("selected-bar", { hidden: true }))).toMatchObject({ position: "absolute", left: 0, width: 3 });
    expect(screen.queryByTestId("selected-underline", { hidden: true })).toBeNull();
    // No wash on the row (it did not clip to the row's shape), the open one or any other.
    expect(style(first()).backgroundColor).toBeUndefined();
    expect(style(screen.getByRole("button", { name: /^Second/ })).backgroundColor).toBeUndefined();
    await fireEvent.press(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getAllByTestId("selected-bar", { hidden: true })).toHaveLength(1);
    expect(style(screen.getByRole("button", { name: "First" })).backgroundColor).toBeUndefined();
    await view.unmount();
  });

  it("moves the bar to the next chat that is opened, leaving it on one chat at a time", async () => {
    const chats = [chat({ slot: "a", title: "First", active_at: NOW - 1_000 }), chat({ slot: "b", title: "Second", active_at: NOW - 2_000 })];
    const view = await renderWith(<HomeScreen {...handlers()} selectedSlot="a" />, { chats });
    expect(within(screen.getByRole("button", { name: /^First/ })).getByTestId("selected-bar", { hidden: true })).toBeTruthy();
    await view.rerender(
      <SafeAreaProvider>
        <ControllerContext.Provider value={view.controller}>
          <HomeScreen {...handlers()} selectedSlot="b" />
        </ControllerContext.Provider>
      </SafeAreaProvider>,
    );
    expect(screen.getAllByTestId("selected-bar", { hidden: true })).toHaveLength(1);
    expect(within(screen.getByRole("button", { name: /^Second/ })).getByTestId("selected-bar", { hidden: true })).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /^First/ })).queryByTestId("selected-bar", { hidden: true })).toBeNull();
    await view.unmount();
  });

  it("has a pin button for the chats only when it is given one (a tablet), that says which it will do", async () => {
    const onTogglePin = jest.fn();
    const first = await renderWith(<HomeScreen {...handlers()} />, { chats: [chat()] });
    expect(screen.queryByRole("button", { name: /Pin the chats|Unpin the chats/ })).toBeNull();
    await first.unmount();
    const second = await renderWith(<HomeScreen {...handlers()} onTogglePin={onTogglePin} />, { chats: [chat()] });
    await fireEvent.press(screen.getByRole("button", { name: "Pin the chats beside the chat" }));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    await second.unmount();
    await renderWith(<HomeScreen {...handlers()} pinned onTogglePin={onTogglePin} />, { chats: [chat()] });
    expect(screen.getByRole("button", { name: "Unpin the chats" }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.queryByRole("button", { name: "Pin the chats beside the chat" })).toBeNull();
  });

  it("folds a project away and opens it again", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats });
    await fireEvent.press(screen.getByRole("button", { name: "Projects" }));
    await fireEvent.press(screen.getByRole("button", { name: "lantern, 2 chats, 1 need you" }));
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
    expect(screen.getByRole("button", { name: "Prayers widget" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "lantern, 2 chats, 1 need you" }));
    expect(screen.getByRole("button", { name: "Release" })).toBeTruthy();
  });

  it("opens a chat from under its project", async () => {
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, { chats });
    await fireEvent.press(screen.getByRole("button", { name: "Projects" }));
    await fireEvent.press(screen.getByRole("button", { name: "Prayers widget" }));
    expect(h.onOpenChat).toHaveBeenCalledWith("b");
  });

  it("remembers the choice for next time", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats });
    await fireEvent.press(screen.getByRole("button", { name: "Projects" }));
    expect(mockRemembered).toBe("project");
  });

  it("opens by project when that is what was chosen last time", async () => {
    mockRemembered = "project";
    await renderWith(<HomeScreen {...handlers()} />, { chats });
    await waitFor(() => expect(screen.getByRole("button", { name: "prayers, 1 chat" })).toBeTruthy());
  });

  it("has no switch with a single chat: there is nothing to group", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat()] });
    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
  });
});

describe("each chat's project, in its colour", () => {
  const colorOf = (text: string) => StyleSheet.flatten(screen.getByText(text).props.style).color;

  it("is a tag in the colour the Mac gave the project, so which project a chat is in reads at a glance", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat({ slot: "a", title: "Release", project: "lantern", project_color: "#c2255c" }), chat({ slot: "b", title: "Widget", project: "prayers", project_color: "#0f8a7e" })] });
    expect(colorOf("lantern")).toBe("#c2255c");
    expect(colorOf("prayers")).toBe("#0f8a7e");
  });

  it("is a plain grey tag for a project the Mac gave no colour, and for garbage", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat({ slot: "a", project: "lantern", project_color: null, workflow: null }), chat({ slot: "b", title: "Other", project: "site", project_color: "url(evil)" })] });
    expect(colorOf("lantern")).toBe("#566272");
    expect(colorOf("site")).toBe("#566272");
  });

  it("colours the project's name above its chats in the Projects view", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat({ slot: "a", project: "lantern", project_color: "#5b5bd6" }), chat({ slot: "b", title: "Other", project: "lantern", project_color: "#5b5bd6" })] });
    await fireEvent.press(screen.getByRole("button", { name: "Projects" }));
    expect(colorOf("lantern")).toBe("#5b5bd6");
  });
});

describe("closing a chat from Home", () => {
  beforeEach(() => {
    mockRemembered = "recent";
  });

  async function home(connection = connectedWithControls) {
    const { controller } = makeController();
    const session = attachSession(controller, {}, connection === connectedWithControls ? ["controls", "close"] : []);
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat({ slot: "a", title: "Release" }), chat({ slot: "b", title: "Widget", status: "working" })], connection }, controller);
    return session;
  }

  it("is offered when a chat is held down, asks first, and closes it on the Mac", async () => {
    const { lastOf } = await home();
    await fireEvent(screen.getByRole("button", { name: "Release, lantern" }), "longPress");
    await fireEvent.press(await screen.findByRole("button", { name: "Close chat…" }));
    await waitFor(() => expect(screen.getByText("Close this chat?")).toBeTruthy(), { timeout: 2000 });
    expect(lastOf("close")).toBeUndefined();
    await fireEvent.press(screen.getByRole("button", { name: "Close chat" }));
    await waitFor(() => expect(lastOf("close")).toEqual({ op: "close", slot: "a" }));
  });

  it("says Claude is busy for a chat that is working, instead of asking", async () => {
    await home();
    await fireEvent(screen.getByRole("button", { name: "Widget, lantern, working" }), "longPress");
    await fireEvent.press(await screen.findByRole("button", { name: "Close chat…" }));
    await waitFor(() => expect(screen.getByText("Close this chat?")).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByText("Claude is busy in this chat. Stop it first, then close it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close chat" })).toBeNull();
  });

  it("offers no closing for a Mac that can't close chats (the other actions are still there)", async () => {
    await home(connected);
    await fireEvent(screen.getByRole("button", { name: "Release, lantern" }), "longPress");
    expect(await screen.findByRole("button", { name: "Pin to the top" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close chat…" })).toBeNull();
    expect(screen.queryByText("Close this chat?")).toBeNull();
  });
});

describe("what holding a chat down offers besides closing it", () => {
  beforeEach(() => {
    mockRemembered = "recent";
    resetPins();
  });
  const chats = [chat({ slot: "a", title: "Release", active_at: NOW - 5 * 60_000 }), chat({ slot: "b", title: "Widget", active_at: NOW - 60_000 })];

  it("pins a chat to the top, and unpins it", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats });
    const order = () => screen.getAllByRole("button").map((b) => b.props.accessibilityLabel as string).filter((l) => /^(Release|Widget)/.test(l));
    expect(order()[0]).toMatch(/^Widget/);
    await fireEvent(screen.getByRole("button", { name: "Release, lantern" }), "longPress");
    await fireEvent.press(await screen.findByRole("button", { name: "Pin to the top" }));
    await waitFor(() => expect(order()[0]).toMatch(/^Release.*pinned/));
    await fireEvent(screen.getByRole("button", { name: /^Release.*pinned/ }), "longPress");
    await fireEvent.press(await screen.findByRole("button", { name: "Unpin from the top" }));
    await waitFor(() => expect(order()[0]).toMatch(/^Widget/));
  });

  it("marks an idle chat unread, and read again", async () => {
    mockSeen = { a: NOW, b: NOW };
    await renderWith(<HomeScreen {...handlers()} />, { chats });
    await fireEvent(screen.getByRole("button", { name: "Release, lantern" }), "longPress");
    await fireEvent.press(await screen.findByRole("button", { name: "Mark as unread" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Release, lantern, unread" })).toBeTruthy());
    await fireEvent(screen.getByRole("button", { name: "Release, lantern, unread" }), "longPress");
    await fireEvent.press(await screen.findByRole("button", { name: "Mark as read" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Release, lantern" })).toBeTruthy());
  });

  it("does not offer read or unread for a chat that is working", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat({ slot: "w", title: "Busy", status: "working" })] });
    await fireEvent(screen.getByRole("button", { name: "Busy, lantern, working" }), "longPress");
    expect(await screen.findByRole("button", { name: "Pin to the top" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mark as/ })).toBeNull();
  });
});

describe("project cards that stay folded", () => {
  const chats = [chat({ slot: "a", title: "Release", project: "lantern" }), chat({ slot: "b", title: "Prayers widget", project: "prayers" })];

  it("remembers a folded card, and an opened one is forgotten", async () => {
    const view = await renderWith(<HomeScreen {...handlers()} />, { chats });
    await fireEvent.press(screen.getByRole("button", { name: "Projects" }));
    await fireEvent.press(screen.getByRole("button", { name: "lantern, 1 chat" }));
    await waitFor(() => expect(mockFolded).toEqual(["lantern"]));
    await fireEvent.press(screen.getByRole("button", { name: "prayers, 1 chat" }));
    await waitFor(() => expect(mockFolded).toEqual(["lantern", "prayers"]));
    await fireEvent.press(screen.getByRole("button", { name: "lantern, 1 chat" }));
    await waitFor(() => expect(mockFolded).toEqual(["prayers"]));
    void view;
  });

  it("opens with the cards folded the way they were left", async () => {
    mockFolded = ["lantern"];
    await renderWith(<HomeScreen {...handlers()} />, { chats });
    await fireEvent.press(screen.getByRole("button", { name: "Projects" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Release" })).toBeNull());
    expect(screen.getByRole("button", { name: "lantern, 1 chat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prayers widget" })).toBeTruthy();
  });
});

// The dots are decoration (the row's label says "unread"), so a screen reader skips them; the tests look anyway.
const HIDDEN = { includeHiddenElements: true };
const SAVED = { timeout: 2500 };

describe("what is unread", () => {
  const read = chat({ slot: "a", title: "Seen already", active_at: NOW - 60_000 });
  const fresh = chat({ slot: "b", title: "Has news", active_at: NOW - 30_000 });
  const marks = { a: NOW - 60_000, b: NOW - 90_000 };

  it("marks a chat that has moved on since it was shown: a dot, a bold title and a stronger time, while a read one is plain", async () => {
    mockSeen = marks;
    await renderWith(<HomeScreen {...handlers()} />, { chats: [read, fresh] });
    const news = await screen.findByRole("button", { name: "Has news, lantern, unread" });
    expect(within(news).getByTestId("unread-dot", HIDDEN)).toBeTruthy();
    expect(StyleSheet.flatten(within(news).getByText("Has news").props.style).fontWeight).toBe("800");
    const plain = screen.getByRole("button", { name: "Seen already, lantern" });
    expect(within(plain).queryByTestId("unread-dot", HIDDEN)).toBeNull();
    expect(StyleSheet.flatten(within(plain).getByText("Seen already").props.style).fontWeight).toBe("400");
  });

  it("calls nothing unread the first time, when it has no idea what was shown", async () => {
    mockSeen = null;
    await renderWith(<HomeScreen {...handlers()} />, { chats: [read, fresh] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Has news, lantern" })).toBeTruthy());
    expect(screen.queryByTestId("unread-dot", HIDDEN)).toBeNull();
    // And from then on, what happens in them does count.
    await waitFor(() => expect(mockSeen).toEqual({ a: NOW - 60_000, b: NOW - 30_000 }), SAVED);
  });

  it("is only for a chat that is waiting: not one that is asleep, working or asking", async () => {
    mockSeen = { a: 0, b: 0, c: 0, d: 0 };
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat({ slot: "a", title: "One", status: "asleep" }), chat({ slot: "b", title: "Two", status: "working" }), chat({ slot: "c", title: "Three", status: "needs_you" }), chat({ slot: "d", title: "Four", status: "ended" })] });
    await screen.findByRole("button", { name: /^One/ });
    expect(screen.queryByTestId("unread-dot", HIDDEN)).toBeNull();
  });

  it("is dropped for a chat that is closed", async () => {
    mockSeen = { a: NOW - 60_000, gone: 5 };
    await renderWith(<HomeScreen {...handlers()} />, { chats: [read] });
    await waitFor(() => expect(mockSeen).toEqual({ a: NOW - 60_000 }), SAVED);
  });

  it("is told on a folded card, which keeps a dot and says how many", async () => {
    mockSeen = marks;
    mockFolded = ["lantern"];
    await renderWith(<HomeScreen {...handlers()} />, { chats: [read, fresh] });
    await fireEvent.press(screen.getByRole("button", { name: "Projects" }));
    const card = await screen.findByRole("button", { name: "lantern, 2 chats, 1 unread" });
    expect(within(card).getByTestId("unread-card-dot", HIDDEN)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Has news, lantern, unread" })).toBeNull();
  });
});

describe("the order of the chats", () => {
  const titles = () => screen.getAllByRole("button", { name: /^(Needs|Busy|Rest)/ }).map((b) => b.props.accessibilityLabel.split(",")[0]);

  it("is what needs you, then what is working, then the rest, and holds still while the working chats keep working", async () => {
    const mk = (over: Record<string, unknown>) => chat({ project: "lantern", ...over });
    const first = [mk({ slot: "n", title: "Needs one", status: "needs_you", active_at: NOW - 5_000 }), mk({ slot: "w1", title: "Busy one", status: "working", active_at: NOW - 50_000 }), mk({ slot: "w2", title: "Busy two", status: "working", active_at: NOW - 40_000 }), mk({ slot: "s", title: "Rest one", status: "asleep", active_at: NOW - 900_000 })];
    const { controller } = makeController();
    await renderWith(<HomeScreen {...handlers()} />, { chats: first }, controller);
    expect(titles()).toEqual(["Needs one", "Busy two", "Busy one", "Rest one"]);
    // Both go on working: their events keep moving their activity, the first one's now the latest.
    for (const [a1, a2] of [[NOW - 10_000, NOW - 30_000], [NOW - 2_000, NOW - 20_000], [NOW - 500, NOW - 10_000]]) {
      await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: first.map((c) => (c.slot === "w1" ? { ...c, active_at: a1 } : c.slot === "w2" ? { ...c, active_at: a2 } : c)) } }));
      expect(titles()).toEqual(["Needs one", "Busy two", "Busy one", "Rest one"]);
    }
  });

  it("puts a chat that finished at the top of the rest, and a chat that begins to work at the top of the working", async () => {
    const mk = (over: Record<string, unknown>) => chat({ project: "lantern", ...over });
    const first = [mk({ slot: "w1", title: "Busy one", status: "working", active_at: NOW - 50_000 }), mk({ slot: "s", title: "Rest one", status: "asleep", active_at: NOW - 900_000 }), mk({ slot: "i", title: "Rest two", status: "idle", active_at: NOW - 600_000 })];
    const { controller } = makeController();
    await renderWith(<HomeScreen {...handlers()} />, { chats: first }, controller);
    expect(titles()).toEqual(["Busy one", "Rest two", "Rest one"]);
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: [{ ...first[0], status: "idle", active_at: NOW - 1_000 }, first[1], { ...first[2], status: "working", active_at: NOW - 400 }] } }));
    expect(titles()).toEqual(["Rest two", "Busy one", "Rest one"]);
  });
});

describe("a file change waiting on you", () => {
  it("says how big it is on the card", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat()], waiting: [waiting({ request_id: "e1", tool_name: "Edit", input: { file_path: "/p/a.ts", old_string: "a", new_string: "b\nc" } })] });
    expect(screen.getByTestId("deck-change")).toHaveTextContent(/^\+2 −1 lines/);
  });
});

describe("the plan usage on Home", () => {
  it("opens the usage in full when pressed", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat()], plan: { used: 0.4, resetsAt: null, status: "allowed" } });
    await fireEvent.press(screen.getByRole("button", { name: /Session: 40 percent/ }));
    expect(await screen.findByText("Usage")).toBeTruthy();
  });
});
