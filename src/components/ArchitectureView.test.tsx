import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { initialState, type ChatItem, type State } from "../store";
import { StepsView } from "./StepsView";
import { ArchitectureTab } from "./ArchitectureTab";
import { Md } from "./Md";
import { ArchitecturePane } from "../lib/architecturePane";
import { architectureMap } from "../lib/architecture";
import { pagesOf } from "../lib/steps";

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
      <ArchitecturePane.Provider value={open}>
        <StepsView state={state(2)} {...handlers()} />
      </ArchitecturePane.Provider>,
    );
    const block = current().querySelector(".arch-block") as HTMLElement;
    expect(within(block).getByRole("button", { name: /^Gateway, new/ })).toBeInTheDocument();
    fireEvent.click(within(block).getByRole("button", { name: "Open in the pane" }));
    expect(open).toHaveBeenCalled();
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
