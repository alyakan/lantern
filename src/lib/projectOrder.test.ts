import { describe, expect, it } from "vitest";
import { ORDER_LIMIT, moveProject, orderProjects } from "./projectOrder";

describe("the project order", () => {
  it("lists projects in the saved order, whatever was used last", () => {
    const { listed, order } = orderProjects(["/b", "/a", "/c"], ["/a", "/b", "/c"]);
    expect(listed).toEqual(["/a", "/b", "/c"]);
    expect(order).toEqual(["/a", "/b", "/c"]);
  });

  it("puts a project it hasn't seen at the top, and saves it there; nothing new keeps the same order", () => {
    const saved = ["/a", "/b"];
    expect(orderProjects(["/new", "/a", "/b"], saved)).toEqual({ listed: ["/new", "/a", "/b"], order: ["/new", "/a", "/b"] });
    expect(orderProjects(["/a", "/b"], saved).order).toBe(saved);
  });

  it("keeps the place of a project that isn't listed now, so it comes back there", () => {
    const { listed, order } = orderProjects(["/a", "/c"], ["/a", "/b", "/c"]);
    expect(listed).toEqual(["/a", "/c"]);
    expect(order).toEqual(["/a", "/b", "/c"]);
    expect(orderProjects(["/a", "/b", "/c"], order).listed).toEqual(["/a", "/b", "/c"]);
  });

  it("forgets the oldest entries past its limit", () => {
    const saved = Array.from({ length: ORDER_LIMIT }, (_, i) => `/p${i}`);
    expect(orderProjects(["/new"], saved).order).toHaveLength(ORDER_LIMIT);
  });

  it("moves a project among those listed", () => {
    const order = ["/a", "/b", "/c", "/d"];
    expect(moveProject(order, order, "/d", 0)).toEqual(["/d", "/a", "/b", "/c"]);
    expect(moveProject(order, order, "/a", 2)).toEqual(["/b", "/c", "/a", "/d"]);
    expect(moveProject(order, order, "/a", 99)).toEqual(["/b", "/c", "/d", "/a"]);
    expect(moveProject(order, order, "/b", 1)).toBe(order);
  });

  it("keeps a project not listed right after the one it followed", () => {
    // /x isn't listed (removed from the recents): it stays behind /a, wherever /a goes.
    const order = ["/a", "/x", "/b", "/c"];
    expect(moveProject(order, ["/a", "/b", "/c"], "/a", 2)).toEqual(["/b", "/c", "/a", "/x"]);
    expect(moveProject(["/x", "/a", "/b"], ["/a", "/b"], "/b", 0)).toEqual(["/x", "/b", "/a"]);
  });
});
