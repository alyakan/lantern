import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Insights } from "../../mobile/src/protocol/generated/Insights";
import { InsightsPanel } from "./InsightsPanel";

const week: Insights = {
  range: "week",
  from: 0,
  to: 1,
  before: "the week before",
  usage: {
    headline: "lantern takes 71%. You use the most between 2 pm and 6 pm.",
    weighted: 54_000_000,
    tokens: 900_000_000,
    bars: [{ label: "Thu", weighted: 10 }, { label: "Fri", weighted: 20 }],
    projects: [{ name: "lantern", weighted: 38_000_000, share: 0.71 }, { name: "rayak", weighted: 16_000_000, share: 0.29 }],
    models: [{ name: "Sonnet 5.5", weighted: 50_000_000, share: 0.92 }, { name: "Haiku 5.5", weighted: 4_000_000, share: 0.08 }],
    heavy: [{ title: "Release 0.1.107", project: "lantern", weighted: 9_100_000, why: "410k context" }],
  },
  savings: { headline: "Each call sends 29% less than the week before.", per_call: { now: 175_000, before: 248_000 }, chat_start: { now: 54_000, before: 54_000 }, cached: { now: 0.91, before: 0.88 }, note: "Chats still start at 54k: a preset with plugins off starts lighter." },
  done: { headline: "14 pull requests merged, 3 releases, 52 commits.", chats: 61, commits: 52, added: 4100, removed: 900, merged: 14, releases: 3, projects: [] },
  habits: { headline: "You write most around 3 pm.", hours: Array.from({ length: 24 }, (_, h) => (h === 15 ? 9 : 1)), reply_ms: 6 * 60_000, away: 0.4 },
};

vi.mock("../api", () => ({ api: { insights: vi.fn(async () => week) } }));

describe("the Insights panel", () => {
  it("answers each question in a sentence, then backs it up with figures", async () => {
    render(<InsightsPanel open onClose={() => {}} />);
    expect(await screen.findByText(week.usage.headline)).toBeTruthy();
    const savings = screen.getByRole("region", { name: "Savings" });
    expect(within(savings).getByText("Each call sends 29% less than the week before.")).toBeTruthy();
    expect(within(savings).getByText("▼ 29%")).toBeTruthy();
    expect(within(savings).getByText("— same")).toBeTruthy();
    expect(within(savings).getByText("▲ 3 pts")).toBeTruthy();
    expect(screen.getByText("410k context")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Habits" })).getByText("6 min")).toBeTruthy();
  });
});
