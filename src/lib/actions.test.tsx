import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ACTIONS, actionForKey, actionIdForKey, availableActions, resetActionsForTest, runAction, shortcutLabel, useAction, type ActionId } from "./actions";
import { useShortcut } from "./shortcuts";
import menuSource from "../../src-tauri/src/menu.rs?raw";

/** A component that owns an action while it's mounted. */
function Owner({ id, run, enabled = true }: { id: ActionId; run: () => void; enabled?: boolean }) {
  useAction(id, run, enabled);
  return null;
}

beforeEach(() => resetActionsForTest());
afterEach(() => {
  cleanup();
  resetActionsForTest();
  vi.restoreAllMocks();
});

const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => ({ key: k, metaKey: true, ...mods });

describe("the shortcut labels", () => {
  it("writes ⇧ before ⌘ and capitalises letters, as macOS does", () => {
    expect(shortcutLabel({ key: "n" })).toBe("⌘N");
    expect(shortcutLabel({ key: "f", shift: true })).toBe("⇧⌘F");
    expect(shortcutLabel({ key: "\\" })).toBe("⌘\\");
    expect(shortcutLabel({ key: "," })).toBe("⌘,");
    expect(shortcutLabel({})).toBeNull();
  });
});

describe("which action a keystroke names", () => {
  it("matches ⌘ with and without Shift, and nothing with Ctrl or Option", () => {
    expect(actionForKey(key("n"))?.id).toBe("new-session");
    expect(actionForKey(key("F", { shiftKey: true }))?.id).toBe("search-files");
    expect(actionForKey(key("f"))?.id).toBe("find-in-file");
    expect(actionForKey(key("n", { ctrlKey: true }))).toBeUndefined();
    expect(actionForKey(key("n", { altKey: true }))).toBeUndefined();
    expect(actionForKey({ key: "n", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBeUndefined();
    expect(actionForKey(key("\\"))?.id).toBe("toggle-changes");
  });

  it("has Start a Team on ⇧⌘N, next to New Chat on ⌘N, and the side panel's toggle on ⌘\\", () => {
    expect(actionForKey(key("n", { shiftKey: true }))?.id).toBe("work-team");
    expect(ACTIONS.find((d) => d.id === "work-team")).toMatchObject({ title: "Start a Team", group: "Work", menu: true, native: true });
    expect(ACTIONS.find((d) => d.id === "new-session")?.title).toBe("New Chat");
    expect(ACTIONS.find((d) => d.id === "toggle-changes")?.title).toBe("Show/Hide Side Panel");
  });

  it("gives every shortcut to one action only", () => {
    const seen = new Map<string, string>();
    for (const def of ACTIONS) {
      if (!def.key) continue;
      const k = `${def.shift ? "shift+" : ""}${def.key}`;
      expect(seen.get(k), `${def.id} and ${seen.get(k)} share ${k}`).toBeUndefined();
      seen.set(k, def.id);
    }
  });
});

describe("the Work menu", () => {
  it("lists Build, Review a PR…, Debug, Design and Start a Team, in the menu bar and the palette's registry", () => {
    const work = ACTIONS.filter((d) => d.group === "Work");
    expect(work.map((d) => d.title)).toEqual(["Build", "Review a PR…", "Debug", "Design", "Start a Team"]);
    expect(work.every((d) => d.menu)).toBe(true);
    // Each is in the native menu's Work submenu too.
    for (const d of work) expect(menuSource, d.id).toContain(`("${d.id}", "${d.title === "Start a Team" ? "Start a Team" : d.title}"`);
  });

  it("is offered by the palette only while an owner has each enabled", () => {
    render(<Owner id="work-build" run={() => {}} />);
    expect(availableActions().map((e) => e.title)).toEqual(["Build"]);
  });
});

describe("running an action", () => {
  it("runs the owner's action while it's enabled, and not when it isn't", () => {
    const run = vi.fn();
    const { rerender } = render(<Owner id="settings" run={run} enabled={false} />);
    expect(runAction("settings")).toBe(false);
    rerender(<Owner id="settings" run={run} enabled />);
    expect(runAction("settings")).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("uses the latest run, without re-registering", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Owner id="settings" run={first} />);
    rerender(<Owner id="settings" run={second} />);
    runAction("settings");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("is off once its owner unmounts", () => {
    const run = vi.fn();
    const { unmount } = render(<Owner id="settings" run={run} />);
    unmount();
    expect(runAction("settings")).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("is the newest owner that runs it, so an action has one handler", () => {
    const older = vi.fn();
    const newer = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const a = render(<Owner id="settings" run={older} />);
    const b = render(<Owner id="settings" run={newer} />);
    runAction("settings");
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
    b.unmount();
    now.mockReturnValue(5000);
    runAction("settings");
    expect(older).toHaveBeenCalledTimes(1);
    a.unmount();
  });

  it("drops a second run of the same action within a moment: the key and the menu item arriving together", () => {
    const run = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    render(<Owner id="new-session" run={run} />);
    runAction("new-session");
    now.mockReturnValue(1100);
    runAction("new-session");
    expect(run).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1400);
    runAction("new-session");
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("the keyboard", () => {
  it("runs an enabled action on its ⌘ key, and leaves the key alone otherwise", () => {
    const run = vi.fn();
    render(<Owner id="settings" run={run} />);
    expect(fireEvent.keyDown(window, key(","))).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("doesn't use the key when the action is disabled", () => {
    const run = vi.fn();
    render(<Owner id="settings" run={run} enabled={false} />);
    expect(fireEvent.keyDown(window, key(","))).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves Keyboard Shortcuts and Session History alone while focus is in Monaco, where ⌘/ and ⌘K are its own", () => {
    const run = vi.fn();
    render(<Owner id="keyboard-shortcuts" run={run} />);
    const editor = document.createElement("div");
    editor.className = "monaco-editor";
    const input = document.createElement("textarea");
    editor.append(input);
    document.body.append(editor);
    input.focus();
    fireEvent.keyDown(input, key("/", { bubbles: true }));
    expect(run).not.toHaveBeenCalled();
    editor.remove();
    fireEvent.keyDown(window, key("/"));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs the action a component's useShortcut names, by key", () => {
    const run = vi.fn();
    function Input() {
      useShortcut("l", run);
      return null;
    }
    render(<Input />);
    fireEvent.keyDown(window, key("l"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(actionIdForKey("l")).toBe("focus-input");
    expect(actionIdForKey("f", true)).toBe("search-files");
    expect(() => actionIdForKey("q")).toThrow(/⌘Q/);
  });
});

describe("the palette's list", () => {
  it("lists only the enabled actions, with their shortcuts", () => {
    render(
      <>
        <Owner id="settings" run={() => {}} />
        <Owner id="search-files" run={() => {}} enabled={false} />
        <Owner id="report-bug" run={() => {}} />
      </>,
    );
    const list = availableActions();
    expect(list.map((a) => a.id)).toEqual(["settings", "report-bug"]);
    expect(list[0]).toMatchObject({ title: "Settings…", group: "View", shortcut: "⌘," });
    expect(list[1].shortcut).toBeNull();
  });
});

describe("the menu bar and the registry", () => {
  // The Rust menu lists the actions it shows, by id, with its accelerators: those lists are read back here.
  const menuIds = [...menuSource.matchAll(/\("([a-z-]+)", "[^"]*", (?:Some\("[^"]*"\)|None)\)/g)].map((m) => m[1]);

  it("reads the menu's action list", () => {
    expect(menuIds.length).toBeGreaterThan(5);
  });

  it("has a menu entry for every catalogue action that's in the menu, and nothing else", () => {
    const inMenu = ACTIONS.filter((a) => a.menu).map((a) => a.id);
    expect([...menuIds].sort()).toEqual([...inMenu].sort());
  });

  it("keeps the shortcut-only actions out of the menu, so their keys stay with the webview", () => {
    for (const id of ["focus-input", "stop"]) expect(menuIds).not.toContain(id);
  });
});
