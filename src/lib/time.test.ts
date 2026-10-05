import { describe, expect, it } from "vitest";
import { messageTime, relativeTime } from "./time";
import { initials } from "./userName";

const now = new Date("2026-09-29T12:00:00").getTime();
const ago = (ms: number) => relativeTime(now - ms, now);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("formats recent times compactly", () => {
    expect(ago(20_000)).toBe("just now");
    expect(ago(5 * MIN)).toBe("5m ago");
    expect(ago(3 * HOUR)).toBe("3h ago");
    expect(ago(30 * HOUR)).toBe("yesterday");
    expect(ago(4 * DAY)).toBe("4d ago");
  });

  it("falls back to a short date after a week", () => {
    expect(ago(20 * DAY)).toBe(new Date(now - 20 * DAY).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  });
});

describe("messageTime", () => {
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  it("shows the clock today, Yesterday before it, then the date", () => {
    expect(messageTime(new Date("2026-09-29T09:05:00").getTime(), now)).toBe(clock("2026-09-29T09:05:00"));
    expect(messageTime(new Date("2026-09-28T23:59:00").getTime(), now)).toBe(`Yesterday ${clock("2026-09-28T23:59:00")}`);
    expect(messageTime(new Date("2026-09-20T08:00:00").getTime(), now)).toMatch(/20.*, /);
    expect(messageTime(new Date("2025-12-31T08:00:00").getTime(), now)).toMatch(/2025/);
  });
});

describe("initials", () => {
  it("takes the first and last names' letters", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("Mary Ann van der Berg")).toBe("MB");
    expect(initials("sam")).toBe("S");
  });
});
