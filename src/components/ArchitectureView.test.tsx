import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { initialState, type ChatItem, type State } from "../store";
import { StepsView } from "./StepsView";

vi.mock("../api", () => ({ api: { userName: () => Promise.resolve("Ada Lovelace") } }));
// Mermaid needs a real browser's layout; the map's own behaviour is what's tested, on a diagram with two nodes.
vi.mock("../lib/mermaid", async (original) => ({
  ...(await original<typeof import("../lib/mermaid")>()),
  renderDiagram: vi.fn(() => Promise.resolve('<svg><g class="node" id="lantern-diagram-1-flowchart-gw-0"><rect/></g><g class="node" id="lantern-diagram-1-flowchart-authSvc-1"><rect/></g></svg>')),
}));

const turn = (n: number): ChatItem => ({ type: "turn", id: `t${n}`, isError: false, stopped: false, result: null, durationMs: 1, denied: 0 });
const OVERVIEW = "# Overview — auth behind a gateway\n\n```mermaid\nflowchart LR\n  gw[Gateway]:::new --> authSvc[Auth service]\n```";
const PART1 = "# Part 1 of 2 — Gateway\n\nCovers: gw\n\n### Role\nTerminates TLS.\n\n### Concerns\n⚠ (should-fix): no timeout, so a slow auth service ties up every connection.";
const PART2 = "# Part 2 of 2 — Auth service\n\nCovers: authSvc\n\n### Role\nChecks tokens.\n\n### Concerns\nNone.";
const SUMMARY = "# Summary — 2 parts, 1 concern agreed";

/** The chat up to and including the page at `pages` (1 = Frame, 2 = Overview, 3 = Part 1, …). */
function chat(pages: number): ChatItem[] {
  const texts = ["# Frame — map PR 12", OVERVIEW, PART1, PART2, SUMMARY].slice(0, pages);
  return texts.flatMap((text, i): ChatItem[] => [{ type: "user", id: `u${i}`, text: i === 0 ? "Map the architecture of PR 12" : "Next", turn: i }, { type: "assistant", id: `a${i}`, text }, turn(i)]);
}
const state = (pages: number): State => ({ ...initialState, folder: "/p", status: "idle", mode: "steps", items: chat(pages) });
const handlers = () => ({ onDecide: () => {}, onOpenFile: () => {}, onNext: vi.fn(), onSend: vi.fn(), flavour: "architecture" as const, onPickFlavour: vi.fn(), onPage: vi.fn() });
const current = () => document.querySelector('.step-page[aria-hidden="false"]')!;
const map = () => screen.queryByRole("complementary", { name: "Architecture map" });
// The Overview's own page draws the same diagram, so the map's nodes are looked up inside the map.
const node = (id: string) => map()?.querySelector(`[id*="flowchart-${id}-"]`) ?? null;

beforeEach(() => localStorage.clear());

describe("Architecture in Step by step", () => {
  it("lays a part out in its sections, with the concerns to agree with or reject, and sends the verdicts with Next", () => {
    const h = handlers();
    render(<StepsView state={state(3)} {...h} />);
    expect(current().querySelector(".step-eyebrow")).toHaveTextContent("Part 1 of 2");
    expect(current().querySelector(".step-title")).toHaveTextContent("Gateway");
    expect(current()).toHaveTextContent("Terminates TLS.");
    expect(current().querySelector(".arch-covers")).toHaveTextContent("gw");
    expect(current().querySelector(".finding")).toHaveTextContent("no timeout");
    fireEvent.click(screen.getByRole("button", { name: "Agree" }));
    fireEvent.click(screen.getByRole("button", { name: "Next part →" }));
    expect(h.onNext).toHaveBeenCalledWith("Next. Agreed: finding 1.");
  });

  it("walks Frame to Overview to the parts to the Summary in its buttons", () => {
    const labels = [1, 2, 3, 4, 5].map((n) => {
      const view = render(<StepsView state={state(n)} {...handlers()} />);
      const label = screen.queryByRole("button", { name: /(→|Done)$/ })?.textContent;
      view.unmount();
      return label;
    });
    expect(labels).toEqual(["Overview →", "First part →", "Next part →", "Summary →", "Done"]);
  });

  it("pins the map beside the pages from the Overview on, lighting the part you're on", async () => {
    render(<StepsView state={state(4)} {...handlers()} />);
    expect(map()).toBeInTheDocument();
    // The diagram is drawn a moment after the page (and its classes a moment after that), so each look waits for it.
    await waitFor(() => {
      expect(node("authSvc")).toHaveClass("covered", "opens");
      expect(node("gw")).not.toHaveClass("covered");
    });
    // Going back lights the other part's node instead.
    fireEvent.click(screen.getByRole("button", { name: "← Previous" }));
    await waitFor(() => {
      expect(node("gw")).toHaveClass("covered");
      expect(node("authSvc")).not.toHaveClass("covered");
    });
  });

  it("has no map before there is a diagram, and doesn't repeat it on the Overview page", () => {
    const frame = render(<StepsView state={state(1)} {...handlers()} />);
    expect(map()).toBeNull();
    frame.unmount();
    render(<StepsView state={state(2)} {...handlers()} />);
    expect(map()).toBeNull();
    expect(current().querySelector(".diagram, .code-block")).not.toBeNull();
  });

  it("opens a part's page when its box is clicked on the map", async () => {
    render(<StepsView state={state(4)} {...handlers()} />);
    expect(current().querySelector(".step-title")).toHaveTextContent("Auth service");
    await waitFor(() => expect(node("gw")).not.toBeNull());
    fireEvent.click(node("gw")!.querySelector("rect")!);
    expect(current().querySelector(".step-title")).toHaveTextContent("Gateway");
  });

  it("slims the map down to a bar and brings it back, and remembers which", async () => {
    const view = render(<StepsView state={state(3)} {...handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide the map" }));
    expect(screen.getByRole("button", { name: "Show the architecture map" })).toBeInTheDocument();
    expect(map()!.querySelector("svg")).toBeNull();
    view.unmount();
    // A chat opened again finds it as it was left.
    render(<StepsView state={state(3)} {...handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show the architecture map" }));
    await waitFor(() => expect(node("gw")).not.toBeNull());
  });

  it("opens the map at full size, with zoom", async () => {
    render(<StepsView state={state(3)} {...handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open the map at full size" }));
    const big = within(await screen.findByRole("dialog", { name: "Architecture map", hidden: true }));
    fireEvent.click(await big.findByRole("button", { name: "Zoom in", hidden: true }));
    expect(big.getByRole("button", { name: "Actual size", hidden: true })).toHaveTextContent("125%");
  });

  it("ends in a summary of the concerns, and starts a Build from it", () => {
    const h = handlers();
    render(<StepsView state={state(5)} {...h} />);
    expect(current().querySelector(".review-table")).toHaveTextContent("Gateway");
    expect(current().querySelector(".review-table")).toHaveTextContent("no timeout");
    fireEvent.click(screen.getByRole("button", { name: "Start Build" }));
    expect(h.onSend).toHaveBeenCalledWith("Start Build.");
  });
});
