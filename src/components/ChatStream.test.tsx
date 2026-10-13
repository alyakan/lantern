import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ChatItem } from "../store";
import { ChatStream } from "./ChatStream";

const items: ChatItem[] = [
  { type: "user", id: "u1", text: "First question" },
  { type: "assistant", id: "a1", text: "First answer" },
  { type: "user", id: "u2", text: "Second question" },
  { type: "assistant", id: "a2", text: "Second answer" },
];
const handlers = { onDecide: () => {}, onOpenFile: () => {} };

describe("ChatStream", () => {
  it("groups each prompt and its reply into a section headed by a sticky prompt", () => {
    const { container } = render(<ChatStream items={items} folder={null} sections {...handlers} />);
    const sections = container.querySelectorAll("section.turn-section");
    expect(sections).toHaveLength(2);
    expect(sections[0].querySelector(".turn-head .msg.user")?.textContent).toBe("First question");
    expect(sections[0].textContent).toContain("First answer");
    expect(sections[1].querySelector(".turn-head .msg.user")?.textContent).toBe("Second question");
  });

  it("stays flat without sections (e.g. nested subagent streams)", () => {
    const { container } = render(<ChatStream items={items} folder={null} {...handlers} />);
    expect(container.querySelector("section")).toBeNull();
    expect(container.querySelectorAll(".msg.user")).toHaveLength(2);
  });
});

describe("message actions", () => {
  const sent: ChatItem[] = [
    { type: "user", id: "u1", text: "Explain the **parser**" },
    { type: "assistant", id: "a1", text: "It **reads** lines." },
    { type: "user", id: "u2", text: "Now the queue", draft: "Now the queue" },
    { type: "assistant", id: "a2", text: "It holds messages." },
  ];
  const resend = { onEdit: vi.fn(), onResend: vi.fn() };

  beforeEach(() => {
    resend.onEdit.mockReset();
    resend.onResend.mockReset();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  it("copies a message as its raw markdown, and says so", async () => {
    render(<ChatStream items={sent} folder={null} {...handlers} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[1]);
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("It **reads** lines.");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("offers Copy on every message, and nothing else without a way to send again", () => {
    render(<ChatStream items={sent} folder={null} {...handlers} />);
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
  });

  it("puts a sent message back in the box with its draft, as Edit", () => {
    render(<ChatStream items={sent} folder={null} {...handlers} resend={resend} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(resend.onEdit).toHaveBeenCalledWith("Explain the **parser**");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    expect(resend.onEdit).toHaveBeenLastCalledWith("Now the queue");
  });

  it("gives the edit title that says it's a new message", () => {
    render(<ChatStream items={sent} folder={null} {...handlers} resend={resend} />);
    expect(screen.getAllByRole("button", { name: "Edit" })[0].getAttribute("title")).toBe("Edit and send as a new message");
  });

  it("regenerates only the latest answer, resending its prompt", () => {
    render(<ChatStream items={sent} folder={null} {...handlers} resend={resend} />);
    const regen = screen.getAllByRole("button", { name: "Regenerate" });
    expect(regen).toHaveLength(1);
    fireEvent.click(regen[0]);
    expect(resend.onResend).toHaveBeenCalledWith({ text: "Now the queue", draft: "Now the queue" });
  });

  it("doesn't regenerate an answer that a later prompt has passed", () => {
    const passed: ChatItem[] = [...sent.slice(0, 2), { type: "user", id: "u2", text: "Next" }];
    render(<ChatStream items={passed} folder={null} {...handlers} resend={resend} />);
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
  });

  it("offers nothing to resend after a reply Claude started on its own", () => {
    const auto: ChatItem[] = [{ type: "user", id: "u1", text: "Background task ended", auto: true }, { type: "assistant", id: "a1", text: "Done." }];
    render(<ChatStream items={auto} folder={null} {...handlers} resend={resend} />);
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("retries a stopped turn with the prompt it answered", () => {
    const stopped: ChatItem[] = [
      { type: "user", id: "u1", text: "Refactor it" },
      { type: "turn", id: "t1", isError: false, stopped: true, result: null, durationMs: 900, denied: 0 },
    ];
    render(<ChatStream items={stopped} folder={null} {...handlers} resend={resend} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(resend.onResend).toHaveBeenCalledWith({ text: "Refactor it", draft: undefined });
  });

  it("doesn't offer Retry on a turn that ended normally, or without a way to resend", () => {
    const ok: ChatItem[] = [
      { type: "user", id: "u1", text: "Hi" },
      { type: "turn", id: "t1", isError: true, stopped: false, result: "Boom", durationMs: 1, denied: 0 },
    ];
    const { unmount } = render(<ChatStream items={ok} folder={null} {...handlers} resend={resend} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    unmount();
    render(<ChatStream items={ok} folder={null} {...handlers} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
