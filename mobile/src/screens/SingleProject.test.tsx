import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { chat, connectedWith, makeController, renderWith, waiting } from "../test/render";
import { resetSeen } from "../seen";
import { PHONE_FEATURES } from "../net/session";
import { reducer as reduce, initialState } from "../sync/reducer";
import type { RemoteSingle } from "../protocol/generated/RemoteSingle";
import { HomeScreen } from "./HomeScreen";

jest.mock("../prefs", () => ({
  // The chats, not the Desk: One project narrows the list.
  loadHomeMode: jest.fn(async () => "chats"),
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

beforeEach(() => resetSeen());

const handlers = () => ({ onOpenChat: jest.fn(), onReview: jest.fn(), onOpenMac: jest.fn(), onCompose: jest.fn(), onNewChat: jest.fn(), onSupport: jest.fn() });
const IOS: RemoteSingle = { project: "/w/lumiform-ios", name: "lumiform-ios", color: "#0f8a7e" };
const chats = [chat({ slot: "a", title: "Testo pairing", project: "lumiform-ios" }), chat({ slot: "b", title: "Desk polish", project: "lantern" }), chat({ slot: "c", title: "Checklist crash", project: "lumiform-ios" })];

async function home(single: RemoteSingle | null, answers: Parameters<typeof attachSession>[1] = {}) {
  const { controller } = makeController();
  const session = attachSession(controller, answers, ["single"]);
  const view = await renderWith(<HomeScreen {...handlers()} />, { connection: connectedWith(["single"]), chats, waiting: [waiting({ slot: "b", request_id: "p-lantern" })] }, controller);
  if (single) await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "single", single } }));
  return { ...view, session };
}

describe("One project on Home", () => {
  it("lists only the project's chats under a banner of its name, leaving out what other projects wait on", async () => {
    await home(IOS);
    expect(screen.getByLabelText("Only lumiform-ios")).toBeTruthy();
    expect(screen.getByText("Testo pairing")).toBeTruthy();
    expect(screen.getByText("Checklist crash")).toBeTruthy();
    expect(screen.queryByText("Desk polish")).toBeNull();
    // The lantern chat's question isn't on the deck either.
    expect(screen.queryByText(/git push/)).toBeNull();
  });

  it("asks the Mac to show every project again from the banner's ×, and changes nothing until the Mac says so", async () => {
    const { session, controller } = await home(IOS);
    await fireEvent.press(screen.getByRole("button", { name: "Show all projects" }));
    expect(session.lastOf("set_single")).toEqual({ op: "set_single", project: null });
    expect(screen.getByLabelText("Only lumiform-ios")).toBeTruthy();
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "single", single: null } }));
    expect(screen.queryByLabelText("Only lumiform-ios")).toBeNull();
    expect(screen.getByText("Desk polish")).toBeTruthy();
  });

  it("picks one from every project the Mac knows, open or not", async () => {
    const { session } = await home(null, { projects: [{ id: "/w/lantern", name: "lantern" }, { id: "/w/nahar", name: "nahar" }, { id: "/w/lumiform-ios", name: "lumiform-ios" }] });
    await fireEvent.press(screen.getByRole("button", { name: "One project" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "nahar" })).toBeTruthy());
    await fireEvent.press(screen.getByRole("button", { name: "nahar" }));
    expect(session.lastOf("set_single")).toEqual({ op: "set_single", project: "/w/nahar" });
  });

  it("starts a new chat in the project, and offers no suggestions about others", async () => {
    const h = handlers();
    const { controller } = makeController();
    attachSession(controller, { suggest: { suggestions: [], at: 0 } }, ["single"]);
    await renderWith(<HomeScreen {...h} />, { connection: connectedWith(["single"]), chats }, controller);
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "single", single: IOS } }));
    expect(screen.queryByText("Claude suggests")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "New chat" }));
    expect(h.onNewChat).toHaveBeenCalledWith({ text: "", project: "/w/lumiform-ios" });
  });

  it("says so when the project has nothing open", async () => {
    await home({ project: "/w/nahar", name: "nahar", color: null });
    expect(screen.getByText(/Nothing is open in nahar/)).toBeTruthy();
  });

  it("has no picker for a Mac that doesn't share it", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { connection: connectedWith([]), chats });
    expect(screen.queryByRole("button", { name: "One project" })).toBeNull();
  });
});

describe("One project in the phone's state", () => {
  it("is what the Mac last pushed, and forgotten on a new connection until the Mac says it again", () => {
    const told = reduce(initialState, { type: "pushed", msg: { type: "single", single: IOS } });
    expect(told.single).toEqual(IOS);
    const welcomed = reduce({ ...told, epoch: 1 }, { type: "welcome", epoch: 1 });
    expect(welcomed.single).toBeNull();
    expect(reduce({ ...told, epoch: 1 }, { type: "welcome", epoch: 2 }).single).toBeNull();
  });

  it("is asked for in the phone's hello", () => {
    expect(PHONE_FEATURES).toContain("single");
  });
});
