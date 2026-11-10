import { describe, expect, it } from "vitest";
import { diagramVariables, isFlowchart, mermaidBlock, nodeIdOf, scopeDiagram, withChangeColours } from "./mermaid";

describe("mounted diagram copies", () => {
  it("preserves HTML labels and line breaks", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" id="drawing"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">First<br>Second&nbsp;line</div></foreignObject></svg>';
    const doc = new DOMParser().parseFromString(scopeDiagram(svg, "popup"), "text/html");
    expect(doc.querySelector("foreignObject br")).not.toBeNull();
    expect(doc.querySelector("foreignObject")?.textContent).toBe("FirstSecond\u00a0line");
  });

  it("keeps arrows, styles and accessible labels within their own copy", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" id="drawing" aria-labelledby="title"><style>#drawing .edge { marker-end: url(#arrow); stroke: #fff; }</style><title id="title">Request flow</title><defs><marker id="arrow"><path d="M0 0L8 4L0 8z"/></marker></defs><path id="edge" class="edge" marker-end="url(#arrow)"/><use href="#edge"/></svg>';
    const copies = ["chat", "popup"].map((scope) => new DOMParser().parseFromString(scopeDiagram(source, scope), "image/svg+xml"));
    for (const [i, doc] of copies.entries()) {
      const scope = i ? "popup" : "chat";
      expect(doc.documentElement.id).toBe(`${scope}-drawing`);
      expect(doc.documentElement.getAttribute("aria-labelledby")).toBe(`${scope}-title`);
      expect(doc.querySelector("path.edge")?.getAttribute("marker-end")).toBe(`url(#${scope}-arrow)`);
      expect(doc.querySelector("use")?.getAttribute("href")).toBe(`#${scope}-edge`);
      expect(doc.querySelector("style")?.textContent).toContain(`#${scope}-drawing .edge`);
      expect(doc.querySelector("style")?.textContent).toContain(`url(#${scope}-arrow)`);
      expect(doc.querySelector("style")?.textContent).toContain("stroke: #fff");
    }
    const firstIds = new Set([...copies[0].querySelectorAll("[id]")].map((el) => el.id));
    expect([...copies[1].querySelectorAll("[id]")].some((el) => firstIds.has(el.id))).toBe(false);
  });
});

describe("withChangeColours", () => {
  it("adds the colours for new, changed and removed to a flowchart", () => {
    const out = withChangeColours("flowchart LR\n  A[Gateway]:::new --> B");
    expect(out).toMatch(/classDef new fill:/);
    expect(out).toMatch(/classDef changed fill:/);
    expect(out).toMatch(/classDef removed fill:/);
    expect(out.startsWith("flowchart LR\n  A[Gateway]:::new --> B")).toBe(true);
  });

  it("leaves a class the diagram defined itself, and other kinds of diagram, alone", () => {
    const own = withChangeColours("graph TD\n  A:::new --> B\n  classDef new fill:#fff");
    expect(own.match(/classDef new/g)).toHaveLength(1);
    expect(own).toMatch(/classDef changed/);
    const seq = "sequenceDiagram\n  A->>B: hi";
    expect(withChangeColours(seq)).toBe(seq);
  });

  it("finds the type past front matter, directives and comments", () => {
    expect(isFlowchart("---\ntitle: x\n---\n%%{init: {}}%%\n%% note\nflowchart TD\nA-->B")).toBe(true);
    expect(isFlowchart("sequenceDiagram\nA->>B: x")).toBe(false);
    expect(isFlowchart("")).toBe(false);
  });
});

describe("mermaidBlock", () => {
  it("is the first mermaid block's source", () => {
    expect(mermaidBlock("Text\n\n```mermaid\nflowchart LR\nA-->B\n```\n\nmore\n\n```mermaid\nsequenceDiagram\n```")).toBe("flowchart LR\nA-->B");
    expect(mermaidBlock("```ts\nconst a = 1;\n```")).toBeNull();
  });
});

describe("nodeIdOf", () => {
  it("reads the id a node was written with from mermaid's element id", () => {
    expect(nodeIdOf("flowchart-authSvc-12")).toBe("authSvc");
    expect(nodeIdOf("flowchart-token-store-3")).toBe("token-store");
    // As drawn: the diagram's id comes first.
    expect(nodeIdOf("lantern-diagram-3-flowchart-authSvc-12")).toBe("authSvc");
    expect(nodeIdOf("edge-4")).toBeNull();
  });
});

describe("diagramVariables", () => {
  const tokens = { pane: "#2e3440", sidebar: "#3b4252", "bg-subtle": "#363d4b", text: "#eceff4", "text-2": "#d8dee9", "line-strong": "#4c566a" };

  it("draws nodes in the chat card's colour, with the theme's text and lines", () => {
    const v = diagramVariables(tokens);
    expect(v).toMatchObject({ background: "#2e3440", primaryColor: "#3b4252", primaryTextColor: "#eceff4", primaryBorderColor: "#4c566a", lineColor: "#d8dee9" });
  });

  it("leaves mermaid's own light or dark alone when the theme's colours can't be read", () => {
    expect(diagramVariables({})).toEqual({});
    expect(diagramVariables({ ...tokens, text: "" })).toEqual({});
  });
});
