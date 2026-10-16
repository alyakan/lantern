import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunTask } from "../store";
import { RunPanel } from "./RunPanel";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...args: unknown[]) => openUrl(...args) }));

beforeEach(() => openUrl.mockReset().mockResolvedValue(undefined));
afterEach(cleanup);

const run: RunTask = { id: "run-1", command: "npm run dev", status: "running", code: null, output: "> vite\n\n  Local: http://localhost:5173/\n", url: "http://localhost:5173/", startedAt: 0 };
const handlers = () => ({ onStop: vi.fn(), onRestart: vi.fn(), onClose: vi.fn() });

describe("the Run panel", () => {
  it("shows a running command, its output, and Stop and Restart", () => {
    const h = handlers();
    render(<RunPanel run={run} {...h} />);
    expect(screen.getByRole("status").textContent).toBe("Running");
    expect(screen.getByText("npm run dev")).toBeTruthy();
    expect(screen.getByRole("region", { name: "What it printed" }).textContent).toContain("Local: http://localhost:5173/");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    fireEvent.click(screen.getByRole("button", { name: "Close the Run panel" }));
    expect([h.onStop, h.onRestart, h.onClose].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("opens the local address it printed in the browser", () => {
    render(<RunPanel run={run} {...handlers()} />);
    fireEvent.click(screen.getByRole("link", { name: "http://localhost:5173/" }));
    expect(openUrl).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("has no link when it printed no local address", () => {
    render(<RunPanel run={{ ...run, url: null, output: "hello\n" }} {...handlers()} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says Stopped, without Stop, once it ended on its own or was stopped", () => {
    render(<RunPanel run={{ ...run, status: "stopped", code: null }} {...handlers()} />);
    expect(screen.getByRole("status").textContent).toBe("Stopped");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
  });

  it("says Failed with the exit code, and what it printed last", () => {
    render(<RunPanel run={{ ...run, status: "failed", code: 127, output: "zsh: command not found: nom\n", url: null }} {...handlers()} />);
    expect(screen.getByRole("status").textContent).toBe("Failed (exit 127)");
    expect(screen.getByRole("region", { name: "What it printed" }).textContent).toBe("zsh: command not found: nom");
  });

  it("waits for output while a command has printed nothing, and shows only its last lines", () => {
    const { rerender } = render(<RunPanel run={{ ...run, output: "", url: null }} {...handlers()} />);
    expect(screen.getByText("Waiting for it to print something…")).toBeTruthy();
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    rerender(<RunPanel run={{ ...run, output: many, url: null }} {...handlers()} />);
    const text = screen.getByRole("region", { name: "What it printed" }).textContent!;
    expect(text.startsWith("line 60")).toBe(true);
    expect(text.endsWith("line 99")).toBe(true);
  });
});
