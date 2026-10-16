import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupCard } from "../store";
import { SetupNotice } from "./SetupNotice";

afterEach(cleanup);

const running: SetupCard = { status: "running", index: 1, total: 3, command: "npm ci", line: "added 412 packages", reason: "", tail: "" };
const failed: SetupCard = { status: "failed", index: 1, total: 3, command: "npm ci", line: "", reason: "it exited with code 1", tail: "npm ERR! missing lockfile\nnpm ERR! aborted" };

describe("a new agent being set up", () => {
  it("says which line is running, how far along it is, and what it printed last", () => {
    render(<SetupNotice card={running} onAnswer={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("status", { name: "Setting up" }).textContent).toContain("Setting up: npm ci…");
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.getByText("added 412 packages")).toBeTruthy();
  });

  it("has no step count for a single line", () => {
    render(<SetupNotice card={{ ...running, index: 0, total: 1 }} onAnswer={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText(/of 1/)).toBeNull();
  });

  it("can be stopped while it runs", async () => {
    const onAnswer = vi.fn(() => Promise.resolve());
    render(<SetupNotice card={running} onAnswer={onAnswer} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onAnswer).toHaveBeenCalledWith("stop");
  });
});

describe("a setup that stopped at a line", () => {
  it("names the line and why, shows the end of what it printed, and says the agent hasn't started", () => {
    render(<SetupNotice card={failed} onAnswer={vi.fn()} onClose={vi.fn()} />);
    const card = screen.getByRole("group", { name: "Setup stopped" });
    expect(card.textContent).toContain("Setup stopped at npm ci");
    expect(card.textContent).toContain("It exited with code 1");
    expect(card.textContent).toContain("hasn't started yet (line 2 of 3)");
    expect(screen.getByRole("region", { name: "What it printed last" }).textContent).toBe("npm ERR! missing lockfile\nnpm ERR! aborted");
  });

  it("offers Start anyway, Run setup again and Close agent, each doing its own thing", async () => {
    const onAnswer = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    render(<SetupNotice card={failed} onAnswer={onAnswer} onClose={onClose} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Start anyway", "Run setup again", "Close agent"]);
    const enabled = () => waitFor(() => expect((screen.getByRole("button", { name: "Start anyway" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Start anyway" }));
    expect(onAnswer).toHaveBeenLastCalledWith("start");
    await enabled();
    fireEvent.click(screen.getByRole("button", { name: "Run setup again" }));
    expect(onAnswer).toHaveBeenLastCalledWith("again");
    expect(onClose).not.toHaveBeenCalled();
    await enabled();
    fireEvent.click(screen.getByRole("button", { name: "Close agent" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is busy while an answer is on its way, and says why one didn't work", async () => {
    let fail!: (e: string) => void;
    const onAnswer = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    render(<SetupNotice card={failed} onAnswer={onAnswer} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Run setup again" }));
    expect((screen.getByRole("button", { name: "Start anyway" }) as HTMLButtonElement).disabled).toBe(true);
    fail("That agent isn't waiting for an answer about its setup.");
    await waitFor(() => expect(screen.getByText("That agent isn't waiting for an answer about its setup.")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Start anyway" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("has no output box when the line printed nothing", () => {
    render(<SetupNotice card={{ ...failed, tail: "" }} onAnswer={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("region")).toBeNull();
  });
});
