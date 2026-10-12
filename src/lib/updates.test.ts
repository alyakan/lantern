import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { api } from "../api";
import type { UpdateState } from "../types";
import { downloadPercent, isInstalling, useUpdateState } from "./updates";

vi.mock("../api", () => ({ api: { onUpdateState: vi.fn(), updateState: vi.fn(), appVersion: vi.fn(), checkForUpdates: vi.fn() } }));
const onUpdateState = vi.mocked(api.onUpdateState);

describe("downloadPercent", () => {
  it("is how far along a download is, and null when it isn't a download or its size isn't known", () => {
    const downloading = (downloaded: number, total: number | null): UpdateState => ({ kind: "downloading", version: "0.1.3", downloaded, total });
    expect(downloadPercent(downloading(0, 200))).toBe(0);
    expect(downloadPercent(downloading(50, 200))).toBe(25);
    expect(downloadPercent(downloading(199, 200))).toBe(100);
    // More than the total (a wrong size from the server) doesn't overflow the bar.
    expect(downloadPercent(downloading(300, 200))).toBe(100);
    expect(downloadPercent(downloading(50, null))).toBeNull();
    expect(downloadPercent(downloading(50, 0))).toBeNull();
    expect(downloadPercent({ kind: "checking" })).toBeNull();
  });

  it("tells installing and restarting from the rest", () => {
    expect([{ kind: "installing", version: "1" }, { kind: "restarting" }].map((s) => isInstalling(s as UpdateState))).toEqual([true, true]);
    expect([{ kind: "idle" }, { kind: "checking" }, { kind: "ready", version: "1" }, { kind: "failed", error: "x" }].map((s) => isInstalling(s as UpdateState))).toEqual([false, false, false, false]);
  });
});

describe("useUpdateState", () => {
  let emit: (state: UpdateState) => void;
  beforeEach(() => {
    onUpdateState.mockReset().mockImplementation((cb) => {
      emit = cb;
      return Promise.resolve(() => {});
    });
    vi.mocked(api.updateState).mockReset().mockResolvedValue({ kind: "idle" });
    vi.mocked(api.appVersion).mockReset().mockResolvedValue("0.1.9");
    vi.mocked(api.checkForUpdates).mockReset();
  });

  it("follows the backend's events and knows the running version", async () => {
    const { result } = renderHook(() => useUpdateState());
    await waitFor(() => expect(result.current.version).toBe("0.1.9"));
    expect(result.current.state).toEqual({ kind: "idle" });
    act(() => emit({ kind: "downloading", version: "0.1.10", downloaded: 10, total: 100 }));
    expect(result.current.state).toMatchObject({ kind: "downloading", downloaded: 10 });
  });

  it("picks up where updating had got to before the window listened, but not over a newer event", async () => {
    vi.mocked(api.updateState).mockResolvedValue({ kind: "downloading", version: "0.1.10", downloaded: 40, total: 100 });
    const { result } = renderHook(() => useUpdateState());
    await waitFor(() => expect(result.current.state).toMatchObject({ kind: "downloading", downloaded: 40 }));
    // An event that arrives while the answer is on its way wins over the older answer.
    vi.mocked(api.updateState).mockReset().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ kind: "checking" }), 20)));
    const second = renderHook(() => useUpdateState());
    act(() => emit({ kind: "ready", version: "0.1.10" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(second.result.current.state).toEqual({ kind: "ready", version: "0.1.10" });
  });

  it("settles on what a check ended with, and shows a check that failed", async () => {
    const { result } = renderHook(() => useUpdateState());
    await waitFor(() => expect(result.current.version).not.toBeNull());
    vi.mocked(api.checkForUpdates).mockResolvedValueOnce({ kind: "up_to_date" });
    await act(() => result.current.check());
    expect(result.current.state).toEqual({ kind: "up_to_date" });
    vi.mocked(api.checkForUpdates).mockRejectedValueOnce("This is a development build.");
    await act(() => result.current.check());
    expect(result.current.state).toEqual({ kind: "failed", error: "This is a development build." });
    vi.mocked(api.checkForUpdates).mockRejectedValueOnce(new Error("offline"));
    await act(() => result.current.check());
    expect(result.current.state).toEqual({ kind: "failed", error: "offline" });
  });
});
