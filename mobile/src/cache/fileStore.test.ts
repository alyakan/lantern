import { createFileCacheStore, fileNameOf } from "./fileStore";

// A folder of files in memory, standing in for expo-file-system's (its native side isn't on Node).
const mockDisk = new Map<string, string>();
jest.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get exists() {
      return [...mockDisk.keys()].some((k) => k.startsWith(`${this.uri}/`));
    }
    create() {}
    delete() {
      for (const k of [...mockDisk.keys()]) if (k.startsWith(`${this.uri}/`)) mockDisk.delete(k);
    }
  }
  class File {
    uri: string;
    constructor(dir: { uri: string }, name: string) {
      this.uri = `${dir.uri}/${name}`;
    }
    get exists() {
      return mockDisk.has(this.uri);
    }
    async text() {
      return mockDisk.get(this.uri)!;
    }
    async write(t: string) {
      mockDisk.set(this.uri, t);
    }
    delete() {
      mockDisk.delete(this.uri);
    }
  }
  return { Directory, File, Paths: { cache: { uri: "caches" } } };
});

beforeEach(() => mockDisk.clear());

describe("the cache's files", () => {
  it("keeps each entry as a file in its own folder in the caches folder, and reads it back", async () => {
    const store = createFileCacheStore();
    await store.write("insights.week", '{"a":1}');
    expect([...mockDisk.keys()]).toEqual([`caches/lantern-cache/${fileNameOf("insights.week")}`]);
    expect(await store.read("insights.week")).toBe('{"a":1}');
    expect(await store.read("nothing")).toBeNull();
  });

  it("names files so no key reaches outside the folder", () => {
    for (const key of ["../../Documents/x", "todos./etc/passwd", "a\\b", "ünïcode project"]) {
      expect(fileNameOf(key)).toMatch(/^[A-Za-z0-9_-]+\.json$/);
    }
    expect(fileNameOf("a")).not.toBe(fileNameOf("b"));
  });

  it("removes one entry, or all of them", async () => {
    const store = createFileCacheStore();
    await store.write("a", "1");
    await store.write("b", "2");
    await store.remove("a");
    expect(await store.read("a")).toBeNull();
    expect(await store.read("b")).toBe("2");
    await store.clear();
    expect(mockDisk.size).toBe(0);
  });
});
