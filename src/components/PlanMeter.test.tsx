import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { planLevel, planLine, planSentence, setPlanUsage } from "../lib/planUsage";
import type { UsageRow } from "../lib/usage";
import { setWeekUsage } from "../lib/weekUsage";
import { HOUR_SECS, SESSION_SECS, windowMarks } from "../lib/usageMarks";
import { PlanMeter } from "./PlanMeter";

const row = (over: Partial<UsageRow>): UsageRow => ({ slot: "s1", name: "Fix the login", project: "acme-api", state: "idle", cost: 0, tokens: 0, models: [], ...over });

describe("the plan meter", () => {
  it("says how full the five-hour window is and when it resets, and warns from 80% and stops at 95%", () => {
    const resetsAt = new Date(2026, 9, 15, 14, 30).getTime() / 1000;
    const at = new Date(resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(planLine({ used: 0.423, resetsAt })).toBe(`Session 42% · resets ${at}`);
    expect(planLine({ used: 0.1, resetsAt: null })).toBe("Session 10%");
    expect([0.79, 0.8, 0.95].map((used) => planLevel({ used, resetsAt: null }))).toEqual(["ok", "warn", "stop"]);
  });

  it("says in words how long is left of the window", () => {
    const now = new Date(2026, 9, 15, 12, 0).getTime();
    expect(planSentence({ used: 0.62, resetsAt: (now + 100 * 60_000) / 1000 }, now)).toBe("Session: 62% of the 5-hour window, resets in 1h 40m");
    expect(planSentence({ used: 0.62, resetsAt: null }, now)).toBe("Session: 62% of the 5-hour window");
    expect(planSentence({ used: 0.99, resetsAt: (now - 1000) / 1000 }, now)).toBe("Session: 99% of the 5-hour window, resetting now");
  });

  it("shows nothing until claude has said, then the latest any chat reported", () => {
    const { container } = render(<PlanMeter />);
    expect(container.textContent).toBe("");
    act(() => setPlanUsage({ used: 0.85, resetsAt: null }));
    expect(screen.getByRole("status").textContent).toBe("Session 85%");
    expect(screen.getByRole("status").className).toContain("warn");
  });
});

describe("where the usage went", () => {
  const team = row({ slot: "s2", name: "Team · acme-api", state: "working", cost: 1.5, tokens: 300_000, models: [{ name: "Sonnet", share: 0.62 }, { name: "Opus", share: 0.38 }], members: [row({ slot: "s2", name: "Lead", cost: 0.5, tokens: 90_000 }), row({ slot: "w1", name: "Login form", cost: 1, tokens: 210_000 })] });
  const rows = [team, row({ cost: 0.4, tokens: 50_000, models: [{ name: "Haiku", share: 1 }] })];

  it("opens from the meter with the plan's line, every chat and team and what each used, and a line on what the numbers are", () => {
    act(() => setPlanUsage({ used: 0.62, resetsAt: Date.now() / 1000 + 100 * 60 }));
    render(<PlanMeter usage={{ rows: () => rows, onOpen: vi.fn() }} />);
    const meter = screen.getByRole("button", { name: /Session 62%/ });
    expect(meter.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(meter);
    const pop = screen.getByRole("dialog", { name: "Session and weekly usage" });
    expect(within(pop).getByText(/^Session: 62% of the 5-hour window, resets in 1h (39|40)m$/)).toBeInTheDocument();
    const top = within(pop).getAllByRole("listitem")[0];
    expect(top.textContent).toContain("Team · acme-api");
    expect(top.textContent).toContain("Working");
    expect(top.textContent).toContain("$1.50 · 300k tokens");
    expect(top.textContent).toContain("Sonnet 62%, Opus 38%");
    expect(within(pop).getByText(/not just this window/)).toBeInTheDocument();
    // A team's agents are listed when it is opened.
    expect(within(pop).queryByText("Login form")).toBeNull();
    fireEvent.click(within(pop).getByRole("button", { name: "Show Team · acme-api's agents" }));
    expect(within(pop).getByText("Login form")).toBeInTheDocument();
    expect(within(pop).getByText("Lead")).toBeInTheDocument();
  });

  it("opens a chat when its name is pressed, and closes on Escape with focus back on the meter", () => {
    act(() => setPlanUsage({ used: 0.3, resetsAt: null }));
    const onOpen = vi.fn();
    render(<PlanMeter usage={{ rows: () => rows, onOpen }} />);
    const meter = screen.getByRole("button", { name: /Session 30%/ });
    fireEvent.click(meter);
    fireEvent.click(screen.getByRole("button", { name: "Fix the login" }));
    expect(onOpen).toHaveBeenCalledWith("s1");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(meter);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(meter);
  });

  it("says so when nothing open has used anything", () => {
    act(() => setPlanUsage({ used: 0.1, resetsAt: null }));
    render(<PlanMeter usage={{ rows: () => [], onOpen: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: /Session 10%/ }));
    expect(screen.getByText("Nothing open has used any of it yet.")).toBeInTheDocument();
  });
});

describe("the session and week bars", () => {
  it("shows both windows as bars, with a tick for each hour of the session and each day of the week, and the week's pace", () => {
    const now = Date.now();
    act(() => setPlanUsage({ used: 0.42, resetsAt: now / 1000 + 2 * 3600 }));
    act(() => setWeekUsage({ used: 0.3, resetsAt: now / 1000 + 3.5 * 86_400 }));
    const { container } = render(<PlanMeter usage={{ rows: () => [], onOpen: vi.fn() }} />);
    const meter = screen.getByRole("button", { name: /Session 42%.*Week 30%/ });
    fireEvent.click(meter);
    const pop = screen.getByRole("dialog", { name: "Session and weekly usage" });
    expect(within(pop).getByRole("meter", { name: "Session used" }).getAttribute("aria-valuenow")).toBe("42");
    expect(within(pop).getByRole("meter", { name: "Week used" }).getAttribute("aria-valuenow")).toBe("30");
    const [session, week] = Array.from(container.querySelectorAll(".usage-bar"));
    expect(session.querySelectorAll(".usage-bar-tick")).toHaveLength(4);
    expect(week.querySelectorAll(".usage-bar-tick")).toHaveLength(6);
    expect(week.querySelectorAll(".usage-bar-days span")).toHaveLength(6);
    // Three of five hours gone, three and a half of seven days.
    expect(parseFloat((session.querySelector(".usage-bar-pace") as HTMLElement).style.left)).toBeCloseTo(60, 1);
    expect(parseFloat((week.querySelector(".usage-bar-pace") as HTMLElement).style.left)).toBeCloseTo(50, 1);
    expect(within(pop).getByText(/At this pace about 60% will be used by the reset/)).toBeInTheDocument();
  });
});

describe("windowMarks", () => {
  it("puts a mark at the end of each step inside the window and the even pace now, and nothing without a reset", () => {
    const reset = 1_800_000_000;
    const { marks, pace } = windowMarks(reset, SESSION_SECS, HOUR_SECS, (reset - SESSION_SECS + 3600) * 1000);
    expect(marks.map((m) => m.at)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(marks[0].when).toBe(reset - SESSION_SECS + 3600);
    expect(pace).toBeCloseTo(0.2);
    expect(windowMarks(reset, SESSION_SECS, HOUR_SECS, (reset + 10) * 1000).pace).toBe(1);
    expect(windowMarks(null, SESSION_SECS, HOUR_SECS)).toEqual({ marks: [], pace: null });
  });
});
