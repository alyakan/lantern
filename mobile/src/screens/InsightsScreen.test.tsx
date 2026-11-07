import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import type { Insights } from "../protocol/generated/Insights";
import { attachSession } from "../test/fakeSession";
import { chat, connectedWith, makeController, renderWith } from "../test/render";
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

async function open(features: string[]) {
  const { controller } = makeController();
  const session = attachSession(controller, { insights: (r: { range: Insights["range"] }) => insights(r.range) }, features);
  await renderWith(<PhoneTabs onOpenChat={jest.fn()} onReview={jest.fn()} onOpenMac={jest.fn()} onCompose={jest.fn()} onNewChat={jest.fn()} onSupport={jest.fn()} onComposeNew={jest.fn()} />, { connection: connectedWith(features), chats: [chat({ slot: "a" })] }, controller);
  await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  return session;
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

  it("asks again on coming back to the tab once its figures are a minute old", async () => {
    const session = await open(["insights"]);
    await fireEvent.press(screen.getByRole("tab", { name: "Insights" }));
    await waitFor(() => expect(screen.getByText("lantern takes 71% week.")).toBeTruthy());
    await fireEvent.press(screen.getByRole("tab", { name: "Chats" }));
    const later = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    await fireEvent.press(screen.getByRole("tab", { name: "Insights" }));
    later.mockRestore();
    expect(session.asked.filter((r) => r.op === "insights")).toHaveLength(2);
  });

  it("has no tab on a Mac that can't work them out", async () => {
    await open([]);
    expect(screen.queryByRole("tab", { name: "Insights" })).toBeNull();
  });
});
