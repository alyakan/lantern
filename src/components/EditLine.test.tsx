import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { EditInfo } from "../store";
import { EditLine, SHOWN_DIFF_LINES } from "./EditLine";

const edit: EditInfo = {
  path: "/p/src/a.ts",
  created: false,
  hunks: [{ old_start: 3, old_lines: 2, new_start: 3, new_lines: 2, lines: [" keep", "-old line", "+new line"] }],
};

describe("EditLine", () => {
  it("opens the change in the review panel from its name", () => {
    const onOpen = vi.fn();
    render(<EditLine edit={edit} folder="/p" onOpen={onOpen} />);
    fireEvent.click(screen.getByTitle("Show in the side panel"));
    expect(onOpen).toHaveBeenCalledWith("/p/src/a.ts");
  });

  it("shows its hunks inline, coloured, from the chevron", () => {
    render(<EditLine edit={edit} folder="/p" onOpen={() => {}} />);
    const toggle = screen.getByRole("button", { name: "Show the change to src/a.ts" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Change" })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide the change to src/a.ts" })).toHaveAttribute("aria-expanded", "true");
    const lines = screen.getByRole("region", { name: "Change" }).querySelectorAll(".diff-line");
    expect([...lines].map((l) => l.textContent?.trim())).toEqual(["@@ -3,2 +3,2 @@", "keep", "-old line", "+new line"]);
    expect(lines[1]).toHaveClass("ctx");
    expect(lines[2]).toHaveClass("del");
    expect(lines[3]).toHaveClass("add");
    expect(lines[0]).toHaveClass("meta");
  });

  it("shows a long change's first lines, then all of it on Show all", () => {
    const long: EditInfo = { ...edit, hunks: [{ old_start: 1, old_lines: 0, new_start: 1, new_lines: 90, lines: Array.from({ length: 90 }, (_, i) => `+row ${i}`) }] };
    render(<EditLine edit={long} folder="/p" onOpen={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Show the change to src/a.ts" }));
    expect(screen.getByRole("region", { name: "Change" }).querySelectorAll(".diff-line")).toHaveLength(SHOWN_DIFF_LINES);
    fireEvent.click(screen.getByRole("button", { name: "Show all 91 lines" }));
    expect(screen.getByRole("region", { name: "Change" }).querySelectorAll(".diff-line")).toHaveLength(91);
  });
});
