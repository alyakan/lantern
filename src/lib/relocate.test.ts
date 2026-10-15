import { describe, expect, it } from "vitest";
import { FOLDER_RECORDS, LAST_FOLDER, NOT_FOLDER_KEYED, OPEN_CHATS, migrateFolderState, movedNote, splitPath, withMovedNote, type KeyValueStore } from "./relocate";
import { initialState, reducer } from "../store";

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
      "settings.permissionsByFolder": { [OLD]: "auto", "/other": "ask" },
      "settings.workflowByFolder": { [OLD]: "steps" },
      "settings.subagentsByFolder": { [OLD]: "inline" },
      "settings.promptHistory": { [OLD]: ["fix the retry"] },
      "settings.harnessByFolder": { [OLD]: "max" },
      "review.collapsedByFolder": { [OLD]: true },
      "settings.pinnedSessions": { [OLD]: ["s1"] },
    });
    const changed = migrateFolderState(store, OLD, NEXT);
    expect(Object.keys(changed).sort()).toEqual([...FOLDER_RECORDS].sort());
    expect(read(store, "settings.permissionsByFolder")).toEqual({ [OLD]: "auto", "/other": "ask", [NEXT]: "auto" });
    expect(read(store, "settings.workflowByFolder")).toEqual({ [OLD]: "steps", [NEXT]: "steps" });
    expect(read(store, "settings.subagentsByFolder")).toEqual({ [OLD]: "inline", [NEXT]: "inline" });
    expect(read(store, "settings.promptHistory")).toEqual({ [OLD]: ["fix the retry"], [NEXT]: ["fix the retry"] });
    expect(read(store, "settings.harnessByFolder")).toEqual({ [OLD]: "max", [NEXT]: "max" });
    expect(read(store, "review.collapsedByFolder")).toEqual({ [OLD]: true, [NEXT]: true });
    expect(read(store, "settings.pinnedSessions")).toEqual({ [OLD]: ["s1"], [NEXT]: ["s1"] });
    // What was returned is what was written.
    expect(changed["settings.permissionsByFolder"]).toEqual(read(store, "settings.permissionsByFolder"));
  });

  it("keeps an entry the new folder already has", () => {
    const store = memoryStore({ "settings.permissionsByFolder": { [OLD]: "auto", [NEXT]: "ask" } });
    expect(migrateFolderState(store, OLD, NEXT)).toEqual({});
    expect(read(store, "settings.permissionsByFolder")).toEqual({ [OLD]: "auto", [NEXT]: "ask" });
  });

  it("does nothing for a folder with no saved state, and ignores a key that doesn't read back", () => {
    const store = memoryStore({ "settings.permissionsByFolder": { "/other": "ask" } });
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
    expect(migrateFolderState(store, OLD, NEXT)["settings.permissionsByFolder"]).toEqual({ [OLD]: "steps", [NEXT]: "steps" });
  });
});

describe("the moved note", () => {
  it("says the project moved, and that earlier paths are the old ones", () => {
    expect(movedNote(OLD, NEXT)).toBe(`[Lantern note: This project moved from ${OLD} to ${NEXT}: paths in earlier messages are the old ones.]`);
  });

  it("goes in front of the message, and only when there's a move and it isn't a slash command", () => {
    expect(withMovedNote("why?", OLD, NEXT)).toBe(`${movedNote(OLD, NEXT)}\n\nwhy?`);
    expect(withMovedNote("why?", null, NEXT)).toBe("why?");
    expect(withMovedNote("why?", OLD, null)).toBe("why?");
    expect(withMovedNote("/compact", OLD, NEXT)).toBe("/compact");
  });

  it("is set by opening a session from the old place, goes with the first message, and stays for a slash command", () => {
    const opened = reducer(initialState, { type: "folder_opened", folder: NEXT });
    const replayed = reducer(opened, { type: "history_loaded", sessionId: "s1", events: [], movedFrom: OLD });
    expect(replayed.movedFrom).toBe(OLD);
    expect(reducer(replayed, { type: "user_sent", text: "/compact" }).movedFrom).toBe(OLD);
    expect(reducer(replayed, { type: "user_sent", text: "why?" }).movedFrom).toBeNull();
    // A session opened from its own folder has no note.
    expect(reducer(opened, { type: "history_loaded", sessionId: "s2", events: [] }).movedFrom).toBeNull();
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

describe("splitPath", () => {
  it("splits a path into its folder and its last name, which a long path keeps", () => {
    expect(splitPath("/Users/you/dev/app")).toEqual(["/Users/you/dev/", "app"]);
    expect(splitPath("/Users/you/dev/app/")).toEqual(["/Users/you/dev/", "app"]);
    expect(splitPath("/app")).toEqual(["/", "app"]);
    expect(splitPath("/")).toEqual(["/", ""]);
    expect(splitPath("app")).toEqual(["", "app"]);
  });
});
