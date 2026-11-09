import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import type { Insights } from "../protocol/generated/Insights";
import { attachSession } from "../test/fakeSession";
import { CACHE_VERSION } from "../cache/cache";
import { MemoryCacheStore } from "../cache/store";
import { chat, connectedWith, makeController, NOW, renderWith } from "../test/render";
import { PhoneTabs } from "./PhoneTabs";

let mockTab: "chats" | "work" | "insights" = "chats";
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

const insights = (range: Insights["range"]): Insights => ({
  range,
  from: 0,
  to: 1,
  before: range === "today" ? "yesterday" : "the week before",
  usage: { headline: `lantern takes 71% ${range}.`, weighted: 54_000_000, tokens: 900_000_000, bars: [{ label: "Thu", weighted: 1 }], projects: [{ name: "lantern", weighted: 1, share: 0.71 }, { name: "rayak", weighted: 1, share: 0.29 }], models: [], heavy: [{ title: "Release 0.1.107", project: "lantern", weighted: 9_100_000, why: "410k context" }] },
  savings: { headline: "Each call sends 29% less than the week before.", per_call: { now: 175_000, before: 248_000 }, chat_start: { now: 54_000, before: 54_000 }, cached: { now: 0.91, before: 0.88 }, note: null },
  done: { headline: "14 pull requests merged.", chats: 61, commits: 52, added: 10, removed: 2, merged: 14, releases: 3, projects: [] },
  habits: { headline: "You write most around 3 pm.", hours: Array.from({ length: 24 }, () => 1), reply_ms: 360_000, away: 0.4 },
});

async function open(features: string[], over: Parameters<typeof makeController>[0] = {}) {
  const { controller } = makeController(over);
  const session = attachSession(controller, { insights: (r: { range: Insights["range"] }) => insights(r.range) }, features);
  await renderWith(<PhoneTabs onOpenChat={jest.fn()} onReview={jest.fn()} onOpenMac={jest.fn()} onCompose={jest.fn()} onNewChat={jest.fn()} onSupport={jest.fn()} onComposeNew={jest.fn()} />, { connection: connectedWith(features), chats: [chat({ slot: "a" })] }, controller);
  await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  return { ...session, controller };
}

beforeEach(() => {
  mockTab = "chats";
});

describe("Insights on the phone", () => {
  it("is a tab for a Mac that works them out, and answers each question in a sentence with its figures", async () => {
    const session = await open(["insights"]);
    await fireEvent.press(screen.getByRole("tab", { name: "Insights" }));
    await waitFor(() => expect(screen.getByText("lantern takes 71% week.")).toBeTruthy());
    expect(session.lastOf("insights")).toEqual({ op: "insights", range: "week" });
    expect(screen.getByText("Each call sends 29% less than the week before.")).toBeTruthy();
    expect(screen.getByLabelText("context a call: 175k, down 29%")).toBeTruthy();
    expect(screen.getByLabelText("a chat's start: 54k, about the same")).toBeTruthy();
    expect(within(screen.getByLabelText("The chats that cost the most")).getByText("410k context")).toBeTruthy();
    expect(mockTab).toBe("insights");
  });

  it("asks again for another stretch of time", async () => {
    const session = await open(["insights"]);
    await fireEvent.press(screen.getByRole("tab", { name: "Insights" }));
    await fireEvent.press(screen.getByRole("tab", { name: "Today" }));
    await waitFor(() => expect(screen.getByText("lantern takes 71% today.")).toBeTruthy());
    expect(session.lastOf("insights")).toEqual({ op: "insights", range: "today" });
  });

  it("is kept as it was left while another tab is shown: coming back neither asks again nor starts over", async () => {
    const session = await open(["insights"]);
    await fireEvent.press(screen.getByRole("tab", { name: "Insights" }));
    await fireEvent.press(screen.getByRole("tab", { name: "Today" }));
    await waitFor(() => expect(screen.getByText("lantern takes 71% today.")).toBeTruthy());
    await fireEvent.press(screen.getByRole("tab", { name: "Chats" }));
    // Out of sight, and out of a screen reader's reach.
    expect(screen.queryByText("lantern takes 71% today.")).toBeNull();
    await fireEvent.press(screen.getByRole("tab", { name: "Insights" }));
    expect(screen.getByText("lantern takes 71% today.")).toBeTruthy();
    expect(session.asked.filter((r) => r.op === "insights")).toHaveLength(2);
  });

  it("asks again on coming back to the tab once its figures are stale (a week's after half an hour)", async () => {
    let now = NOW;
    const session = await open(["insights"], { now: () => now });
    await fireEvent.press(screen.getByRole("tab", { name: "Insights" }));
    await waitFor(() => expect(screen.getByText("lantern takes 71% week.")).toBeTruthy());
    await fireEvent.press(screen.getByRole("tab", { name: "Chats" }));
    now += 29 * 60_000;
    await fireEvent.press(screen.getByRole("tab", { name: "Insights" }));
    expect(session.asked.filter((r) => r.op === "insights")).toHaveLength(1);
    await fireEvent.press(screen.getByRole("tab", { name: "Chats" }));
    now += 2 * 60_000;
    await fireEvent.press(screen.getByRole("tab", { name: "Insights" }));
    await waitFor(() => expect(session.asked.filter((r) => r.op === "insights")).toHaveLength(2));
  });

  it("opens on the figures kept from last time, says how old they are, and asks behind them once they are stale", async () => {
    const cacheStore = new MemoryCacheStore();
    cacheStore.entries.set("insights.week", JSON.stringify({ v: CACHE_VERSION, at: NOW - 2 * 60 * 60_000, value: { ...insights("week"), usage: { ...insights("week").usage, headline: "Kept from before." } } }));
    const session = await open(["insights"], { cacheStore });
    await fireEvent.press(screen.getByRole("tab", { name: "Insights" }));
    // Two hours old: shown, then the fresh answer replaces it.
    await waitFor(() => expect(screen.getByText("lantern takes 71% week.")).toBeTruthy());
    expect(session.asked.filter((r) => r.op === "insights")).toHaveLength(1);
    expect(screen.getByText("Updated just now")).toBeTruthy();
    expect(JSON.parse(cacheStore.entries.get("insights.week")!).value.usage.headline).toBe("lantern takes 71% week.");
  });

  it("doesn't ask the Mac when the kept figures are fresh", async () => {
    const cacheStore = new MemoryCacheStore();
    cacheStore.entries.set("insights.week", JSON.stringify({ v: CACHE_VERSION, at: NOW - 5 * 60_000, value: { ...insights("week"), usage: { ...insights("week").usage, headline: "Kept from before." } } }));
    const session = await open(["insights"], { cacheStore });
    await fireEvent.press(screen.getByRole("tab", { name: "Insights" }));
    await waitFor(() => expect(screen.getByText("Kept from before.")).toBeTruthy());
    expect(screen.getByText("Updated 5 min ago")).toBeTruthy();
    expect(session.asked.filter((r) => r.op === "insights")).toHaveLength(0);
  });

  it("forgets the kept figures when the phone is unpaired", async () => {
    const cacheStore = new MemoryCacheStore();
    const { controller } = await open(["insights"], { cacheStore });
    await fireEvent.press(screen.getByRole("tab", { name: "Insights" }));
    await waitFor(() => expect(cacheStore.entries.has("insights.week")).toBe(true));
    await act(async () => controller.unpair());
    expect(cacheStore.entries.size).toBe(0);
  });

  it("has no tab on a Mac that can't work them out", async () => {
    await open([]);
    expect(screen.queryByRole("tab", { name: "Insights" })).toBeNull();
  });
});
