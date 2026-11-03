import { Linking, StyleSheet } from "react-native";
import { act, fireEvent, screen, within } from "@testing-library/react-native";
import type { RemoteWork } from "../protocol/generated/RemoteWork";
import type { RemoteWorkItem } from "../protocol/generated/RemoteWorkItem";
import { attachSession } from "../test/fakeSession";
import { chat, connectedWith, makeController, NOW, renderWith } from "../test/render";
import { HomeScreen } from "./HomeScreen";

let mockMode: "desk" | "work" | "chats" = "work";
let mockGrouping: "auto" | "feature" | "project" | "none" = "auto";
const mockSaveGrouping = jest.fn(async (g: "feature" | "project" | "none") => {
  mockGrouping = g;
});
jest.mock("../prefs", () => ({
  ...jest.requireActual("../prefs"),
  loadHomeMode: jest.fn(async () => mockMode),
  saveHomeMode: jest.fn(async (m: "desk" | "work" | "chats") => {
    mockMode = m;
  }),
  loadWorkGrouping: jest.fn(async () => mockGrouping),
  saveWorkGrouping: (g: "feature" | "project" | "none") => mockSaveGrouping(g),
  loadGrouping: jest.fn(async () => "recent"),
  saveGrouping: jest.fn(async () => {}),
  loadFolded: jest.fn(async () => []),
  saveFolded: jest.fn(async () => {}),
  loadSeen: jest.fn(async () => ({})),
  saveSeen: jest.fn(async () => {}),
  loadSuggestionPrefs: jest.fn(async () => ({ collapsed: true, dismissed: [] as string[] })),
  saveSuggestionPrefs: jest.fn(async () => {}),
}));
jest.mock("../deskLog", () => ({ loadDeskLog: jest.fn(async () => []), saveDeskLog: jest.fn(async () => {}), forgetDeskLog: jest.fn(async () => {}) }));

beforeEach(() => {
  mockMode = "work";
  mockGrouping = "auto";
  mockSaveGrouping.mockClear();
});

const item = (key: string, over: Partial<RemoteWorkItem> = {}): RemoteWorkItem => ({ key, repo: "lantern", title: `Work ${key}`, stage: "checks", tone: "wait", word: "Checks running", meta: "lantern · b", at: null, number: null, feature: null, issue: null, url: null, sig: "s", step_only: false, fold: null, next: null, ...over });
const step = (what = "Fix failing checks on", over: Partial<NonNullable<RemoteWorkItem["next"]>> = {}) => ({ what, yours: false, button: "Do it", warn: false, ...over });

const work: RemoteWork = {
  issues: true,
  looked: true,
  blind: [],
  items: [
    item("pr7", { number: 7, title: "Retry fetchJson", tone: "bad", word: "Checks failing", feature: "Reliability", issue: "ENG-1", meta: "ENG-1 Retry on 429 · Reliability · lantern", url: "https://github.com/aly/lantern/pull/7", sig: "checks:fail", next: step() }),
    item("pr8", { number: 8, title: "Cache settings", tone: "you", stage: "merge", word: "Ready to merge", feature: "Reliability", issue: "ENG-2", next: step("Merge", { yours: true, button: "Merge…" }) }),
    item("eng5", { title: "ENG-5 Rate limit", tone: "todo", stage: "issue", word: "Todo", feature: "Dashboard", issue: "ENG-5", repo: "web", url: "https://linear.app/a/issue/ENG-5", next: step("Start", { button: "Start" }) }),
    item("pr9", { number: 9, title: "Old merged", tone: "done", stage: "release", word: "Released", repo: "web", meta: "web · merged {ago}", at: NOW - 2 * 3_600_000 }),
  ],
};

async function open(answers: Record<string, unknown> = {}, features = ["desk", "work"]) {
  const { controller } = makeController();
  const session = attachSession(controller, { work, ...answers }, features);
  await renderWith(<HomeScreen onOpenChat={jest.fn()} onReview={jest.fn()} onOpenMac={jest.fn()} onCompose={jest.fn()} onNewChat={jest.fn()} onSupport={jest.fn()} />, { connection: connectedWith(features), chats: [chat({ slot: "a" })] }, controller);
  await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  return { session, controller };
}

const card = (name: string) => within(screen.getByLabelText(name));

describe("Your work on the phone", () => {
  it("is a switch beside the Desk and the chats for a Mac that has it, with how many steps wait, and not for one that doesn't", async () => {
    await open();
    expect(screen.getByRole("tab", { name: "Work, 3 to do" })).toBeTruthy();
    expect(screen.getByLabelText("Your work")).toBeTruthy();
  });

  it("has its bar float over the list, which starts below the bar once it is measured", async () => {
    await open();
    const start = () => StyleSheet.flatten(screen.getByLabelText("Your work").props.contentContainerStyle).paddingTop;
    const before = start();
    // The bar takes no touches itself (it only passes them to what is in it), so the event goes to its handler directly.
    await act(async () => {
      screen.getByTestId("work-bar").props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 120 } } });
    });
    expect(start()).toBe(132);
    expect(before).not.toBe(132);
  });

  it("draws a merge that goes around the required review as Bypass & merge, outlined, and says what it does", async () => {
    const bypass = item("pr10", { number: 10, title: "Unreviewed", tone: "you", stage: "review", word: "Not approved", next: step("Bypass review and merge", { yours: true, warn: true, button: "Bypass & merge…" }) });
    await open({ work: { ...work, items: [...work.items, bypass] } });
    const button = card("Next").getByRole("button", { name: "Bypass review and merge #10" });
    expect(button.props.accessibilityHint).toMatch(/past the required review/);
    expect(StyleSheet.flatten(button.props.style)).toMatchObject({ borderWidth: 1 });
    // The plain merge keeps its usual look.
    const plain = card("Next").getByRole("button", { name: "Merge #8" });
    expect(StyleSheet.flatten(plain.props.style).borderWidth).toBeUndefined();
  });

  it("folds Ready items into one line that opens to them, and a feature's Done ones too", async () => {
    const ready = (key: string) => item(key, { title: `Ready ${key}`, tone: "wait", stage: "release", word: "Ready", feature: "Reliability", issue: key.toUpperCase(), fold: "ready" });
    const done = (key: string) => item(key, { title: `Finished ${key}`, tone: "done", stage: "release", word: "Done", feature: "Reliability", issue: key.toUpperCase(), fold: "done" });
    await open({ work: { ...work, items: [...work.items, ready("r1"), ready("r2"), done("d1"), done("d2")] } });
    const stand = () => card("Where things stand");
    expect(stand().getByRole("button", { name: "2 Ready · merged, waiting for a release" })).toBeTruthy();
    expect(stand().getByRole("button", { name: "2 Done" })).toBeTruthy();
    expect(stand().queryByText(/Ready r1/)).toBeNull();
    await fireEvent.press(stand().getByRole("button", { name: "2 Ready · merged, waiting for a release" }));
    expect(stand().getByText(/Ready r1/)).toBeTruthy();
    expect(stand().getByText(/Ready r2/)).toBeTruthy();
    // The Done ones stay folded until they are asked for.
    expect(stand().queryByText(/Finished d1/)).toBeNull();
    // Looking at a state (done) shows its rows, not a fold.
    await fireEvent.press(stand().getByRole("button", { name: "done 3" }));
    expect(stand().getByText(/Finished d1/)).toBeTruthy();
  });

  it("is not offered by a Mac that lists no work, which keeps the Desk", async () => {
    await open({}, ["desk"]);
    expect(screen.queryByRole("tab", { name: /^Work/ })).toBeNull();
    expect(screen.queryByLabelText("Your work")).toBeNull();
    expect(screen.getByRole("tab", { name: "Desk" })).toBeTruthy();
  });

  it("shows Next with what is yours first, and where things stand grouped by feature with Linear", async () => {
    const clock = jest.spyOn(Date, "now").mockReturnValue(NOW);
    await open();
    const next = card("Next");
    expect(next.getByText(/Merge .*Cache settings/)).toBeTruthy();
    expect(next.getByText(/Fix failing checks on/)).toBeTruthy();
    const stand = card("Where things stand");
    expect(stand.getByRole("button", { name: "Reliability" })).toBeTruthy();
    expect(stand.getByRole("button", { name: "Dashboard" })).toBeTruthy();
    expect(stand.getByRole("button", { name: "No feature" })).toBeTruthy();
    // Under its feature's heading a row doesn't say the feature again.
    expect(stand.queryByText("ENG-1 Retry on 429 · Reliability · lantern")).toBeNull();
    // ...but it still names the issue it is the work of.
    expect(stand.getByText("ENG-1 Retry on 429 · lantern")).toBeTruthy();
    // A time the Mac left out is filled in here.
    expect(stand.getByText("web · merged 2 h ago")).toBeTruthy();
    clock.mockRestore();
  });

  it("groups by project without Linear, with feature switched off", async () => {
    await open({ work: { ...work, issues: false, items: work.items.map((i) => ({ ...i, feature: null, issue: null })) } });
    const stand = card("Where things stand");
    expect(stand.getByRole("button", { name: "lantern" })).toBeTruthy();
    expect(stand.getByRole("button", { name: "web" })).toBeTruthy();
    expect(stand.getByRole("radio", { name: "Feature" }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(stand.getByRole("radio", { name: "Project" }).props.accessibilityState).toMatchObject({ checked: true });
  });

  it("remembers how it is grouped, and folds a group away", async () => {
    await open();
    const stand = card("Where things stand");
    await fireEvent.press(stand.getByRole("radio", { name: "Project" }));
    expect(mockSaveGrouping).toHaveBeenCalledWith("project");
    expect(card("Where things stand").getByRole("button", { name: "web" })).toBeTruthy();
    expect(card("Where things stand").getByText(/Cache settings/)).toBeTruthy();
    await fireEvent.press(card("Where things stand").getByRole("button", { name: "lantern" }));
    expect(card("Where things stand").queryByText(/Cache settings/)).toBeNull();
  });

  it("shows only the states chosen, and all again on asking", async () => {
    await open();
    await fireEvent.press(card("Where things stand").getByRole("button", { name: "blocked 1" }));
    const stand = card("Where things stand");
    expect(stand.getByText(/Retry fetchJson/)).toBeTruthy();
    expect(stand.queryByText(/Cache settings/)).toBeNull();
    await fireEvent.press(stand.getByRole("button", { name: "Show all" }));
    expect(card("Where things stand").getByText(/Cache settings/)).toBeTruthy();
  });

  it("asks the Mac to do a step by its key and what it showed, sends no words, and says where it went", async () => {
    const { session } = await open({ work_step: { kind: "sent", to: "Fix the checks" } });
    await fireEvent.press(card("Next").getByRole("button", { name: "Fix failing checks on #7" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(session.lastOf("work_step")).toEqual({ op: "work_step", key: "pr7", sig: "checks:fail" });
    expect(session.asked.filter((r) => r.op === "send" || r.op === "new_chat")).toEqual([]);
    expect(card("Next").getByText("Sent to “Fix the checks”")).toBeTruthy();
    expect(card("Next").queryByRole("button", { name: "Fix failing checks on #7" })).toBeNull();
  });

  it("says a step that gets prepared in a chat asks before anything happens, and where a new chat was started", async () => {
    await open({ work_step: { kind: "started", to: "lantern" } });
    await fireEvent.press(card("Next").getByRole("button", { name: "Merge #8" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(card("Next").getByText("Started a chat in lantern. It asks you before anything happens.")).toBeTruthy();
  });

  it("says why when the Mac refuses a step, and lets it be asked again", async () => {
    await open({ work_step: new Error("That moved on since you looked. Look again.") });
    await fireEvent.press(card("Next").getByRole("button", { name: "Fix failing checks on #7" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(card("Next").getByText("That moved on since you looked. Look again.")).toBeTruthy();
    expect(card("Next").getByRole("button", { name: "Fix failing checks on #7" })).toBeTruthy();
  });

  it("lists every step of Next in a sheet from Show more, and a step is asked from it as from the card", async () => {
    const more = ["a", "b", "c"].map((k, n) => item(`more-${k}`, { number: 20 + n, title: `More ${k}`, tone: "bad", sig: `m${n}`, next: step("Fix failing checks on") }));
    const { session } = await open({ work: { ...work, items: [...work.items, ...more] }, work_step: { kind: "sent", to: "Fix the checks" } });
    expect(card("Next").queryByText(/More c/)).toBeNull();
    await fireEvent.press(card("Next").getByRole("button", { name: "Show 3 more" }));
    const all = within(screen.getByLabelText("All next steps"));
    expect(all.getByText(/More c/)).toBeTruthy();
    expect(all.getAllByRole("button", { name: /^(Fix failing checks on|Merge|Start)/ })).toHaveLength(6);
    await fireEvent.press(all.getByRole("button", { name: "Fix failing checks on #22" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(session.lastOf("work_step")).toEqual({ op: "work_step", key: "more-c", sig: "m2" });
    expect(all.getByText("Sent to “Fix the checks”")).toBeTruthy();
  });

  it("asks the Mac to look again on Refresh", async () => {
    const { session } = await open();
    await fireEvent.press(card("Next").getByRole("button", { name: "Refresh" }));
    expect(session.lastOf("work_refresh")).toEqual({ op: "work_refresh" });
  });

  it("opens a pull request or issue page, and never a link that isn't on GitHub or Linear", async () => {
    const open_ = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const evil = { ...work, items: [...work.items, item("x", { title: "Sneaky", tone: "bad", url: "https://evil.example/https://github.com/", next: step() })] };
    await open({ work: evil });
    await fireEvent.press(card("Next").getByRole("link", { name: /Retry fetchJson/ }));
    expect(open_).toHaveBeenCalledWith("https://github.com/aly/lantern/pull/7");
    expect(card("Next").queryByRole("link", { name: /Sneaky/ })).toBeNull();
    expect(card("Next").getByText(/Sneaky/)).toBeTruthy();
    open_.mockRestore();
  });

  it("says when nothing is open", async () => {
    await open({ work: { issues: false, looked: true, blind: [], items: [] } });
    expect(card("Next").getByText(/Nothing open/)).toBeTruthy();
    expect(screen.queryByLabelText("Where things stand")).toBeNull();
  });

  it("doesn't say nothing is open before the Mac has looked, or when it couldn't tell whose pull requests are yours", async () => {
    await open({ work: { issues: false, looked: false, blind: [], items: [] } });
    expect(card("Next").getByText(/Your Mac hasn't looked yet/)).toBeTruthy();
    expect(card("Next").queryByText(/Nothing open/)).toBeNull();
  });

  it("says which repositories it couldn't tell the owner of, with the work it could list", async () => {
    await open({ work: { ...work, blind: ["lantern", "web"] } });
    expect(card("Next").getByText(/Couldn't tell which GitHub account is yours in lantern, web/)).toBeTruthy();
    expect(card("Next").getByText(/Merge .*Cache settings/)).toBeTruthy();
  });
});
