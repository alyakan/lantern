import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { pushRestorePoints, restorePointsOn, setRestorePoints } from "./restorePointsSetting";

vi.mock("../api", () => ({ api: { setRestorePoints: vi.fn(() => Promise.resolve()) } }));

describe("the setting that keeps restore points before each message", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(api.setRestorePoints).mockClear();
  });

  it("is on until turned off, and tells the backend on every change and at start", async () => {
    expect(restorePointsOn()).toBe(true);
    await pushRestorePoints();
    expect(api.setRestorePoints).toHaveBeenLastCalledWith(true);
    setRestorePoints(false);
    expect(restorePointsOn()).toBe(false);
    expect(api.setRestorePoints).toHaveBeenLastCalledWith(false);
    await pushRestorePoints();
    expect(api.setRestorePoints).toHaveBeenLastCalledWith(false);
    setRestorePoints(true);
    expect(restorePointsOn()).toBe(true);
  });
});
