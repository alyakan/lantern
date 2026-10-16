import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StepsSummary } from "../lib/stepsSummary";

const exportText = vi.fn((_name: string, _text: string) => Promise.resolve<string | null>("/Users/you/Desktop/plan.md"));
vi.mock("../api", () => ({ api: { changeSummary: () => Promise.resolve([]), exportText: (name: string, text: string) => exportText(name, text) } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: () => Promise.resolve() }));

import { DoneHandoff, type Handoff } from "./DoneHandoff";

const summary: StepsSummary = { headline: "1 of 1 steps built", rows: [] } as unknown as StepsSummary;
const handoff = (extra: Partial<Handoff> = {}): Handoff => ({
  slot: "s",
  summary,
  changed: [{ path: "/p/a.ts", created: false, added: 1, removed: 0 }, { path: "/p/b.ts", created: true, added: 3, removed: 0 }],
  doc: { pages: [], title: "Add slugify", folder: "/p" },
  running: false,
  onReviewChanges: vi.fn(),
  onStartNew: vi.fn(),
  onShip: vi.fn(),
  ...extra,
});

describe("the Done page's hand-off", () => {
  it("shows the next actions as buttons", () => {
    render(<DoneHandoff handoff={handoff()} onSend={() => {}} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Review the changes (2)", "Ship it…", "Export the plan", "Start something new"]);
  });

  it("opens the side panel on the changes with Review the changes, and starts a new chat with Start something new", () => {
    const h = handoff();
    render(<DoneHandoff handoff={h} onSend={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Review the changes/ }));
    expect(h.onReviewChanges).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Start something new" }));
    expect(h.onStartNew).toHaveBeenCalledTimes(1);
  });

  it("opens Ship it with Ship it…, and sends nothing itself", () => {
    const onSend = vi.fn();
    const h = handoff();
    render(<DoneHandoff handoff={h} onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "Ship it…" }));
    expect(h.onShip).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("leaves Ship it off while Claude is busy, but not the rest", () => {
    render(<DoneHandoff handoff={handoff()} />);
    expect(screen.getByRole("button", { name: "Ship it…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Review the changes/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start something new" })).toBeEnabled();
  });

  it("exports the plan, as the Summary tab does", async () => {
    render(<DoneHandoff handoff={handoff()} onSend={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Export the plan" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as Markdown…" }));
    await waitFor(() => expect(exportText).toHaveBeenCalled());
    expect(exportText.mock.calls[0][0]).toMatch(/\.md$/);
    expect(await screen.findByText(/Saved plan\.md/)).toBeInTheDocument();
  });

  it("has no export when there is no plan to export", () => {
    render(<DoneHandoff handoff={handoff({ summary: null })} onSend={() => {}} />);
    expect(screen.queryByRole("button", { name: "Export the plan" })).toBeNull();
  });
});
