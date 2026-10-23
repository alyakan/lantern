import { act, renderHook } from "@testing-library/react-native";
import { markSeen, resetSeen, settleSeen, useSeen } from "./seen";

// What the phone mockKept: in memory here, not in the Keychain.
let mockKept: Record<string, number> | null = null;
const mockSaved: Record<string, number>[] = [];
jest.mock("./prefs", () => ({
  loadSeen: jest.fn(async () => (mockKept ? { ...mockKept } : null)),
  saveSeen: jest.fn(async (m: Record<string, number>) => {
    mockSaved.push({ ...m });
  }),
}));

beforeEach(() => {
  jest.useFakeTimers();
  mockKept = null;
  mockSaved.length = 0;
  resetSeen();
});
afterEach(() => jest.useRealTimers());

const settle = async () => act(async () => void (await jest.advanceTimersByTimeAsync(10)));

describe("what each chat was last shown at", () => {
  it("is what was kept", async () => {
    mockKept = { a: 5 };
    const { result } = await renderHook(() => useSeen());
    await settle();
    expect(result.current).toEqual({ a: 5 });
  });

  it("takes what is listed the first launch as seen, and only then", async () => {
    const { result } = await renderHook(() => useSeen());
    await settle();
    // Nothing was kept: it stays unknown (so nothing is called unread) until the listing has been taken as seen.
    expect(result.current).toBeNull();
    await act(async () => settleSeen([{ slot: "a", active_at: 10 }, { slot: "b", active_at: 20 }]));
    await settle();
    expect(result.current).toEqual({ a: 10, b: 20 });
    // A chat that appears afterwards isn't taken as seen: it has no mark, so what is in it is new.
    await act(async () => settleSeen([{ slot: "a", active_at: 10 }, { slot: "b", active_at: 20 }, { slot: "c", active_at: 30 }]));
    await settle();
    expect(result.current).toEqual({ a: 10, b: 20 });
  });

  it("moves a chat's mark forward when it is shown, never back", async () => {
    mockKept = { a: 10 };
    const { result } = await renderHook(() => useSeen());
    await settle();
    await act(async () => markSeen("a", 40));
    await settle();
    expect(result.current).toEqual({ a: 40 });
    await act(async () => markSeen("a", 25));
    await settle();
    expect(result.current).toEqual({ a: 40 });
  });

  it("drops the mark of a chat that is no longer listed", async () => {
    mockKept = { a: 10, gone: 3 };
    const { result } = await renderHook(() => useSeen());
    await settle();
    await act(async () => settleSeen([{ slot: "a", active_at: 10 }]));
    await settle();
    expect(result.current).toEqual({ a: 10 });
  });

  it("doesn't drop them all for an empty list (not connected)", async () => {
    mockKept = { a: 10 };
    const { result } = await renderHook(() => useSeen());
    await settle();
    await act(async () => settleSeen([]));
    await settle();
    expect(result.current).toEqual({ a: 10 });
  });

  it("writes a burst of marks down once, a moment after", async () => {
    mockKept = { a: 1 };
    await renderHook(() => useSeen());
    await settle();
    await act(async () => {
      markSeen("a", 2);
      markSeen("a", 3);
      markSeen("a", 4);
    });
    await settle();
    expect(mockSaved).toEqual([]);
    await act(async () => void (await jest.advanceTimersByTimeAsync(1100)));
    expect(mockSaved).toEqual([{ a: 4 }]);
  });
});
