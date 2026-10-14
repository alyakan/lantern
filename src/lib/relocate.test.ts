import { describe, expect, it } from "vitest";
import { FOLDER_RECORDS, LAST_FOLDER, NOT_FOLDER_KEYED, OPEN_CHATS, migrateFolderState, type KeyValueStore } from "./relocate";

/** An in-memory localStorage: the keys and values as they'd be saved. */
function memoryStore(initial: Record<string, unknown> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const read = (store: { data: Map<string, string> }, key: string) => JSON.parse(store.data.get(key) ?? "null");

const OLD = "/Users/you/Documents/Github/acme-api";
const NEXT = "/Users/you/dev/Github/acme-api";

describe("migrateFolderState", () => {
  it("gives the new folder each per-folder entry of the old one", () => {
    const store = memoryStore({
      "settings.modeByFolder": { [OLD]: "steps", "/other": "ask" },
      "settings.autoApproveByFolder": { [OLD]: true },
      "settings.promptHistory": { [OLD]: ["fix the retry"] },
      "settings.harnessByFolder": { [OLD]: "max" },
      "review.collapsedByFolder": { [OLD]: true },
      "settings.pinnedSessions": { [OLD]: ["s1"] },
    });
    const changed = migrateFolderState(store, OLD, NEXT);
    expect(Object.keys(changed).sort()).toEqual([...FOLDER_RECORDS].sort());
    expect(read(store, "settings.modeByFolder")).toEqual({ [OLD]: "steps", "/other": "ask", [NEXT]: "steps" });
    expect(read(store, "settings.autoApproveByFolder")).toEqual({ [OLD]: true, [NEXT]: true });
    expect(read(store, "settings.promptHistory")).toEqual({ [OLD]: ["fix the retry"], [NEXT]: ["fix the retry"] });
    expect(read(store, "settings.harnessByFolder")).toEqual({ [OLD]: "max", [NEXT]: "max" });
    expect(read(store, "review.collapsedByFolder")).toEqual({ [OLD]: true, [NEXT]: true });
    expect(read(store, "settings.pinnedSessions")).toEqual({ [OLD]: ["s1"], [NEXT]: ["s1"] });
    // What was returned is what was written.
    expect(changed["settings.modeByFolder"]).toEqual(read(store, "settings.modeByFolder"));
  });

  it("keeps an entry the new folder already has", () => {
    const store = memoryStore({ "settings.modeByFolder": { [OLD]: "steps", [NEXT]: "ask" } });
    expect(migrateFolderState(store, OLD, NEXT)).toEqual({});
    expect(read(store, "settings.modeByFolder")).toEqual({ [OLD]: "steps", [NEXT]: "ask" });
  });

  it("does nothing for a folder with no saved state, and ignores a key that doesn't read back", () => {
    const store = memoryStore({ "settings.modeByFolder": { "/other": "ask" } });
    store.data.set("settings.promptHistory", "{not json");
    expect(migrateFolderState(store, OLD, NEXT)).toEqual({});
    expect(store.data.get("settings.promptHistory")).toBe("{not json");
    expect(migrateFolderState(memoryStore(), OLD, NEXT)).toEqual({});
  });

  it("points the last folder at the new path, and only if it was the old one", () => {
    expect(migrateFolderState(memoryStore({ [LAST_FOLDER]: OLD }), OLD, NEXT)).toEqual({ [LAST_FOLDER]: NEXT });
    expect(migrateFolderState(memoryStore({ [LAST_FOLDER]: "/other" }), OLD, NEXT)).toEqual({});
  });

  it("names the new folder in the chats saved from the old one, each chat once", () => {
    const chats = [
      { sessionId: "s1", folder: OLD, title: "Retries", draft: "", active: true },
      { sessionId: null, folder: OLD, title: "Draft", draft: "try this", active: false },
      { sessionId: "s2", folder: "/other", title: "Elsewhere", draft: "", active: false },
      { sessionId: "s1", folder: NEXT, title: "Retries", draft: "", active: false },
    ];
    const store = memoryStore({ [OPEN_CHATS]: chats });
    migrateFolderState(store, OLD, NEXT);
    // In their saved order: the old session is the one already listed for the new folder, so it isn't kept twice.
    expect(read(store, OPEN_CHATS)).toEqual([
      { sessionId: null, folder: NEXT, title: "Draft", draft: "try this", active: false },
      { sessionId: "s2", folder: "/other", title: "Elsewhere", draft: "", active: false },
      { sessionId: "s1", folder: NEXT, title: "Retries", draft: "", active: false },
    ]);
  });

  it("writes nothing when a store refuses writes, but still reports the move", () => {
    const store: KeyValueStore = {
      getItem: () => JSON.stringify({ [OLD]: "steps" }),
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(migrateFolderState(store, OLD, NEXT)["settings.modeByFolder"]).toEqual({ [OLD]: "steps", [NEXT]: "steps" });
  });
});

// The drift guard: every key the app saves with usePersistentState is classified here, so a new per-folder key can't be
// forgotten by a move. The keys are read from the sources, as api.test.ts reads its commands.
const sources = Object.entries(import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>).filter(
  ([path]) => !/\.test\.tsx?$/.test(path),
);
const saved = [...new Set(sources.flatMap(([, text]) => [...text.matchAll(/usePersistentState(?:<[\s\S]*?>)?\(\s*"([^"]+)"/g)].map((m) => m[1])))];
const chatKeys = sources.some(([, text]) => text.includes(`"${OPEN_CHATS}"`)) ? [OPEN_CHATS] : [];

describe("the keys the app writes", () => {
  it("finds the saved keys in the sources", () => {
    expect(saved.length).toBeGreaterThan(20);
  });

  it("classifies every saved key as a folder's record or as not about a folder", () => {
    const classified = [...FOLDER_RECORDS, LAST_FOLDER, ...NOT_FOLDER_KEYED];
    expect(saved.filter((key) => !classified.includes(key as never))).toEqual([]);
  });

  it("has every migrated key in use, and no classified key the app no longer writes", () => {
    for (const key of [...FOLDER_RECORDS, LAST_FOLDER]) expect(saved, key).toContain(key);
    expect(chatKeys).toEqual([OPEN_CHATS]);
    for (const key of NOT_FOLDER_KEYED) expect(saved, key).toContain(key);
  });
});
