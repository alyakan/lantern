import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, type MergeProposal, type State } from "../store";
import { setTidyMode } from "./tidySetting";
import { useAutoTidy } from "./useAutoTidy";

afterEach(() => localStorage.clear());

const proposal = (worker: string, status: MergeProposal["status"]): MergeProposal => ({ worker, name: worker, branch: `lantern/${worker}`, into: "main", summary: "", commits: 1, files: [], uncommitted: 0, loose: [], status, problem: null, attempts: 0 });
const slots = (statuses: Record<string, MergeProposal["status"]>, workers: Record<string, State["status"]> = {}): Record<string, State> => ({
  s1: { ...initialState, orchestrator: true, status: "idle", proposals: Object.entries(statuses).map(([w, s]) => proposal(w, s)) },
  ...Object.fromEntries(Object.keys(statuses).map((w) => [w, { ...initialState, status: workers[w] ?? "idle" }])),
});
const check = (uncommitted: number, unmerged_commits: number) => ({ worktree: true, branch: "b", uncommitted, unmerged_commits });
const actions = (over: { closeCheck?: (worker: string) => Promise<ReturnType<typeof check>> } = {}) => ({ closeCheck: vi.fn(over.closeCheck ?? (() => Promise.resolve(check(0, 0)))), closeWorker: vi.fn((_worker: string) => Promise.resolve()) });
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe("tidying up by itself after a merge", () => {
  it("closes the agent of a merge that just went through, when the setting is Automatically and nothing is left to lose", async () => {
    setTidyMode("auto");
    const a = actions();
    const { rerender } = renderHook(({ s }) => useAutoTidy(s, a), { initialProps: { s: slots({ w1: "open" }) } });
    rerender({ s: slots({ w1: "merged" }) });
    await settle();
    expect(a.closeCheck).toHaveBeenCalledWith("w1");
    expect(a.closeWorker).toHaveBeenCalledWith("w1");
  });

  it("does nothing on Off or Ask me", async () => {
    for (const mode of ["off", "ask"] as const) {
      setTidyMode(mode);
      const a = actions();
      const { rerender } = renderHook(({ s }) => useAutoTidy(s, a), { initialProps: { s: slots({ w1: "open" }) } });
      rerender({ s: slots({ w1: "merged" }) });
      await settle();
      expect(a.closeCheck).not.toHaveBeenCalled();
    }
  });

  it("leaves an agent that still has work to lose, and one that is still at work", async () => {
    setTidyMode("auto");
    const a = actions({ closeCheck: (w) => Promise.resolve(w === "w1" ? check(0, 2) : check(0, 0)) });
    const { rerender } = renderHook(({ s }) => useAutoTidy(s, a), { initialProps: { s: slots({ w1: "open", w2: "open" }) } });
    rerender({ s: slots({ w1: "merged", w2: "merged" }, { w2: "running" }) });
    await settle();
    expect(a.closeCheck).toHaveBeenCalledWith("w1");
    expect(a.closeWorker).not.toHaveBeenCalled();
  });

  it("doesn't touch merges that were already there when the app started, and acts once per merge", async () => {
    setTidyMode("auto");
    const a = actions();
    const { rerender } = renderHook(({ s }) => useAutoTidy(s, a), { initialProps: { s: slots({ w1: "merged" }) } });
    await settle();
    expect(a.closeCheck).not.toHaveBeenCalled();
    rerender({ s: slots({ w1: "merged", w2: "merged" }) });
    rerender({ s: slots({ w1: "merged", w2: "merged" }) });
    await settle();
    expect(a.closeCheck).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the check or the close fails: the card still offers Tidy up", async () => {
    setTidyMode("auto");
    const a = actions({ closeCheck: () => Promise.reject("gone") });
    const { rerender } = renderHook(({ s }) => useAutoTidy(s, a), { initialProps: { s: slots({ w1: "open" }) } });
    rerender({ s: slots({ w1: "merged" }) });
    await settle();
    expect(a.closeWorker).not.toHaveBeenCalled();
  });
});
