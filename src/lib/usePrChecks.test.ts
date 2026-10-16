import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { api } from "../api";
import type { PrCheck, PrWatch } from "../types";
import type { PrSetting } from "./prChecks";
import { usePrChecks, type PrChat, type PrChecksOptions } from "./usePrChecks";

vi.mock("../api", () => ({ api: { prWatch: vi.fn(), prFailureLog: vi.fn() } }));
const prWatch = vi.mocked(api.prWatch);
const prFailureLog = vi.mocked(api.prFailureLog);

const FOLDER = "/p";
const run = (name: string, bucket: PrCheck["bucket"], id = "1"): PrCheck => ({ name, state: bucket.toUpperCase(), bucket, link: `https://github.com/o/r/actions/runs/${id}/job/9`, workflow: "CI", run_id: id });
const found = (checks: PrCheck[], head = "aaa", state: "OPEN" | "MERGED" | "CLOSED" = "OPEN"): PrWatch => ({ kind: "found", pr: { number: 5, url: "https://github.com/o/r/pull/5", state, branch: "feat/x", base: "main", head_sha: head }, checks });
const FAILED = (id = "1", head = "aaa") => found([run("build", "pass", id), run("test", "fail", id)], head);
const PASSED = (id = "2", head = "bbb") => found([run("build", "pass", id), run("test", "pass", id)], head);

const chat = (busy = false): PrChat => ({ slot: "s1", folder: FOLDER, live: true, busy });

function setup(setting: PrSetting, first: PrChat = chat()) {
  const send = vi.fn();
  const onFailed = vi.fn();
  const props = (chats: PrChat[]): PrChecksOptions => ({ chats, active: "s1", settings: { [FOLDER]: setting }, send, onFailed });
  const hook = renderHook((p: PrChecksOptions) => usePrChecks(p), { initialProps: props([first]) });
  return { ...hook, send, onFailed, props };
}

/** Lets the pending look (and the log reads after it) finish. */
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(10)));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.resetAllMocks();
  prFailureLog.mockResolvedValue("FAIL src/a.test.ts\nexpected 1 got 2");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the pull request loop", () => {
  it("looks when a chat opens in a project, and shows the pull request", async () => {
    prWatch.mockResolvedValue(found([run("build", "pending")]));
    const { result } = setup({ mode: "tell", tries: 3 });
    await settle();
    expect(prWatch).toHaveBeenCalledWith(FOLDER);
    expect(result.current.views[FOLDER].snap?.pr.number).toBe(5);
    expect(result.current.views[FOLDER].needsYou).toBe(false);
  });

  it("doesn't look at all when the project is Off", async () => {
    prWatch.mockResolvedValue(FAILED());
    const { result } = setup({ mode: "off", tries: 3 });
    await settle();
    expect(prWatch).not.toHaveBeenCalled();
    expect(result.current.views[FOLDER]).toBeUndefined();
  });

  it("shows nothing when there's no pull request, and when gh can't be used it says so", async () => {
    prWatch.mockResolvedValue({ kind: "no_pr" });
    const a = setup({ mode: "tell", tries: 3 });
    await settle();
    expect(a.result.current.views[FOLDER].snap).toBeNull();
    cleanup();
    prWatch.mockResolvedValue({ kind: "no_gh" });
    const b = setup({ mode: "tell", tries: 3 });
    await settle();
    expect(b.result.current.views[FOLDER]).toMatchObject({ snap: null, access: "no_gh" });
  });

  it("polls every 30 seconds while checks run, and stops once they pass", async () => {
    prWatch.mockResolvedValueOnce(found([run("build", "pending")])).mockResolvedValue(PASSED());
    setup({ mode: "tell", tries: 3 });
    await settle();
    expect(prWatch).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(prWatch).toHaveBeenCalledTimes(2);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5 * 60_000)));
    expect(prWatch).toHaveBeenCalledTimes(2);
  });

  it("keeps what it knew when gh fails for a reason that may pass, and tries again", async () => {
    prWatch.mockResolvedValueOnce(found([run("build", "pending")])).mockRejectedValueOnce("network").mockResolvedValue(PASSED());
    const { result } = setup({ mode: "tell", tries: 3 });
    await settle();
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(result.current.views[FOLDER].snap?.checks[0].bucket).toBe("pending");
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(result.current.views[FOLDER].snap?.checks.every((c) => c.bucket === "pass")).toBe(true);
  });

  it("Tell me: tells once when checks finish failed, sends nothing, and the button sends the failure", async () => {
    prWatch.mockResolvedValue(FAILED());
    const { result, send, onFailed } = setup({ mode: "tell", tries: 3 });
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0][0]).toBe(FOLDER);
    expect(result.current.views[FOLDER].needsYou).toBe(true);
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(onFailed).toHaveBeenCalledTimes(1);
    await act(async () => result.current.sendFailure(FOLDER, "s1"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("s1");
    expect(send.mock.calls[0][1]).toContain("Untrusted output from CI");
    expect(send.mock.calls[0][1]).toContain("expected 1 got 2");
    expect(send.mock.calls[0][1]).not.toContain("Lantern sent this on its own");
    expect(prFailureLog).toHaveBeenCalledWith(FOLDER, "1");
    expect(result.current.views[FOLDER].needsYou).toBe(false);
  });

  it("Fix it myself: sends the failure by itself, once, then waits; a new run that passes ends it", async () => {
    prWatch.mockResolvedValue(FAILED());
    const { result, send, onFailed, rerender, props } = setup({ mode: "fix", tries: 3 });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain('try 1 of 3');
    expect(send.mock.calls[0][1]).toContain("Lantern sent this on its own");
    expect(onFailed).not.toHaveBeenCalled();
    expect(result.current.views[FOLDER].loop).toMatchObject({ tries: 1, status: "waiting" });
    // Claude works on it (busy), the same failure is seen again: nothing more is sent.
    rerender(props([chat(true)]));
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(send).toHaveBeenCalledTimes(1);
    // The turn ends with a push; the next look shows the checks passing.
    prWatch.mockResolvedValue(PASSED());
    rerender(props([chat(false)]));
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.views[FOLDER].loop.status).toBe("idle");
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("Fix it myself: never sends while the chat is busy, and sends when its turn ends", async () => {
    prWatch.mockResolvedValue(FAILED());
    const { send, rerender, props } = setup({ mode: "fix", tries: 3 }, chat(true));
    await settle();
    expect(send).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(send).not.toHaveBeenCalled();
    rerender(props([chat(false)]));
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("Fix it myself: the same failure with no push after Claude's turn stops and tells the user", async () => {
    prWatch.mockResolvedValue(FAILED());
    const { result, send, onFailed, rerender, props } = setup({ mode: "fix", tries: 3 });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    rerender(props([chat(true)]));
    await settle();
    rerender(props([chat(false)]));
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.views[FOLDER].loop.status).toBe("stalled");
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(result.current.views[FOLDER].needsYou).toBe(true);
  });

  it("Fix it myself: each new failure after a push is another try, up to the limit, then Out of tries", async () => {
    let n = 0;
    prWatch.mockImplementation(async () => FAILED(String(++n), `c${n}`));
    const { result, send, onFailed, rerender, props } = setup({ mode: "fix", tries: 2 });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) {
      rerender(props([chat(true)]));
      await settle();
      rerender(props([chat(false)]));
      await settle();
    }
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.current.views[FOLDER].loop).toMatchObject({ tries: 2, status: "out" });
    expect(onFailed).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5 * 60_000)));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("Stop ends Fix it myself for the pull request, and nothing more is sent", async () => {
    let n = 0;
    prWatch.mockImplementation(async () => FAILED(String(++n), `c${n}`));
    const { result, send, rerender, props } = setup({ mode: "fix", tries: 3 });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    act(() => result.current.stop(FOLDER));
    expect(result.current.views[FOLDER].loop.status).toBe("stopped");
    rerender(props([chat(true)]));
    await settle();
    rerender(props([chat(false)]));
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.views[FOLDER].needsYou).toBe(true);
  });

  it("sends nothing and stops looking once the pull request is merged", async () => {
    prWatch.mockResolvedValueOnce(found([run("build", "pending")])).mockResolvedValue(found([run("test", "fail")], "aaa", "MERGED"));
    const { send } = setup({ mode: "fix", tries: 3 });
    await settle();
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    const calls = prWatch.mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(5 * 60_000)));
    expect(send).not.toHaveBeenCalled();
    expect(prWatch.mock.calls.length).toBe(calls);
  });

  it("sends nothing when the checks pass", async () => {
    prWatch.mockResolvedValue(PASSED());
    const { send, onFailed } = setup({ mode: "fix", tries: 3 });
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("counts the tries for the pull request across a restart", async () => {
    prWatch.mockResolvedValue(FAILED());
    const a = setup({ mode: "fix", tries: 3 });
    await settle();
    expect(a.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("prChecks.loopByFolder")!)[FOLDER]["5"]).toMatchObject({ tries: 1, status: "waiting" });
    cleanup();
    const b = setup({ mode: "fix", tries: 3 });
    await settle();
    // The same failing run is known to have been sent: it isn't sent again.
    expect(b.send).not.toHaveBeenCalled();
    expect(b.result.current.views[FOLDER].loop.tries).toBe(1);
  });

  it("a log that can't be read is said so in the message, and the message still goes", async () => {
    prFailureLog.mockRejectedValue("gh run view: run is still in progress");
    prWatch.mockResolvedValue(FAILED());
    const { send } = setup({ mode: "fix", tries: 3 });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain("No log could be read for this check");
  });
});
