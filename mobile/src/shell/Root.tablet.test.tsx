import "@shopify/flash-list/jestSetup";
import { BackHandler } from "react-native";
import { StyleSheet } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { loadSidebarPinned, saveChangesShare, saveSidebarPinned } from "../prefs";
import { attachSession } from "../test/fakeSession";
import { chat, connectedWith, makeController, seed, waiting } from "../test/render";
import { Root } from "./Root";
import type { Layout } from "../view/layout";

jest.mock("expo-camera", () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: false, canAskAgain: true }, jest.fn()] }));
jest.mock("expo-clipboard", () => ({ getStringAsync: jest.fn(async () => "") }));

// The layout is what the window's size says; a test says it directly. Whether the chats are pinned is what this tablet remembers.
let mockLayout: Layout = "split";
// null: never chosen on this tablet, so the window decides.
let mockPinned: boolean | null = false;
// The share of the width the Changes were last dragged to: none until they were.
let mockShare: number | null = null;
jest.mock("./useLayout", () => ({ useLayout: () => mockLayout }));
jest.mock("../prefs", () => ({ ...jest.requireActual("../prefs"), loadSidebarPinned: jest.fn(async () => mockPinned), saveSidebarPinned: jest.fn(async () => {}), loadChangesShare: jest.fn(async () => mockShare), saveChangesShare: jest.fn(async () => {}) }));

// How wide the window is: the Changes pane has room beside the chat only in a wide one.
let mockWidth = 1100;
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({ __esModule: true, default: () => ({ width: mockWidth, height: 800, scale: 2, fontScale: 1 }) }));

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

async function open(s: Parameters<typeof seed>[1]) {
  const { controller } = makeController();
  seed(controller, s);
  const session = attachSession(controller, { list_waiting: s.waiting ?? [] });
  const view = await render(<Root controller={controller} />);
  await settle();
  return { controller, view, ...session };
}

type BackHandlerFn = Parameters<typeof BackHandler.addEventListener>[1];
let backHandlers: BackHandlerFn[] = [];
beforeEach(() => {
  backHandlers = [];
  mockPinned = false;
  mockShare = null;
  mockWidth = 1100;
  (saveSidebarPinned as jest.Mock).mockClear();
  (saveChangesShare as jest.Mock).mockClear();
  jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, cb) => {
    backHandlers.push(cb);
    return { remove: () => void (backHandlers = backHandlers.filter((h) => h !== cb)) };
  });
});

// The chats' column when it is slid away is hidden from the screen reader, so it is asked for as hidden.
const column = () => screen.getByTestId("chats-column", { hidden: true });
const press = (name: string | RegExp) => fireEvent.press(screen.getByRole("button", { name }));
const two = [chat({ slot: "a", title: "Release 0.1.53" }), chat({ slot: "b", title: "Fix the footer", project: "site" })];
/** A tablet that is already in a chat, with the chats slid away. */
async function openInAChat() {
  const rig = await open({ chats: two });
  await press(/Release 0.1.53/);
  await settle();
  return rig;
}

describe("the screens before the chats, on a tablet", () => {
  beforeEach(() => {
    mockLayout = "overlay";
  });

  it("gives the pairing screen its own narrow column, camera and all, not the words-on-paper column", async () => {
    await open({ connection: { kind: "unpaired" } });
    expect(screen.getByText("Pair with your Mac")).toBeTruthy();
    expect(screen.getByTestId("pair-column")).toBeTruthy();
    expect(screen.queryByTestId("narrow-column")).toBeNull();
  });

  it("keeps the words-on-paper screens in a readable column in the middle", async () => {
    await open({ connection: { kind: "offline", reason: "Can't reach Aly's Mac.", retryInMs: 1000 }, chats: [] });
    expect(screen.getByText("Can't reach your Mac")).toBeTruthy();
    expect(screen.getByTestId("narrow-column")).toBeTruthy();
  });
});

describe("a tablet with the chats pinned", () => {
  beforeEach(() => {
    mockLayout = "split";
    mockPinned = true;
  });

  it("has the chats beside the chat, and asks to pick one until one is", async () => {
    await open({ chats: two });
    expect(column()).toBeTruthy();
    expect(screen.getByTestId("pick-a-chat")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show chats" })).toBeNull();
  });

  describe("with no Desk", () => {
    const item = { key: "pr7", repo: "lantern", title: "Retry fetchJson", stage: "checks", tone: "bad", word: "Checks failing", meta: "lantern · b", at: null, number: 7, feature: null, issue: null, url: null, sig: "s", step_only: false, fold: null, next: { what: "Fix failing checks on", yours: false, button: "Do it", warn: false }, issue_url: null, branch: null, stack: null, chat: null };
    const withFeatures = async (features: string[]) => {
      const { controller } = makeController();
      seed(controller, { chats: two, connection: connectedWith(features) });
      attachSession(controller, { list_waiting: [], work: { issues: false, looked: true, blind: [], items: [item] } }, features);
      await render(<Root controller={controller} />);
      await settle();
    };

    it("opens on Your work where no chat is open, for a Mac that has it, and lists Work, not a Desk, above the chats", async () => {
      await withFeatures(["desk", "work"]);
      expect(screen.getByLabelText("Your work")).toBeTruthy();
      expect(screen.queryByTestId("pick-a-chat")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Desk/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Work, 1 waiting" }).props.accessibilityState).toMatchObject({ selected: true });
    });

    it("shows a chat in its place when one is picked, and Work again from its row", async () => {
      await withFeatures(["desk", "work"]);
      await press(/Release 0.1.53/);
      await settle();
      expect(screen.queryByLabelText("Your work")).toBeNull();
      expect(screen.getByRole("button", { name: "Work, 1 waiting" }).props.accessibilityState).toMatchObject({ selected: false });
      await press("Work, 1 waiting");
      await settle();
      expect(screen.getByLabelText("Your work")).toBeTruthy();
    });

    it("goes back to Work when the chat shown is closed (from the chats beside it, or on the Mac), instead of keeping a dead chat", async () => {
      const { controller } = makeController();
      seed(controller, { chats: two, connection: connectedWith(["desk", "work"]) });
      attachSession(controller, { list_waiting: [], work: { issues: false, looked: true, blind: [], items: [item] } }, ["desk", "work"]);
      await render(<Root controller={controller} />);
      await settle();
      await press(/Release 0.1.53/);
      await settle();
      expect(screen.queryByLabelText("Your work")).toBeNull();
      // Another chat going changes nothing.
      await act(async () => controller.sync.onPushed({ type: "chats", chats: two }));
      await settle();
      expect(screen.queryByLabelText("Your work")).toBeNull();
      await act(async () => controller.sync.onPushed({ type: "chats", chats: [two[1]] }));
      await settle();
      expect(screen.getByLabelText("Your work")).toBeTruthy();
    });

    it("keeps the chat shown through a Mac that started again, whose first list may not have it back yet", async () => {
      const { controller } = makeController();
      seed(controller, { chats: two, connection: connectedWith(["desk", "work"]) });
      attachSession(controller, { list_waiting: [], work: { issues: false, looked: true, blind: [], items: [item] } }, ["desk", "work"]);
      await render(<Root controller={controller} />);
      await settle();
      await press(/Release 0.1.53/);
      await settle();
      await act(async () => {
        controller.sync.apply({ type: "welcome", epoch: 999 });
        controller.sync.flush();
      });
      await act(async () => controller.sync.onPushed({ type: "chats", chats: [two[1]] }));
      await settle();
      expect(screen.queryByLabelText("Your work")).toBeNull();
    });

    it("keeps a chat shown that the list doesn't have yet (one just started), rather than throwing it away", async () => {
      const { controller } = makeController();
      seed(controller, { chats: two, connection: connectedWith(["desk", "work"]) });
      attachSession(controller, { list_waiting: [], work: { issues: false, looked: true, blind: [], items: [item] } }, ["desk", "work"]);
      await render(<Root controller={controller} openSlot="new" onOpened={jest.fn()} />);
      await settle();
      await act(async () => controller.sync.onPushed({ type: "chats", chats: [...two] }));
      await settle();
      expect(screen.queryByLabelText("Your work")).toBeNull();
    });

    it("asks to pick a chat, with no Desk to open, for a Mac with a Desk and no work", async () => {
      await withFeatures(["desk"]);
      expect(screen.getByTestId("pick-a-chat")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^(Desk|Work)/ })).toBeNull();
    });
  });

  it("slides them in instead, keeping the pin, in a window too narrow for them and a readable chat (an upright 11-inch)", async () => {
    mockLayout = "overlay";
    mockWidth = 820;
    await openInAChat();
    expect(column().props.pointerEvents).toBe("none");
    expect(screen.getByRole("button", { name: "Show chats" })).toBeTruthy();
    await press("Show chats");
    // No pin offered where it couldn't sit beside the chat, and the one chosen is not forgotten.
    expect(screen.queryByRole("button", { name: /^(Pin|Unpin) the chats/ })).toBeNull();
    expect(saveSidebarPinned).not.toHaveBeenCalled();
  });

  it("keeps them beside the chat upright too: pinned is the user's choice, not the window's", async () => {
    mockLayout = "overlay";
    await open({ chats: two });
    expect(column().props.pointerEvents).toBe("auto");
    expect(screen.queryByTestId("chats-edge", { hidden: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close chats" })).toBeNull();
  });

  it("shows a chat in place when it is picked, marks it, and replaces it with the next instead of stacking", async () => {
    const { lastOf } = await open({ chats: two });
    await press(/Release 0.1.53/);
    await settle();
    expect(screen.queryByTestId("pick-a-chat")).toBeNull();
    expect(lastOf("subscribe")).toMatchObject({ slot: "a" });
    // The chats are still there, and the open one says it is selected.
    expect(screen.getByRole("button", { name: /Release 0.1.53/ }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByRole("button", { name: /Fix the footer/ }).props.accessibilityState).toMatchObject({ selected: false });
    // Nothing leads back: the chats are not behind it.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show chats" })).toBeNull();
    await press(/Fix the footer/);
    await settle();
    expect(lastOf("subscribe")).toMatchObject({ slot: "b" });
    expect(screen.getByRole("button", { name: /Fix the footer/ }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByRole("button", { name: /Release 0.1.53/ }).props.accessibilityState).toMatchObject({ selected: false });
  });

  it("reviews a prompt over its own chat, even when another chat is open, and lands in that chat when it is closed", async () => {
    await open({ chats: two, waiting: [waiting({ slot: "b", request_id: "p9" })] });
    await press(/Release 0.1.53/);
    await settle();
    await press("Review");
    expect(screen.getByTestId("decision-pane")).toBeTruthy();
    expect(screen.getByLabelText("Swipe to allow")).toBeTruthy();
    // The chat and its pane under it are out of the screen reader's reach until it is done.
    expect(screen.getByTestId("detail-under", { includeHiddenElements: true }).props.accessibilityElementsHidden).toBe(true);
    await press("Deny");
    await waitFor(() => expect(screen.getByText("Denied.")).toBeTruthy());
    await press("Done");
    await settle();
    expect(screen.queryByTestId("decision-pane")).toBeNull();
    expect(screen.getByRole("button", { name: /Fix the footer/ }).props.accessibilityState).toMatchObject({ selected: true });
  });

  it("the system's back button closes the chat, and then leaves the app", async () => {
    await open({ chats: two });
    await press(/Release 0.1.53/);
    await settle();
    await act(async () => void backHandlers[backHandlers.length - 1]({ nativeEvent: {} } as never));
    await settle();
    expect(screen.getByTestId("pick-a-chat")).toBeTruthy();
    // Nothing left to go back to: the handler lets the system have the button.
    let handled = true;
    await act(async () => void (handled = backHandlers[backHandlers.length - 1]({ nativeEvent: {} } as never) as boolean));
    expect(handled).toBe(false);
  });

  it("has one button for the chats at a time: the list's, and none in the chat's header", async () => {
    await openInAChat();
    expect(screen.getByRole("button", { name: "Unpin the chats" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(Show|Hide) chats$/ })).toBeNull();
  });

  it("takes the chats away from the list's own button, so the chat has the whole width, and it is remembered", async () => {
    await openInAChat();
    await press("Unpin the chats");
    await settle();
    expect(saveSidebarPinned).toHaveBeenCalledWith(false);
    expect(column().props.pointerEvents).toBe("none");
    expect(screen.queryByRole("button", { name: "Close chats" })).toBeNull();
    // The chat's header has the chats' button now, and the list's is gone with the list.
    expect(screen.getByRole("button", { name: "Show chats" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pin the chats/ })).toBeNull();
    await press("Show chats");
    await settle();
    expect(column().props.pointerEvents).toBe("auto");
    expect(screen.getByRole("button", { name: "Pin the chats beside the chat" })).toBeTruthy();
    // Slid in, the list's button is the only one: the chat's is out of sight.
    expect(screen.queryByRole("button", { name: "Show chats" })).toBeNull();
  });
});

describe("the changed files, beside the chat or over it", () => {
  const edited = [
    { kind: "user_text" as const, text: "Fix it.", at: 1_000_000, sent_by: "desktop" },
    { kind: "tool_started" as const, tool_use_id: "t1", name: "Edit", summary: "a.ts" },
    { kind: "file_edited" as const, tool_use_id: "t1", path: "/p/src/a.ts", created: false, added: 3, removed: 1 },
  ];
  const openEdited = async () => {
    const rig = await open({ chats: two, events: { a: edited } });
    await press(/Release 0.1.53/);
    await settle();
    return rig;
  };
  const paneUp = () => screen.queryByTestId("changes-pane");

  beforeEach(() => {
    mockLayout = "split";
    mockWidth = 1100;
  });

  it("are beside the chat while the chats are away, and the Changes button shows and hides them", async () => {
    mockPinned = false;
    await openEdited();
    expect(paneUp()).toBeTruthy();
    expect(screen.queryByText(/^Changes ·/)).toBeNull();
    await press("Changes");
    expect(paneUp()).toBeNull();
    await press("Changes");
    expect(paneUp()).toBeTruthy();
    // The pane's own Hide puts it away too, and the button brings it back: a button, not a word over the chat's header.
    await press("Hide");
    expect(paneUp()).toBeNull();
    expect(screen.queryByText(/^Changes ·/)).toBeNull();
    await press("Changes");
    expect(paneUp()).toBeTruthy();
  });

  it("are a sheet over the chat while the chats are beside it, however wide the window", async () => {
    mockPinned = true;
    mockWidth = 1400;
    await openEdited();
    expect(paneUp()).toBeNull();
    await press("Changes");
    expect(paneUp()).toBeTruthy();
    await press("Close");
    expect(paneUp()).toBeNull();
  });

  it("are a sheet in a window too narrow for both, even with the chats away", async () => {
    mockPinned = false;
    mockWidth = 800;
    await openEdited();
    expect(paneUp()).toBeNull();
    await press("Changes");
    expect(paneUp()).toBeTruthy();
  });

  const paneWidth = () => StyleSheet.flatten(screen.getByTestId("changes-dock").props.style).width;

  it("take half the width beside the chat at first, and the share they were last dragged to once it is read", async () => {
    await openEdited();
    expect(paneWidth()).toBe(550);
    mockShare = 0.4;
    await openEdited();
    expect(paneWidth()).toBe(440);
  });

  it("are made narrower from their divider, and that is remembered", async () => {
    await openEdited();
    await act(async () => void fireEvent(screen.getByLabelText("Width of the changes"), "accessibilityAction", { nativeEvent: { actionName: "decrement" } }));
    expect(paneWidth()).toBe(495);
    expect(saveChangesShare).toHaveBeenCalledWith(0.45);
  });

  it("float over the chat as a card from their own button, and go back beside it", async () => {
    await openEdited();
    await press("Float the changes over the chat");
    expect(paneUp()).toBeTruthy();
    expect(screen.queryByTestId("changes-divider")).toBeNull();
    await press("Put the changes beside the chat");
    expect(paneUp()).toBeTruthy();
    expect(screen.getByTestId("changes-divider")).toBeTruthy();
  });

  it("are beside the next chat again, not floated over it as the last chat's were", async () => {
    const { view, controller } = await open({ chats: two, events: { a: edited, b: edited.map((e) => ({ ...e, tool_use_id: "tb" })) } });
    await press(/Release 0.1.53/);
    await settle();
    await press("Float the changes over the chat");
    expect(screen.queryByTestId("changes-divider")).toBeNull();
    // Another chat opened while the card floats (here from a notification; a pinned list or the edge swipe do the same).
    await view.rerender(<Root controller={controller} openSlot="b" onOpened={jest.fn()} />);
    await settle();
    expect(screen.getByTestId("changes-divider")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Put the changes beside the chat" })).toBeNull();
  });

  it("go away with a tap around the floating card, and the Changes button brings them back floating", async () => {
    await openEdited();
    await press("Float the changes over the chat");
    await fireEvent.press(screen.getByTestId("changes-scrim", { includeHiddenElements: true }));
    expect(paneUp()).toBeNull();
    await press("Changes");
    expect(paneUp()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Put the changes beside the chat" })).toBeTruthy();
  });

  it("show a file tapped in the chat in the pane, brought back if it was put away, not in a sheet beside it", async () => {
    mockPinned = false;
    const other = { kind: "file_edited" as const, tool_use_id: "t1", path: "/p/src/b.ts", created: false, added: 1, removed: 0 };
    const said = { kind: "assistant_text" as const, block_id: "x1", text: "Fixed it in `a.ts`." };
    const done = { kind: "turn_done" as const, is_error: false, result: "ok", duration_ms: 9000, context_window: null };
    await open({ chats: two, events: { a: [...edited, other, said, done] } });
    await press(/Release 0.1.53/);
    await settle();
    // The newest edit is shown at first; the pane is put away.
    expect(screen.getByRole("button", { name: /^b\.ts,/ }).props.accessibilityState).toMatchObject({ selected: true });
    await press("Hide");
    expect(paneUp()).toBeNull();
    await fireEvent.press(screen.getByRole("link", { name: "a.ts" }));
    await settle();
    expect(paneUp()).toBeTruthy();
    expect(screen.getByRole("button", { name: /^a\.ts,/ }).props.accessibilityState).toMatchObject({ selected: true });
    // No sheet of what changed over the chat: its Close is the only way to tell it is there.
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("show a file a link names that the chat never changed in the pane too, even in a chat that changed nothing", async () => {
    mockPinned = false;
    const said = { kind: "assistant_text" as const, block_id: "x1", text: "It is in `src/app/Flow.swift:12`." };
    const done = { kind: "turn_done" as const, is_error: false, result: "ok", duration_ms: 9000, context_window: null };
    await open({ chats: two, events: { a: [edited[0], said, done] } });
    await press(/Release 0.1.53/);
    await settle();
    expect(paneUp()).toBeNull();
    await fireEvent.press(screen.getByRole("link", { name: "src/app/Flow.swift:12" }));
    await settle();
    expect(paneUp()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Flow.swift, from a link" }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("show the chat's to-dos in the pane from the chat bar's To-dos, even in a chat that changed nothing", async () => {
    mockPinned = false;
    const { controller } = makeController();
    seed(controller, { chats: two, connection: connectedWith(["todos"]) });
    const { lastOf } = attachSession(controller, { list_waiting: [], projects: [{ id: "/Users/me/lantern", name: "lantern" }], todos: { project: "/Users/me/lantern", name: "lantern", items: [] } }, ["todos"]);
    await render(<Root controller={controller} />);
    await settle();
    await press(/Release 0.1.53/);
    await settle();
    expect(screen.queryByTestId("todos-pane")).toBeNull();
    await press("Tools");
    await press("To-dos");
    await settle();
    expect(screen.getByTestId("todos-pane")).toBeTruthy();
    expect(lastOf("todos")).toMatchObject({ op: "todos" });
    // Beside the chat, not in a sheet over it: the pane has its divider.
    expect(screen.getByTestId("changes-divider")).toBeTruthy();
  });

  it("move from the sheet to the pane as the chats are put away", async () => {
    mockPinned = true;
    await openEdited();
    expect(paneUp()).toBeNull();
    await press("Unpin the chats");
    await settle();
    expect(paneUp()).toBeTruthy();
  });
});

describe("a tablet that was never told whether the chats are pinned", () => {
  beforeEach(() => {
    mockPinned = null;
  });

  // iPadOS decides by the window: beside the content sideways, away upright until asked for. The first time it is asked to
  // change, that is what the tablet keeps.
  it("keeps them beside the chat in a window with the room, flat, and offers to take them away", async () => {
    mockLayout = "split";
    await open({ chats: two });
    expect(column().props.pointerEvents).toBe("auto");
    expect(screen.queryByRole("button", { name: "Close chats" })).toBeNull();
    expect(screen.queryByTestId("chats-edge", { hidden: true })).toBeNull();
    expect(screen.getByRole("button", { name: "Unpin the chats" })).toBeTruthy();
    await press("Unpin the chats");
    await settle();
    expect(saveSidebarPinned).toHaveBeenCalledWith(false);
    expect(column().props.pointerEvents).toBe("none");
    expect(screen.getByRole("button", { name: "Show chats" })).toBeTruthy();
  });

  // A tablet that took the chats away sideways would open on them and slide them off, were the window to decide before the read.
  it("keeps them away until it has read what this tablet chose", async () => {
    mockLayout = "split";
    (loadSidebarPinned as jest.Mock).mockImplementationOnce(() => new Promise(() => {}));
    await open({ chats: two });
    expect(column().props.pointerEvents).toBe("none");
    expect(screen.queryByRole("button", { name: "Unpin the chats" })).toBeNull();
  });

  it("shows the chat with the whole width upright, the chats slid in when asked for", async () => {
    mockLayout = "overlay";
    await openInAChat();
    expect(column().props.pointerEvents).toBe("none");
    expect(screen.getByRole("button", { name: "Show chats" })).toBeTruthy();
    await press("Show chats");
    expect(column().props.pointerEvents).toBe("auto");
    // Slid in, they can be pinned beside the chat even upright: that is the person's choice now.
    await press("Pin the chats beside the chat");
    await settle();
    expect(saveSidebarPinned).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("button", { name: "Close chats" })).toBeNull();
  });
});

describe("a tablet with the chats not pinned", () => {
  beforeEach(() => {
    mockLayout = "split";
    mockPinned = false;
  });

  it("brings the chats back from Work's own bar, which had no way back but the edge swipe", async () => {
    const { controller } = makeController();
    seed(controller, { chats: two, connection: connectedWith(["desk", "work"]) });
    attachSession(controller, { list_waiting: [], work: { items: [] } }, ["desk", "work"]);
    await render(<Root controller={controller} />);
    await settle();
    // The chats slid in at first: Work's button would only open what is open already.
    expect(column().props.pointerEvents).toBe("auto");
    await press("Close chats");
    expect(column().props.pointerEvents).toBe("none");
    await press("Show chats");
    expect(column().props.pointerEvents).toBe("auto");
  });

  it("is not pinned until it is chosen, whichever way the tablet is held: the chat has the whole width", async () => {
    await openInAChat();
    expect(column().props.pointerEvents).toBe("none");
    expect(screen.queryByTestId("pick-a-chat")).toBeNull();
    // The chat's header leads with the chats' button, not a back arrow.
    expect(screen.getByRole("button", { name: "Show chats" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("slides the chats in by themselves when it opens on no chat, rather than an empty screen, and away once one is chosen", async () => {
    const { lastOf } = await open({ chats: two });
    // The empty screen is behind the chats, out of the screen reader's reach.
    expect(screen.getByTestId("pick-a-chat", { hidden: true })).toBeTruthy();
    expect(column().props.pointerEvents).toBe("auto");
    await press(/Release 0.1.53/);
    await settle();
    expect(lastOf("subscribe")).toMatchObject({ slot: "a" });
    expect(column().props.pointerEvents).toBe("none");
  });

  it("only does that once: the chats come in again only when they are asked for", async () => {
    await openInAChat();
    expect(column().props.pointerEvents).toBe("none");
    await settle();
    expect(column().props.pointerEvents).toBe("none");
    await press("Show chats");
    expect(column().props.pointerEvents).toBe("auto");
    await press("Close chats");
    expect(column().props.pointerEvents).toBe("none");
  });

  it("pins them beside the chat from the list's own button, and remembers it", async () => {
    await openInAChat();
    await press("Show chats");
    await press("Pin the chats beside the chat");
    await settle();
    expect(saveSidebarPinned).toHaveBeenCalledWith(true);
    expect(column().props.pointerEvents).toBe("auto");
    // Beside the chat now: nothing to close or pull, and the chat does not lead with the chats' button.
    expect(screen.queryByRole("button", { name: "Close chats" })).toBeNull();
    expect(screen.queryByTestId("chats-edge", { hidden: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show chats" })).toBeNull();
    expect(screen.getByRole("button", { name: "Unpin the chats" })).toBeTruthy();
  });

  it("slides the chats in from the chat's own button, and away again once a chat is picked", async () => {
    const { lastOf } = await openInAChat();
    await press("Show chats");
    expect(column().props.pointerEvents).toBe("auto");
    await press(/Fix the footer/);
    await settle();
    expect(lastOf("subscribe")).toMatchObject({ slot: "b" });
    expect(column().props.pointerEvents).toBe("none");
    // The chat's header still leads with the chats' button, not a back arrow.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    await press("Show chats");
    expect(column().props.pointerEvents).toBe("auto");
    await press("Close chats");
    expect(column().props.pointerEvents).toBe("none");
  });

  it("the system's back button puts the chats away before it goes back a screen", async () => {
    await openInAChat();
    await press("Show chats");
    await act(async () => void backHandlers[backHandlers.length - 1]({ nativeEvent: {} } as never));
    expect(column().props.pointerEvents).toBe("none");
    expect(screen.queryByTestId("pick-a-chat")).toBeNull();
  });
});

describe("a tablet held upright", () => {
  beforeEach(() => {
    mockLayout = "overlay";
    mockPinned = false;
  });

  it("works the same: the chats slid in when asked for, the chat with the whole width", async () => {
    await openInAChat();
    expect(column().props.pointerEvents).toBe("none");
    await press("Show chats");
    expect(column().props.pointerEvents).toBe("auto");
  });
});

describe("turning the tablet", () => {
  it("keeps the chat that is open, and goes back to the phone's stack when the window gets narrow", async () => {
    mockLayout = "split";
    mockPinned = true;
    const { view, controller } = await open({ chats: two });
    await press(/Release 0.1.53/);
    await settle();
    mockLayout = "phone";
    await view.rerender(<Root controller={controller} />);
    await settle();
    // On the phone layout the chat is a screen with a back button, and Home is under it.
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByTestId("chats-column")).toBeNull();
    // A phone has no pin: it is a tablet's.
    expect(screen.queryByRole("button", { name: /Pin the chats|Unpin the chats/ })).toBeNull();
    await press("Back");
    await settle();
    expect(screen.getByText("Nothing")).toBeTruthy();
  });
});

describe("dragging the chats in and out on a tablet with them not pinned", () => {
  beforeEach(() => {
    mockLayout = "overlay";
    mockPinned = false;
  });

  // A finger at (x, 400), at a time in ms.
  const touch = (x: number, t: number, y = 400) => ({ nativeEvent: { pageX: x, pageY: y, timestamp: t } });
  const edge = () => screen.getByTestId("chats-edge", { hidden: true });

  it("brings the chats in when the finger is pulled from the screen's edge far enough", async () => {
    await openInAChat();
    expect(column().props.pointerEvents).toBe("none");
    await fireEvent(edge(), "responderGrant", touch(4, 0));
    await fireEvent(edge(), "responderMove", touch(120, 400));
    await fireEvent(edge(), "responderMove", touch(260, 800));
    await fireEvent(edge(), "responderRelease", touch(260, 800));
    await settle();
    expect(column().props.pointerEvents).toBe("auto");
    // The edge has done its work: it is not in the way of the chats now.
    expect(screen.queryByTestId("chats-edge", { hidden: true })).toBeNull();
  });

  it("leaves a tap or a scroll that begins at the edge to the chat, and takes only a pull to the right that began there", async () => {
    await openInAChat();
    const takes = (fromX: number, x: number, y: number) => {
      edge().props.onStartShouldSetResponderCapture(touch(fromX, 0, 400));
      return edge().props.onMoveShouldSetResponderCapture(touch(x, 0, y));
    };
    // Nothing is taken on the way in: a tap there is the chat's.
    expect(edge().props.onStartShouldSetResponderCapture(touch(4, 0))).toBe(false);
    expect(takes(4, 60, 405)).toBe(true);
    // Up and down, or to the left, from the edge: the chat's own scroll.
    expect(takes(4, 6, 480)).toBe(false);
    expect(takes(10, 2, 400)).toBe(false);
    // A pull to the right that began away from the edge is the chat's too.
    expect(takes(200, 300, 400)).toBe(false);
  });

  it("lets them stay away when the pull was short and slow, and brings them in on a flick however short", async () => {
    await openInAChat();
    await fireEvent(edge(), "responderGrant", touch(4, 0));
    await fireEvent(edge(), "responderMove", touch(70, 900));
    await fireEvent(edge(), "responderRelease", touch(70, 1000));
    await settle();
    expect(column().props.pointerEvents).toBe("none");
    await fireEvent(edge(), "responderGrant", touch(4, 2000));
    await fireEvent(edge(), "responderMove", touch(30, 2020));
    await fireEvent(edge(), "responderRelease", touch(60, 2040));
    await settle();
    expect(column().props.pointerEvents).toBe("auto");
  });

  it("sends them away when they are pulled to the left, and keeps them when the pull comes back", async () => {
    await openInAChat();
    await press("Show chats");
    expect(column().props.pointerEvents).toBe("auto");
    // Pulled a little, slowly, and let go: still there.
    await fireEvent(column(), "startShouldSetResponderCapture", touch(300, 0));
    await fireEvent(column(), "responderGrant", touch(300, 0));
    await fireEvent(column(), "responderMove", touch(270, 900));
    await fireEvent(column(), "responderRelease", touch(270, 1000));
    await settle();
    expect(column().props.pointerEvents).toBe("auto");
    // Pulled most of the way and let go: gone.
    await fireEvent(column(), "startShouldSetResponderCapture", touch(300, 2000));
    await fireEvent(column(), "responderGrant", touch(300, 2000));
    await fireEvent(column(), "responderMove", touch(120, 3000));
    await fireEvent(column(), "responderMove", touch(20, 4000));
    await fireEvent(column(), "responderRelease", touch(20, 4000));
    await settle();
    expect(column().props.pointerEvents).toBe("none");
  });

  it("takes a drag left that nothing under the finger took, only once it is plainly going left", async () => {
    await openInAChat();
    await press("Show chats");
    // Asked on the way out, not on the way in: a row's own left swipe (Close, Read) comes first.
    expect(column().props.onMoveShouldSetResponderCapture).toBeUndefined();
    const steal = (x: number, y: number) => {
      column().props.onStartShouldSetResponderCapture(touch(300, 0, 300));
      return column().props.onMoveShouldSetResponder(touch(x, 0, y));
    };
    expect(steal(250, 305)).toBe(true);
    // Scrolling up and down, a tap that wobbles, and a pull to the right are the list's own.
    expect(steal(298, 380)).toBe(false);
    expect(steal(296, 300)).toBe(false);
    expect(steal(340, 300)).toBe(false);
  });

  it("has no edge to pull from, or column to pull away, when the chats are pinned beside the chat", async () => {
    mockPinned = true;
    await open({ chats: two });
    expect(screen.queryByTestId("chats-edge", { hidden: true })).toBeNull();
    expect(column().props.onMoveShouldSetResponderCapture).toBeUndefined();
    expect(column().props.onMoveShouldSetResponder).toBeUndefined();
  });
});
