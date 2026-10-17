import { beforeEach, describe, expect, it } from "vitest";
import { appColours, COLOURED_APPS, lastStorageTab, memoryParts, memoryShare, memoryText, partText, processText, rememberStorageTab, ROW_SLACK, stableOrder, summaryLine, updatedText } from "./memory";
import type { MemoryApp, MemorySnapshot } from "../types";

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const TOTAL = 16 * GB;

const app = (name: string, mb: number, over: Partial<MemoryApp> = {}): MemoryApp => ({ name, bytes: mb * MB, processes: 1, share: (mb * MB) / TOTAL, kind: "app", ...over });
const snapshot = (apps: MemoryApp[], over: Partial<MemorySnapshot> = {}): MemorySnapshot => {
  const used = apps.reduce((n, a) => n + a.bytes, 0);
  return { total_bytes: TOTAL, used_bytes: used, cached_bytes: 3 * GB, free_bytes: TOTAL - used - 3 * GB, compressed_bytes: 2 * GB, swap_used_bytes: 2.5 * GB, pressure: "normal", pressure_source: "kernel", scaled: false, apps, ...over };
};
const names = (apps: MemoryApp[]) => apps.map((a) => a.name);

describe("memory text", () => {
  it("writes sizes 1024-based like Activity Monitor, so a 16 GB Mac is 16.0 GB", () => {
    expect(memoryText(TOTAL)).toBe("16.0 GB");
    expect(memoryText(412 * MB)).toBe("412 MB");
    expect(memoryText(1500 * MB)).toBe("1.5 GB");
    expect(memoryText(0)).toBe("0 MB");
    expect(memoryText(1023 * MB)).toBe("1.0 GB");
  });

  it("writes a share as a whole percent, and a small one as under 1%", () => {
    expect(memoryShare(0.256)).toBe("26%");
    expect(memoryShare(0.004)).toBe("<1%");
    expect(memoryShare(0)).toBe("0%");
    expect(processText(1)).toBe("1 process");
    expect(processText(11)).toBe("11 processes");
  });

  it("says what is used, of how much, the pressure and the swap", () => {
    const s = snapshot([app("Chrome", 1024 * 11.8)], { swap_used_bytes: 8.3 * GB });
    expect(summaryLine(s)).toBe("About 11.8 GB used of 16.0 GB, pressure: normal, swap 8.3 GB");
    expect(summaryLine({ ...s, swap_used_bytes: null, pressure: "critical" })).toBe("About 11.8 GB used of 16.0 GB, pressure: critical");
  });

  it("counts how long ago the numbers were read", () => {
    const at = 1_000_000;
    expect(updatedText(null, at)).toBe("");
    expect(updatedText(at, at + 2000)).toBe("Updated just now");
    expect(updatedText(at, at + 12_000)).toBe("Updated 12s ago");
    expect(updatedText(at, at + 130_000)).toBe("Updated 2m ago");
    expect(updatedText(at, at - 5000)).toBe("Updated just now");
  });
});

describe("stableOrder", () => {
  const a = app("A", 900);
  const b = app("B", 800);
  const c = app("C", 700);
  const d = app("D", 600);

  it("starts out by size, biggest first", () => {
    expect(names(stableOrder([], [c, a, d, b]))).toEqual(["A", "B", "C", "D"]);
  });

  it("keeps the rows where they were when sizes swap places by a row or two", () => {
    // B and A trade places, then D passes C and B: all within the slack, so nothing moves.
    const now = [app("A", 790), app("B", 800), app("C", 610), app("D", 700)];
    expect(names(stableOrder(["A", "B", "C", "D"], now))).toEqual(["A", "B", "C", "D"]);
  });

  it("moves an app that is further from its place than the slack", () => {
    const apps = ["A", "B", "C", "D", "E", "F", "G", "H"].map((n, i) => app(n, 1000 - i * 100));
    const jumped = apps.map((x) => (x.name === "H" ? { ...x, bytes: 5000 * MB } : x));
    const out = names(stableOrder(["A", "B", "C", "D", "E", "F", "G", "H"], jumped));
    expect(out[0]).toBe("H");
    expect(out.slice(1)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    // One short of the slack: it stays.
    const near = apps.map((x) => (x.name === "D" ? { ...x, bytes: 1100 * MB } : x));
    expect(ROW_SLACK).toBe(3);
    expect(names(stableOrder(["A", "B", "C", "D", "E", "F", "G", "H"], near)).slice(0, 5)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("puts a new app where its size belongs, drops one that is gone, and keeps Other apps last", () => {
    const other = app("Other apps", 5000, { kind: "other" });
    const out = stableOrder(["Other apps", "A", "B", "Gone", "C"], [other, a, b, c, app("New", 950)]);
    expect(names(out)).toEqual(["New", "A", "B", "C", "Other apps"]);
    expect(out[out.length - 1].kind).toBe("other");
  });

  it("is the same order again for the same readings", () => {
    const once = stableOrder(["B", "A", "D", "C"], [a, b, c, d]);
    expect(names(stableOrder(names(once), [a, b, c, d]))).toEqual(names(once));
  });

  it("copes with nothing", () => {
    expect(stableOrder(["A"], [])).toEqual([]);
    expect(stableOrder([], [])).toEqual([]);
  });
});

describe("the stacked bar", () => {
  const lantern = app("Lantern and its agents", 1800, { kind: "lantern", processes: 9 });
  const macos = app("macOS", 1500, { kind: "macos", processes: 380 });
  const other = app("Other apps", 400, { kind: "other", processes: 30 });
  const apps = [app("Chrome", 2100), lantern, app("Xcode", 1600), macos, app("Slack", 800), app("node", 600), app("Figma", 500), other];
  const parts = (s = snapshot(apps)) => memoryParts(s, apps);

  it("splits the whole RAM: the biggest apps, Lantern, macOS, the other apps, cached and free", () => {
    const p = parts();
    expect(p.map((x) => x.key)).toEqual(["app:Chrome", "app:Xcode", "app:Slack", "app:node", "lantern", "macos", "other", "cached", "free"]);
    // The apps past the coloured ones, with the backend's Other apps, are one piece.
    expect(p.find((x) => x.key === "other")!.bytes).toBe((500 + 400) * MB);
    expect(COLOURED_APPS).toBe(4);
  });

  it("adds up to the whole RAM and to exactly 100 percent", () => {
    const s = snapshot(apps);
    const p = parts(s);
    expect(p.reduce((n, x) => n + x.bytes, 0)).toBe(s.total_bytes);
    expect(p.reduce((n, x) => n + x.share, 0)).toBe(100);
  });

  it("leaves out what is empty, and never draws a piece narrower than the minimum", () => {
    const s = snapshot(apps, { free_bytes: 0, cached_bytes: 0 });
    expect(memoryParts(s, apps).map((x) => x.key)).not.toContain("free");
    const tiny = [app("Chrome", 9000), app("Tiny", 1)];
    const p = memoryParts(snapshot(tiny, { cached_bytes: 0, free_bytes: 1 * GB }), tiny);
    expect(Math.min(...p.map((x) => x.width))).toBeGreaterThanOrEqual(2);
    expect(p.reduce((n, x) => n + x.width, 0)).toBeCloseTo(100, 5);
  });

  it("writes every piece as text, for the bar's alternative", () => {
    const chrome = parts().find((x) => x.key === "app:Chrome")!;
    expect(partText(chrome)).toBe(`Chrome: 2.1 GB (${chrome.share}%)`);
  });

  it("gives each app the colour of its piece: its own for the biggest few, Other apps' for the rest", () => {
    const colours = appColours(apps);
    const own = ["Chrome", "Xcode", "Slack", "node"].map((n) => colours.get(n));
    expect(new Set(own).size).toBe(4);
    expect(colours.get("Figma")).toBe(colours.get("Other apps"));
    expect(colours.get(lantern.name)).not.toBe(colours.get("macOS"));
    expect(own.every((c) => c !== colours.get("Other apps"))).toBe(true);
  });
});

describe("the remembered tab", () => {
  beforeEach(() => localStorage.clear());

  it("is Disk until Memory is picked, then Memory", () => {
    expect(lastStorageTab()).toBe("disk");
    rememberStorageTab("memory");
    expect(lastStorageTab()).toBe("memory");
    rememberStorageTab("disk");
    expect(lastStorageTab()).toBe("disk");
  });

  it("ignores anything else in storage", () => {
    localStorage.setItem("lantern.storageTab", "bogus");
    expect(lastStorageTab()).toBe("disk");
  });
});
