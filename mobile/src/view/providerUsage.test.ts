import { claudeUsage, currentUsageWindows, tightest, tightestText } from "./providerUsage";

it("keeps an active weekly limit when the session expired, without inventing a reset percentage", () => {
  const reading = claudeUsage({ used: 1, resetsAt: 1, status: "rejected", week: { used: .95, resetsAt: 100 } });
  expect(currentUsageWindows(reading, 2000).map(w => [w.label, w.used])).toEqual([["Week", .95]]);
});

it("leaves missing usage unavailable and preserves a reported zero", () => {
  expect(currentUsageWindows(claudeUsage(null))).toEqual([]);
  expect(currentUsageWindows(claudeUsage({ used: 0, resetsAt: null, status: "allowed" }))[0].used).toBe(0);
});

describe("the tightest limit, for Home's ring", () => {
  const NOW = Date.UTC(2026, 10, 4, 12);
  const at = (hours: number) => NOW / 1000 + hours * 3600;

  it("is nothing when no provider has said", () => {
    expect(tightest(null, {}, NOW)).toBeNull();
  });

  it("puts a week that runs out on pace before a fuller session that won't", () => {
    // Four days into the week at 70%: the pace runs it out before the reset in three days.
    const plan = { used: 0.78, resetsAt: at(2), status: "allowed" as const, week: { used: 0.7, resetsAt: at(72) } };
    const t = tightest(plan, {}, NOW)!;
    expect(t.provider).toBe("Claude");
    expect(t.window.minutes).toBe(10080);
    expect(t.view.tone).toBe("warn");
    expect(tightestText(t)).toMatch(/^Claude weekly limit 70% used, out /);
  });

  it("puts a limit reached on any provider first, and says so", () => {
    const plan = { used: 0.9, resetsAt: at(2), status: "allowed" as const };
    const providers = { codex: { provider: "codex", updated_at: 1, windows: [{ label: "5 hours", used: 1, resets_at: at(1), minutes: 300 }] } };
    const t = tightest(plan, providers, NOW)!;
    expect(t.provider).toBe("Codex");
    expect(t.view.tone).toBe("stop");
    expect(tightestText(t)).toBe("Codex session limit reached, resets in 1 h");
  });

  it("is the fullest when all are fine", () => {
    const plan = { used: 0.3, resetsAt: at(2), status: "allowed" as const };
    const providers = { codex: { provider: "codex", updated_at: 1, windows: [{ label: "5 hours", used: 0.5, resets_at: at(3), minutes: 300 }] } };
    const t = tightest(plan, providers, NOW)!;
    expect([t.provider, t.view.tone, t.view.percent]).toEqual(["Codex", "ok", 50]);
  });
});
