import { describe, expect, it, vi } from "vitest";
import { quietActWarnings } from "./quietActWarnings";

describe("quietActWarnings", () => {
  it("drops React's act warning and prints every other error", () => {
    const error = vi.fn();
    const target = { error };
    quietActWarnings(target);

    target.error("An update to %s inside a test was not wrapped in act(...).", "Sidebar");
    expect(error).not.toHaveBeenCalled();

    target.error("Something else broke", 42);
    target.error(new Error("not a string first"));
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenNthCalledWith(1, "Something else broke", 42);
  });
});
