import { claudeUsage, currentUsageWindows } from "./providerUsage";

it("keeps an active weekly limit when the session expired, without inventing a reset percentage", () => {
  const reading = claudeUsage({ used: 1, resetsAt: 1, status: "rejected", week: { used: .95, resetsAt: 100 } });
  expect(currentUsageWindows(reading, 2000).map(w => [w.label, w.used])).toEqual([["Week", .95]]);
});

it("leaves missing usage unavailable and preserves a reported zero", () => {
  expect(currentUsageWindows(claudeUsage(null))).toEqual([]);
  expect(currentUsageWindows(claudeUsage({ used: 0, resetsAt: null, status: "allowed" }))[0].used).toBe(0);
});
