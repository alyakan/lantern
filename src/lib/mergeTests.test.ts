import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { autoMergeTests, commandLine, pushAutoMergeTests, setAutoMergeTests, testsClock, testsHeadline } from "./mergeTests";

vi.mock("../api", () => ({ api: { setAutoMergeTests: vi.fn(() => Promise.resolve()) } }));

describe("what the merge card says of a test run", () => {
  it("puts the result in plain words", () => {
    expect(testsHeadline({ result: "passed", passed: 214, failed: 0 })).toBe("Tests passed: 214");
    expect(testsHeadline({ result: "passed", passed: null, failed: null })).toBe("Tests passed");
    expect(testsHeadline({ result: "failed", passed: 211, failed: 3 })).toBe("3 tests failed");
    expect(testsHeadline({ result: "failed", passed: 0, failed: 1 })).toBe("1 test failed");
    expect(testsHeadline({ result: "failed", passed: null, failed: null })).toBe("Tests failed");
    expect(testsHeadline({ result: "timed_out", passed: null, failed: null })).toBe("Tests timed out");
  });

  it("tells the time to the second", () => {
    expect(testsClock(0)).toBe("0s");
    expect(testsClock(42_900)).toBe("42s");
    expect(testsClock(65_000)).toBe("1m 05s");
  });

  it("shows a command's words so that each one's end is clear", () => {
    expect(commandLine(["npm", "run", "test:unit"])).toBe("npm run test:unit");
    expect(commandLine(["pytest", "-k", "a and b", ""])).toBe('pytest -k "a and b" ""');
  });
});

describe("the setting that runs tests when a merge is proposed", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(api.setAutoMergeTests).mockClear();
  });

  it("is off until turned on, and tells the backend on every change and at start", async () => {
    expect(autoMergeTests()).toBe(false);
    setAutoMergeTests(true);
    expect(autoMergeTests()).toBe(true);
    expect(api.setAutoMergeTests).toHaveBeenLastCalledWith(true);
    await pushAutoMergeTests();
    expect(api.setAutoMergeTests).toHaveBeenLastCalledWith(true);
    setAutoMergeTests(false);
    expect(autoMergeTests()).toBe(false);
    expect(api.setAutoMergeTests).toHaveBeenLastCalledWith(false);
  });
});
