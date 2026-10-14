/**
 * Mermaid, for Architecture's diagrams. The library is big, so it loads the first time a diagram is drawn (as Monaco
 * does for code), and it runs in its strict security level: no scripts, no click handlers, no HTML in labels.
 */

/**
 * How a node says what the change does to it, in the diagram's own words: `A[Auth service]:::changed`. Claude is told
 * these three (see STEPS_PROMPT); Lantern adds the colours, so they match the theme and a diagram can't get them wrong.
 */
const CLASS_DEFS: Record<string, string> = {
  new: "fill:#2ea04333,stroke:#2ea043,stroke-width:2px",
  changed: "fill:#d9a30033,stroke:#d9a300,stroke-width:2px",
  removed: "fill:#e5484d22,stroke:#e5484d,stroke-width:2px,stroke-dasharray:4 3",
};

/** The diagram's type word: its first line that isn't blank, a comment, a directive or front matter. */
function diagramType(source: string): string | null {
  let front = false;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "---") {
      front = !front;
      continue;
    }
    if (front || !line || line.startsWith("%%")) continue;
    return /^[A-Za-z][\w-]*/.exec(line)?.[0] ?? null;
  }
  return null;
}

/** Whether nodes in this diagram have ids that pages can name (a flowchart's do). */
export const isFlowchart = (source: string) => /^(flowchart|graph)$/i.test(diagramType(source) ?? "");

/** The diagram with the colours for new, changed and removed nodes added (only flowcharts have classes to colour). */
export function withChangeColours(source: string): string {
  if (!isFlowchart(source)) return source;
  const defs = Object.entries(CLASS_DEFS)
    .filter(([name]) => !new RegExp(`^\\s*classDef\\s+(?:[\\w,\\s]*,)?\\s*${name}\\b`, "m").test(source))
    .map(([name, style]) => `classDef ${name} ${style}`);
  return defs.length ? `${source.replace(/\s+$/, "")}\n${defs.join("\n")}\n` : source;
}

/** The first mermaid block of some markdown, or null. */
export function mermaidBlock(markdown: string): string | null {
  const m = /^```mermaid[^\n]*\n([\s\S]*?)^```/m.exec(markdown);
  return m ? m[1].replace(/\s+$/, "") : null;
}

/**
 * The id a flowchart node was written with, from the id mermaid gave its element: `flowchart-authSvc-12`, with the
 * diagram's own id in front of it once it is drawn (`lantern-diagram-3-flowchart-authSvc-12`).
 */
export function nodeIdOf(elementId: string): string | null {
  return /(?:^|-)flowchart-(.+)-\d+$/.exec(elementId)?.[1] ?? null;
}

/** A drawn SVG's own size, from its viewBox. */
export function svgSize(svg: string): { w: number; h: number } | null {
  const m = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

type Mermaid = (typeof import("mermaid"))["default"];

let loaded: Promise<Mermaid> | null = null;
let counter = 0;
// Mermaid's settings are global and its renders share the page, so one draws at a time.
let queue: Promise<unknown> = Promise.resolve();
const cache = new Map<string, string>();
const CACHE_MAX = 40;

const load = () => (loaded ??= import("mermaid").then((m) => m.default));

/** The diagram as SVG markup; rejects with mermaid's message when the source isn't valid. */
export function renderDiagram(source: string, dark: boolean): Promise<string> {
  const key = `${dark ? "d" : "l"}:${source}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const run = async () => {
    const mermaid = await load();
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", fontFamily: "inherit", flowchart: { htmlLabels: true, useMaxWidth: false } });
    const id = `lantern-diagram-${++counter}`;
    try {
      await mermaid.parse(source);
      const { svg } = await mermaid.render(id, source);
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(key, svg);
      return svg;
    } finally {
      // A diagram that doesn't parse leaves its error drawing behind in the page.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}
