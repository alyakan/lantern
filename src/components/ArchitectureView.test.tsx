import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { initialState, type ChatItem, type State } from "../store";
import { StepsView } from "./StepsView";
import { ArchitectureTab } from "./ArchitectureTab";
import { Md } from "./Md";
import { ArchitecturePane } from "../lib/architecturePane";
import { architectureMap } from "../lib/architecture";
import { pagesOf } from "../lib/steps";
import { TESTO_MAP } from "../lib/testoMap";

vi.mock("../api", () => ({ api: { userName: () => Promise.resolve("Ada Lovelace") } }));
// Mermaid needs a real browser's layout: older maps and other diagrams are tested on a stand-in drawing.
vi.mock("../lib/mermaid", async (original) => ({
  ...(await original<typeof import("../lib/mermaid")>()),
  renderDiagram: vi.fn(() => Promise.resolve('<svg viewBox="0 0 300 120"><g class="node" id="lantern-diagram-1-flowchart-gw-0"><rect/></g><g class="node" id="lantern-diagram-1-flowchart-authSvc-1"><rect/></g></svg>')),
}));

const turn = (n: number): ChatItem => ({ type: "turn", id: `t${n}`, isError: false, stopped: false, result: null, durationMs: 1, denied: 0 });
const SPEC = { nodes: [{ id: "gw", label: "Gateway", change: "new", note: "Terminates TLS and forwards requests" }, { id: "authSvc", label: "Auth service", note: "Checks every token" }, { id: "logs", label: "Logs" }], edges: [{ from: "gw", to: "authSvc", label: "forwards" }, { from: "authSvc", to: "logs" }] };
const OVERVIEW = `# Overview — auth behind a gateway\n\nThe gateway is new.\n\n\`\`\`architecture\n${JSON.stringify(SPEC)}\n\`\`\``;
const PART1 = "# Part 1 of 2 — Gateway\n\nCovers: gw\n\n### Role\nTerminates TLS.\n\n### Concerns\n⚠ (should-fix): no timeout, so a slow auth service ties up every connection.";
const PART2 = "# Part 2 of 2 — Auth service\n\nCovers: authSvc\n\n### Role\nChecks tokens.\n\n### Concerns\nNone.";
const SUMMARY = "# Summary — 2 parts, 1 concern agreed";

/** The chat up to and including the page at `pages` (1 = Frame, 2 = Overview, 3 = Part 1, …). */
function chat(pages: number, overview = OVERVIEW): ChatItem[] {
  const texts = ["# Frame — map PR 12", overview, PART1, PART2, SUMMARY].slice(0, pages);
  return texts.flatMap((text, i): ChatItem[] => [{ type: "user", id: `u${i}`, text: i === 0 ? "Map the architecture of PR 12" : "Next", turn: i }, { type: "assistant", id: `a${i}`, text }, turn(i)]);
}
const state = (pages: number): State => ({ ...initialState, folder: "/p", status: "idle", mode: "steps", items: chat(pages) });
const handlers = () => ({ onDecide: () => {}, onOpenFile: () => {}, onNext: vi.fn(), onSend: vi.fn(), flavour: "architecture" as const, onPickFlavour: vi.fn(), onPage: vi.fn() });
const current = () => document.querySelector('.step-page[aria-hidden="false"]')!;

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

  it("says which page is on screen, so the Map tab can light it", () => {
    const onShown = vi.fn();
    render(<StepsView state={state(4)} {...handlers()} onShown={onShown} />);
    expect(onShown).toHaveBeenLastCalledWith("u3");
    fireEvent.click(screen.getByRole("button", { name: "← Previous" }));
    fireEvent.transitionEnd(document.querySelector(".steps-track")!);
    expect(onShown).toHaveBeenLastCalledWith("u2");
  });

  it("draws the Overview page's map in the page, with a way to the pane", () => {
    const open = vi.fn();
    render(
      <ArchitecturePane.Provider value={{ open, label: (id) => (id === "gw" ? "Gateway" : id) }}>
        <StepsView state={state(2)} {...handlers()} />
      </ArchitecturePane.Provider>,
    );
    const block = current().querySelector(".arch-block") as HTMLElement;
    expect(within(block).getByRole("button", { name: /^Gateway, new/ })).toBeInTheDocument();
    fireEvent.click(within(block).getByRole("button", { name: "Open in the pane" }));
    expect(open).toHaveBeenCalled();
  });

  it("names a part's boxes on the map by their labels, and a chip opens the Map with that box lit", () => {
    const open = vi.fn();
    render(
      <ArchitecturePane.Provider value={{ open, label: (id) => (id === "gw" ? "Gateway" : id) }}>
        <StepsView state={state(3)} {...handlers()} />
      </ArchitecturePane.Provider>,
    );
    const chip = within(current().querySelector(".arch-covers") as HTMLElement).getByRole("button", { name: "Gateway" });
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledWith("gw");
  });

  it("says where Next goes on the first pages, and how many of a part's concerns are answered", () => {
    const { rerender } = render(<StepsView state={state(1)} {...handlers()} />);
    expect(screen.getByRole("button", { name: "Overview →" })).toHaveAttribute("title", "Go on to the Overview");
    rerender(<StepsView state={state(2)} {...handlers()} />);
    expect(screen.getByRole("button", { name: "First part →" })).toHaveAttribute("title", "Go on to the first part");
    rerender(<StepsView state={state(3)} {...handlers()} />);
    expect(screen.getByText("0 of 1 concern answered")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Agree" }));
    expect(screen.getByText("1 of 1 concern answered")).toBeInTheDocument();
  });

  it("says under a reply that looked like a page but wasn't one that Lantern couldn't show it", () => {
    const s = state(3);
    s.items = [...s.items, { type: "user", id: "ux", text: "why?", turn: 9 }, { type: "assistant", id: "ax", text: "## Architecture · The retry story\n\nIt retries." }];
    render(<StepsView state={s} {...handlers()} />);
    expect(screen.getByText("Lantern couldn't show this as a page; it will tell Claude with your next message.")).toBeInTheDocument();
    // An answer with no heading is how answers should be.
    const plain = state(3);
    plain.items = [...plain.items, { type: "user", id: "ux", text: "why?", turn: 9 }, { type: "assistant", id: "ax", text: "Because it retries." }];
    cleanup();
    render(<StepsView state={plain} {...handlers()} />);
    expect(screen.queryByText(/couldn't show this as a page/)).toBeNull();
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

describe("the Map tab", () => {
  const pages = pagesOf(chat(4));
  const map = architectureMap(pages)!;
  const names = { [pages[2].key]: "Part 1 of 2 — Gateway", [pages[3].key]: "Part 2 of 2 — Auth service" };
  const box = (name: RegExp) => screen.getByRole("button", { name });

  it("marks a box with no page of its own as disabled, and pans the map to the box the arrow keys reach", () => {
    render(<ArchitectureTab map={map} current={[]} pageNames={names} onOpenPage={() => {}} />);
    expect(box(/^Logs/)).toHaveAttribute("aria-disabled", "true");
    expect(box(/^Gateway/)).not.toHaveAttribute("aria-disabled");
    const world = document.querySelector(".pz-world") as HTMLElement;
    const before = world.style.transform;
    fireEvent.keyDown(box(/^Gateway/), { key: "ArrowRight" });
    // The room has no size here, so any box is "off screen": the view moved to bring the next one in.
    expect(world.style.transform).not.toBe(before);
  });

  it("eases the zoom and Fit buttons like the canvas does, and leaves a gesture to follow the pointer", () => {
    render(<ArchitectureTab map={map} current={[]} pageNames={names} onOpenPage={() => {}} />);
    const world = document.querySelector(".pz-world") as HTMLElement;
    expect(world.classList.contains("animating")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(world.classList.contains("animating")).toBe(true);
    fireEvent.wheel(document.querySelector(".pz-surface")!, { deltaX: 0, deltaY: 20 });
    expect(world.classList.contains("animating")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(world.classList.contains("animating")).toBe(true);
  });

  it("draws every box as a button, says what the change does to it, and lights the part on screen", () => {
    const { container } = render(<ArchitectureTab map={map} current={["authSvc"]} pageNames={names} onOpenPage={() => {}} />);
    expect(screen.getByText("auth behind a gateway")).toBeInTheDocument();
    expect(box(/^Gateway, new/)).toHaveClass("new");
    expect(box(/^Auth service/)).toHaveClass("covered", "opens");
    expect(box(/^Logs, no page of its own/)).not.toHaveClass("opens");
    expect(container.querySelector(".arch-graph")).toHaveClass("focused");
    expect(within(screen.getByLabelText("Legend")).getByText("New")).toBeInTheDocument();
    expect(container.querySelectorAll(".arch-edge")).toHaveLength(2);
    expect(screen.getByText("forwards")).toBeInTheDocument();
  });

  it("opens a box's page on a click or Enter, and tells what a box does on hover", () => {
    const onOpenPage = vi.fn();
    render(<ArchitectureTab map={map} current={[]} pageNames={names} onOpenPage={onOpenPage} />);
    fireEvent.click(box(/^Gateway/));
    expect(onOpenPage).toHaveBeenLastCalledWith(pages[2].key);
    fireEvent.keyDown(box(/^Auth service/), { key: "Enter" });
    expect(onOpenPage).toHaveBeenLastCalledWith(pages[3].key);
    fireEvent.mouseEnter(box(/^Gateway/));
    expect(screen.getByText("Terminates TLS and forwards requests")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Part 1 of 2 — Gateway →" }));
    expect(onOpenPage).toHaveBeenLastCalledWith(pages[2].key);
  });

  it("zooms with its buttons and fits back", () => {
    render(<ArchitectureTab map={map} current={[]} pageNames={names} onOpenPage={() => {}} />);
    const level = screen.getByLabelText("Zoom level");
    const before = level.textContent;
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(level.textContent).not.toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(level.textContent).toBe(before);
  });

  it("says why it can't draw an Overview whose block doesn't read", () => {
    const broken = architectureMap(pagesOf(chat(2, "# Overview — x\n\n```architecture\n{nodes\n```")))!;
    render(<ArchitectureTab map={broken} current={[]} pageNames={{}} onOpenPage={() => {}} />);
    expect(screen.getByText(/couldn't be read: It isn't valid JSON/)).toBeInTheDocument();
  });

  it("still shows an Overview drawn in Mermaid, lit and clickable", async () => {
    const old = architectureMap(pagesOf(chat(4, "# Overview — old\n\n```mermaid\nflowchart LR\n  gw --> authSvc\n```")))!;
    const onOpenPage = vi.fn();
    const { container } = render(<ArchitectureTab map={old} current={["authSvc"]} pageNames={{}} onOpenPage={onOpenPage} />);
    await waitFor(() => expect(container.querySelector('[id*="flowchart-authSvc-"]')).toHaveClass("covered"));
    fireEvent.click(container.querySelector('[id*="flowchart-gw-"] rect')!);
    expect(onOpenPage).toHaveBeenCalled();
  });
});

describe("a diagram in a message", () => {
  it("opens at full size, to zoom and move around", async () => {
    render(<Md>{"```mermaid\nsequenceDiagram\n  A->>B: hi\n```"}</Md>);
    fireEvent.click(await screen.findByRole("button", { name: "Expand diagram" }));
    const big = within(await screen.findByRole("dialog", { name: "Diagram", hidden: true }));
    expect(big.getByRole("button", { name: "Fit", hidden: true })).toBeInTheDocument();
  });
});

describe("a layered map in the Map tab", () => {
  const overview = `# Overview — Testo on iOS\n\n\`\`\`architecture\n${JSON.stringify(TESTO_MAP)}\n\`\`\``;
  const map = architectureMap(pagesOf([{ type: "user", id: "u0", text: "map it" }, { type: "assistant", id: "a0", text: overview }]))!;
  const box = (name: RegExp) => screen.getByRole("button", { name });

  it("draws each layer as a band, each box's status, and the boxes Claude found a problem with", () => {
    const { container } = render(<ArchitectureTab map={map} current={[]} pageNames={{}} onOpenPage={() => {}} />);
    expect([...container.querySelectorAll(".arch-band-label")].map((t) => t.textContent)).toEqual(["UI", "Business logic", "Device boundary", "Testo implementation", "External"]);
    expect(box(/^Gating, done/)).toHaveClass("st-done");
    expect(box(/^Sensor field and view model, planned/)).toHaveClass("st-planned");
    expect(box(/^Window events and expected quantities, in progress, has an issue/)).toHaveClass("has-issue");
    // Its long label is wrapped onto two lines, not cut short.
    expect([...box(/^Window events/).querySelectorAll("tspan")].map((t) => t.textContent)).toEqual(["Window events and", "expected quantities"]);
    const legend = within(screen.getByLabelText("Legend"));
    expect(legend.getByText("Done")).toBeInTheDocument();
    expect(legend.getByText("Planned")).toBeInTheDocument();
    expect(legend.getByText(/crossings$/)).toBeInTheDocument();
  });

  it("lists every issue, Claude's and the boundary crossing Lantern found, and marks the arrows", () => {
    const { container } = render(<ArchitectureTab map={map} current={[]} pageNames={{}} onOpenPage={() => {}} />);
    const list = within(screen.getByLabelText("Issues"));
    expect(list.getByText("3 issues")).toBeInTheDocument();
    expect(list.getByText(/goes around Device boundary/)).toBeInTheDocument();
    expect(list.getByText(/found by Lantern from the layers/)).toBeInTheDocument();
    expect(container.querySelectorAll(".arch-edge.skip")).toHaveLength(1);
    expect(container.querySelectorAll(".arch-edge.issue")).toHaveLength(1);
    expect(container.querySelectorAll(".arch-crossing").length).toBeGreaterThan(10);
    // Hovering a box shows what it is, its layer and its issue, in the same tall slot the list was in (a slot that
    // changed size would refit the map and move the box from under the pointer).
    const slot = container.querySelector(".arch-panel-slot")!;
    expect(slot).toHaveClass("tall");
    fireEvent.mouseEnter(box(/^Window events/));
    expect(screen.getByText("Testo implementation", { selector: ".arch-panel-layer" })).toBeInTheDocument();
    expect(screen.getByText(/two jobs in one type/, { selector: ".arch-panel-issue" })).toBeInTheDocument();
    expect(container.querySelector(".arch-panel-slot")).toBe(slot);
    expect(slot).toHaveClass("tall");
  });
});

