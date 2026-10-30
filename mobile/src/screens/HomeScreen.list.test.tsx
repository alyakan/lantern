import { fireEvent, screen } from "@testing-library/react-native";
import { chat, NOW, renderWith } from "../test/render";
import { resetSeen } from "../seen";
import { resetPins, setPinned } from "../pins";
import { HomeScreen } from "./HomeScreen";

// What Home remembers: nothing, here (it is not in the Keychain on Node).
jest.mock("../prefs", () => ({
  // Home as the Desk or the chats: the Desk, as on a phone that never chose (only a Mac that has one shows it).
  loadHomeMode: jest.fn(async () => "desk"),
  saveHomeMode: jest.fn(async () => {}),
  loadGrouping: jest.fn(async () => "recent"),
  saveGrouping: jest.fn(async () => {}),
  loadFolded: jest.fn(async () => []),
  saveFolded: jest.fn(async () => {}),
  loadSeen: jest.fn(async () => null),
  saveSeen: jest.fn(async () => {}),
  loadSuggestionPrefs: jest.fn(async () => ({ collapsed: false, dismissed: [] as string[] })),
  saveSuggestionPrefs: jest.fn(async () => {}),
}));

beforeEach(() => {
  resetSeen();
  resetPins();
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => jest.restoreAllMocks());

const handlers = () => ({ onOpenChat: jest.fn(), onReview: jest.fn(), onOpenMac: jest.fn(), onCompose: jest.fn(), onNewChat: jest.fn(), onSupport: jest.fn() });

describe("a chat's row on Home", () => {
  it("shows the line the Mac sent under the title, and says it to a screen reader", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat({ title: "Storage audit", preview: "Want me to open a PR?" })] });
    expect(screen.getByText("Want me to open a PR?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Storage audit, lantern, Want me to open a PR?" })).toBeTruthy();
  });

  it("is as it was for a Mac that sends no line", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat({ title: "Storage audit" })] });
    expect(screen.getByRole("button", { name: "Storage audit, lantern" })).toBeTruthy();
  });

  it("says how long a working chat has been at it", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat({ title: "Build", status: "working", active_at: NOW - 7 * 60_000, preview: "Bash npm test" })] });
    expect(screen.getByLabelText("Working")).toBeTruthy();
    expect(screen.getByText("7 min")).toBeTruthy();
    expect(screen.getByText("Bash npm test")).toBeTruthy();
  });

  it("marks a pinned chat with a pin, not an emoji, says so, and sets it first under its own label", async () => {
    setPinned("p", true);
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat({ slot: "q", title: "Other", active_at: NOW - 1000 }), chat({ slot: "p", title: "Pinned one", active_at: 5 })] });
    expect(screen.getByRole("button", { name: /^Pinned one.*, pinned$/ })).toBeTruthy();
    expect(screen.queryByText(/📌/)).toBeNull();
    expect(screen.getByText("Pinned")).toBeTruthy();
    const names = screen.getAllByRole("button").map((b) => b.props.accessibilityLabel as string).filter((l) => /Pinned one|Other/.test(l));
    expect(names[0]).toContain("Pinned one");
  });
});

describe("the labelled stretches of the list", () => {
  it("are there once the chats are in more than one", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat({ slot: "n", title: "Asks", status: "needs_you" }), chat({ slot: "i", title: "Idle", active_at: 5 })] });
    expect(screen.getByText("Waiting on you")).toBeTruthy();
    expect(screen.getByText("Earlier")).toBeTruthy();
  });

  it("are left out when every chat is alike", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat({ slot: "a", title: "One" }), chat({ slot: "b", title: "Two", active_at: 5 })] });
    expect(screen.queryByText("Earlier")).toBeNull();
  });
});

describe("searching the chats", () => {
  const many = () => [chat({ slot: "a", title: "Storage audit" }), chat({ slot: "b", title: "Network tab filters", project: "network-monitor", active_at: 5 }), chat({ slot: "c", title: "Release 0.1.71", active_at: 4, preview: "Tagged and drafted" }), chat({ slot: "d", title: "Mobile gateway", active_at: 3 })];

  it("has no search circle while a few chats are all in view", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: many().slice(0, 3) });
    expect(screen.queryByRole("button", { name: "Search chats" })).toBeNull();
  });

  it("narrows the list by what is typed (title, project or preview) and steps the rest of Home aside", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: many() });
    await fireEvent.press(screen.getByRole("button", { name: "Search chats" }));
    await fireEvent.changeText(screen.getByLabelText("Search chats"), "monitor");
    expect(screen.getByText("Network tab filters")).toBeTruthy();
    expect(screen.queryByText("Storage audit")).toBeNull();
    expect(screen.getByText("Results")).toBeTruthy();
    expect(screen.queryByText("Nothing")).toBeNull();
    expect(screen.getByText("1 chat")).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Search chats"), "tagged");
    expect(screen.getByText("Release 0.1.71")).toBeTruthy();
  });

  it("says when nothing answers, and gives the list back when the search is cancelled", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: many() });
    await fireEvent.press(screen.getByRole("button", { name: "Search chats" }));
    await fireEvent.changeText(screen.getByLabelText("Search chats"), "zebra");
    expect(screen.getByText("No chat says that")).toBeTruthy();
    expect(screen.getByText("No match")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Cancel search" }));
    expect(screen.queryByText("No chat says that")).toBeNull();
    expect(screen.getByText("Storage audit")).toBeTruthy();
    expect(screen.getByText("Nothing")).toBeTruthy();
  });

  it("opens the chat that was found", async () => {
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, { chats: many() });
    await fireEvent.press(screen.getByRole("button", { name: "Search chats" }));
    await fireEvent.changeText(screen.getByLabelText("Search chats"), "gateway");
    await fireEvent.press(screen.getByRole("button", { name: /Mobile gateway/ }));
    expect(h.onOpenChat).toHaveBeenCalledWith("d");
  });
});

describe("the empty list", () => {
  it("is a quiet picture with the same words as before", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [] });
    expect(screen.getByText("Quiet in here")).toBeTruthy();
    expect(screen.getByText(/No chats are open on your Mac/)).toBeTruthy();
  });
});
