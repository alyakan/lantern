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
const NO_PR: PrWatch = { kind: "no_pr" };
const PASSED = (id = "2", head = "bbb") => found([run("build", "pass", id), run("test", "pass", id)], head);

/** A worktree of the project, with the pull request's branch checked out. */
const WT = "/wt/x";
/** A chat working on the pull request's branch, in its worktree. */
const chat = (busy = false, slot = "s1", work = WT): PrChat => ({ slot, folder: FOLDER, work, live: true, busy });
/** A chat in the project's own folder. */
const inFolder = (slot: string, busy = false): PrChat => chat(busy, slot, FOLDER);

function setup(setting: PrSetting, first: PrChat | PrChat[] = chat()) {
  const send = vi.fn();
  const onFailed = vi.fn();
  const start = vi.fn((): string | null => "s9");
  const props = (chats: PrChat[], active = "s1"): PrChecksOptions => ({ chats, active, settings: { [FOLDER]: setting }, send, start, onFailed });
  const hook = renderHook((p: PrChecksOptions) => usePrChecks(p), { initialProps: props(Array.isArray(first) ? first : [first]) });
  return { ...hook, send, start, onFailed, props };
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
    setup({ mode: "tell", tries: 3 }, inFolder("s1"));
    await settle();
    expect(prWatch).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(prWatch).toHaveBeenCalledTimes(2);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5 * 60_000)));
    expect(prWatch).toHaveBeenCalledTimes(2);
  });

  it("keeps what it knew when gh fails for a reason that may pass, and tries again", async () => {
    prWatch.mockResolvedValueOnce(found([run("build", "pending")])).mockRejectedValueOnce("network").mockResolvedValue(PASSED());
    const { result } = setup({ mode: "tell", tries: 3 }, inFolder("s1"));
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

  it("Fix it myself: a turn that ends while gh fails or finds no pull request still counts at the next look", async () => {
    for (const miss of [() => prWatch.mockRejectedValueOnce("network"), () => prWatch.mockResolvedValueOnce(NO_PR)]) {
      cleanup();
      localStorage.clear();
      prWatch.mockReset();
      prWatch.mockImplementation(async (place) => (place === FOLDER ? NO_PR : FAILED()));
      const { result, send, onFailed, rerender, props } = setup({ mode: "fix", tries: 3 });
      await settle();
      expect(send).toHaveBeenCalledTimes(1);
      rerender(props([chat(true)]));
      await settle();
      // The look made when the turn ends gets nothing back...
      miss();
      rerender(props([chat(false)]));
      await settle();
      expect(send).toHaveBeenCalledTimes(1);
      // ...so the next one (a refresh: with no pull request found there is no poll) sees the same failure on the same commit, and stops.
      await act(async () => result.current.refresh(WT));
      await settle();
      expect(send).toHaveBeenCalledTimes(1);
      expect(result.current.views[WT].loop.status).toBe("stalled");
      expect(onFailed).toHaveBeenCalledTimes(1);
    }
  });

  it("Fix it myself: each new failure after a push is another try, up to the limit, then Out of tries", async () => {
    let n = 0;
    prWatch.mockImplementation(async (place) => place === FOLDER ? NO_PR : FAILED(String(++n), `c${n}`));
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
    expect(result.current.views[WT].loop).toMatchObject({ tries: 2, status: "out" });
    expect(onFailed).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5 * 60_000)));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("Stop ends Fix it myself for the pull request, and nothing more is sent", async () => {
    let n = 0;
    prWatch.mockImplementation(async (place) => place === FOLDER ? NO_PR : FAILED(String(++n), `c${n}`));
    const { result, send, rerender, props } = setup({ mode: "fix", tries: 3 });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    act(() => result.current.stop(WT));
    expect(result.current.views[WT].loop.status).toBe("stopped");
    rerender(props([chat(true)]));
    await settle();
    rerender(props([chat(false)]));
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.views[WT].needsYou).toBe(true);
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
  it("Fix it myself: never sends to chats that are only in the project's folder, and starts one for the pull request instead", async () => {
    // The folder itself is on the pull request's branch, and the two chats there are about something else.
    prWatch.mockResolvedValue(FAILED());
    const { send, start, rerender, props } = setup({ mode: "fix", tries: 3 }, [inFolder("s1"), inFolder("s2")]);
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]).toEqual([FOLDER, FOLDER, expect.stringContaining("try 1 of 3")]);
    // The started chat (s9) is the pull request's from here: the same failure isn't sent again, nor another chat started.
    rerender(props([inFolder("s1"), inFolder("s2"), inFolder("s9", true)], "s2"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(start).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("Fix it myself: goes to the chat in the worktree on the branch even while another chat is on screen", async () => {
    prWatch.mockImplementation(async (place) => (place === FOLDER ? NO_PR : FAILED()));
    const { send, start } = setup({ mode: "fix", tries: 3 }, [inFolder("s2"), chat(false, "s1")]);
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("s1");
  });

  it("Fix it myself: the next try goes to the chat that had the last one, wherever the user is", async () => {
    let n = 0;
    prWatch.mockImplementation(async (place) => (place === FOLDER ? NO_PR : FAILED(String(++n), `c${n}`)));
    const other = chat(false, "s4");
    const { send, rerender, props } = setup({ mode: "fix", tries: 3 }, [chat(), other]);
    await settle();
    expect(send.mock.calls.map((c) => c[0])).toEqual(["s1"]);
    // s1 works and pushes; meanwhile the user is looking at s4, in the same worktree.
    rerender(props([chat(true), other], "s4"));
    await settle();
    rerender(props([chat(false), other], "s4"));
    await settle();
    expect(send.mock.calls.map((c) => c[0])).toEqual(["s1", "s1"]);
  });
});
