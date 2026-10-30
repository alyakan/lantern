import { describe, expect, it } from "vitest";
import { addDesk, deskOf, DESKS_MAX, HOME_ID, moveProject, NO_DESKS, openOn, readDesks, removeDesk, renameDesk, waitingBy } from "./desks";
import type { ProjectOpen } from "./sidebar";

const JOB = "/work/ios-app";
const SIDE = "/me/lantern";
const open = (needs: number): ProjectOpen => ({ items: [], sessionIds: [], needs, target: null });
const work = () => moveProject(addDesk(NO_DESKS, "Work", "w")!, JOB, "w");

describe("Desks", () => {
  it("start as one Desk with every project on it", () => {
    expect(deskOf(NO_DESKS, JOB)).toBe(HOME_ID);
    expect(Object.keys(openOn(NO_DESKS, HOME_ID, { [JOB]: open(0), [SIDE]: open(0) }))).toEqual([JOB, SIDE]);
  });

  it("split: a project moved to another Desk is on it alone, and every other project stays home", () => {
    const d = work();
    expect(d.on).toBe("w");
    expect(deskOf(d, JOB)).toBe("w");
    expect(deskOf(d, SIDE)).toBe(HOME_ID);
    expect(Object.keys(openOn(d, "w", { [JOB]: open(0), [SIDE]: open(0) }))).toEqual([JOB]);
    expect(Object.keys(openOn(d, HOME_ID, { [JOB]: open(0), [SIDE]: open(0) }))).toEqual([SIDE]);
    // Moved back home, it is on no other Desk.
    expect(deskOf(moveProject(d, JOB, HOME_ID), JOB)).toBe(HOME_ID);
  });

  it("count what waits on you on each Desk", () => {
    expect(waitingBy(work(), { [JOB]: open(2), [SIDE]: open(1) })).toEqual({ [HOME_ID]: 1, w: 2 });
  });

  it("can be renamed and removed, never the home one, and a removed Desk's projects go home", () => {
    const d = renameDesk(work(), "w", "  Job  ");
    expect(d.list[1].name).toBe("Job");
    expect(renameDesk(d, "w", "   ").list[1].name).toBe("Job");
    const gone = removeDesk(d, "w");
    expect(gone.on).toBe(HOME_ID);
    expect(deskOf(gone, JOB)).toBe(HOME_ID);
    expect(removeDesk(d, HOME_ID)).toBe(d);
  });

  it("need a name, and stop at the most there may be", () => {
    expect(addDesk(NO_DESKS, "  ", "x")).toBeNull();
    let d = NO_DESKS;
    for (let i = 1; i < DESKS_MAX; i++) d = addDesk(d, `D${i}`, `d${i}`)!;
    expect(addDesk(d, "One more", "z")).toBeNull();
  });

  it("read back from storage keep home first and each project on one Desk", () => {
    const raw = { list: [{ id: "w", name: "Work", projects: [JOB, 3] }, { id: HOME_ID, name: "Side", projects: [SIDE] }, { id: "w", name: "Again", projects: [] }, { id: "x", name: "X", projects: [JOB] }], on: "nope" };
    const d = readDesks(raw);
    expect(d.list.map((x) => [x.id, x.projects])).toEqual([
      [HOME_ID, []],
      ["w", [JOB]],
      ["x", []],
    ]);
    expect(d.on).toBe(HOME_ID);
    expect(readDesks("junk")).toEqual(NO_DESKS);
  });
});
