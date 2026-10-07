import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ShellItem } from "../store";
import { PROMPT_PAUSE_MS, SHOWN_LINES, ShellBlock } from "./ShellBlock";

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

  describe("when the command asks something", () => {
    it("opens a reply field once output stops mid-line, and types the reply with Enter", () => {
      vi.useFakeTimers();
      const onInput = vi.fn();
      const { rerender } = render(<ShellBlock item={item({ command: "rm -i notes.txt", output: "remove notes.txt? " })} onInput={onInput} />);
      expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(PROMPT_PAUSE_MS));
      const field = screen.getByLabelText("Reply");
      expect(field.closest("form")).toHaveTextContent("remove notes.txt?");
      expect(field).toHaveFocus();
      fireEvent.change(field, { target: { value: "y" } });
      fireEvent.submit(field.closest("form")!);
      expect(onInput).toHaveBeenCalledWith("s1", "y\r");
      // Answered: it waits for the command to print something new.
      expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
      rerender(<ShellBlock item={item({ command: "rm -i notes.txt", output: "remove notes.txt? y\r\nremove todo.txt? " })} onInput={onInput} />);
      act(() => vi.advanceTimersByTime(PROMPT_PAUSE_MS));
      expect(screen.getByLabelText("Reply")).toBeInTheDocument();
      vi.useRealTimers();
    });

    it("doesn't take output that keeps coming as a question", () => {
      vi.useFakeTimers();
      const { rerender } = render(<ShellBlock item={item({ output: "Downloading 10%" })} onInput={() => {}} />);
      act(() => vi.advanceTimersByTime(PROMPT_PAUSE_MS - 100));
      rerender(<ShellBlock item={item({ output: "Downloading 10%\rDownloading 40%" })} onInput={() => {}} />);
      act(() => vi.advanceTimersByTime(PROMPT_PAUSE_MS - 100));
      expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
      vi.useRealTimers();
    });

    it("asks for a password in a secret field, right away", () => {
      const onInput = vi.fn();
      render(<ShellBlock item={item({ command: "sudo brew install redis", output: "Password:", secret: true })} onInput={onInput} />);
      const field = screen.getByLabelText("Secret reply");
      expect(field).toHaveAttribute("type", "password");
      expect(screen.getByText(/not shown, kept or sent to Claude/)).toBeInTheDocument();
      fireEvent.change(field, { target: { value: "hunter2" } });
      fireEvent.submit(field.closest("form")!);
      expect(onInput).toHaveBeenCalledWith("s1", "hunter2\r");
    });

    it("can be opened by hand, ends input with ⌃D and hides with Escape", () => {
      const onInput = vi.fn();
      render(<ShellBlock item={item({ command: "cat > notes.txt", output: "" })} onInput={onInput} />);
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      const field = screen.getByLabelText("Reply");
      fireEvent.keyDown(field, { key: "d", ctrlKey: true });
      expect(onInput).toHaveBeenCalledWith("s1", "\u0004");
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Escape" });
      expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
    });
  });
});
