import { beforeEach, describe, expect, it } from "vitest";
import { NOTIFY_DEFAULTS, NOTIFY_KEY, loadNotifyPrefs, shouldNotify, type NotifyPrefs } from "./notifyPrefs";

describe("shouldNotify", () => {
  const on: NotifyPrefs = { ...NOTIFY_DEFAULTS };

  it("tells about every kind by default", () => {
    for (const kind of ["finished", "waiting", "failed", "stopped"] as const) expect(shouldNotify(on, kind)).toBe(true);
  });

  it("is silent for every kind when the master switch is off", () => {
    for (const kind of ["finished", "waiting", "failed", "stopped"] as const) expect(shouldNotify({ ...on, on: false }, kind)).toBe(false);
  });

  it("follows the per-event switches", () => {
    expect(shouldNotify({ ...on, finished: false }, "finished")).toBe(false);
    expect(shouldNotify({ ...on, waiting: false }, "waiting")).toBe(false);
    expect(shouldNotify({ ...on, failed: false }, "failed")).toBe(false);
    expect(shouldNotify({ ...on, failed: false }, "finished")).toBe(true);
  });

  it("lets a stopped turn follow the Finished switch", () => {
    expect(shouldNotify({ ...on, finished: false }, "stopped")).toBe(false);
    expect(shouldNotify({ ...on, waiting: false }, "stopped")).toBe(true);
  });

  it("is silent until the pause ends, then tells again", () => {
    const paused = { ...on, pausedUntil: 10_000 };
    expect(shouldNotify(paused, "waiting", 9_999)).toBe(false);
    expect(shouldNotify(paused, "waiting", 10_000)).toBe(true);
  });
});

describe("loadNotifyPrefs", () => {
  beforeEach(() => localStorage.clear());

  it("gives the defaults when nothing is saved", () => {
    expect(loadNotifyPrefs()).toEqual(NOTIFY_DEFAULTS);
  });

  it("fills in what an older save lacks", () => {
    localStorage.setItem(NOTIFY_KEY, JSON.stringify({ on: false }));
    expect(loadNotifyPrefs()).toEqual({ ...NOTIFY_DEFAULTS, on: false });
  });
});
