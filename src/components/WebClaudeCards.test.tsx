import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { resetActionsForTest } from "../lib/actions";
import type { WebCard } from "../lib/webClaude";
import { cardNotice } from "../lib/useWebClaude";
import { Inbox } from "./Inbox";

const at = Date.now() - 60_000;
const connect: WebCard = { kind: "connect", id: "c1", client: "Claude", at };
const run = (over: Partial<Extract<WebCard, { kind: "run" }>> = {}): WebCard => ({ kind: "run", id: "r1", canvas: "https://claude.ai/artifact/abc", title: "Rayak — Grocery", message: "Move the rating under the price.\nKeep the dark colours.", folder: null, answer: false, chat_title: null, at, ...over });

function setup(cards: WebCard[], allow = vi.fn(() => Promise.resolve()), runIt = vi.fn(() => Promise.resolve())) {
  resetActionsForTest();
  render(<Inbox items={[]} onGo={vi.fn()} onDecide={vi.fn()} web={{ cards, projects: [["/dev/rayak", "rayak"], ["/dev/lantern", "lantern"]], onAllow: allow, onRun: runIt }} />);
  const toggle = screen.getByRole("button", { name: /What needs you/ });
  fireEvent.click(toggle);
  // A card's yes stays dead for a moment after it appears.
  act(() => {
    vi.advanceTimersByTime(500);
  });
  return { toggle, allow, runIt };
}

describe("web Claude's cards in the inbox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts them as waiting", () => {
    const { toggle } = setup([connect, run()]);
    expect(toggle).toHaveAccessibleName("What needs you, 2 waiting");
  });

  it("allows a sign-in only with the six-character code typed, and never shows the code itself", () => {
    const { allow } = setup([connect]);
    const row = screen.getAllByRole("listitem")[0];
    expect(within(row).getByText("Claude wants to connect")).toBeInTheDocument();
    const yes = within(row).getByRole("button", { name: "Allow Claude" });
    expect(yes).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(yes);
    expect(allow).not.toHaveBeenCalled();
    fireEvent.change(within(row).getByLabelText("The code on the claude.ai sign-in page"), { target: { value: "ab3 k7q" } });
    expect(yes).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(yes);
    expect(allow).toHaveBeenCalledWith("c1", true, "AB3K7Q");
  });

  it("denies a sign-in without a code, and Deny is where the keyboard starts", () => {
    const { allow } = setup([connect]);
    const no = screen.getByRole("button", { name: "Deny Claude" });
    expect(no).toHaveFocus();
    fireEvent.click(no);
    expect(allow).toHaveBeenCalledWith("c1", false, null);
  });

  it("says why a wrong code was refused", async () => {
    setup([connect], vi.fn(() => Promise.reject("That isn't the code on the sign-in page.")));
    fireEvent.change(screen.getByLabelText("The code on the claude.ai sign-in page"), { target: { value: "AAAAAA" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow Claude" }));
    await act(async () => {});
    expect(screen.getByText("That isn't the code on the sign-in page.")).toBeInTheDocument();
  });

  it("asks for a project before Run when the canvas has none, and sends the one picked", () => {
    const { runIt } = setup([run()]);
    const row = screen.getAllByRole("listitem")[0];
    expect(within(row).getByText("From web Claude · pick its project")).toBeInTheDocument();
    expect(within(row).getByText("Move the rating under the price.")).toBeInTheDocument();
    const yes = within(row).getByRole("button", { name: "Run Rayak — Grocery" });
    fireEvent.click(yes);
    expect(runIt).not.toHaveBeenCalled();
    fireEvent.change(within(row).getByLabelText("The project this canvas belongs to"), { target: { value: "/dev/rayak" } });
    fireEvent.click(yes);
    expect(runIt).toHaveBeenCalledWith("r1", true, "/dev/rayak");
  });

  it("runs a linked canvas or an answer as it is, and Decline declines", () => {
    const { runIt } = setup([run({ folder: "/dev/rayak" }), run({ id: "r2", answer: true, chat_title: "Header", title: "Rayak" })]);
    const [linked, answer] = screen.getAllByRole("listitem");
    expect(within(linked).getByText("From web Claude · rayak")).toBeInTheDocument();
    expect(within(linked).queryByLabelText("The project this canvas belongs to")).toBeNull();
    expect(within(answer).getByText("An answer for Header")).toBeInTheDocument();
    fireEvent.click(within(linked).getByRole("button", { name: "Run Rayak — Grocery" }));
    expect(runIt).toHaveBeenCalledWith("r1", true, null);
    fireEvent.click(within(answer).getByRole("button", { name: "Decline Rayak" }));
    expect(runIt).toHaveBeenCalledWith("r2", false, null);
  });

  it("notifies in words that never carry a sign-in code", () => {
    expect(cardNotice(connect).title).toBe("Web Claude wants to connect");
    expect(cardNotice(run())).toEqual({ title: "Web Claude sent work: Rayak — Grocery", body: "Move the rating under the price." });
    expect(cardNotice(run({ answer: true })).title).toBe("Web Claude answered: Rayak — Grocery");
  });
});
