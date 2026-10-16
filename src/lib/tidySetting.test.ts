import { afterEach, describe, expect, it } from "vitest";
import { initialState, type MergeProposal, type State } from "../store";
import { isOccupied, newlyMerged, setTidyMode, tidyMode } from "./tidySetting";

afterEach(() => localStorage.clear());

describe("the tidy-up setting", () => {
  it("is Off until chosen, keeps what was chosen, and ignores anything else", () => {
    expect(tidyMode()).toBe("off");
    setTidyMode("auto");
    expect(localStorage.getItem("lantern.tidyAfterMerge")).toBe("auto");
    expect(tidyMode()).toBe("auto");
    setTidyMode("ask");
    expect(tidyMode()).toBe("ask");
    localStorage.setItem("lantern.tidyAfterMerge", "nonsense");
    expect(tidyMode()).toBe("off");
    setTidyMode("whenever" as never);
    expect(localStorage.getItem("lantern.tidyAfterMerge")).toBe("nonsense");
  });
});

const proposal = (worker: string, status: MergeProposal["status"], over: Partial<MergeProposal> = {}): MergeProposal => ({ worker, name: worker, branch: `lantern/${worker}`, into: "main", summary: "", commits: 1, files: [], uncommitted: 0, loose: [], status, problem: null, attempts: 0, ...over });
const lead = (...proposals: MergeProposal[]): Record<string, State> => ({ s1: { ...initialState, orchestrator: true, proposals } });

describe("which merges are new", () => {
  it("counts what is merged at the first look without reporting it, so a restored chat isn't tidied", () => {
    const first = newlyMerged(null, lead(proposal("w1", "merged"), proposal("w2", "open")));
    expect(first.fresh).toEqual([]);
    expect([...first.seen]).toEqual(["w1:lantern/w1"]);
  });

  it("reports a merge that went through since, once", () => {
    const before = newlyMerged(null, lead(proposal("w1", "open"), proposal("w2", "merged")));
    const after = newlyMerged(before.seen, lead(proposal("w1", "merged"), proposal("w2", "merged")));
    expect(after.fresh).toEqual(["w1"]);
    expect(newlyMerged(after.seen, lead(proposal("w1", "merged"), proposal("w2", "merged"))).fresh).toEqual([]);
  });

  it("doesn't report one that is tidied already, and reports a branch merged again after being proposed again", () => {
    const seen = newlyMerged(null, lead(proposal("w1", "open"))).seen;
    expect(newlyMerged(seen, lead(proposal("w1", "merged", { tidied: true }))).fresh).toEqual([]);
    const merged = newlyMerged(seen, lead(proposal("w1", "merged")));
    const open = newlyMerged(merged.seen, lead(proposal("w1", "open")));
    expect(newlyMerged(open.seen, lead(proposal("w1", "merged"))).fresh).toEqual(["w1"]);
  });
});

describe("an agent that is busy", () => {
  it("is one at work, waiting for the user or starting; not one that is done or stopped; not one that isn't there", () => {
    expect(isOccupied({ ...initialState, status: "running" })).toBe(true);
    expect(isOccupied({ ...initialState, status: "starting" })).toBe(true);
    expect(isOccupied({ ...initialState, status: "idle" })).toBe(false);
    expect(isOccupied({ ...initialState, status: "ended" })).toBe(false);
    expect(isOccupied(undefined)).toBe(false);
  });
});
