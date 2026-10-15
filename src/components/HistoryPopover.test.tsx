import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HistoryPopover } from "./HistoryPopover";

const sessions = [
  { id: "a", title: "Add retries to fetchJson", updated_ms: Date.now() - 60_000, prompts: 3 },
  { id: "b", title: "Fix the login redirect", updated_ms: Date.now() - 3_600_000, prompts: 1 },
];

function setup(over: Partial<React.ComponentProps<typeof HistoryPopover>> = {}) {
  const props = { folder: "/work/acme-api", exclude: [], load: vi.fn().mockResolvedValue(sessions), loadOld: vi.fn().mockResolvedValue([]), onBring: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(), ...over };
  render(<HistoryPopover {...props} />);
  return props;
}

describe("History", () => {
  it("reads a project's past chats when it opens, names the project, and opens a pick", async () => {
    const p = setup();
    expect(await screen.findByText("Past chats in acme-api")).toBeInTheDocument();
    fireEvent.click(await screen.findByText("Fix the login redirect"));
    expect(p.load).toHaveBeenCalledTimes(1);
    expect(p.onOpen).toHaveBeenCalledWith("b");
  });

  it("lists past chats only: the ones open (in the sidebar) are left out", async () => {
    setup({ exclude: ["a"] });
    expect(await screen.findByText("Fix the login redirect")).toBeInTheDocument();
    expect(screen.queryByText("Add retries to fetchJson")).toBeNull();
    expect(screen.queryByText("Open chats")).toBeNull();
  });

  it("offers the old chats of a moved project, only when some aren't brought over", async () => {
    const p = setup({
      loadOld: vi.fn().mockResolvedValue([
        { path: "/old/acme-api", exists: true, sessions: 7, updated_ms: 1, already: false },
        { path: "/src/acme-api", exists: true, sessions: 4, updated_ms: 1, already: true },
      ]),
    });
    fireEvent.click(await screen.findByRole("button", { name: "7 chats from before you moved this project: Bring them here" }));
    expect(p.onBring).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and on a press outside it", async () => {
    const p = setup();
    await screen.findByText("Fix the login redirect");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(p.onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(screen.getByPlaceholderText("Search chats"));
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });

  it("says so when the chats can't be read", async () => {
    setup({ load: vi.fn().mockRejectedValue("nope") });
    expect(await screen.findByText("No past chats in this folder")).toBeInTheDocument();
  });
});
