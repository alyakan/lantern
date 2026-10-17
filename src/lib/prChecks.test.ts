import { describe, expect, it } from "vitest";
import type { PrCheck, PullRequest } from "../types";
import { DEFAULT_PR_SETTING, failureSig, fixLine, freshLoop, needsYou, overall, pollDelay, pruneLoops, sentByUser, settingFor, step, stopLoop, summaryLine, totals, WATCH_LIMIT_MS, worthWatching, type LoopState, type PrSetting, type PrSnap } from "./prChecks";

const check = (name: string, bucket: PrCheck["bucket"], run = "1"): PrCheck => ({ name, state: bucket.toUpperCase(), bucket, link: `https://github.com/o/r/actions/runs/${run}/job/${name}`, workflow: "CI", run_id: run });
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 5, url: "https://github.com/o/r/pull/5", state: "OPEN", branch: "feat/x", base: "main", head_sha: "aaa", ...over });
const snap = (checks: PrCheck[], over: Partial<PullRequest> = {}): PrSnap => ({ pr: pr(over), checks });
const fix = (tries = 3): PrSetting => ({ mode: "fix", tries });
const tell: PrSetting = { mode: "tell", tries: 3 };
const failed = (head = "aaa", run = "1") => snap([check("build", "pass"), check("test", "fail", run)], { head_sha: head });
const idle = { busy: false, turnEnded: false };

describe("the project's setting", () => {
  it("is Tell me with 3 tries until the user chooses", () => {
    expect(settingFor({}, "/p")).toEqual({ mode: "tell", tries: 3 });
    expect(settingFor({}, null)).toEqual(DEFAULT_PR_SETTING);
  });
  it("is kept per folder, and an odd saved value is read as the usual one", () => {
    const saved = { "/lantern": { mode: "fix", tries: 4 } as const, "/lumiform": { mode: "tell" } as const, "/odd": { mode: "bogus" as never, tries: "x" as never } };
    expect(settingFor(saved, "/lantern")).toEqual({ mode: "fix", tries: 4 });
    expect(settingFor(saved, "/lumiform")).toEqual({ mode: "tell", tries: 3 });
    expect(settingFor(saved, "/odd")).toEqual({ mode: "tell", tries: 3 });
  });
  it("keeps the tries between 1 and 5", () => {
    expect(settingFor({ "/p": { mode: "fix", tries: 0 } }, "/p").tries).toBe(1);
    expect(settingFor({ "/p": { mode: "fix", tries: 99 } }, "/p").tries).toBe(5);
    expect(settingFor({ "/p": { mode: "fix", tries: 2.6 } }, "/p").tries).toBe(3);
  });
});

describe("the checks' totals", () => {
  const checks = [check("a", "pass"), check("b", "pass"), check("c", "fail"), check("d", "pending"), check("e", "skipping"), check("f", "cancel")];
  it("counts each bucket", () => {
    expect(totals(checks)).toEqual({ passed: 2, failed: 1, running: 1, skipped: 1, cancelled: 1, total: 6 });
  });
  it("says them in a line, leaving out what there is none of", () => {
    expect(summaryLine(totals([check("a", "pass"), check("b", "pass"), check("c", "fail"), check("d", "pending")]))).toBe("Checks: 2 passed, 1 failed, 1 running");
    expect(summaryLine(totals([check("a", "pass")]))).toBe("Checks: 1 passed");
    expect(summaryLine(totals(checks))).toBe("Checks: 2 passed, 1 failed, 1 running, 1 skipped, 1 cancelled");
    expect(summaryLine(totals([]))).toBe("No checks yet");
  });
  it("is running while any check is, then failed or passed", () => {
    expect(overall(totals([]))).toBe("none");
    expect(overall(totals(checks))).toBe("running");
    expect(overall(totals([check("a", "pass"), check("c", "fail")]))).toBe("failed");
    expect(overall(totals([check("a", "pass"), check("e", "skipping"), check("f", "cancel")]))).toBe("passed");
  });
  it("is only worth watching while open and not all passed", () => {
    expect(worthWatching(snap([check("a", "pending")]))).toBe(true);
    expect(worthWatching(snap([check("a", "fail")]))).toBe(true);
    expect(worthWatching(snap([]))).toBe(true);
    expect(worthWatching(snap([check("a", "pass")]))).toBe(false);
    expect(worthWatching(snap([check("a", "fail")], { state: "MERGED" }))).toBe(false);
    expect(worthWatching(snap([check("a", "fail")], { state: "CLOSED" }))).toBe(false);
  });
});

describe("a failing run's signature", () => {
  it("changes with the runs that failed, not with their order", () => {
    const a = failureSig(snap([check("x", "fail", "1"), check("y", "fail", "2")]));
    expect(failureSig(snap([check("y", "fail", "2"), check("x", "fail", "1")]))).toBe(a);
    expect(failureSig(snap([check("x", "fail", "1"), check("y", "fail", "3")]))).not.toBe(a);
  });
  it("counts two failed jobs of one run once", () => {
    expect(failureSig(snap([check("x", "fail", "7"), check("y", "fail", "7")]))).toBe("7");
  });
  it("uses the commit for a check that has no run to name", () => {
    const outside = (head: string) => snap([{ ...check("ci/other", "fail"), link: null, run_id: null }], { head_sha: head });
    expect(failureSig(outside("aaa"))).toBe(failureSig(outside("aaa")));
    expect(failureSig(outside("aaa"))).not.toBe(failureSig(outside("bbb")));
  });
});

describe("the loop", () => {
  it("does nothing when it is off or the pull request isn't open", () => {
    const off = step({ setting: { mode: "off", tries: 3 }, snap: failed(), loop: freshLoop(), ...idle });
    expect(off).toEqual({ loop: freshLoop(), send: false, notify: false });
    for (const state of ["MERGED", "CLOSED"] as const) {
      const r = step({ setting: fix(), snap: snap([check("t", "fail")], { state }), loop: freshLoop(), ...idle });
      expect(r.send || r.notify).toBe(false);
    }
  });

  it("waits while checks run and does nothing when they pass", () => {
    const running = step({ setting: fix(), snap: snap([check("a", "fail"), check("b", "pending")]), loop: freshLoop(), ...idle });
    expect(running).toEqual({ loop: freshLoop(), send: false, notify: false });
    const passed = step({ setting: fix(), snap: snap([check("a", "pass")]), loop: freshLoop(), ...idle });
    expect(passed.send || passed.notify).toBe(false);
  });

  it("Tell me never sends, and tells once for each failing run", () => {
    const first = step({ setting: tell, snap: failed(), loop: freshLoop(), ...idle });
    expect(first.send).toBe(false);
    expect(first.notify).toBe(true);
    const again = step({ setting: tell, snap: failed(), loop: first.loop, ...idle });
    expect(again.notify).toBe(false);
    const another = step({ setting: tell, snap: failed("bbb", "2"), loop: first.loop, ...idle });
    expect(another.notify).toBe(true);
  });

  it("Tell me stops telling once the user sent the failure to Claude", () => {
    const loop = sentByUser(freshLoop(), failureSig(failed()));
    expect(step({ setting: tell, snap: failed(), loop, ...idle })).toEqual({ loop, send: false, notify: false });
    expect(needsYou(tell, failed(), loop)).toBe(false);
    expect(needsYou(tell, failed(), freshLoop())).toBe(true);
  });

  it("Fix it myself sends a failure, counts the try, and then waits for a new run", () => {
    const sent = step({ setting: fix(), snap: failed(), loop: freshLoop(), ...idle });
    expect(sent.send).toBe(true);
    expect(sent.notify).toBe(false);
    expect(sent.loop).toMatchObject({ tries: 1, status: "waiting", sentSig: "1", sentHead: "aaa" });
    // The same failing run is seen again while Claude works: nothing more is sent.
    const wait = step({ setting: fix(), snap: failed(), loop: sent.loop, busy: true, turnEnded: false });
    expect(wait).toEqual({ loop: sent.loop, send: false, notify: false });
    // Claude pushed: the checks run again, then pass: the loop starts over, with the try still counted.
    const rerun = step({ setting: fix(), snap: snap([check("t", "pending", "2")], { head_sha: "bbb" }), loop: sent.loop, ...idle });
    expect(rerun.send).toBe(false);
    const passed = step({ setting: fix(), snap: snap([check("t", "pass", "2")], { head_sha: "bbb" }), loop: sent.loop, ...idle });
    expect(passed.send || passed.notify).toBe(false);
    expect(passed.loop).toMatchObject({ tries: 1, status: "idle", sentSig: null });
  });

  it("sends a second try for a new failure on a new commit, never while the chat is busy", () => {
    const first = step({ setting: fix(), snap: failed(), loop: freshLoop(), ...idle }).loop;
    const next = failed("bbb", "2");
    const busy = step({ setting: fix(), snap: next, loop: first, busy: true, turnEnded: false });
    expect(busy).toEqual({ loop: first, send: false, notify: false });
    const free = step({ setting: fix(), snap: next, loop: first, ...idle });
    expect(free.send).toBe(true);
    expect(free.loop).toMatchObject({ tries: 2, status: "waiting", sentSig: "2", sentHead: "bbb" });
  });

  it("never sends while the chat is busy, even the first time", () => {
    const r = step({ setting: fix(), snap: failed(), loop: freshLoop(), busy: true, turnEnded: false });
    expect(r).toEqual({ loop: freshLoop(), send: false, notify: false });
  });

  it("gives up after the last try and tells the user", () => {
    let loop: LoopState = freshLoop();
    let head = 0;
    for (let n = 1; n <= 3; n++) {
      const r = step({ setting: fix(3), snap: failed(`c${++head}`, String(head)), loop, ...idle });
      expect(r.send).toBe(true);
      loop = r.loop;
    }
    expect(loop.tries).toBe(3);
    const out = step({ setting: fix(3), snap: failed(`c${++head}`, String(head)), loop, ...idle });
    expect(out.send).toBe(false);
    expect(out.notify).toBe(true);
    expect(out.loop.status).toBe("out");
    expect(fixLine(fix(3), out.loop)?.text).toMatch(/Out of tries/);
    // Out stays out: no later look sends.
    const later = step({ setting: fix(3), snap: failed(`c${++head}`, String(head)), loop: out.loop, ...idle });
    expect(later.send).toBe(false);
    expect(needsYou(fix(3), failed(), out.loop)).toBe(true);
  });

  it("one try only: the second failure is out of tries", () => {
    const first = step({ setting: fix(1), snap: failed(), loop: freshLoop(), ...idle }).loop;
    const second = step({ setting: fix(1), snap: failed("bbb", "2"), loop: first, ...idle });
    expect(second.send).toBe(false);
    expect(second.loop.status).toBe("out");
  });

  it("the same failure with no push after Claude's turn means the fix did not land: it stops and says so", () => {
    const sent = step({ setting: fix(), snap: failed(), loop: freshLoop(), ...idle }).loop;
    const stalled = step({ setting: fix(), snap: failed(), loop: sent, busy: false, turnEnded: true });
    expect(stalled.send).toBe(false);
    expect(stalled.notify).toBe(true);
    expect(stalled.loop).toMatchObject({ status: "stalled", tries: 1 });
    expect(fixLine(fix(), stalled.loop)?.text).toMatch(/nothing new was pushed/);
    // Later looks of the same failure send nothing.
    expect(step({ setting: fix(), snap: failed(), loop: stalled.loop, ...idle }).send).toBe(false);
  });

  it("a different failure on the same commit, once Claude's turn is over, is not a new try either", () => {
    const sent = step({ setting: fix(), snap: failed("aaa", "1"), loop: freshLoop(), ...idle }).loop;
    const rerun = step({ setting: fix(), snap: failed("aaa", "9"), loop: sent, busy: false, turnEnded: true });
    expect(rerun.send).toBe(false);
    expect(rerun.loop.status).toBe("stalled");
  });

  it("a second check failing on the same commit while Claude is still working waits, and doesn't stall the loop", () => {
    const sent = step({ setting: fix(), snap: failed("aaa", "1"), loop: freshLoop(), ...idle }).loop;
    const both = snap([check("build", "fail", "2"), check("test", "fail", "1")], { head_sha: "aaa" });
    for (const input of [{ busy: true, turnEnded: false }, { busy: false, turnEnded: false }, { busy: true, turnEnded: true }]) {
      expect(step({ setting: fix(), snap: both, loop: sent, ...input })).toEqual({ loop: sent, send: false, notify: false });
    }
    // Claude then pushes a fix that fails again: it is the next try, as if nothing had happened.
    const pushed = step({ setting: fix(), snap: failed("bbb", "3"), loop: sent, ...idle });
    expect(pushed).toMatchObject({ send: true, loop: { tries: 2, status: "waiting" } });
  });

  it("a push that still fails the same check, which has no run to tell it by, is a new try", () => {
    const status = (head: string) => snap([{ name: "lint", state: "FAILURE", bucket: "fail", link: "https://ci.example/lint", workflow: null, run_id: null }], { head_sha: head });
    const sent = step({ setting: fix(2), snap: status("aaa"), loop: freshLoop(), ...idle }).loop;
    expect(sent.sentSig).toBe("https://ci.example/lint");
    // Waiting for Claude's turn: nothing yet. Once it ended on a new commit, the failure goes again.
    expect(step({ setting: fix(2), snap: status("bbb"), loop: sent, busy: true, turnEnded: false }).send).toBe(false);
    const second = step({ setting: fix(2), snap: status("bbb"), loop: sent, busy: false, turnEnded: true });
    expect(second).toMatchObject({ send: true, loop: { tries: 2, status: "waiting", sentHead: "bbb" } });
    // With the tries used, a third commit that fails the same way is out, not idle forever.
    const third = step({ setting: fix(2), snap: status("ccc"), loop: second.loop, busy: false, turnEnded: true });
    expect(third).toMatchObject({ send: false, notify: true, loop: { status: "out" } });
    // The same commit still failing after the turn is stalled, as before.
    expect(step({ setting: fix(2), snap: status("aaa"), loop: sent, busy: false, turnEnded: true }).loop.status).toBe("stalled");
  });

  it("a push that hasn't started its checks yet is waited for, not counted as stalled", () => {
    const sent = step({ setting: fix(), snap: failed(), loop: freshLoop(), ...idle }).loop;
    // The turn ended, the branch moved, but the checks shown are still the old failing run.
    const r = step({ setting: fix(), snap: failed("bbb", "1"), loop: sent, busy: false, turnEnded: true });
    expect(r).toEqual({ loop: sent, send: false, notify: false });
  });

  it("a head that isn't known never counts as the same commit", () => {
    const base = snap([check("t", "fail", "1")], { head_sha: null });
    const sent = step({ setting: fix(), snap: base, loop: freshLoop(), ...idle }).loop;
    expect(step({ setting: fix(), snap: base, loop: sent, busy: false, turnEnded: true }).loop.status).toBe("waiting");
  });

  it("stop falls back to Tell me and stays stopped, even after the checks pass", () => {
    const waiting = step({ setting: fix(), snap: failed(), loop: freshLoop(), ...idle }).loop;
    const stopped = stopLoop(waiting);
    expect(fixLine(fix(), stopped)?.text).toMatch(/stopped/);
    const r = step({ setting: fix(), snap: failed("bbb", "2"), loop: stopped, ...idle });
    expect(r.send).toBe(false);
    expect(r.notify).toBe(true);
    expect(needsYou(fix(), failed("bbb", "2"), stopped)).toBe(true);
    const passed = step({ setting: fix(), snap: snap([check("t", "pass")]), loop: stopped, ...idle });
    expect(passed.loop.status).toBe("stopped");
  });

  it("while a fix is awaited, nothing is asked of the user", () => {
    const waiting = step({ setting: fix(), snap: failed(), loop: freshLoop(), ...idle }).loop;
    expect(needsYou(fix(), failed(), waiting)).toBe(false);
    expect(fixLine(fix(), waiting)).toEqual({ text: "Fixing failed checks: try 1 of 3", stoppable: true });
    expect(fixLine(fix(), freshLoop())).toBeNull();
    expect(fixLine(tell, waiting)).toBeNull();
  });

  it("never merges or sends when merged", () => {
    const waiting = step({ setting: fix(), snap: failed(), loop: freshLoop(), ...idle }).loop;
    const merged = step({ setting: fix(), snap: snap([check("t", "fail")], { state: "MERGED" }), loop: waiting, ...idle });
    expect(merged).toEqual({ loop: waiting, send: false, notify: false });
  });

  it("counts tries for one pull request: they survive the checks passing in between", () => {
    const first = step({ setting: fix(2), snap: failed(), loop: freshLoop(), ...idle }).loop;
    const passed = step({ setting: fix(2), snap: snap([check("t", "pass", "2")], { head_sha: "bbb" }), loop: first, ...idle }).loop;
    const second = step({ setting: fix(2), snap: failed("ccc", "3"), loop: passed, ...idle });
    expect(second.loop.tries).toBe(2);
    const third = step({ setting: fix(2), snap: failed("ddd", "4"), loop: second.loop, ...idle });
    expect(third.send).toBe(false);
    expect(third.loop.status).toBe("out");
  });
});

describe("polling", () => {
  it("is every 30 seconds at first, backs off, and stops after an hour", () => {
    expect(pollDelay(0)).toBe(30_000);
    expect(pollDelay(4 * 60_000)).toBe(30_000);
    expect(pollDelay(6 * 60_000)).toBe(60_000);
    expect(pollDelay(30 * 60_000)).toBe(120_000);
    expect(pollDelay(WATCH_LIMIT_MS - 1)).toBe(120_000);
    expect(pollDelay(WATCH_LIMIT_MS)).toBeNull();
  });
});

describe("the saved loops", () => {
  it("keep the eight newest pull requests of a folder", () => {
    const loops = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), { ...freshLoop(), tries: i }]));
    const pruned = pruneLoops(loops);
    expect(Object.keys(pruned).map(Number).sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });
});
