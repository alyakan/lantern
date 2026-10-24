import { bytesText, clearTotals, diskTone, kindText, scanState, SCAN_FRESH_MS, usedShare } from "./storage";

const item = (bytes: number, to_trash = false) => ({ id: "a", kind: "cache", name: "x", bytes, to_trash, note: "" });

describe("sizes", () => {
  it("are written as Finder writes them", () => {
    expect(bytesText(0)).toBe("0 B");
    expect(bytesText(999)).toBe("999 B");
    expect(bytesText(840_000_000)).toBe("840 MB");
    expect(bytesText(12_340_000_000)).toBe("12.3 GB");
    expect(bytesText(251_000_000_000)).toBe("251 GB");
    expect(bytesText(1_000_000_000_000)).toBe("1 TB");
  });
});

describe("how full the disk is", () => {
  it("is the share used, and nothing when the Mac didn't say", () => {
    expect(usedShare({ free_bytes: 25, total_bytes: 100 })).toBe(0.75);
    expect(usedShare({ free_bytes: null, total_bytes: 100 })).toBeNull();
    expect(usedShare({ free_bytes: 5, total_bytes: 0 })).toBeNull();
    expect(usedShare({ free_bytes: 500, total_bytes: 100 })).toBe(0);
  });

  it("stays calm until the disk is nearly full: a disk 80% full is ordinary", () => {
    expect(diskTone(0.8)).toBe("ok");
    expect(diskTone(0.89)).toBe("ok");
    expect(diskTone(0.9)).toBe("warn");
    expect(diskTone(0.95)).toBe("stop");
    expect(diskTone(null)).toBe("ok");
  });
});

describe("how fresh the scan is", () => {
  const now = 10 * SCAN_FRESH_MS;
  it("says so in a few words, and is fresh for an hour", () => {
    expect(scanState(null, now)).toEqual({ fresh: false, text: "Not scanned yet" });
    expect(scanState(now - 10_000, now)).toEqual({ fresh: true, text: "Scanned just now" });
    expect(scanState(now - 25 * 60_000, now)).toEqual({ fresh: true, text: "Scanned 25 min ago" });
    expect(scanState(now - SCAN_FRESH_MS - 60_000, now)).toEqual({ fresh: false, text: "Scanned 1 h ago" });
    expect(scanState(now - 3 * SCAN_FRESH_MS, now).text).toBe("Scanned 3 h ago");
  });
});

describe("what clearing would free", () => {
  it("adds up, and counts what only goes to the Trash apart", () => {
    expect(clearTotals([item(100), item(50, true), item(25)])).toEqual({ count: 3, bytes: 175, trashBytes: 50 });
    expect(clearTotals([])).toEqual({ count: 0, bytes: 0, trashBytes: 0 });
  });

  it("names the kinds, and has a word for one it doesn't know", () => {
    expect(kindText("worktree")).toBe("Worktree");
    expect(kindText("build_output")).toBe("Build output");
    expect(kindText("simulator")).toBe("Simulator");
    expect(kindText("something_new")).toBe("Item");
  });
});
