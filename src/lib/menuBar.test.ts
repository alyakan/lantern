import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const setMenuBarApi = vi.fn(() => Promise.resolve());
vi.mock("../api", () => ({ api: { setMenuBar: (...a: unknown[]) => (setMenuBarApi as (...x: unknown[]) => Promise<void>)(...a) } }));

import { backendConfig, diskLevel, knownProject, MENU_BAR_DEFAULT, menuBarChats, percent, pressureLevel, pushMenuBar, readMenuBar, setMenuBar, useMenuBar } from "./menuBar";
import type { ProjectOpen } from "./sidebar";

beforeEach(() => {
  localStorage.clear();
  setMenuBarApi.mockClear();
});

describe("menu bar settings", () => {
  it("starts as the whole thing: the lantern, its readout, alerts and every section", () => {
    expect(readMenuBar()).toEqual(MENU_BAR_DEFAULT);
    expect(MENU_BAR_DEFAULT.mode).toBe("full");
  });

  it("keeps what is saved and falls back, part by part, on what isn't valid", () => {
    localStorage.setItem("lantern.menuBar", JSON.stringify({ mode: "icon", ram: false, alerts: "yes", panel: { chats: false, memory: 3 } }));
    const s = readMenuBar();
    expect(s.mode).toBe("icon");
    expect(s.ram).toBe(false);
    // Not a boolean: the default.
    expect(s.alerts).toBe(true);
    expect(s.disk).toBe(true);
    expect(s.panel).toEqual({ memory: true, disk: true, chats: false, newChat: true });
    for (const junk of ['"icon"', "null", "7", "[1]", "{not json", '{"mode":"sideways"}']) {
      localStorage.setItem("lantern.menuBar", junk);
      expect(readMenuBar().mode).toBe("full");
    }
  });

  it("saves a change, merges the panel's sections, and tells the backend only what it needs", () => {
    setMenuBar({ mode: "icon" });
    setMenuBar({ panel: { newChat: false } });
    const s = readMenuBar();
    expect(s.mode).toBe("icon");
    expect(s.panel).toEqual({ memory: true, disk: true, chats: true, newChat: false });
    expect(setMenuBarApi).toHaveBeenLastCalledWith({ mode: "icon", ram: true, disk: true, alerts: true });
    expect(Object.keys(backendConfig(s)).sort()).toEqual(["alerts", "disk", "mode", "ram"]);
  });

  it("pushes the saved choice at launch", async () => {
    localStorage.setItem("lantern.menuBar", JSON.stringify({ mode: "off" }));
    await pushMenuBar();
    expect(setMenuBarApi).toHaveBeenCalledWith({ mode: "off", ram: true, disk: true, alerts: true });
  });

  it("a hook follows a change made anywhere, in this window or the other one", () => {
    const { result } = renderHook(() => useMenuBar());
    expect(result.current.mode).toBe("full");
    act(() => setMenuBar({ mode: "off" }));
    expect(result.current.mode).toBe("off");
    // Another window saved it: only a storage event reaches this one.
    act(() => {
      localStorage.setItem("lantern.menuBar", JSON.stringify({ mode: "icon" }));
      window.dispatchEvent(new StorageEvent("storage", { key: "lantern.menuBar" }));
    });
    expect(result.current.mode).toBe("icon");
  });

  it("lists every open chat and team with its project's name", () => {
    const row = { unread: false, background: 0, sessionId: null, active: false, pinned: false };
    const open = {
      "/Users/me/acme-api": {
        items: [
          { kind: "chat", slot: "s1", title: "Fix retries", state: "waiting", ...row },
          { kind: "team", slot: "s2", title: "New team", state: "running", agents: [], ...row },
        ],
        sessionIds: [],
        needs: 1,
        target: null,
      },
      "/Users/me/web": { items: [{ kind: "chat", slot: "s3", title: "Dark mode", state: "done", ...row }], sessionIds: [], needs: 0, target: null },
    } as unknown as Record<string, ProjectOpen>;
    expect(menuBarChats(open)).toEqual([
      { slot: "s1", title: "Fix retries", project: "acme-api", state: "waiting", team: false },
      { slot: "s2", title: "New team", project: "acme-api", state: "running", team: true },
      { slot: "s3", title: "Dark mode", project: "web", state: "done", team: false },
    ]);
    expect(menuBarChats({})).toEqual([]);
  });

  it("starts a chat only in a project the user already works in", () => {
    const recent = [{ path: "/Users/me/acme-api", updated_ms: 1 }];
    expect(knownProject("/Users/me/acme-api", recent, [])).toBe(true);
    expect(knownProject("/Users/me/other", recent, ["/Users/me/other", null])).toBe(true);
    expect(knownProject("/etc", recent, ["/Users/me/other", null])).toBe(false);
    expect(knownProject("/Users/me/acme-api/../../../etc", recent, [])).toBe(false);
  });

  it("says how low things are on the same lines as the menu bar item", () => {
    expect([diskLevel(null), diskLevel(15_000_000_000), diskLevel(14_999_999_999), diskLevel(5_000_000_000), diskLevel(4_999_999_999)]).toEqual(["ok", "ok", "warn", "warn", "critical"]);
    expect([pressureLevel(undefined), pressureLevel("normal"), pressureLevel("warning"), pressureLevel("critical")]).toEqual(["ok", "ok", "warn", "critical"]);
    expect([percent(10, 16), percent(20, 16), percent(1, 0)]).toEqual([63, 100, 0]);
  });
});
