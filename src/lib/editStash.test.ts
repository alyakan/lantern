import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "@tauri-apps/plugin-dialog";
import { clearStash, guardWindowClose, setDirty, stash, unsavedCount } from "./editStash";

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
const onCloseRequested = vi.fn((_handler: unknown) => Promise.resolve(() => {}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: (h: unknown) => onCloseRequested(h) }) }));
const asked = vi.mocked(ask);

type CloseHandler = (event: { preventDefault: () => void }) => Promise<void>;
const closeEvent = () => ({ preventDefault: vi.fn() });

describe("unsaved edits", () => {
  beforeEach(() => clearStash());

  it("counts the files with edits not yet saved: open editors and edits kept from closed ones", () => {
    setDirty("s1:/p/a.ts", true);
    stash("s1:/p/b.ts", "one", "two");
    expect(unsavedCount()).toBe(2);
    setDirty("s1:/p/a.ts", false);
    expect(unsavedCount()).toBe(1);
  });

  it("doesn't count an editor closed with its edits saved", () => {
    stash("s1:/p/a.ts", "same", "same");
    expect(unsavedCount()).toBe(0);
  });
});

describe("closing the window", () => {
  beforeEach(() => {
    clearStash();
    asked.mockReset();
    onCloseRequested.mockClear();
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  const handler = (): CloseHandler => {
    guardWindowClose();
    return onCloseRequested.mock.calls[0][0] as unknown as CloseHandler;
  };

  it("closes straight away when nothing is unsaved", async () => {
    const event = closeEvent();
    await handler()(event);
    expect(asked).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("asks first when there are unsaved edits, and stays open if you keep editing", async () => {
    setDirty("s1:/p/a.ts", true);
    asked.mockResolvedValueOnce(false);
    const event = closeEvent();
    await handler()(event);
    expect(asked).toHaveBeenCalledWith("One file has unsaved changes that are lost when Lantern closes.", expect.objectContaining({ okLabel: "Close anyway", cancelLabel: "Keep editing" }));
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("closes when you choose to close anyway, and counts every file in the question", async () => {
    setDirty("s1:/p/a.ts", true);
    stash("s2:/p/b.ts", "x", "y");
    asked.mockResolvedValueOnce(true);
    const event = closeEvent();
    await handler()(event);
    expect(asked).toHaveBeenCalledWith("2 files have unsaved changes that are lost when Lantern closes.", expect.anything());
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("stays open if the question can't be asked", async () => {
    setDirty("s1:/p/a.ts", true);
    asked.mockRejectedValueOnce(new Error("no dialog"));
    const event = closeEvent();
    await handler()(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("does nothing outside the app", () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    guardWindowClose();
    expect(onCloseRequested).not.toHaveBeenCalled();
  });
});
