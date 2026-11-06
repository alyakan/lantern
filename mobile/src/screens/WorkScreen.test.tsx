import { Linking, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { act, fireEvent, screen, within } from "@testing-library/react-native";
import type { RemoteWork } from "../protocol/generated/RemoteWork";
import type { RemoteWorkItem } from "../protocol/generated/RemoteWorkItem";
import { attachSession } from "../test/fakeSession";
import { chat, connectedWith, makeController, NOW, renderWith } from "../test/render";
import { BAR_TEXT_SCALE, Txt } from "../ui/components";
import { PhoneTabs } from "./PhoneTabs";
import { WorkScreen } from "./WorkScreen";

let mockTab: "chats" | "work" | "insights" = "work";
jest.mock("../prefs", () => ({
  ...jest.requireActual("../prefs"),
  loadTab: jest.fn(async () => mockTab),
  saveTab: jest.fn(async (t: "chats" | "work" | "insights") => {
    mockTab = t;
  }),
  loadGrouping: jest.fn(async () => "recent"),
  saveGrouping: jest.fn(async () => {}),
  loadFolded: jest.fn(async () => []),
  saveFolded: jest.fn(async () => {}),
  loadSeen: jest.fn(async () => ({})),
  saveSeen: jest.fn(async () => {}),
}));
jest.mock("../deskLog", () => ({ loadDeskLog: jest.fn(async () => []), saveDeskLog: jest.fn(async () => {}), forgetDeskLog: jest.fn(async () => {}) }));

beforeEach(() => {
  mockTab = "work";
});

const item = (key: string, over: Partial<RemoteWorkItem> = {}): RemoteWorkItem => ({ key, repo: "lantern", title: `Work ${key}`, stage: "checks", tone: "wait", word: "Checks running", meta: "lantern · b", at: null, number: null, feature: null, issue: null, url: null, sig: "s", step_only: false, fold: null, next: null, issue_url: null, branch: null, stack: null, chat: null, ...over });
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

async function open(answers: Record<string, unknown> = {}, features = ["desk", "work"], onOpenChat = jest.fn()) {
  const { controller } = makeController();
  const session = attachSession(controller, { work, ...answers }, features);
  await renderWith(<PhoneTabs onOpenChat={onOpenChat} onReview={jest.fn()} onOpenMac={jest.fn()} onCompose={jest.fn()} onNewChat={jest.fn()} onSupport={jest.fn()} onComposeNew={jest.fn()} />, { connection: connectedWith(features), chats: [chat({ slot: "a" })] }, controller);
  await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  return { session, controller };
}

/** Opens a feature's page from its card on the Work screen. */
async function openCard(name: string) {
  await fireEvent.press(screen.getByRole("button", { name: new RegExp(`^${name}, `) }));
  return within(screen.getByLabelText(name));
}

describe("Your work on a tablet", () => {
  it("says Work in its bar and nowhere under it, and holds the bar to the page's column", async () => {
    const { controller } = makeController();
    attachSession(controller, { work }, ["desk", "work"]);
    await renderWith(<WorkScreen top={<Txt>Work</Txt>} wide onOpenChat={jest.fn()} />, { connection: connectedWith(["desk", "work"]), chats: [chat({ slot: "a" })] }, controller);
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    // The bar is the one headline: the list under it has no big "Work" of its own (a phone's does).
    expect(screen.queryByRole("header", { name: "Work" })).toBeNull();
    expect(within(screen.getByTestId("work-bar")).getByText("Work")).toBeTruthy();
    // And the bar is on the list's column, not the window's: the cards' width, centered, not a second wider edge.
    const column = screen.getByTestId("work-bar").children[0] as unknown as { props: { style: StyleProp<ViewStyle> } };
    expect(StyleSheet.flatten(column.props.style)).toMatchObject({ maxWidth: 640, alignSelf: "center" });
    // A feature's page bar rides the same column.
    await fireEvent.press(screen.getByRole("button", { name: /^Reliability, / }));
    const row = screen.getByTestId("work-page-bar").children[0] as unknown as { props: { style: StyleProp<ViewStyle> } };
    expect(StyleSheet.flatten(row.props.style)).toMatchObject({ maxWidth: 640, alignSelf: "center" });
  });

  it("keeps the tablet's own header on a feature's page, beside the way back, and the list's copy of it is out of reach", async () => {
    const { controller } = makeController();
    attachSession(controller, { work }, ["desk", "work"]);
    await renderWith(<WorkScreen top={<Txt>Chats header</Txt>} wide onOpenChat={jest.fn()} />, { connection: connectedWith(["desk", "work"]), chats: [chat({ slot: "a" })] }, controller);
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    await fireEvent.press(screen.getByRole("button", { name: /^Reliability, / }));
    const bar = within(screen.getByTestId("work-page-bar"));
    expect(bar.getByRole("button", { name: "Back to Work" })).toBeTruthy();
    expect(bar.getByText("Chats header")).toBeTruthy();
    // The list stays mounted under the page, with its own bar: only the page's is there for a reader to find.
    expect(screen.getAllByText("Chats header")).toHaveLength(1);
  });
});

describe("Your work on the phone", () => {
  it("is a tab beside the chats for a Mac that has it, with how many steps wait", async () => {
    await open();
    expect(screen.getByRole("tab", { name: "Work, 3 waiting" }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByLabelText("Your work")).toBeTruthy();
  });

  it("is its own headline, with no bar over the list", async () => {
    await open();
    expect(screen.getByRole("header", { name: "Work" })).toBeTruthy();
    expect(screen.queryByTestId("work-bar")).toBeNull();
    // The list starts below the clock rather than below a bar.
    const start = StyleSheet.flatten(screen.getByLabelText("Your work").props.contentContainerStyle).paddingTop;
    expect(start).toBeGreaterThan(0);
  });

  it("is not offered by a Mac that lists no work, which opens on the chats", async () => {
    await open({}, ["desk"]);
    expect(screen.queryByRole("tab", { name: /^Work/ })).toBeNull();
    expect(screen.queryByLabelText("Your work")).toBeNull();
    expect(screen.getByRole("tab", { name: /^Chats/ }).props.accessibilityState).toMatchObject({ selected: true });
  });

  it("goes to the chats from the tab bar, and is remembered there", async () => {
    await open();
    await fireEvent.press(screen.getByRole("tab", { name: /^Chats/ }));
    expect(screen.queryByLabelText("Your work")).toBeNull();
    expect(mockTab).toBe("chats");
  });

  it("says each item's project as the chats' chip, unless the page it is on is that project", async () => {
    await open();
    const page = await openCard("Reliability");
    // The chip says the project, so the quiet line doesn't.
    expect(page.getAllByLabelText("lantern").length).toBeGreaterThan(0);
    expect(page.getByText(/ENG-1 Retry on 429$/)).toBeTruthy();
  });

  it("leaves room under the list for the tab bar floating over it", async () => {
    await open();
    const { paddingBottom } = StyleSheet.flatten(screen.getByLabelText("Your work").props.contentContainerStyle);
    expect(paddingBottom).toBeGreaterThan(40);
  });

  it("is a card for each feature, with what it holds and the one thing that needs you, and how many things need you", async () => {
    await open();
    expect(screen.getByText("2 things need you.")).toBeTruthy();
    // Your call comes before blocked: the card names that, and says one more is waiting.
    expect(screen.getByRole("button", { name: "Reliability, 2 open, Ready to merge" })).toBeTruthy();
    expect(screen.getByText(/Merge #8 Cache settings/)).toBeTruthy();
    expect(screen.getByText("and 1 more")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dashboard, 1 open" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "No feature, 1 shipped" })).toBeTruthy();
    // No filters, grouping switch or list of states over the cards.
    expect(screen.queryByText("Group by")).toBeNull();
    expect(screen.queryByLabelText("Where things stand")).toBeNull();
  });

  it("opens a card to the feature's page, on Needs you, and goes back to the cards", async () => {
    await open();
    const page = await openCard("Reliability");
    expect(page.getByText("2 open, 0 shipped")).toBeTruthy();
    expect(page.getByRole("tab", { name: "Needs you, 2" }).props.accessibilityState).toMatchObject({ selected: true });
    expect(page.getByText(/Retry fetchJson/)).toBeTruthy();
    expect(page.getByText(/Cache settings/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Back to Work" }));
    expect(screen.getByRole("button", { name: /^Dashboard, / })).toBeTruthy();
  });

  it("puts the way back beside the bar, as a chat's is: a glass circle with a finger's worth of a target", async () => {
    await open();
    const page = await openCard("Reliability");
    const back = within(screen.getByTestId("work-page-bar")).getByRole("button", { name: "Back to Work" });
    expect(StyleSheet.flatten(back.props.style).minHeight).toBe(44);
    // It is the bar's, not the page's: the page's own heading no longer carries it, so it can't scroll away.
    expect(page.queryByRole("button", { name: "Back to Work" })).toBeNull();
  });

  it("lets the page's name grow its capsule at the larger text sizes, to 1.8 times and no further", async () => {
    await open();
    await openCard("Reliability");
    const bar = within(screen.getByTestId("work-page-bar"));
    const name = bar.getByRole("header", { name: "Reliability" });
    expect(name.props.maxFontSizeMultiplier).toBe(BAR_TEXT_SCALE);
    // The capsule is at least a button tall, and has no height of its own to clip the words at.
    const capsule = StyleSheet.flatten(name.parent!.props.style);
    expect(capsule.minHeight).toBe(44);
    expect(capsule.height).toBeUndefined();
  });

  it("can still be pulled to refresh when everything is in one feature, and while it loads", async () => {
    await open({ work: { ...work, items: work.items.filter((i) => i.feature === "Reliability") } });
    expect(screen.getByLabelText("Your work").props.refreshControl).toBeTruthy();
  });

  it("has four tabs, each with the rows of its state, and dims one with nothing in it", async () => {
    await open();
    const page = await openCard("Reliability");
    for (const label of ["Moving", "To start", "Shipped"]) expect(page.getByRole("tab", { name: label })).toBeTruthy();
    expect(StyleSheet.flatten(page.getByText("Shipped").props.style).opacity).toBe(0.5);
    expect(StyleSheet.flatten(page.getByText("Needs you").props.style).opacity).toBe(1);
    await fireEvent.press(page.getByRole("tab", { name: "Moving" }));
    expect(page.getByText("Nothing here.")).toBeTruthy();
    expect(page.queryByText(/Retry fetchJson/)).toBeNull();
  });

  it("opens a feature with nothing needing you on its first tab that has anything, and shows a shipped item's time filled in", async () => {
    const clock = jest.spyOn(Date, "now").mockReturnValue(NOW);
    await open();
    const page = await openCard("No feature");
    expect(page.getByRole("tab", { name: "Shipped" }).props.accessibilityState).toMatchObject({ selected: true });
    // Its project is a chip, so the line doesn't say it.
    expect(page.getByText(/merged 2 h ago/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Back to Work" }));
    const dashboard = await openCard("Dashboard");
    expect(dashboard.getByRole("tab", { name: "To start" }).props.accessibilityState).toMatchObject({ selected: true });
    clock.mockRestore();
  });

  it("lists every shipped item on its tab, with no fold", async () => {
    const ready = (key: string) => item(key, { title: `Ready ${key}`, tone: "ready", stage: "release", word: "Ready", feature: "Reliability", issue: key.toUpperCase(), fold: "ready" });
    await open({ work: { ...work, items: [...work.items, ready("r1"), ready("r2")] } });
    const page = await openCard("Reliability");
    await fireEvent.press(page.getByRole("tab", { name: "Shipped" }));
    expect(page.getByText(/Ready r1/)).toBeTruthy();
    expect(page.getByText(/Ready r2/)).toBeTruthy();
    expect(page.queryByText(/Ready · merged, waiting for a release/)).toBeNull();
  });

  it("shows each item's pipeline, and the stage it is at", async () => {
    await open();
    const page = await openCard("Reliability");
    // Linear is connected, so the pipeline starts at the issue: Checks is where the blocked pull request is.
    expect(page.getByLabelText("At Checks, blocked")).toBeTruthy();
    expect(page.getByLabelText("At Merge, your call")).toBeTruthy();
    expect(page.getByText("Checks")).toBeTruthy();
    expect(page.getByText("Merge")).toBeTruthy();
  });

  it("draws a merge that goes around the required review as Bypass & merge, outlined, and says what it does", async () => {
    const bypass = item("pr10", { number: 10, title: "Unreviewed", tone: "you", stage: "review", word: "Not approved", feature: "Reliability", next: step("Bypass review and merge", { yours: true, warn: true, button: "Bypass & merge…" }) });
    await open({ work: { ...work, items: [...work.items, bypass] } });
    const page = await openCard("Reliability");
    const button = page.getByRole("button", { name: "Bypass review and merge #10" });
    expect(button.props.accessibilityHint).toMatch(/past the required review/);
    expect(StyleSheet.flatten(button.props.style)).toMatchObject({ borderWidth: 1 });
    // The plain merge keeps its usual look.
    const plain = page.getByRole("button", { name: "Merge #8" });
    expect(StyleSheet.flatten(plain.props.style).borderWidth).toBeUndefined();
  });

  it("groups by project without Linear, with a card for each", async () => {
    await open({ work: { ...work, issues: false, items: work.items.map((i) => ({ ...i, feature: null, issue: null })) } });
    expect(screen.getByRole("button", { name: /^lantern, 2 open/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^web, / })).toBeTruthy();
  });

  it("has no cards when everything is in one feature: its page is the screen", async () => {
    await open({ work: { ...work, items: work.items.filter((i) => i.feature === "Reliability") } });
    expect(screen.getByLabelText("Reliability")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to Work" })).toBeNull();
    expect(screen.getByText("2 things need you.")).toBeTruthy();
  });

  it("asks the Mac to do a step by its key and what it showed, sends no words, and says where it went", async () => {
    const { session } = await open({ work_step: { kind: "sent", to: "Fix the checks" } });
    const page = await openCard("Reliability");
    await fireEvent.press(page.getByRole("button", { name: "Fix failing checks on #7" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(session.lastOf("work_step")).toEqual({ op: "work_step", key: "pr7", sig: "checks:fail" });
    expect(session.asked.filter((r) => r.op === "send" || r.op === "new_chat")).toEqual([]);
    expect(page.getByText("Sent to “Fix the checks”")).toBeTruthy();
    expect(page.queryByRole("button", { name: "Fix failing checks on #7" })).toBeNull();
  });

  it("says a step that gets prepared in a chat asks before anything happens, and where a new chat was started", async () => {
    await open({ work_step: { kind: "started", to: "lantern" } });
    const page = await openCard("Reliability");
    await fireEvent.press(page.getByRole("button", { name: "Merge #8" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(page.getByText("Started a chat in lantern. It asks you before anything happens.")).toBeTruthy();
  });

  it("says why when the Mac refuses a step, and lets it be asked again", async () => {
    await open({ work_step: new Error("That moved on since you looked. Look again.") });
    const page = await openCard("Reliability");
    await fireEvent.press(page.getByRole("button", { name: "Fix failing checks on #7" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(page.getByText("That moved on since you looked. Look again.")).toBeTruthy();
    expect(page.getByRole("button", { name: "Fix failing checks on #7" })).toBeTruthy();
  });

  it("lists every step to take in a sheet from Review, and a step is asked from it as from a page", async () => {
    const more = ["a", "b", "c"].map((k, n) => item(`more-${k}`, { number: 20 + n, title: `More ${k}`, tone: "bad", sig: `m${n}`, next: step("Fix failing checks on") }));
    const { session } = await open({ work: { ...work, items: [...work.items, ...more] }, work_step: { kind: "sent", to: "Fix the checks" } });
    await fireEvent.press(screen.getByRole("button", { name: "Review" }));
    const all = within(screen.getByLabelText("All next steps"));
    expect(all.getByText(/More c/)).toBeTruthy();
    expect(all.getAllByRole("button", { name: /^(Fix failing checks on|Merge|Start) (#\d+|.+)$/ }).filter((b) => b.props.accessibilityHint !== "Opens its details")).toHaveLength(6);
    await fireEvent.press(all.getByRole("button", { name: "Fix failing checks on #22" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(session.lastOf("work_step")).toEqual({ op: "work_step", key: "more-c", sig: "m2" });
    expect(all.getByText("Sent to “Fix the checks”")).toBeTruthy();
  });

  it("asks the Mac to look again on Refresh", async () => {
    const { session } = await open();
    await fireEvent.press(screen.getByRole("button", { name: "Refresh" }));
    expect(session.lastOf("work_refresh")).toEqual({ op: "work_refresh" });
  });

  it("opens an item's details from its row, with its pages on GitHub and Linear, and never a link that isn't one of them", async () => {
    const open_ = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const evil = { ...work, items: [...work.items, item("x", { title: "Sneaky", tone: "bad", feature: "Reliability", url: "https://evil.example/https://github.com/", issue_url: "https://evil.example/", next: step() })] };
    await open({ work: evil });
    const page = await openCard("Reliability");
    await fireEvent.press(page.getByRole("button", { name: /^#7 Retry fetchJson/ }));
    const details = within(screen.getByLabelText("Details"));
    await fireEvent.press(details.getByRole("button", { name: "GitHub" }));
    expect(open_).toHaveBeenCalledWith("https://github.com/aly/lantern/pull/7");
    await fireEvent.press(details.getByRole("button", { name: "Done" }));
    await fireEvent.press(page.getByRole("button", { name: /^Sneaky/ }));
    const sneaky = within(screen.getByLabelText("Details"));
    expect(sneaky.queryByRole("button", { name: "GitHub" })).toBeNull();
    expect(sneaky.queryByRole("button", { name: "Linear" })).toBeNull();
    open_.mockRestore();
  });

  it("shows a stack's rows with their place, and opens the chat on an item's branch from its details", async () => {
    const onOpenChat = jest.fn();
    const stacked = { ...work, issues: false, items: [item("s1", { number: 1, title: "Base", tone: "you", stack: { id: 1, pos: 1, of: 2, on: null } }), item("s2", { number: 2, title: "Top", stack: { id: 1, pos: 2, of: 2, on: 1 }, branch: "aly/top", chat: { slot: "a", title: "Top work" } })] };
    await open({ work: stacked }, ["desk", "work"], onOpenChat);
    await fireEvent.press(screen.getByRole("tab", { name: "Moving" }));
    const page = within(screen.getByLabelText("lantern"));
    expect(page.getByRole("button", { name: /^#2 Top, Checks running, b · stack 2 of 2 · on #1$/ })).toBeTruthy();
    await fireEvent.press(page.getByRole("button", { name: /^#2 Top/ }));
    const details = within(screen.getByLabelText("Details"));
    expect(details.getByText(/aly\/top · stack 2 of 2 · on #1/)).toBeTruthy();
    await fireEvent.press(details.getByRole("button", { name: "Open chat" }));
    expect(onOpenChat).toHaveBeenCalledWith("a");
  });

  it("says when nothing is open", async () => {
    await open({ work: { issues: false, looked: true, blind: [], items: [] } });
    expect(screen.getByText(/Nothing open/)).toBeTruthy();
  });

  it("doesn't say nothing is open before the Mac has looked, or when it couldn't tell whose pull requests are yours", async () => {
    await open({ work: { issues: false, looked: false, blind: [], items: [] } });
    expect(screen.getByText(/Your Mac hasn't looked yet/)).toBeTruthy();
    expect(screen.queryByText(/Nothing open/)).toBeNull();
  });

  it("says which repositories it couldn't tell the owner of, with the work it could list", async () => {
    await open({ work: { ...work, blind: ["lantern", "web"] } });
    expect(screen.getByText(/Couldn't tell which GitHub account is yours in lantern, web/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Reliability, / })).toBeTruthy();
  });
});
