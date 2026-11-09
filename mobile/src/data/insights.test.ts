import type { Insights } from "../protocol/generated/Insights";
import { isInsights } from "./insights";

const week: Insights = {
  range: "week",
  from: 0,
  to: 1,
  before: "the week before",
  usage: { headline: "h", weighted: 1, tokens: 2, bars: [{ label: "Thu", weighted: 1 }], projects: [{ name: "lantern", weighted: 1, share: 1 }], models: [], heavy: [{ title: "t", project: "lantern", weighted: 1, why: null }] },
  savings: { headline: "h", per_call: { now: 1, before: 2 }, chat_start: { now: 1, before: null }, cached: { now: 0.9, before: 0.8 }, note: null },
  done: { headline: "h", chats: 1, commits: 2, added: 3, removed: 4, merged: 5, releases: 6, projects: [] },
  habits: { headline: "h", hours: [0, 1], reply_ms: null, away: 0.4 },
};

describe("kept insights", () => {
  it("are shown when they have everything the screen reads, for their own stretch", () => {
    expect(isInsights("week")(week)).toBe(true);
    expect(isInsights("today")(week)).toBe(false);
  });

  it("are dropped when an older Mac's or app's are missing something the screen reads", () => {
    const { habits, ...noHabits } = week;
    expect(habits).toBeTruthy();
    expect(isInsights("week")(noHabits)).toBe(false);
    expect(isInsights("week")({ ...week, usage: { ...week.usage, bars: null } })).toBe(false);
    expect(isInsights("week")({ ...week, savings: { ...week.savings, cached: { now: "91%" } } })).toBe(false);
    expect(isInsights("week")(null)).toBe(false);
  });
});
