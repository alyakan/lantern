import type { ArchLayout } from "./archGraph";

/** How much of itself a box or an arrow shows while a part is on screen: all of it, some (an arrow into the part), or little. */
export type Focus = "full" | "context" | "dim";

/** The opacity each level is drawn at; the stylesheet has the same numbers. */
export const FOCUS_OPACITY: Record<Focus, number> = { full: 1, context: 0.6, dim: 0.28 };

export interface Focused {
  /** Whether anything is lit: false on the Overview, where everything is at full strength. */
  active: boolean;
  nodes: Map<string, Focus>;
  edges: Map<string, Focus>;
}

/**
 * What stands out while stepping through a design. With a part on screen (`covered`, its Covers line) the boxes it covers
 * and the arrows between them are in play; an arrow between one of them and something else keeps half its strength, so
 * the part's surroundings still show; the rest steps back. A box or arrow picked from the issues list is in play too.
 * With nothing covered (the Overview) everything is at full strength, as it is when `all` (the Show all button is held).
 */
export function focusOf(layout: Pick<ArchLayout, "nodes" | "edges">, covered: string[], picked: { node: string | null; edge: string | null } | null = null, all = false): Focused {
  const lit = new Set(layout.nodes.filter((n) => covered.includes(n.id)).map((n) => n.id));
  const active = !all && (lit.size > 0 || picked !== null);
  const nodes = new Map<string, Focus>();
  const edges = new Map<string, Focus>();
  const pickedEdge = picked?.edge ? layout.edges.find((e) => e.key === picked.edge) : undefined;
  for (const n of layout.nodes) nodes.set(n.id, !active || lit.has(n.id) || picked?.node === n.id || pickedEdge?.from === n.id || pickedEdge?.to === n.id ? "full" : "dim");
  for (const e of layout.edges) {
    const ends = (lit.has(e.from) ? 1 : 0) + (lit.has(e.to) ? 1 : 0);
    edges.set(e.key, !active || picked?.edge === e.key || ends === 2 ? "full" : ends === 1 ? "context" : "dim");
  }
  return { active, nodes, edges };
}
