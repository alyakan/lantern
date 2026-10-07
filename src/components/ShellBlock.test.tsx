import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ShellItem } from "../store";
import { SHOWN_LINES, ShellBlock } from "./ShellBlock";

const item = (over: Partial<ShellItem> = {}): ShellItem => ({ type: "shell", id: "s1", command: "npm run dev", output: "", status: "running", code: null, startedAt: 0, shared: false, ...over });

describe("ShellBlock", () => {
  it("shows the command and its output, and stops it while it runs", () => {
    const onStop = vi.fn();
    render(<ShellBlock item={item({ output: "\x1b[32mready\x1b[0m in 212 ms\n" })} onStop={onStop} />);
    expect(screen.getByText("npm run dev")).toBeInTheDocument();
    expect(screen.getByText("ready in 212 ms")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledWith("s1");
  });

  it("says how it ended", () => {
    const { rerender, container } = render(<ShellBlock item={item({ status: "failed", code: 1, endedAt: 3_000 })} />);
    expect(screen.getByText("exit 1")).toBeInTheDocument();
    expect(screen.getByText("3s")).toBeInTheDocument();
    expect(container.firstChild).toHaveClass("failed");
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    rerender(<ShellBlock item={item({ status: "stopped", endedAt: 1_000 })} />);
    expect(screen.getByText("stopped")).toBeInTheDocument();
  });

  it("shows the end of long output, and all of it when asked", () => {
    const output = Array.from({ length: SHOWN_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
    const { container } = render(<ShellBlock item={item({ status: "done", code: 0, output })} />);
    const shown = () => container.querySelector(".shell-output")!.textContent!.split("\n");
    expect(shown()[0]).toBe("line 5");
    fireEvent.click(screen.getByRole("button", { name: `Show all ${SHOWN_LINES + 5} lines` }));
    expect(shown()[0]).toBe("line 0");
  });
});
