import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ToolItem } from "../store";
import { ActivityGroup } from "./ActivityGroup";

const tool = (id: string, name: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  type: "tool", id, name, summary: "/p/src/a.ts", status: "done", output: null, edit: null, children: [], ...extra,
});
const edit = { path: "/p/src/b.ts", created: true, hunks: [{ old_start: 0, old_lines: 0, new_start: 1, new_lines: 2, lines: ["+a", "+b"] }] };
const handlers = { onDecide: () => {}, onOpenFile: () => {} };

describe("ActivityGroup", () => {
  it("shows a summary and a collapsed changed-files line, and expands to steps with output", () => {
    render(<ActivityGroup steps={[tool("1", "Read", { output: "file body" }), tool("2", "Write", { edit })]} folder="/p" {...handlers} />);
    expect(screen.getByText("Read 1 file")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1 file changed/ })).toHaveTextContent("1 file changed+2");
    expect(screen.queryByText("src/b.ts")).toBeNull();
    expect(screen.queryByText("file body")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Read 1 file/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Read src\/a\.ts/ }));
    expect(screen.getByText("file body")).toBeInTheDocument();
  });

  it("shows the running step and failures", () => {
    render(<ActivityGroup steps={[tool("1", "Bash", { status: "error", summary: "npm test" }), tool("2", "Read", { status: "running" })]} folder="/p" {...handlers} />);
    expect(screen.getByText("Reading src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
  });

  it("opens an edited file when its line is clicked", () => {
    const onOpenFile = vi.fn();
    render(<ActivityGroup steps={[tool("1", "Task", { children: [tool("s", "Edit", { edit })] })]} folder="/p" onDecide={() => {}} onOpenFile={onOpenFile} />);
    fireEvent.click(screen.getByRole("button", { name: /1 file changed/ }));
    fireEvent.click(screen.getByRole("button", { name: /src\/b\.ts/ }));
    expect(onOpenFile).toHaveBeenCalledWith("/p/src/b.ts");
  });

  it("adds up several edits to one file into one line", () => {
    const more = { path: "/p/src/b.ts", created: false, hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: ["-a", "+c"] }] };
    const other = { path: "/p/src/c.ts", created: false, hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 0, lines: ["-x"] }] };
    const steps = [tool("1", "Write", { edit }), tool("2", "Edit", { edit: more }), tool("3", "Edit", { edit: other })];
    render(<ActivityGroup steps={steps} folder="/p" {...handlers} />);
    const line = screen.getByRole("button", { name: /2 files changed/ });
    expect(line).toHaveTextContent("2 files changed+3−2");
    fireEvent.click(line);
    expect(screen.getByRole("button", { name: /src\/b\.ts/ })).toHaveTextContent("src/b.tsnew+3−1");
    expect(screen.getByRole("button", { name: /src\/c\.ts/ })).toHaveTextContent("src/c.ts−1");
  });

  it("while live, is one line naming the current step instead of a list", () => {
    const steps = [tool("1", "Skill", { summary: "brainstorming" }), tool("2", "Bash", { summary: "npm test", status: "running" })];
    const { rerender } = render(<ActivityGroup steps={steps} live folder="/p" {...handlers} />);
    expect(screen.getByText("Running npm test")).toBeInTheDocument();
    expect(screen.getByText("2 steps")).toBeInTheDocument();
    expect(screen.queryByText("brainstorming")).toBeNull();

    // Between steps it keeps going with the work so far (the turn's word is on the line at the bottom).
    rerender(<ActivityGroup steps={[steps[0], { ...steps[1], status: "done" }]} live folder="/p" {...handlers} />);
    expect(screen.getByText("Ran 1 command, used 1 skill")).toBeInTheDocument();
    expect(document.querySelector(".activity.live")).not.toBeNull();

    // Once the turn ends it becomes a summary.
    rerender(<ActivityGroup steps={[steps[0], { ...steps[1], status: "done" }]} folder="/p" {...handlers} />);
    expect(screen.getByText("Ran 1 command, used 1 skill")).toBeInTheDocument();
    expect(screen.queryByText("2 steps")).toBeNull();
  });

  it("expands to the timeline, narration included", () => {
    const steps = [tool("1", "Read"), tool("2", "Bash", { summary: "npm test" })];
    const entries = [steps[0], { type: "assistant" as const, id: "m1", text: "Found it, running the tests." }, steps[1]];
    render(<ActivityGroup steps={steps} entries={entries} folder="/p" {...handlers} />);
    expect(screen.queryByText("Found it, running the tests.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Read 1 file, ran 1 command/ }));
    const texts = [...document.querySelectorAll(".steps > *")].map((n) => n.textContent);
    expect(texts).toEqual(["Readsrc/a.ts", "Found it, running the tests.", "Bashnpm test"]);
  });

  it("has no summary line when the group is only applied edits", () => {
    render(<ActivityGroup steps={[tool("1", "Edit", { edit })]} folder="/p" {...handlers} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
