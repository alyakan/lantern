import type { ChatItem, ToolItem } from "../store";
import { categoryOf, mcpTool, stepLabel, type Category } from "./activity";
import { agentTree, lastTurn, shortModel, type AdvisorCall, type SubagentNode } from "./agents";
import { familyOf, type Family } from "./harness";

/**
 * The latest turn as a graph: the main agent at the root, the advisor beside it, each subagent below it, and under
 * every agent the kinds of tools it uses (files, search, shell, web, each MCP server). Laid out as a tree.
 */

export type NodeKind = "main" | "advisor" | "workflow" | "agent" | "leaf";
export type NodeStatus = "running" | "done" | "error" | "idle";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Under the label: the model for an agent, "×4" for a leaf. */
  sub: string;
  tone: Family | "none";
  status: NodeStatus;
  parent: string | null;
  x: number;
  y: number;
  /** For the hover panel: lines about it (what it's doing, steps, tokens; a leaf's last calls). */
  detail: string[];
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** Work is going along it now. */
  active: boolean;
  /** The advisor's edge: on call, not part of the tree. */
  dashed: boolean;
}

export interface AgentGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  /**
   * Which edge each step travels: a subagent's start and end on main→agent, a tool call on agent→leaf, and for a
   * subagent's own calls also `via` its edge from main (its work shows on the way to it).
   */
  stepEdge: Record<string, { edge: string; via?: string; status: ToolItem["status"] }>;
}

/** Kinds of tool, as leaves: what the chat's categories group into. Agents and the advisor are nodes of their own. */
type LeafKind = "files" | "search" | "shell" | "web" | "skill" | "other" | `mcp:${string}`;

const LEAF_OF: Partial<Record<Category, LeafKind>> = { read: "files", edit: "files", search: "search", run: "shell", web: "web", skill: "skill" };
const LEAF_LABEL: Record<string, string> = { files: "files", search: "search", shell: "shell", web: "web", skill: "skills", other: "other" };

function leafOf(step: ToolItem): LeafKind | null {
  const c = categoryOf(step);
  if (c === "agent" || c === "advisor") return null;
  if (c === "mcp") return `mcp:${mcpTool(step.name)?.server ?? "MCP"}`;
  return LEAF_OF[c] ?? "other";
}

const leafLabel = (kind: LeafKind) => (kind.startsWith("mcp:") ? kind.slice(4) : LEAF_LABEL[kind]);
const steps = (items: ChatItem[]): ToolItem[] => items.flatMap((it) => (it.type === "tool" ? [it] : []));
const isAgent = (t: ToolItem) => t.name === "Agent" || t.name === "Task";
const toneOf = (model: string | null): Family | "none" => familyOf(model) ?? "none";

/** More subagents than this and their tool leaves fold into the agents' panels, to keep the graph readable. */
export const MAX_UNFOLDED = 6;

/** Sizes and gaps the layout uses (SVG units). */
export const SIZE = { agent: 132, leaf: 82, rowGap: 124, colGap: 14, top: 40, side: 20 };
/** How far below an agent's centre its label and model reach: edges leave from there. */
export const LABEL_DEPTH = 62;

function leavesFor(owner: string, calls: ToolItem[], out: { nodes: GraphNode[]; edges: GraphEdge[]; stepEdge: AgentGraph["stepEdge"] }, via?: string) {
  const groups = new Map<LeafKind, ToolItem[]>();
  for (const c of calls) {
    const kind = leafOf(c);
    if (kind) groups.set(kind, [...(groups.get(kind) ?? []), c]);
  }
  for (const [kind, list] of groups) {
    const id = `${owner}/${kind}`;
    const last = list[list.length - 1];
    const status: NodeStatus = list.some((c) => c.status === "running") ? "running" : last.status === "error" ? "error" : "done";
    out.nodes.push({ id, kind: "leaf", label: leafLabel(kind), sub: `×${list.length}`, tone: "none", status, parent: owner, x: 0, y: 0, detail: list.slice(-3).map((c) => `${stepLabel(c)} ${c.summary}`.trim() + (c.status === "error" ? " (failed)" : c.status === "running" ? " (running)" : "")) });
    const edge = `${owner}->${id}`;
    out.edges.push({ id: edge, from: owner, to: id, active: status === "running", dashed: false });
    for (const c of list) out.stepEdge[c.id] = { edge, via, status: c.status };
  }
}

const agentDetail = (s: SubagentNode) =>
  [s.description, s.now, [s.steps ? `${s.steps} steps` : "", s.tokens !== null ? `${Math.round(s.tokens / 100) / 10}k tokens` : "", s.ms !== null && s.ms >= 1000 ? `${Math.round(s.ms / 1000)}s` : ""].filter(Boolean).join(" · ")].filter(Boolean);

const advisorStatus = (calls: AdvisorCall[]): NodeStatus => {
  const last = calls[calls.length - 1];
  if (!last) return "idle";
  if (last.status === "advising") return "running";
  return last.status === "reviewed" ? "done" : "error";
};

/** The graph of the chat's latest turn, laid out. */
export function agentGraph(items: ChatItem[], opts: Parameters<typeof agentTree>[1]): AgentGraph {
  const tree = agentTree(items, opts);
  // The same turn as the tree: since your last message, Claude's own follow-ups included.
  const top = steps(lastTurn(items).items);
  const out = { nodes: [] as GraphNode[], edges: [] as GraphEdge[], stepEdge: {} as AgentGraph["stepEdge"] };

  const mainStatus: NodeStatus = tree.live ? "running" : top.some((t) => t.status === "error") && !tree.back ? "error" : "done";
  out.nodes.push({ id: "main", kind: "main", label: "main", sub: shortModel(opts.mainModel) ?? "default model", tone: toneOf(opts.mainModel), status: mainStatus, parent: null, x: 0, y: 0, detail: [tree.main.now ?? "Done", `${tree.main.steps} steps this turn`] });

  if (opts.advisor || tree.advisor.calls.length) {
    const status = advisorStatus(tree.advisor.calls);
    out.nodes.push({ id: "advisor", kind: "advisor", label: "advisor", sub: shortModel(opts.advisor) ?? "on call", tone: toneOf(opts.advisor), status, parent: null, x: 0, y: 0, detail: tree.advisor.calls.length ? tree.advisor.calls.map((c) => `${c.moment}: ${c.status}${c.detail ? ` (${c.detail})` : ""}`) : ["Not consulted this turn"] });
    out.edges.push({ id: "main->advisor", from: "main", to: "advisor", active: status === "running", dashed: true });
    for (const t of top) if (t.name === "advisor") out.stepEdge[t.id] = { edge: "main->advisor", status: t.status };
  }

  const fold = tree.subagents.length > MAX_UNFOLDED;
  const nodeStatus = (st: ToolItem["status"]): NodeStatus => (st === "running" ? "running" : st === "error" ? "error" : "done");
  const allTools = (list: ToolItem[]): ToolItem[] => list.flatMap((t) => [t, ...allTools(steps(t.children))]);
  const tools = allTools(top);
  // A subagent under its parent (main, or the workflow it runs in), with its kinds of tools under it.
  const addAgent = (s: SubagentNode, parent: string, via?: string) => {
    const id = `agent:${s.id}`;
    const status = nodeStatus(s.status);
    // A workflow agent is named by its label ("propose:reduce"); a subagent by its type ("Explore").
    const label = s.workflow ? s.description : s.type;
    out.nodes.push({ id, kind: "agent", label, sub: shortModel(s.model) ?? "…", tone: toneOf(s.model), status, parent, x: 0, y: 0, detail: s.workflow ? [`${s.type} phase`, ...agentDetail(s).slice(1)] : agentDetail(s) });
    const edge = `${parent}->${id}`;
    out.edges.push({ id: edge, from: parent, to: id, active: status === "running", dashed: false });
    out.stepEdge[s.id] = { edge, via, status: s.status };
    const tool = tools.find((t) => t.id === s.id);
    if (tool && !fold) leavesFor(id, steps(tool.children), out, edge);
    // Folded: its calls still show on its edge.
    if (tool && fold) for (const c of steps(tool.children)) out.stepEdge[c.id] = { edge, status: c.status };
  };
  // In the turn's order: subagents Claude started, and workflows with their agents.
  for (const t of top) {
    if (isAgent(t)) {
      const s = tree.subagents.find((x) => x.id === t.id);
      if (s) addAgent(s, "main");
    } else if (t.name === "Workflow") {
      const w = tree.workflows.find((x) => x.id === t.id)!;
      const id = `wf:${w.id}`;
      const status = nodeStatus(w.status);
      const mine = tree.subagents.filter((x) => x.workflow === w.id);
      out.nodes.push({ id, kind: "workflow", label: w.name.length > 22 ? `${w.name.slice(0, 21)}…` : w.name, sub: w.phase ?? "workflow", tone: "none", status, parent: "main", x: 0, y: 0, detail: [`Workflow: ${w.name}`, `${mine.length} agents${w.phase ? ` · now: ${w.phase}` : ""}`] });
      out.edges.push({ id: `main->${id}`, from: "main", to: id, active: status === "running", dashed: false });
      out.stepEdge[w.id] = { edge: `main->${id}`, status: w.status };
      for (const s of mine) addAgent(s, id, `main->${id}`);
    }
  }
  leavesFor("main", top.filter((t) => !isAgent(t) && t.name !== "advisor" && t.name !== "Workflow"), out);

  return layout(out);
}

/**
 * A tidy tree, top-down: each node centred over its children, siblings side by side in the order they appeared (so
 * new ones add to the right). The advisor sits to the left of the main agent, on its row.
 */
function layout(g: { nodes: GraphNode[]; edges: GraphEdge[]; stepEdge: AgentGraph["stepEdge"] }): AgentGraph {
  const children = (id: string) => g.nodes.filter((n) => n.parent === id);
  const own = (n: GraphNode) => (n.kind === "leaf" ? SIZE.leaf : SIZE.agent);
  const width = new Map<string, number>();
  const measure = (n: GraphNode): number => {
    const kids = children(n.id);
    const w = Math.max(own(n), kids.reduce((sum, k) => sum + measure(k), 0) + Math.max(0, kids.length - 1) * SIZE.colGap);
    width.set(n.id, w);
    return w;
  };
  const place = (n: GraphNode, left: number, depth: number) => {
    const w = width.get(n.id)!;
    n.x = left + w / 2;
    n.y = SIZE.top + depth * SIZE.rowGap;
    const kids = children(n.id);
    const total = kids.reduce((sum, k) => sum + width.get(k.id)!, 0) + Math.max(0, kids.length - 1) * SIZE.colGap;
    let x = left + (w - total) / 2;
    for (const k of kids) {
      place(k, x, depth + 1);
      x += width.get(k.id)! + SIZE.colGap;
    }
  };
  const main = g.nodes.find((n) => n.id === "main")!;
  const advisor = g.nodes.find((n) => n.id === "advisor");
  const treeWidth = measure(main);
  // Room on the left for the advisor, beside the main agent.
  const offset = SIZE.side + (advisor ? Math.max(0, SIZE.agent + SIZE.colGap * 2 - (treeWidth - SIZE.agent) / 2) : 0);
  place(main, offset, 0);
  if (advisor) {
    advisor.x = main.x - SIZE.agent - SIZE.colGap * 2;
    advisor.y = main.y;
  }
  // Down to the lowest thing drawn: a leaf's bottom edge, or an agent's model line.
  const bottom = Math.max(...g.nodes.map((n) => n.y + (n.kind === "leaf" ? 14 : LABEL_DEPTH)));
  return { ...g, width: offset + treeWidth + SIZE.side, height: bottom + 8 };
}

/** The view the graph shows: a box in its coordinates. */
export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Narrower than this and a zoomed branch of one or two nodes would be blown up to fill the pane. */
export const MIN_VIEW = { w: 420, h: 260 };

/** The whole graph, at least MIN_VIEW wide, centred. */
export function wholeView(g: AgentGraph): View {
  const w = Math.max(g.width, 560);
  return { x: -(w - g.width) / 2, y: 0, w, h: g.height };
}

/** The node to zoom to for a click: a tool leaf's agent, otherwise the node itself. */
export function zoomTarget(g: AgentGraph, id: string): string {
  const n = g.nodes.find((x) => x.id === id);
  return n?.kind === "leaf" && n.parent ? n.parent : id;
}

/** A node's branch: it, its children and their children. */
export function branchOf(g: AgentGraph, id: string): Set<string> {
  const ids = new Set([id]);
  for (let depth = 0; depth < 2; depth++) for (const n of g.nodes) if (n.parent && ids.has(n.parent)) ids.add(n.id);
  return ids;
}

/** The box around a node's branch, with room for labels, at least MIN_VIEW in size (centred on the branch). */
export function branchView(g: AgentGraph, id: string): View {
  const branch = g.nodes.filter((n) => branchOf(g, id).has(n.id));
  if (branch.length === 0) return wholeView(g);
  const half = (n: GraphNode) => (n.kind === "leaf" ? SIZE.leaf : SIZE.agent) / 2;
  const left = Math.min(...branch.map((n) => n.x - half(n))) - 16;
  const right = Math.max(...branch.map((n) => n.x + half(n))) + 16;
  const top = Math.min(...branch.map((n) => n.y)) - SIZE.top;
  const bottom = Math.max(...branch.map((n) => n.y + (n.kind === "leaf" ? 14 : LABEL_DEPTH))) + 12;
  const w = Math.max(right - left, MIN_VIEW.w);
  const h = Math.max(bottom - top, MIN_VIEW.h);
  return { x: (left + right) / 2 - w / 2, y: top, w, h };
}

/** The way down from the main agent to a node, for the breadcrumb: its ancestors, then it. */
export function trailTo(g: AgentGraph, id: string): GraphNode[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out: GraphNode[] = [];
  for (let n = byId.get(id); n; n = n.parent ? byId.get(n.parent) : undefined) out.unshift(n);
  return out;
}
