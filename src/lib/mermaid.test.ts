import { describe, expect, it } from "vitest";
import { isFlowchart, mermaidBlock, nodeIdOf, withChangeColours } from "./mermaid";

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
