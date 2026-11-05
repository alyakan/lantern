import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { AWAY_MS, type RecapChat } from "../lib/recap";
import { RecapLine, useRecap } from "./RecapLine";

vi.mock("../api", () => ({ api: { recapSession: vi.fn() } }));
const recapSession = vi.mocked(api.recapSession);

const idle: RecapChat = { canRecap: true, idle: true, sessionId: "s1", items: 4 };

function Chat({ slot = "a", chat = idle }: { slot?: string; chat?: RecapChat }) {
  const recap = useRecap(slot, chat, "/work", "/bin/claude");
  return recap ? <RecapLine text={recap} /> : null;
}

/** The window loses focus, `ms` pass, and it comes back. */
async function awayFor(ms: number) {
  act(() => {
    window.dispatchEvent(new Event("blur"));
  });
  vi.advanceTimersByTime(ms);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
}

describe("useRecap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    recapSession.mockReset();
    recapSession.mockResolvedValue("Adding retries. Next: pick the backoff.");
    // The window starts in front, as when you're using the app.
    window.dispatchEvent(new Event("focus"));
  });
  afterEach(() => vi.useRealTimers());

  it("shows a recap when you come back after five minutes away", async () => {
    render(<Chat />);
    await awayFor(AWAY_MS);
    expect(recapSession).toHaveBeenCalledWith("/bin/claude", "/work", "s1");
    expect(screen.getByRole("status").textContent).toBe("recap: Adding retries. Next: pick the backoff.");
  });

  it("asks nothing after a short break, or again for a chat that hasn't changed", async () => {
    render(<Chat />);
    await awayFor(AWAY_MS - 1000);
    expect(recapSession).not.toHaveBeenCalled();
    await awayFor(AWAY_MS);
    await awayFor(AWAY_MS);
    expect(recapSession).toHaveBeenCalledTimes(1);
  });

  it("goes once the chat moves on", async () => {
    const { rerender } = render(<Chat />);
    await awayFor(AWAY_MS);
    expect(screen.queryByRole("status")).not.toBeNull();
    rerender(<Chat chat={{ ...idle, items: 5, idle: false }} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("counts time on another chat as away", async () => {
    const { rerender } = render(<Chat slot="a" />);
    rerender(<Chat slot="b" chat={{ ...idle, sessionId: "s2" }} />);
    vi.advanceTimersByTime(AWAY_MS);
    await act(async () => rerender(<Chat slot="a" />));
    expect(recapSession).toHaveBeenCalledWith("/bin/claude", "/work", "s1");
  });

  it("never asks for a provider that can't recap", async () => {
    render(<Chat chat={{ ...idle, canRecap: false }} />);
    await awayFor(AWAY_MS);
    expect(recapSession).not.toHaveBeenCalled();
  });
});
