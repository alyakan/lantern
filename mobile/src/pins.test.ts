import { act, renderHook, waitFor } from "@testing-library/react-native";
import { PINS_KEPT, resetPins, setPinned, settlePins, usePins } from "./pins";
import { rows } from "./view/home";
import { chat, NOW } from "./test/render";

const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));

beforeEach(() => {
  mockStore.clear();
  resetPins();
});

describe("pins", () => {
  it("pins newest first, unpins, and remembers across a restart", async () => {
    const { result } = await renderHook(() => usePins());
    await act(async () => {
      setPinned("a", true);
      setPinned("b", true);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(result.current).toEqual(["b", "a"]);
    await act(async () => {
      setPinned("a", false);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(result.current).toEqual(["b"]);
    expect(JSON.parse(mockStore.get("lantern.pinned-chats")!)).toEqual(["b"]);
    resetPins();
    const again = await renderHook(() => usePins());
    await waitFor(() => expect(again.result.current).toEqual(["b"]));
  });

  it("pins a chat once, and keeps only so many", async () => {
    const { result } = await renderHook(() => usePins());
    await act(async () => {
      for (let n = 0; n < PINS_KEPT + 3; n++) setPinned(`c${n}`, true);
      setPinned("c5", true);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current).toHaveLength(PINS_KEPT);
    expect(result.current[0]).toBe(`c${PINS_KEPT + 2}`);
  });

  it("drops a pin on a chat the Mac no longer lists", async () => {
    const { result } = await renderHook(() => usePins());
    await act(async () => {
      setPinned("a", true);
      setPinned("b", true);
      await new Promise((r) => setTimeout(r, 10));
      settlePins(["b", "z"]);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(result.current).toEqual(["b"]);
  });
});

describe("pinned rows", () => {
  it("lead the list whatever they are doing, in the list's usual order among themselves", () => {
    const chats = [chat({ slot: "a", title: "A", status: "needs_you" }), chat({ slot: "b", title: "B", status: "idle", active_at: NOW - 9_000_000 }), chat({ slot: "c", title: "C", status: "idle", active_at: NOW - 8_000_000 })];
    expect(rows(chats, NOW).map((r) => r.slot)).toEqual(["a", "c", "b"]);
    expect(rows(chats, NOW, null, {}, ["b"]).map((r) => r.slot)).toEqual(["b", "a", "c"]);
    expect(rows(chats, NOW, null, {}, ["c", "b"]).map((r) => r.slot)).toEqual(["c", "b", "a"]);
  });
});
