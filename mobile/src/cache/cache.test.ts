import { Cache, CACHE_VERSION } from "./cache";
import { MemoryCacheStore } from "./store";

const isNum = (v: unknown): v is number => typeof v === "number";

function setup() {
  const store = new MemoryCacheStore();
  let now = 1_000;
  const cache = new Cache(store, () => now);
  return { store, cache, advance: (ms: number) => (now += ms), at: () => now };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("a cached resource", () => {
  it("asks the Mac the first time, keeps the answer, and shares it between everyone who reads it", async () => {
    const { store, cache, at } = setup();
    const fetch = jest.fn(async () => 42);
    const r = cache.resource({ key: "n", fetch, freshMs: 60_000, check: isNum });
    await r.load();
    expect(r.getState()).toEqual({ value: 42, savedAt: at(), loading: false, error: null });
    expect(JSON.parse(store.entries.get("n")!)).toEqual({ v: CACHE_VERSION, at: at(), value: 42 });
    expect(cache.resource({ key: "n", fetch, freshMs: 60_000, check: isNum })).toBe(r);
  });

  it("shows what was kept at once and doesn't ask while it is fresh", async () => {
    const { store, cache } = setup();
    store.entries.set("n", JSON.stringify({ v: CACHE_VERSION, at: 900, value: 7 }));
    const fetch = jest.fn(async () => 8);
    const r = cache.resource({ key: "n", fetch, freshMs: 60_000, check: isNum });
    await r.load();
    expect(r.getState().value).toBe(7);
    expect(r.getState().savedAt).toBe(900);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows what was kept while it asks again once that is stale", async () => {
    const { store, cache } = setup();
    store.entries.set("n", JSON.stringify({ v: CACHE_VERSION, at: 0, value: 7 }));
    const answer = deferred<number>();
    const r = cache.resource({ key: "n", fetch: () => answer.promise, freshMs: 500, check: isNum });
    const loading = r.load();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.getState()).toMatchObject({ value: 7, loading: true });
    answer.resolve(8);
    await loading;
    expect(r.getState()).toMatchObject({ value: 8, loading: false });
  });

  it("asks again on a pull however fresh it is, and once its freshness runs out", async () => {
    const { cache, advance } = setup();
    let n = 0;
    const r = cache.resource({ key: "n", fetch: async () => ++n, freshMs: 1_000, check: isNum });
    await r.load();
    await r.load();
    expect(n).toBe(1);
    await r.load({ force: true });
    expect(n).toBe(2);
    advance(1_000);
    await r.load();
    expect(n).toBe(3);
  });

  it("asks once when several screens load it at the same time", async () => {
    const { cache } = setup();
    const answer = deferred<number>();
    const fetch = jest.fn(() => answer.promise);
    const r = cache.resource({ key: "n", fetch, freshMs: 1_000, check: isNum });
    const both = Promise.all([r.load(), r.load({ force: true })]);
    await new Promise((res) => setTimeout(res, 0));
    answer.resolve(1);
    await both;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps what it showed when an ask fails, says why, and asks again next time", async () => {
    const { cache } = setup();
    const fetch = jest.fn<Promise<number>, []>().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("Mac asleep")).mockResolvedValueOnce(2);
    const r = cache.resource({ key: "n", fetch, freshMs: 60_000, check: isNum });
    await r.load();
    await r.load({ force: true });
    expect(r.getState()).toMatchObject({ value: 1, error: "Mac asleep", loading: false });
    // Fresh, but the last ask failed: it asks again.
    await r.load();
    expect(r.getState()).toMatchObject({ value: 2, error: null });
  });

  it("drops what was kept by an older version, in another shape, or unreadable", async () => {
    for (const raw of [JSON.stringify({ v: CACHE_VERSION - 1, at: 1, value: 7 }), JSON.stringify({ v: CACHE_VERSION, at: 1, value: "seven" }), "{not json"]) {
      const { store, cache } = setup();
      store.entries.set("n", raw);
      const r = cache.resource({ key: "n", fetch: async () => 9, freshMs: 60_000, check: isNum });
      await r.load();
      expect(r.getState().value).toBe(9);
      expect(JSON.parse(store.entries.get("n")!).value).toBe(9);
    }
  });

  it("forgets everything on a clear, and an answer that lands after it is neither shown nor kept", async () => {
    const { store, cache } = setup();
    store.entries.set("old", JSON.stringify({ v: CACHE_VERSION, at: 1, value: 1 }));
    const answer = deferred<number>();
    const r = cache.resource({ key: "n", fetch: () => answer.promise, freshMs: 60_000, check: isNum });
    const loading = r.load();
    await new Promise((res) => setTimeout(res, 0));
    await cache.clear();
    answer.resolve(5);
    await loading;
    expect(r.getState()).toEqual({ value: null, savedAt: null, loading: false, error: null });
    expect(store.entries.size).toBe(0);
    // After the clear it asks afresh.
    const fetch = jest.fn(async () => 6);
    const again = cache.resource({ key: "m", fetch, freshMs: 60_000, check: isNum });
    await again.load();
    expect(again.getState().value).toBe(6);
  });

  it("holds the answer in memory when the store can't write it", async () => {
    const { store, cache } = setup();
    store.write = async () => {
      throw new Error("disk full");
    };
    const r = cache.resource({ key: "n", fetch: async () => 3, freshMs: 60_000, check: isNum });
    await r.load();
    expect(r.getState()).toMatchObject({ value: 3, error: null });
  });
});
