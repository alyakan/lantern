import { ageText, KNOWN_KEPT, loadLastKnown, saveLastKnown, snapshotOf, TITLE_MAX } from "./lastKnown";
import { chat } from "./test/render";

const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));

beforeEach(() => mockStore.clear());

describe("snapshotOf", () => {
  it("keeps titles and projects, newest first, and nothing that could be stale or private", () => {
    const k = snapshotOf([chat({ slot: "a", title: "Old one", active_at: 1 }), chat({ slot: "b", title: " Newer ", project: "lantern", active_at: 5 })], "Aly's Mac", 99)!;
    expect(k).toEqual({ at: 99, mac: "Aly's Mac", chats: [{ title: "Newer", project: "lantern" }, { title: "Old one", project: "lantern" }] });
    expect(JSON.stringify(k)).not.toContain('"slot"');
    expect(JSON.stringify(k)).not.toContain("status");
  });

  it("skips a chat with no real title, cuts long ones, and keeps the newest few", () => {
    expect(snapshotOf([chat({ title: null }), chat({ title: "  " })], null, 1)).toBeNull();
    expect(snapshotOf([chat({ title: "x".repeat(200) })], null, 1)!.chats[0].title).toHaveLength(TITLE_MAX);
    const many = Array.from({ length: KNOWN_KEPT + 5 }, (_, n) => chat({ slot: `s${n}`, title: `t${n}`, active_at: n }));
    const k = snapshotOf(many, null, 1)!;
    expect(k.chats).toHaveLength(KNOWN_KEPT);
    expect(k.chats[0].title).toBe(`t${KNOWN_KEPT + 4}`);
  });
});

describe("ageText", () => {
  it("says how long ago in a few words", () => {
    const now = 10 * 86_400_000;
    expect(ageText(now - 20_000, now)).toBe("just now");
    expect(ageText(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(ageText(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(ageText(now - 30 * 3_600_000, now)).toBe("yesterday");
    expect(ageText(now - 3 * 86_400_000, now)).toBe("3 days ago");
    expect(ageText(now + 5000, now)).toBe("just now");
  });
});

describe("keeping it", () => {
  it("saves and loads it back", async () => {
    await saveLastKnown({ at: 5, mac: "Mac", chats: [{ title: "A", project: null }] });
    expect(await loadLastKnown()).toEqual({ at: 5, mac: "Mac", chats: [{ title: "A", project: null }] });
  });

  it("is null when nothing was kept or what was kept is not usable", async () => {
    expect(await loadLastKnown()).toBeNull();
    mockStore.set("lantern.last-known", "{not json");
    expect(await loadLastKnown()).toBeNull();
    mockStore.set("lantern.last-known", JSON.stringify({ at: "x", chats: [] }));
    expect(await loadLastKnown()).toBeNull();
    mockStore.set("lantern.last-known", JSON.stringify({ at: 1, chats: [{ title: 5 }, null] }));
    expect(await loadLastKnown()).toBeNull();
  });
});
