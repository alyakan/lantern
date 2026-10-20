import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { initialState, type ChatItem, type State } from "../store";
import { StepsView } from "./StepsView";
import { rememberVerdicts } from "../lib/review";
import { act } from "@testing-library/react";
import { ArchitectureTab } from "./ArchitectureTab";
import { Md } from "./Md";
import { ArchitecturePane } from "../lib/architecturePane";
import { architectureMap } from "../lib/architecture";
import { pagesOf } from "../lib/steps";
import { TESTO_MAP } from "../lib/testoMap";
import { DENSE_MAP } from "../lib/denseMap";

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
  // Verdicts not yet sent are kept across views (see StepsView); each test starts with none.
  beforeEach(() => rememberVerdicts("s1", {}));

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
    expect(h.onSend).toHaveBeenCalledWith("Start Build.", "build");
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

  it("asks Claude to bring the map up to date with Update map, which waits while Claude is busy", () => {
    const onUpdate = vi.fn();
    const view = render(<ArchitectureTab map={map} current={[]} pageNames={names} onOpenPage={() => {}} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole("button", { name: "Update map" }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<ArchitectureTab map={map} current={[]} pageNames={names} onOpenPage={() => {}} />);
    expect(screen.getByRole("button", { name: "Update map" })).toBeDisabled();
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
    // The issues are under a chip over the map (not in the layout, so the map has the room); a click opens the list.
    expect(within(screen.getByLabelText("Issues")).getByText("3 issues")).toBeInTheDocument();
    expect(screen.queryByText(/goes around Device boundary/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /3 issues/ }));
    const list = within(screen.getByLabelText("Issues"));
    expect(list.getByText(/goes around Device boundary/)).toBeInTheDocument();
    expect(list.getByText(/found by Lantern from the layers/)).toBeInTheDocument();
    expect(container.querySelectorAll(".arch-edge.skip")).toHaveLength(1);
    expect(container.querySelectorAll(".arch-edge.issue")).toHaveLength(1);
    expect(container.querySelectorAll(".arch-crossing").length).toBeGreaterThan(10);
    // Hovering an issue lights its box or arrow; hovering a box shows what it is, its layer and its issue, over the map
    // (an overlay, so the map doesn't refit and move the box from under the pointer).
    fireEvent.mouseEnter(list.getByText(/two jobs in one type/).closest("li")!);
    expect(box(/^Window events/).getAttribute("data-focus")).toBe("full");
    expect(box(/^Gating/).getAttribute("data-focus")).toBe("dim");
    fireEvent.mouseLeave(list.getByText(/two jobs in one type/).closest("ul")!);
    fireEvent.mouseEnter(box(/^Window events/));
    expect(screen.getByText("Testo implementation", { selector: ".arch-panel-layer" })).toBeInTheDocument();
    expect(screen.getByText(/two jobs in one type/, { selector: ".arch-panel-issue" })).toBeInTheDocument();
  });
});


describe("the focus while stepping through the design", () => {
  const pages = pagesOf(chat(4));
  const map = architectureMap(pages)!;
  const names = { [pages[2].key]: "Part 1 of 2 — Gateway", [pages[3].key]: "Part 2 of 2 — Auth service" };
  const box = (name: RegExp) => screen.getByRole("button", { name });
  const focusOf = (el: Element) => el.getAttribute("data-focus");
  const edgeFocus = (container: HTMLElement) => [...container.querySelectorAll(".arch-edge")].map((e) => focusOf(e));

  it("draws everything at full strength on the Overview, where nothing is covered", () => {
    const { container } = render(<ArchitectureTab map={map} current={[]} pageNames={names} onOpenPage={() => {}} />);
    expect(container.querySelector(".arch-graph")).not.toHaveClass("focused");
    for (const el of container.querySelectorAll("[data-node], .arch-edge")) expect(focusOf(el)).toBe("full");
  });

  it("steps back the boxes and arrows a part is not about, and half-lights an arrow out of it", () => {
    const { container } = render(<ArchitectureTab map={map} current={["gw"]} pageNames={names} onOpenPage={() => {}} />);
    expect(container.querySelector(".arch-graph")).toHaveClass("focused");
    expect(focusOf(box(/^Gateway/))).toBe("full");
    expect(focusOf(box(/^Auth service/))).toBe("dim");
    expect(focusOf(box(/^Logs/))).toBe("dim");
    // gw → authSvc leaves the covered box; authSvc → logs touches none.
    expect(edgeFocus(container)).toEqual(["context", "dim"]);
    // A faint arrow's label is faint with it.
    expect(container.querySelector('[data-pill]')?.getAttribute("data-focus")).toBe("context");
  });

  it("shows a faint box at full strength when it is the one looked at", () => {
    render(<ArchitectureTab map={map} current={["gw"]} pageNames={names} onOpenPage={() => {}} />);
    fireEvent.mouseEnter(box(/^Logs/));
    expect(box(/^Logs/)).toHaveClass("shown");
  });

  describe("Show all", () => {
    const button = () => screen.getByRole("button", { name: "Show everything while held" });
    const drawn = (container: HTMLElement) => [...container.querySelectorAll("[data-node], .arch-edge")].map((e) => focusOf(e));
    const setup = () => render(<ArchitectureTab map={map} current={["gw"]} pageNames={names} onOpenPage={() => {}} />);

    it("is a button that says what it does and is not pressed to begin with", () => {
      setup();
      expect(button()).toHaveAttribute("aria-pressed", "false");
      expect(button()).toHaveTextContent("Show all");
      expect(button().querySelector("svg")).not.toBeNull();
    });

    it("shows everything while a press (mouse, touch or pen) is held, and goes back when it is let go", () => {
      for (const pointerType of ["mouse", "touch", "pen"]) {
        const { container, unmount } = setup();
        expect(drawn(container)).toContain("dim");
        fireEvent.pointerDown(button(), { pointerType, button: 0 });
        expect(button()).toHaveAttribute("aria-pressed", "true");
        expect(drawn(container).every((v) => v === "full")).toBe(true);
        fireEvent.pointerUp(button(), { pointerType });
        expect(button()).toHaveAttribute("aria-pressed", "false");
        expect(drawn(container)).toContain("dim");
        unmount();
      }
    });

    it("is not a switch: a click that stays on it twice leaves it off", () => {
      const { container } = setup();
      fireEvent.pointerDown(button(), { button: 0 });
      fireEvent.pointerUp(button());
      fireEvent.click(button());
      fireEvent.pointerDown(button(), { button: 0 });
      fireEvent.pointerUp(button());
      fireEvent.click(button());
      expect(button()).toHaveAttribute("aria-pressed", "false");
      expect(drawn(container)).toContain("dim");
    });

    it("lets go when the press is cancelled, or the pointer leaves it", () => {
      const { container } = setup();
      fireEvent.pointerDown(button(), { button: 0 });
      fireEvent.pointerCancel(button());
      expect(drawn(container)).toContain("dim");
      fireEvent.pointerDown(button(), { button: 0 });
      fireEvent.pointerLeave(button());
      expect(button()).toHaveAttribute("aria-pressed", "false");
      expect(drawn(container)).toContain("dim");
    });

    it("lets go when the press ends away from the button, the window loses focus or is hidden", () => {
      const { container } = setup();
      fireEvent.pointerDown(button(), { button: 0 });
      act(() => void window.dispatchEvent(new Event("pointerup")));
      expect(button()).toHaveAttribute("aria-pressed", "false");
      fireEvent.pointerDown(button(), { button: 0 });
      act(() => void window.dispatchEvent(new Event("blur")));
      expect(button()).toHaveAttribute("aria-pressed", "false");
      fireEvent.pointerDown(button(), { button: 0 });
      act(() => void document.dispatchEvent(new Event("visibilitychange")));
      expect(button()).toHaveAttribute("aria-pressed", "false");
      expect(drawn(container)).toContain("dim");
    });

    it("ignores a press of another mouse button", () => {
      setup();
      fireEvent(button(), new MouseEvent("pointerdown", { button: 2, bubbles: true }));
      expect(button()).toHaveAttribute("aria-pressed", "false");
    });

    it("works from the keyboard: Space or Enter held shows everything, released puts it back, and focus leaving puts it back", () => {
      const { container } = setup();
      for (const key of [" ", "Enter"]) {
        fireEvent.keyDown(button(), { key });
        expect(button()).toHaveAttribute("aria-pressed", "true");
        expect(drawn(container).every((v) => v === "full")).toBe(true);
        fireEvent.keyUp(button(), { key });
        expect(button()).toHaveAttribute("aria-pressed", "false");
      }
      fireEvent.keyDown(button(), { key: "a" });
      expect(button()).toHaveAttribute("aria-pressed", "false");
      fireEvent.keyDown(button(), { key: " " });
      fireEvent.blur(button());
      expect(button()).toHaveAttribute("aria-pressed", "false");
      expect(drawn(container)).toContain("dim");
    });

    it("is let go when the map goes away, so the next one doesn't start lit", () => {
      const { unmount } = setup();
      fireEvent.pointerDown(button(), { button: 0 });
      unmount();
      const { container } = setup();
      expect(button()).toHaveAttribute("aria-pressed", "false");
      expect(drawn(container)).toContain("dim");
    });
  });
});

describe("the labels on a dense map in the Map tab", () => {
  const overview = `# Overview — dense\n\n\`\`\`architecture\n${JSON.stringify(DENSE_MAP)}\n\`\`\``;
  const map = architectureMap(pagesOf([{ type: "user", id: "u0", text: "map it" }, { type: "assistant", id: "a0", text: overview }]))!;

  it("draws a pill for each label placed, cut short when long, and a dot for one left off that shows when its arrow is looked at", () => {
    const { container } = render(<ArchitectureTab map={map} current={[]} pageNames={{}} onOpenPage={() => {}} />);
    const pills = [...container.querySelectorAll("[data-pill]")];
    expect(pills.length).toBeGreaterThan(35);
    expect(container.querySelector(".arch-pills")).toHaveAttribute("aria-hidden", "true");
    expect(pills.some((p) => p.textContent === "pairs, measures a…")).toBe(true);
    const dots = container.querySelectorAll(".arch-edge-dot");
    // Every labelled arrow has a pill or a dot.
    expect(pills.length + dots.length).toBe(DENSE_MAP.edges.filter((e) => "label" in e && e.label).length);
    // The arrow says its whole label, to a screen reader and as a tooltip.
    const edge = [...container.querySelectorAll(".arch-edge")].find((e) => e.querySelector("title")?.textContent?.includes("pairs, measures and reports back"))!;
    expect(edge).toBeTruthy();
    // Pointing at it shows the label whole, over the others.
    fireEvent.mouseEnter(edge);
    expect(container.querySelector('[data-pill].open')?.textContent).toContain("pairs, measures and reports back");
    fireEvent.mouseLeave(edge);
    expect(container.querySelector("[data-pill].open")).toBeNull();
  });

  it("shows a box's arrows' labels whole while the box is looked at", () => {
    const { container } = render(<ArchitectureTab map={map} current={[]} pageNames={{}} onOpenPage={() => {}} />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: /^Bluetooth bridge/ }));
    expect([...container.querySelectorAll("[data-pill].open")].map((p) => p.textContent).sort()).toEqual(["BLE", "logs", "pairs, measures and reports back to the…", "reading"].sort());
  });

  it("gives an arrow a wide line to point at", () => {
    const { container } = render(<ArchitectureTab map={map} current={[]} pageNames={{}} onOpenPage={() => {}} />);
    expect(container.querySelectorAll(".arch-edge-hit")).toHaveLength(DENSE_MAP.edges.length);
  });

  it("opens the map larger, in a dialog with the same map in it", () => {
    render(<ArchitectureTab map={map} current={[]} pageNames={{}} onOpenPage={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Open the map larger" }));
    const big = within(screen.getByRole("dialog", { name: "Architecture map, larger", hidden: true }));
    expect(big.getAllByRole("button", { name: /^App shell/, hidden: true }).length).toBeGreaterThan(0);
    expect(big.getByRole("button", { name: "Show everything while held", hidden: true })).toBeInTheDocument();
    fireEvent.click(big.getByRole("button", { name: "Close", hidden: true }));
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
  });
});

describe("fitting the map in the room", () => {
  const overview = `# Overview — dense\n\n\`\`\`architecture\n${JSON.stringify(DENSE_MAP)}\n\`\`\``;
  const map = architectureMap(pagesOf([{ type: "user", id: "u0", text: "map it" }, { type: "assistant", id: "a0", text: overview }]))!;

  it("keeps the fitted map clear of the legend at the top and the controls at the bottom", () => {
    const w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const h = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1400 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 900 });
    try {
      render(<ArchitectureTab map={map} current={[]} pageNames={{}} onOpenPage={() => {}} />);
      const t = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec((document.querySelector(".pz-world") as HTMLElement).style.transform)!;
      const [x, y, zoom] = [Number(t[1]), Number(t[2]), Number(t[3])];
      const world = document.querySelector(".pz-world") as HTMLElement;
      const height = Number(world.style.height.replace("px", ""));
      expect(y).toBeGreaterThanOrEqual(34);
      expect(y + height * zoom).toBeLessThanOrEqual(900 - 44);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(zoom).toBeGreaterThanOrEqual(0.75);
    } finally {
      if (w) Object.defineProperty(HTMLElement.prototype, "clientWidth", w);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
      if (h) Object.defineProperty(HTMLElement.prototype, "clientHeight", h);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    }
  });
});
